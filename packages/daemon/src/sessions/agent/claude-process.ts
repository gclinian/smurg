// One `claude` child in bidirectional stream-json mode (ARCHITECTURE §7.6 "Launch"; DESIGN §2.1; port of
// runtime/prototype/claude-session.mjs): spawn, a bounded line reader on stdout, a writer on stdin, a bounded tail of
// stderr (read continuously: a full pipe must never block the agent), our own control requests with deadlines.
//
// `detached: true` is required: killTree protects the daemon's own process group, so a child in that group would never
// be killed. The child leads its own group; the registry ends it with killTree like a PTY child.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** One stdout line may carry a whole file (a Write's input): bounded all the same. */
export const CLAUDE_LINE_MAX_BYTES = 64 * 1024 * 1024;

export interface ClaudeExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class ControlError extends Error {
  readonly why: 'timeout' | 'exit' | 'refused';
  constructor(why: 'timeout' | 'exit' | 'refused', message: string) {
    super(message);
    this.name = 'ControlError';
    this.why = why;
  }
}

export interface ClaudeProcessOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stderrTailBytes: number;
  /** One complete stdout line (without its newline). */
  onLine(line: string): void;
  /** A line longer than CLAUDE_LINE_MAX_BYTES was dropped. */
  onOversizedLine?(): void;
}

interface PendingControl {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class ClaudeProcess {
  readonly exited: Promise<ClaudeExit>;
  private readonly child: ChildProcess;
  private readonly pendingControl = new Map<string, PendingControl>();
  private readonly tailLimit: number;
  private stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private exit: ClaudeExit | null = null;
  private inputEnded = false;

  constructor(options: ClaudeProcessOptions) {
    this.tailLimit = options.stderrTailBytes;
    this.child = spawn(options.file, [...options.args], { cwd: options.cwd, env: { ...options.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise<ClaudeExit>((resolve) => {
      let settled = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        this.exit = { code, signal };
        for (const pending of this.pendingControl.values()) {
          clearTimeout(pending.timer);
          pending.reject(new ControlError('exit', 'the claude process ended'));
        }
        this.pendingControl.clear();
        resolve(this.exit);
      };
      // 'error': the spawn itself failed (ENOENT, EACCES): there is no process.
      this.child.once('error', () => finish(null, null));
      this.child.once('close', (code, signal) => finish(code, signal));
    });
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let dropping = false;
    this.child.stdout?.on('data', (chunk: Buffer) => {
      let rest = chunk;
      for (;;) {
        const newline = rest.indexOf(0x0a);
        if (newline === -1) {
          if (dropping) return;
          pendingBytes += rest.length;
          if (pendingBytes > CLAUDE_LINE_MAX_BYTES) {
            dropping = true;
            pending = [];
            pendingBytes = 0;
            options.onOversizedLine?.();
            return;
          }
          if (rest.length > 0) pending.push(rest);
          return;
        }
        const piece = rest.subarray(0, newline);
        rest = rest.subarray(newline + 1);
        if (dropping) {
          dropping = false;
          continue;
        }
        const line = pending.length === 0 ? piece : Buffer.concat([...pending, piece]);
        pending = [];
        pendingBytes = 0;
        if (line.length > 0) options.onLine(line.toString('utf8'));
      }
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrChunks.push(chunk);
      this.stderrBytes += chunk.length;
      while (this.stderrBytes > this.tailLimit && this.stderrChunks.length > 1) {
        this.stderrBytes -= (this.stderrChunks.shift() as Buffer).length;
      }
    });
    // EPIPE when the process is gone: `exited` reports it.
    this.child.stdin?.on('error', () => {});
    this.child.stdout?.on('error', () => {});
    this.child.stderr?.on('error', () => {});
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return this.exit === null && this.child.pid !== undefined;
  }

  /** The last bytes the child wrote to stderr (for the log; never sent to anyone). */
  stderrTail(): string {
    const text = Buffer.concat(this.stderrChunks).toString('utf8');
    return text.length > this.tailLimit ? text.slice(-this.tailLimit) : text;
  }

  /** Writes one protocol message; false when the process takes no more input. */
  write(message: unknown): boolean {
    const stdin = this.child.stdin;
    if (this.inputEnded || this.exit !== null || stdin === null || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  /** One control request of ours. Rejects with ControlError: `timeout`, `exit`, or `refused` (the CLI answered with an error). */
  control(request: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<unknown> {
    const requestId = `smurg_${randomUUID()}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(new ControlError('timeout', `no answer to ${String(request['subtype'])}`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingControl.set(requestId, { resolve, reject, timer });
      if (!this.write({ type: 'control_request', request_id: requestId, request })) {
        clearTimeout(timer);
        this.pendingControl.delete(requestId);
        reject(new ControlError('exit', 'the claude process takes no input'));
      }
    });
  }

  /** The answer to one of our control requests arrived (the runner's normaliser saw it). */
  settleControl(requestId: string, ok: boolean, response: unknown, error?: string): void {
    const pending = this.pendingControl.get(requestId);
    if (!pending) return;
    this.pendingControl.delete(requestId);
    clearTimeout(pending.timer);
    if (ok) pending.resolve(response);
    else pending.reject(new ControlError('refused', error ?? 'control request failed'));
  }

  /** Answers a control request of the CLI's (`can_use_tool`). */
  respond(claudeRequestId: string, response: Readonly<Record<string, unknown>>): boolean {
    return this.write({ type: 'control_response', response: { subtype: 'success', request_id: claudeRequestId, response } });
  }

  respondError(claudeRequestId: string, error: string): boolean {
    return this.write({ type: 'control_response', response: { subtype: 'error', request_id: claudeRequestId, error } });
  }

  /** Closes stdin: the CLI finishes what it does and exits 0 by itself. */
  endInput(): void {
    if (this.inputEnded) return;
    this.inputEnded = true;
    try {
      this.child.stdin?.end();
    } catch {
      // already gone
    }
  }

  /** Resolves with the exit, or null after `ms`. */
  waitExit(ms: number): Promise<ClaudeExit | null> {
    if (this.exit !== null) return Promise.resolve(this.exit);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      timer.unref?.();
      void this.exited.then((exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
  }
}

// TEST ONLY: two renderers to compare screens (R4.1).
//  - SecondViewer: a session viewer built like the web client (headless xterm with the full query swallow set of
//    pty-packaging.md §6.2, snapshot = reset + resize + paint, exec.resize applied in stream order), on any
//    WorkspaceChannel.
//  - LocalTerminal: "the person's terminal window": an outer PTY (node-pty) running a non-interactive `sh -c` script,
//    rendered by a headless xterm that answers queries like a real terminal would.
import xtermHeadless from '@xterm/headless';
import * as pty from 'node-pty';
import type { TerminalSession } from '@smurg/protocol';
import type { WorkspaceChannel } from '../src/channel/channel.ts';

const { Terminal } = xtermHeadless;
type HeadlessTerminal = InstanceType<typeof Terminal>;

function swallowQueries(term: HeadlessTerminal): void {
  const p = term.parser;
  const swallow = (): boolean => true;
  for (const prefix of [undefined, '>', '=']) p.registerCsiHandler({ ...(prefix ? { prefix } : {}), final: 'c' }, swallow);
  for (const prefix of [undefined, '?']) p.registerCsiHandler({ ...(prefix ? { prefix } : {}), final: 'n' }, swallow);
  for (const prefix of [undefined, '?']) p.registerCsiHandler({ ...(prefix ? { prefix } : {}), intermediates: '$', final: 'p' }, swallow);
  p.registerCsiHandler({ final: 't' }, (params) => [11, 13, 14, 15, 16, 18, 19, 20, 21].includes(params[0] as number));
  p.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow);
}

export function viewportOf(term: HeadlessTerminal): string[] {
  const buffer = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < term.rows; i++) out.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '');
  return out;
}

export function drained(term: HeadlessTerminal): Promise<void> {
  return new Promise((resolve) => term.write('', () => resolve()));
}

export class SecondViewer {
  readonly term: HeadlessTerminal;
  private readonly channel: WorkspaceChannel;
  private readonly sessionId: string;
  private pending: { offset: number; data: Uint8Array }[] | null = [];
  private expected = 0;
  private readonly off: (() => void)[] = [];

  constructor(channel: WorkspaceChannel, session: TerminalSession) {
    this.channel = channel;
    this.sessionId = session.id;
    this.term = new Terminal({ cols: session.cols, rows: session.rows, scrollback: 5000, allowProposedApi: true });
    swallowQueries(this.term);
    this.off.push(
      channel.on('exec.output', (p) => {
        if (p.sessionId !== this.sessionId) return;
        if (this.pending) this.pending.push({ offset: p.offset, data: p.data });
        else this.apply(p.offset, p.data);
      }),
      channel.on('exec.resize', (p) => {
        if (p.sessionId !== this.sessionId) return;
        this.term.write('', () => this.term.resize(p.cols, p.rows));
      }),
    );
  }

  private apply(offset: number, data: Uint8Array): void {
    const end = offset + data.length;
    if (end <= this.expected) return;
    this.term.write(data.subarray(Math.max(0, this.expected - offset)));
    this.expected = end;
  }

  /** A viewer that does not drive the size (no cols/rows): it renders at the PTY size. */
  async attach(): Promise<void> {
    const result = await this.channel.request('session.attach', { sessionId: this.sessionId });
    this.term.write('', () => {
      this.term.reset();
      this.term.resize(result.cols, result.rows);
    });
    this.term.write(result.data);
    this.expected = result.nextOffset;
    const queued = this.pending ?? [];
    this.pending = null;
    for (const chunk of queued) this.apply(chunk.offset, chunk.data);
  }

  viewport(): string[] {
    return viewportOf(this.term);
  }

  size(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  dispose(): void {
    for (const off of this.off) off();
    this.term.dispose();
  }
}

export interface LocalTerminal {
  readonly term: HeadlessTerminal;
  readonly outer: pty.IPty;
  text: string;
  cursorHidden: boolean;
  since(mark: number): string;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export function localTerminal(script: string, env: Record<string, string>, cwd: string, cols = 100, rows = 30): LocalTerminal {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const outer = pty.spawn('/bin/sh', ['-c', script], { name: 'xterm-256color', cols, rows, cwd, env, encoding: null } as unknown as pty.IPtyForkOptions);
  const local: LocalTerminal = {
    term,
    outer,
    text: '',
    cursorHidden: false,
    since: (mark) => local.text.slice(mark),
    resize: (c, r) => {
      outer.resize(c, r);
      term.write('', () => term.resize(c, r));
    },
    kill: () => {
      try {
        outer.kill();
      } catch {
        // already gone
      }
    },
  };
  outer.onData((d: unknown) => {
    const bytes = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8');
    term.write(bytes);
    local.text += bytes.toString('utf8');
  });
  // A real terminal answers queries; if the CLI let one through, this reply would reach the session twice.
  term.onData((d) => outer.write(d));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (p) => {
    if (p.includes(25)) local.cursorHidden = true;
    return false;
  });
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (p) => {
    if (p.includes(25)) local.cursorHidden = false;
    return false;
  });
  return local;
}

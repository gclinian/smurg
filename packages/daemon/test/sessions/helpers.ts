// TEST ONLY: fakes of the services the sessions module calls (hooks, locks, presence, activity, worktrees) and a
// terminal VIEWER built like a real client (a headless xterm with the full set of
// query swallow-handlers, pty-packaging.md §6.2) that follows session.attach + exec.output + exec.resize.
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import xtermHeadless from '@xterm/headless';
import type { MemberNotification } from '@smurg/protocol';
import type { Connection } from '@smurg/protocol/client';
import type { FeatureModule } from '../../src/core/context.ts';
import type {
  ActivityFeed,
  HookServer,
  HookSessionCredentials,
  HookSessionRegistration,
  LockManager,
  PresenceService,
  SessionLaunchFiles,
  WorktreeHandle,
  WorktreeManager,
  LaunchProfile,
} from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import type { DaemonContext } from '../../src/core/context.ts';
import { removeSessionFiles, writeSessionFiles } from '../../src/hooks/settings-writer.ts';

const { Terminal } = xtermHeadless;
type HeadlessTerminal = InstanceType<typeof Terminal>;

// ---------------------------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------------------------

export class FakeHooks implements HookServer {
  readonly socketPath = '/tmp/smurg-fake.hook';
  readonly registered = new Map<string, HookSessionRegistration>();
  readonly unregistered: string[] = [];
  /** The launch profile of each process start, newest last. */
  readonly profiles: { sessionId: string; profile: LaunchProfile }[] = [];
  readonly reassigned: { sessionId: string; ownerUserId: string }[] = [];
  /** Set by fakeServicesModule: the launch files are written by the hooks module's real writer into this daemon. */
  ctx: DaemonContext | null = null;

  registerSession(session: HookSessionRegistration): HookSessionCredentials {
    const token = `tok_${randomBytes(12).toString('hex')}`;
    this.registered.set(session.sessionId, session);
    return { token, env: { SMURG_HOOK_SOCKET: this.socketPath, SMURG_SESSION_TOKEN: token, SMURG_SESSION_ID: session.sessionId } };
  }

  unregisterSession(sessionId: string): void {
    this.unregistered.push(sessionId);
    this.registered.delete(sessionId);
    if (this.ctx) void removeSessionFiles(this.ctx.config.stateDir, this.ctx.config.workspaceId, sessionId);
  }

  reassignSession(sessionId: string, ownerUserId: string): void {
    this.reassigned.push({ sessionId, ownerUserId });
    const registration = this.registered.get(sessionId);
    if (registration) this.registered.set(sessionId, { ...registration, ownerUserId });
  }

  /** The hooks module's own writer (settings-writer.ts), fed what HookServerImpl feeds it: one source of truth. */
  async writeSessionFiles(sessionId: string, launch: LaunchProfile): Promise<SessionLaunchFiles> {
    const ctx = this.ctx;
    const registration = this.registered.get(sessionId);
    if (!ctx || !registration) throw new Error(`FakeHooks: session ${sessionId} is not registered`);
    const command = ctx.config.sessions.selfCommand;
    if (command === null) throw new Error('FakeHooks: no selfCommand');
    if (!ctx.roots.get(registration.root)) throw new Error('FakeHooks: unknown root');
    this.profiles.push({ sessionId, profile: launch });
    return writeSessionFiles({ stateDir: ctx.config.stateDir, workspaceId: ctx.config.workspaceId, sessionId, settings: { command, profile: launch }, rolePrompt: launch.rolePrompt });
  }

  async removeSessionFiles(sessionId: string): Promise<void> {
    if (this.ctx) await removeSessionFiles(this.ctx.config.stateDir, this.ctx.config.workspaceId, sessionId);
  }
}

export class FakeLocks {
  readonly released: { sessionId: string; reason: string }[] = [];

  releaseAllForSession(sessionId: string, reason: string): void {
    this.released.push({ sessionId, reason });
  }
}

export class FakePresence {
  readonly agents = new Map<string, unknown>();
  readonly removed: string[] = [];

  snapshot(): never {
    throw new Error('not in this fake');
  }

  update(): void {}

  setAgent(agent: { sessionId: string }): void {
    this.agents.set(agent.sessionId, agent);
  }

  removeAgent(sessionId: string): void {
    this.removed.push(sessionId);
    this.agents.delete(sessionId);
  }
}

export class FakeActivity {
  readonly notifications: ({ userId: string } & Pick<MemberNotification, 'text' | 'msg' | 'fallback'>)[] = [];

  notify(userId: string, notification: Pick<MemberNotification, 'text' | 'msg' | 'fallback'>): void {
    const { text, msg, fallback } = notification;
    this.notifications.push({ userId, ...(text !== undefined ? { text } : {}), ...(msg !== undefined ? { msg } : {}), ...(fallback !== undefined ? { fallback } : {}) });
  }
}

/** Worktrees as plain directories registered with the real RootRegistry (enough for the session side of R9). */
export class FakeWorktrees {
  ctx: DaemonContext | null = null;
  readonly acquired: { sessionId: string; worktreeId: string }[] = [];
  readonly released: { worktreeId: string; sessionId: string; keep: boolean }[] = [];

  async acquireForSession(input: { readonly owner: { userId: string | null }; readonly sessionId: string; readonly worktreeId?: string }): Promise<WorktreeHandle> {
    const ctx = this.ctx as DaemonContext;
    const worktreeId = input.worktreeId ?? `wt_${randomBytes(8).toString('hex')}`;
    const dir = join(ctx.roots.main.realPath, '.smurg', 'worktrees', worktreeId);
    await mkdir(dir, { recursive: true });
    const root = ctx.roots.get({ kind: 'worktree', worktreeId }) ?? (await ctx.roots.registerWorktree({ worktreeId, dir, ownerUserId: input.owner.userId as string, sharedLinks: [] }));
    this.acquired.push({ sessionId: input.sessionId, worktreeId });
    const now = Date.now();
    return {
      root,
      worktree: { id: worktreeId, ownerUserId: input.owner.userId as string, ownerName: 'x', branch: `smurg/x/${worktreeId}`, sessionId: input.sessionId, kept: false, createdAt: now, sharedDirs: [] },
    };
  }

  async releaseFromSession(worktreeId: string, sessionId: string, options: { readonly keep: boolean }): Promise<void> {
    this.released.push({ worktreeId, sessionId, keep: options.keep });
  }

  get(worktreeId: string): { branch: string } | null {
    return this.acquired.some((entry) => entry.worktreeId === worktreeId) ? { branch: `smurg/x/${worktreeId}` } : null;
  }

  readonly owners: { worktreeId: string; ownerUserId: string | null }[] = [];
  async setOwner(worktreeId: string, owner: { userId: string | null }): Promise<void> {
    this.owners.push({ worktreeId, ownerUserId: owner.userId });
  }
}

export interface Fakes {
  readonly hooks: FakeHooks;
  readonly locks: FakeLocks;
  readonly presence: FakePresence;
  readonly activity: FakeActivity;
  readonly worktrees: FakeWorktrees;
}

export function createFakes(): Fakes {
  return { hooks: new FakeHooks(), locks: new FakeLocks(), presence: new FakePresence(), activity: new FakeActivity(), worktrees: new FakeWorktrees() };
}

/** Provides the fakes as services (a module like any other). */
export function fakeServicesModule(fakes: Fakes): FeatureModule {
  return {
    name: 'session-test-fakes',
    create: (ctx) => {
      fakes.worktrees.ctx = ctx;
      fakes.hooks.ctx = ctx;
      return {
        hooks: fakes.hooks,
        locks: fakes.locks as unknown as LockManager,
        presence: fakes.presence as unknown as PresenceService,
        activity: fakes.activity as unknown as ActivityFeed,
        worktrees: fakes.worktrees as unknown as WorktreeManager,
      };
    },
    register: () => toDisposable(() => {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------------------------------------------

type OutputEvent = { kind: 'output'; offset: number; data: Uint8Array } | { kind: 'resize'; cols: number; rows: number };

/** A client-side terminal following one session over one Connection, like the web app / `smurg attach` would. */
export class TestViewer {
  readonly term: HeadlessTerminal;
  lastOffset = 0;
  readonly gaps: { expected: number; got: number }[] = [];
  private pending: OutputEvent[] | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly decoder = new TextDecoder();
  /** Everything received (for "never contains X" checks). */
  received = '';

  private readonly conn: Connection;
  private readonly sessionId: string;

  constructor(conn: Connection, sessionId: string) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.term = new Terminal({ cols: 80, rows: 24, scrollback: 10_000, allowProposedApi: true });
    const parser = this.term.parser;
    const swallow = (): boolean => true;
    for (const prefix of [undefined, '>', '=']) parser.registerCsiHandler({ ...(prefix ? { prefix } : {}), final: 'c' }, swallow);
    for (const prefix of [undefined, '?']) parser.registerCsiHandler({ ...(prefix ? { prefix } : {}), final: 'n' }, swallow);
    for (const prefix of [undefined, '?']) parser.registerCsiHandler({ ...(prefix ? { prefix } : {}), intermediates: '$', final: 'p' }, swallow);
    parser.registerCsiHandler({ final: 't' }, (params) => [11, 13, 14, 15, 16, 18, 19, 20, 21].includes(params[0] as number));
    parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow);
    for (const id of [4, 10, 11, 12]) parser.registerOscHandler(id, (data) => data.split(';').includes('?'));
    this.unsubscribe.push(
      conn.on('exec.output', (payload) => {
        if (payload.sessionId !== this.sessionId) return;
        this.handle({ kind: 'output', offset: payload.offset, data: payload.data });
      }),
      conn.on('exec.resize', (payload) => {
        if (payload.sessionId !== this.sessionId) return;
        this.handle({ kind: 'resize', cols: payload.cols, rows: payload.rows });
      }),
    );
  }

  private handle(event: OutputEvent): void {
    if (this.pending) {
      this.pending.push(event);
      return;
    }
    this.apply(event);
  }

  private apply(event: OutputEvent): void {
    if (event.kind === 'resize') {
      this.term.write('', () => this.term.resize(event.cols, event.rows));
      return;
    }
    let data = event.data;
    let offset = event.offset;
    if (offset < this.lastOffset) {
      // overlap (already have it): keep only the new part
      const skip = this.lastOffset - offset;
      if (skip >= data.length) return;
      data = data.subarray(skip);
      offset = this.lastOffset;
    }
    if (offset > this.lastOffset) this.gaps.push({ expected: this.lastOffset, got: offset });
    this.term.write(data);
    this.received += this.decoder.decode(data, { stream: true });
    this.lastOffset = offset + data.length;
  }

  async attach(options: { readonly cols?: number; readonly rows?: number; readonly haveOffset?: number } = {}): Promise<{ mode: string; nextOffset: number }> {
    this.pending = [];
    try {
      const result = await this.conn.request('session.attach', {
        sessionId: this.sessionId,
        ...(options.cols !== undefined && options.rows !== undefined ? { cols: options.cols, rows: options.rows } : {}),
        ...(options.haveOffset !== undefined ? { haveOffset: options.haveOffset } : {}),
      });
      if (result.mode === 'snapshot') {
        this.term.write('', () => {
          this.term.reset();
          this.term.resize(result.cols, result.rows);
        });
        this.term.write(result.data);
      } else {
        this.term.write('', () => this.term.resize(result.cols, result.rows));
        this.term.write(result.data);
      }
      this.received += this.decoder.decode(result.data, { stream: true });
      this.lastOffset = result.nextOffset;
      const queued = this.pending;
      this.pending = null;
      for (const event of queued) this.apply(event);
      return { mode: result.mode, nextOffset: result.nextOffset };
    } catch (err) {
      const queued = this.pending ?? [];
      this.pending = null;
      for (const event of queued) this.apply(event);
      throw err;
    }
  }

  drained(): Promise<void> {
    return new Promise((resolve) => this.term.write('', () => resolve()));
  }

  /** Every line of the active buffer (scrollback + viewport), right-trimmed. */
  lines(): string[] {
    const buffer = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '');
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }

  /** The visible screen, right-trimmed. */
  viewport(): string[] {
    const buffer = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < this.term.rows; i++) out.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '');
    return out;
  }

  state(): { type: string; cols: number; rows: number; cursorX: number; cursorY: number } {
    const buffer = this.term.buffer.active;
    return { type: buffer.type, cols: this.term.cols, rows: this.term.rows, cursorX: buffer.cursorX, cursorY: buffer.cursorY };
  }

  text(): string {
    return this.lines().join('\n');
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.term.dispose();
  }
}

export function typeInto(conn: Connection, sessionId: string, text: string): boolean {
  return conn.notify('exec.input', { sessionId, data: new TextEncoder().encode(text) });
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

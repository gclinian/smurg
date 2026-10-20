// Host settings (admin.settings.get / set; ARCHITECTURE §5.8). Persisted in state.json. Beyond the protocol schema,
// shared directories (D12) must be existing, non-host-only directories of the main root: a shared dir is linked
// read-only into every worktree, so sharing `.git` or `.claude` would hand members what §5.2 protects.
//
// Also the host's notices (`state.json`'s `hostNotices`, DESIGN 0.6.0 D13): `agents-auto` is in the host's inbox (an
// attention item that opens the console's settings) until the host has seen it (`admin.notice.seen`) or decided the
// workspace's mode (`admin.settings.set` naming `permissionMode`).
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { SmurgError, hostSettingsPatchSchema, hostSettingsSchema, isHostOnlyPath, type HostNotice, type HostSettings, type HostSettingsPatch, type PublicSettings } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { AttentionFact, AuditLog, EventBus, PersistentDocument, Principal, SettingsService, UserId } from '../core/interfaces.ts';
import type { WorkspaceState } from '../core/workspace-state.ts';
import { isInside } from '../workspace/fs-util.ts';

export interface SettingsDeps {
  readonly state: PersistentDocument<WorkspaceState>;
  readonly audit: AuditLog;
  readonly bus: EventBus;
  /** realpath of the main root. */
  readonly mainRealPath: string;
  /** The host's user id (who the notices are for). */
  readonly hostUserId: () => UserId;
  /** The daemon's OS user id (`ask-nothing` is refused for root). Default: process.getuid(). A seam for tests. */
  readonly uid?: () => number | undefined;
  /** When a notice was first known in this run (an attention item keeps its time). Default: Date.now. */
  readonly now?: () => number;
}

/** What every member sees: the host settings a client works with. */
export function publicSettingsOf(settings: HostSettings): PublicSettings {
  return {
    humanLockIdleMs: settings.humanLockIdleMs,
    agentLockTimeoutMs: settings.agentLockTimeoutMs,
    uploadChunkSize: settings.uploadChunkSize,
    sharedDirs: [...settings.sharedDirs],
    permissionMode: settings.permissionMode,
  };
}

export class SettingsServiceImpl implements SettingsService {
  private readonly deps: SettingsDeps;
  /** When each notice was first seen in this run (the inbox row's time). */
  private readonly noticeSince = new Map<HostNotice, number>();

  constructor(deps: SettingsDeps) {
    this.deps = deps;
  }

  private uid(): number | undefined {
    return this.deps.uid !== undefined ? this.deps.uid() : typeof process.getuid === 'function' ? process.getuid() : undefined;
  }

  get(): HostSettings {
    return this.deps.state.get().settings;
  }

  public(): PublicSettings {
    return publicSettingsOf(this.get());
  }

  async update(patch: HostSettingsPatch, by: Principal): Promise<HostSettings> {
    if (by.kind !== 'system' && by.role !== 'host') throw new SmurgError('forbidden');
    const parsedPatch = hostSettingsPatchSchema.safeParse(patch);
    if (!parsedPatch.success) throw new SmurgError('bad_request', msg('settings.invalid'), { reason: 'invalid-settings' });
    const previous = this.get();
    const merged = hostSettingsSchema.safeParse({ ...previous, ...parsedPatch.data });
    if (!merged.success) throw new SmurgError('bad_request', msg('settings.invalid'), { reason: 'invalid-settings' });
    const next = merged.data;
    for (const dir of next.sharedDirs) await this.checkSharedDir(dir);
    // DESIGN 0.6.0 D8: Claude Code refuses to run without asking as root, so smurg never lets the host choose it then.
    if (parsedPatch.data.permissionMode === 'ask-nothing' && this.uid() === 0) throw new SmurgError('forbidden', msg('settings.asksNothing.root'), { reason: 'root' });
    // Naming the mode settles the update's notice: the host decided (DESIGN 0.6.0 D13).
    const settles = parsedPatch.data.permissionMode !== undefined && this.notices().includes('agents-auto');
    this.deps.state.update((draft) => {
      draft.settings = next;
      if (settles) draft.hostNotices = draft.hostNotices.filter((notice) => notice !== 'agents-auto');
    });
    if (settles) this.deps.bus.emit('attention.changed', { source: 'settings' });
    // The new settings are in force from here on, saved or not: tell every module (a failed write is re-tried by the
    // store) and the host, instead of applying them silently.
    const saved = await this.deps.state.flush().then(
      () => true,
      () => false,
    );
    const changed = Object.keys(parsedPatch.data).filter(
      (key) => JSON.stringify(previous[key as keyof HostSettings]) !== JSON.stringify(next[key as keyof HostSettings]),
    );
    this.deps.audit.record({ actor: by.actor, action: 'settings.change', outcome: 'ok', target: 'settings', detail: { changed, ...(saved ? {} : { saved: false }) } });
    if (changed.length > 0) this.deps.bus.emit('settings.changed', { settings: next, previous, by: by.actor });
    if (!saved) {
      throw new SmurgError('internal', msg('admin.appliedNotSaved', { change: 'settings' }), {
        reason: 'state-not-saved',
        applied: true,
      });
    }
    return next;
  }

  notices(): readonly HostNotice[] {
    return [...this.deps.state.get().hostNotices];
  }

  async seeNotice(notice: HostNotice, by: Principal): Promise<void> {
    if (by.kind !== 'system' && by.role !== 'host') throw new SmurgError('forbidden');
    if (!this.notices().includes(notice)) return;
    this.deps.state.update((draft) => {
      draft.hostNotices = draft.hostNotices.filter((entry) => entry !== notice);
    });
    this.deps.bus.emit('attention.changed', { source: 'settings' });
    const saved = await this.deps.state.flush().then(
      () => true,
      () => false,
    );
    if (!saved) throw new SmurgError('internal', msg('admin.appliedNotSaved', { change: 'settings' }), { reason: 'state-not-saved', applied: true });
  }

  attention(): AttentionFact[] {
    const out: AttentionFact[] = [];
    for (const notice of this.notices()) {
      if (notice !== 'agents-auto') continue;
      let at = this.noticeSince.get(notice);
      if (at === undefined) {
        at = (this.deps.now ?? Date.now)();
        this.noticeSince.set(notice, at);
      }
      out.push({ subject: 'agents-auto', id: 'workspace', at, recipients: [this.deps.hostUserId()], target: { kind: 'console', section: 'settings' }, excerpt: '' });
    }
    return out;
  }

  private async checkSharedDir(dir: string): Promise<void> {
    const refuse = (reason: string): never => {
      throw new SmurgError('bad_request', msg('settings.sharedDirInvalid'), { reason, path: dir });
    };
    if (isHostOnlyPath(dir) || dir.toLowerCase().split('/')[0] === '.smurg') refuse('host-only');
    const abs = join(this.deps.mainRealPath, dir);
    const real = await realpath(abs).catch(() => null);
    if (real === null) refuse('missing');
    if (real !== abs || !isInside(real as string, this.deps.mainRealPath)) refuse('symlink');
    if (!(await lstat(real as string)).isDirectory()) refuse('not-directory');
  }
}

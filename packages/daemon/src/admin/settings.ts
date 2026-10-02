// Host settings (admin.settings.get / set; ARCHITECTURE §5.8). Persisted in state.json. Beyond the protocol schema,
// shared directories (D12) must be existing, non-host-only directories of the main root: a shared dir is linked
// read-only into every worktree, so sharing `.git` or `.claude` would hand members what §5.2 protects.
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { SmurgError, hostSettingsPatchSchema, hostSettingsSchema, isHostOnlyPath, type HostSettings, type HostSettingsPatch, type PublicSettings } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { AuditLog, EventBus, PersistentDocument, Principal, SettingsService } from '../core/interfaces.ts';
import type { WorkspaceState } from '../core/workspace-state.ts';
import { isInside } from '../workspace/fs-util.ts';

export interface SettingsDeps {
  readonly state: PersistentDocument<WorkspaceState>;
  readonly audit: AuditLog;
  readonly bus: EventBus;
  /** realpath of the main root. */
  readonly mainRealPath: string;
}

/** What every member sees: the host settings a client works with. */
export function publicSettingsOf(settings: HostSettings): PublicSettings {
  return {
    humanLockIdleMs: settings.humanLockIdleMs,
    agentLockTimeoutMs: settings.agentLockTimeoutMs,
    uploadChunkSize: settings.uploadChunkSize,
    sharedDirs: [...settings.sharedDirs],
  };
}

export class SettingsServiceImpl implements SettingsService {
  private readonly deps: SettingsDeps;

  constructor(deps: SettingsDeps) {
    this.deps = deps;
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
    this.deps.state.update((draft) => {
      draft.settings = next;
    });
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

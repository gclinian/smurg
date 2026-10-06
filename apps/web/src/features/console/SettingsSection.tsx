// Host settings (admin.settings.get / set): shared read-only folders for worktrees (D12), lock timings (R8), the disk
// reserve (R7) and the three agent settings of v0.5.0 (how many work items run at once, how long a question waits
// before others are asked, and whether agents may use the host's own MCP servers: DESIGN §2.11, §3.9, §3.12).
// Validated as the host types (settings-form.ts), applied at once by the daemon, and live: the form
// follows the current settings while it has no unsaved edits, and re-reads them when they change elsewhere (another
// device of the host: channel.settingsUpdated).
import { useEffect, useId, useRef, useState } from 'react';
import { ESCALATE_AFTER_MS_DEFAULT, MAX_LIVE_AGENTS_RANGE, REPORT_ESCALATION_FACTOR, type HostSettings } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { selectSettings } from '../../lib/stores/workspace.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, Input, Spinner, TextArea, useToast } from '../../ui/index.ts';
import { draftFromSettings, errorCount, hasChanges, parseSettingsDraft, type SettingsDraft, type SettingsField } from './settings-form.ts';
import { t } from './strings.ts';

export function SettingsSection() {
  const stores = useStores();
  const settings = useStore(stores.admin, (state) => state.settings);
  if (!settings) {
    return (
      <p className="console-loading">
        <Spinner size={14} decorative /> {t('settings.loading')}
      </p>
    );
  }
  return <SettingsForm settings={settings} />;
}

/** Re-reads the host settings when the daemon announces a change this page did not make. */
function useExternalSettingsChanges(saving: { readonly current: boolean }): void {
  const stores = useStores();
  const publicSettings = useStore(stores.workspace, selectSettings);
  // Every channel.settingsUpdated installs a new object (host-only fields such as allowedDomains are not in it, so its
  // identity is the signal, not its values).
  const seen = useRef(publicSettings);
  useEffect(() => {
    if (seen.current === publicSettings) return;
    seen.current = publicSettings;
    if (saving.current) return;
    stores.admin.reload().catch(() => {
      // The admin store keeps the failure in its own `error`; the page shows it.
    });
  }, [publicSettings, stores.admin, saving]);
}

function SettingsForm({ settings }: { settings: HostSettings }) {
  const stores = useStores();
  const toast = useToast();
  // null: no unsaved edits, the form shows the current settings.
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const mcpHint = useId();
  useExternalSettingsChanges(saving);

  const shown = draft ?? draftFromSettings(settings);
  const parsed = parseSettingsDraft(shown, settings);
  const invalid = errorCount(parsed);
  const changed = hasChanges(parsed);

  const edit = (field: SettingsField, value: string): void => {
    setError(null);
    setDraft({ ...shown, [field]: value });
  };
  const setAgentMcp = (on: boolean): void => {
    setError(null);
    setDraft({ ...shown, agentMcp: on });
  };

  const save = async (): Promise<void> => {
    if (invalid > 0 || !changed) return;
    setBusy(true);
    setError(null);
    saving.current = true;
    try {
      await stores.admin.setSettings(parsed.patch);
      setDraft(null);
      toast.show({ tone: 'success', title: t('settings.saved') });
    } catch (failure) {
      setError(t('settings.saveFailed', { message: describeError(failure) }));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <form
      className="console-settings"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="console-hint">{t('settings.lead')}</p>
      <div className="console-settings__grid">
        <TextArea
          label={t('settings.sharedDirs')}
          hint={t('settings.sharedDirsHint')}
          rows={4}
          spellCheck={false}
          value={shown.sharedDirs}
          error={parsed.errors.sharedDirs}
          onChange={(event) => edit('sharedDirs', event.currentTarget.value)}
        />
        <Input
          label={t('settings.humanLockIdle')}
          hint={t('settings.humanLockIdleHint')}
          inputMode="decimal"
          value={shown.humanLockIdleSec}
          error={parsed.errors.humanLockIdleSec}
          onChange={(event) => edit('humanLockIdleSec', event.currentTarget.value)}
        />
        <Input
          label={t('settings.agentLockTimeout')}
          hint={t('settings.agentLockTimeoutHint')}
          inputMode="decimal"
          value={shown.agentLockTimeoutSec}
          error={parsed.errors.agentLockTimeoutSec}
          onChange={(event) => edit('agentLockTimeoutSec', event.currentTarget.value)}
        />
        <Input
          label={t('settings.diskReserveGb')}
          hint={t('settings.diskHint')}
          inputMode="decimal"
          value={shown.diskReserveGb}
          error={parsed.errors.diskReserveGb}
          onChange={(event) => edit('diskReserveGb', event.currentTarget.value)}
        />
        <Input
          label={t('settings.diskReservePercent')}
          inputMode="decimal"
          value={shown.diskReservePercent}
          error={parsed.errors.diskReservePercent}
          onChange={(event) => edit('diskReservePercent', event.currentTarget.value)}
        />
      </div>
      <h3 className="console-settings__group">{t('settings.agents')}</h3>
      <div className="console-settings__grid">
        <Input
          label={t('settings.maxLiveAgents')}
          hint={t('settings.maxLiveAgentsHint', { min: MAX_LIVE_AGENTS_RANGE.min, max: MAX_LIVE_AGENTS_RANGE.max })}
          inputMode="numeric"
          value={shown.maxLiveAgents}
          error={parsed.errors.maxLiveAgents}
          onChange={(event) => edit('maxLiveAgents', event.currentTarget.value)}
        />
        <Input
          label={t('settings.escalateAfter')}
          hint={t('settings.escalateAfterHint', { factor: REPORT_ESCALATION_FACTOR, minutes: ESCALATE_AFTER_MS_DEFAULT / 60_000 })}
          inputMode="decimal"
          value={shown.escalateAfterMin}
          error={parsed.errors.escalateAfterMin}
          onChange={(event) => edit('escalateAfterMin', event.currentTarget.value)}
        />
        <div className="console-settings__switch">
          <label className="console-check">
            <input type="checkbox" checked={shown.agentMcp} aria-describedby={mcpHint} onChange={(event) => setAgentMcp(event.currentTarget.checked)} />
            <span>{t('settings.agentMcp')}</span>
          </label>
          <p id={mcpHint} className={shown.agentMcp ? 'console-settings__consequence console-settings__consequence--on' : 'console-settings__consequence'}>
            {t('settings.agentMcpHint')}
          </p>
        </div>
      </div>
      {invalid > 0 ? (
        <p className="console-settings__status" role="status">
          {t('settings.invalid', { count: invalid })}
        </p>
      ) : null}
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
      <div className="console-settings__actions">
        <Button variant="ghost" disabled={draft === null || busy} onClick={() => setDraft(null)}>
          {t('settings.reset')}
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={invalid > 0 || !changed}>
          {t('settings.save')}
        </Button>
      </div>
    </form>
  );
}

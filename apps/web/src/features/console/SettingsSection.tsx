// Host settings (admin.settings.get / set): shared read-only folders for worktrees (D12), lock timings (R8), the disk
// reserve (R7) and the three agent settings of v0.5.0 (how many work items run at once, how long a question waits
// before others are asked, and whether agents may use the host's own MCP servers: DESIGN §2.11, §3.9, §3.12).
// Validated as the host types (settings-form.ts), applied at once by the daemon, and live: the form
// follows the current settings while it has no unsaved edits, and re-reads them when they change elsewhere (another
// device of the host: channel.settingsUpdated).
//
// What agents may do without asking (protocol 5, DESIGN 0.6.0 D3, D13, D18): the workspace's permission mode, the
// default of every session and work item. It applies as soon as it is chosen; "Asks for nothing" only after the
// warning's own button, and never while smurg runs as root. Under it: what auto mode costs, what the host's Claude
// Code turned off, and which live sessions run on a model that may bill usage credits. After the 0.6.0 update a banner
// says that agents now run in auto mode, until the host presses "Got it".
//
// How work items reach the shared folder (protocol 6, DESIGN 0.7.0 D3, D18): "Merging work items", smurg merges what
// its report says is complete and verified, or the host merges each item. It applies as soon as it is chosen; after
// the 0.7.0 update a banner says that work items now merge by themselves, until the host presses "Got it".
import { useEffect, useId, useRef, useState } from 'react';
import {
  ESCALATE_AFTER_MS_DEFAULT,
  MAX_LIVE_AGENTS_RANGE,
  MERGE_POLICIES,
  PERMISSION_MODES,
  REPORT_ESCALATION_FACTOR,
  isSessionOver,
  type HostNotice,
  type HostSettings,
  type MergePolicy,
  type PermissionMode,
} from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { formatList } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectAgentHost } from '../../lib/stores/host.ts';
import { selectAgentList, sessionTitle } from '../../lib/stores/sessions.ts';
import { selectSettings } from '../../lib/stores/workspace.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, Dialog, Input, Select, Spinner, TextArea, useToast } from '../../ui/index.ts';
import { tApp } from '../../strings/app.ts';
import { autoCostText, billsUsageCredits, entryOfRunning, modeLabel } from '../agents/agent-choice.ts';
import { draftFromSettings, errorCount, hasChanges, parseSettingsDraft, type SettingsDraft, type SettingsField } from './settings-form.ts';
import { t } from './strings.ts';

/** Live sessions named one by one in the credits line; the rest are counted. */
export const CREDITS_SESSIONS_SHOWN = 5;

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
  return (
    <>
      <NoticeBanner notice="agents-auto" text={t('settings.agentsAuto.banner')} />
      <NoticeBanner notice="auto-merge" text={t('settings.mergesAuto.banner')} />
      <SettingsForm settings={settings} />
    </>
  );
}

/**
 * "Since smurg 0.6.0, agents run in auto mode…" (`agents-auto`) and "Since smurg 0.7.0, work items merge by
 * themselves…" (`auto-merge`): each while the host's inbox holds that notice, until "Got it".
 */
function NoticeBanner({ notice, text }: { notice: HostNotice; text: string }) {
  const stores = useStores();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const shown = useStore(stores.inbox, (state) => [...state.items.values()].some((item) => item.kind === 'attention' && item.subject === notice));
  if (!shown) return null;
  const dismiss = (): void => {
    setBusy(true);
    stores.admin
      .seeNotice(notice)
      .catch((error: unknown) => toast.show({ tone: 'danger', title: t('settings.saveFailed', { message: describeError(error) }) }))
      .finally(() => setBusy(false));
  };
  return (
    <Banner
      tone="info"
      live="none"
      className="console-settings__notice"
      actions={
        <Button size="sm" loading={busy} onClick={dismiss}>
          {t('settings.agentsAuto.dismiss')}
        </Button>
      }
    >
      {text}
    </Banner>
  );
}

/** "Merging work items": applies when chosen (turning it off gives every started item to the host at once). */
function Merging({ settings }: { settings: HostSettings }) {
  const stores = useStores();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = (next: MergePolicy): void => {
    if (next === settings.merging) return;
    setBusy(true);
    setError(null);
    stores.admin
      .setSettings({ merging: next })
      .then(
        () => toast.show({ tone: 'success', title: t('settings.saved') }),
        (failure: unknown) => setError(t('settings.saveFailed', { message: describeError(failure) })),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="console-settings__mode">
      <Select<MergePolicy>
        label={t('settings.merging')}
        hint={t('settings.mergingHint')}
        value={settings.merging}
        disabled={busy}
        options={MERGE_POLICIES.map((value) => ({ value, label: t(`settings.merging.${value}`) }))}
        onChange={choose}
      />
      {error !== null ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
    </div>
  );
}

/** The live agent sessions that run on a model whose list entry may bill usage credits (by what the agent reported). */
function useCreditsSessions(): string[] {
  const stores = useStores();
  const agent = useStore(stores.host, selectAgentHost);
  const titles = useStore(stores.sessions, (state) =>
    selectAgentList(state)
      .filter((session) => {
        if (isSessionOver(session)) return false;
        const running = session.modelInUse === undefined ? undefined : entryOfRunning(agent, session.modelInUse);
        return running !== undefined ? running.billing === 'usage-credits' : billsUsageCredits(agent, session.model);
      })
      .map((session) => sessionTitle(session))
      .join('\n'),
  );
  return titles === '' ? [] : titles.split('\n');
}

/** The workspace's permission mode: applies when chosen, "Asks for nothing" behind its warning. */
function AgentMode({ settings }: { settings: HostSettings }) {
  const stores = useStores();
  const toast = useToast();
  const agent = useStore(stores.host, selectAgentHost);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const credits = useCreditsSessions();
  const root = agent?.asksNothing === 'root';
  const mode = settings.permissionMode;

  const apply = async (next: PermissionMode): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await stores.admin.setSettings({ permissionMode: next });
      setConfirming(false);
      toast.show({ tone: 'success', title: t('settings.saved') });
    } catch (failure) {
      setError(t('settings.saveFailed', { message: describeError(failure) }));
    } finally {
      setBusy(false);
    }
  };
  const choose = (next: PermissionMode): void => {
    if (next === mode) return;
    if (next === 'ask-nothing') setConfirming(true);
    else void apply(next);
  };

  const shownNames = credits.slice(0, CREDITS_SESSIONS_SHOWN);
  const more = credits.length - shownNames.length;
  const names = formatList(more > 0 ? [...shownNames, t('settings.creditsSessions.more', { count: more })] : shownNames);
  return (
    <div className="console-settings__mode">
      <Select<PermissionMode>
        label={t('settings.permissionMode')}
        hint={t('settings.permissionModeHint')}
        value={mode}
        disabled={busy}
        options={PERMISSION_MODES.map((value) => ({ value, label: modeLabel(value), disabled: value === 'ask-nothing' && root && mode !== 'ask-nothing' }))}
        onChange={choose}
      />
      {mode === 'auto' ? <p className="console-hint">{autoCostText(true)}</p> : null}
      {root ? <p className="console-hint">{t('settings.askNothingRoot')}</p> : null}
      {agent?.autoMode === 'off' ? (
        <Banner tone="warning" live="none">
          {t('settings.autoOff')}
        </Banner>
      ) : null}
      {agent?.asksNothing === 'off' ? (
        <Banner tone="warning" live="none">
          {t('settings.askNothingOff')}
        </Banner>
      ) : null}
      {credits.length > 0 ? <p className="console-hint">{t('settings.creditsSessions', { count: credits.length, names })}</p> : null}
      {error !== null ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        role="alertdialog"
        size="md"
        title={t('settings.askNothing.confirm.title')}
        description={t('settings.askNothing.confirm.body')}
        footer={
          <>
            <Button onClick={() => setConfirming(false)} disabled={busy}>
              {tApp('common.cancel')}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void apply('ask-nothing')}>
              {t('settings.askNothing.confirm.go')}
            </Button>
          </>
        }
      />
    </div>
  );
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
      <AgentMode settings={settings} />
      <Merging settings={settings} />
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

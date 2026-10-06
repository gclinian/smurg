// The strip under a conversation column's header (UX §4, DESIGN §5.12 item 10): who is responsible, where the agent
// works, what it may do without asking, and Stop. "End session" and "Rename" are in the column's "More actions"
// (ConversationColumn.tsx). The host and members with agent access change things; everyone else reads them.
import { useEffect, useState } from 'react';
import { PERMISSION_MODES, mayBeResponsible, ruleString, type AgentSession, type PermissionMode, type RememberedRule, type ResultOf } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { formatRole } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectAgentList } from '../../lib/stores/sessions.ts';
import { useCapabilities, useCommands, useStores } from '../../lib/workspace/context.tsx';
import { Avatar, Banner, Button, Chip, Dialog, IconButton, Menu, Spinner, type MenuItem } from '../../ui/index.ts';
import { IconFolder, IconGitBranch, IconLock, IconShield, IconStop, IconTrash, IconUsers } from '../../ui/icons.tsx';
import { modeLabel } from './cards.ts';
import { useAction, useConversationEnv } from './env.tsx';
import { useHostDialogs } from './host-dialogs.ts';
import { personOf } from './people.ts';
import { t } from './strings.ts';

type Rules = ResultOf<'session.rules.get'>;

function ModeDialog({ session, onClose }: { session: AgentSession; onClose(): void }) {
  const stores = useStores();
  const hostDialogs = useHostDialogs();
  const caps = useCapabilities();
  const [rules, setRules] = useState<Rules | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showHost, setShowHost] = useState(false);
  const action = useAction();
  const sessionId = session.id;
  // Read again whenever the session says its rules changed (someone allowed a kind, a rule was removed).
  const ruleCount = session.ruleCount;
  useEffect(() => {
    let current = true;
    stores.sessions.rules(sessionId).then(
      (result) => {
        if (current) {
          setRules(result);
          setLoadError(null);
        }
      },
      (error: unknown) => {
        if (current) setLoadError(describeError(error));
      },
    );
    return () => {
      current = false;
    };
  }, [stores, sessionId, ruleCount]);

  const canChange = caps.canDrive && !session.modeFixed && session.status !== 'ended';
  const remove = (rule: RememberedRule): void => {
    void action
      .run(() => (rule.scope === 'topic' && session.topicId !== undefined ? stores.topics.removeRule(session.topicId, rule.id) : stores.sessions.removeRule(sessionId, rule.id)))
      .then((ok) => {
        if (ok) setRules((previous) => (previous === null ? previous : { ...previous, rules: previous.rules.filter((one) => one.id !== rule.id) }));
      });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('mode.dialog')}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('mode.close')}
        </Button>
      }
    >
      <div className="conv-mode">
        {session.modeFixed ? (
          <p>{t('mode.fixedTitle')}</p>
        ) : (
          <fieldset className="conv-mode__choice" disabled={!canChange || action.busy}>
            <legend>{t('mode.choice')}</legend>
            {PERMISSION_MODES.map((mode: PermissionMode) => (
              <label key={mode}>
                <input type="radio" name="conv-mode" checked={session.permissionMode === mode} onChange={() => void action.run(() => stores.sessions.setMode(sessionId, mode))} /> {modeLabel(mode)}
              </label>
            ))}
            {!caps.canDrive ? <p className="conv-card__who">{t('mode.onlyDrive')}</p> : null}
          </fieldset>
        )}
        <h3 className="conv-mode__heading">{t('mode.rules')}</h3>
        {rules === null && loadError === null ? <Spinner label={t('mode.rules.loading')} /> : null}
        {loadError !== null ? <Banner tone="warning">{t('mode.rules.failed', { message: loadError })}</Banner> : null}
        {rules !== null && rules.rules.length === 0 ? <p className="conv-card__who">{t('mode.rules.none')}</p> : null}
        {rules !== null && rules.rules.length > 0 ? (
          <ul className="conv-mode__rules">
            {rules.rules.map((rule) => (
              <li key={rule.id}>
                <code className="conv-mono">{ruleString(rule)}</code>
                <span className="conv-card__who">{t('mode.rules.entry', { scope: t(rule.scope === 'topic' ? 'mode.rules.topic' : 'mode.rules.session'), name: rule.addedBy.displayName })}</span>
                {caps.canDrive ? <IconButton size="sm" label={t('mode.rules.remove', { rule: ruleString(rule) })} icon={<IconTrash />} disabled={action.busy} onClick={() => remove(rule)} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {rules !== null && rules.host.state === 'applied' ? (
          <p className="conv-card__who">
            {t('mode.host', { count: rules.host.rules?.length ?? 0 })}{' '}
            {caps.isHost ? (
              // The host reads them in the console's own dialog (which also marks them as seen).
              <button type="button" className="conv-link" onClick={() => hostDialogs.hostRules()}>
                {t('mode.host.show')}
              </button>
            ) : rules.host.rules !== undefined && rules.host.rules.length > 0 && !showHost ? (
              <button type="button" className="conv-link" onClick={() => setShowHost(true)}>
                {t('mode.host.show')}
              </button>
            ) : null}
          </p>
        ) : null}
        {showHost && rules?.host.rules !== undefined ? (
          <ul className="conv-mode__rules">
            {rules.host.rules.map((rule) => (
              <li key={rule}>
                <code className="conv-mono">{rule}</code>
              </li>
            ))}
          </ul>
        ) : null}
        {action.error !== null ? <Banner tone="danger">{t('actionFailed', { message: action.error })}</Banner> : null}
      </div>
    </Dialog>
  );
}

export function HeaderStrip({ session }: { session: AgentSession }) {
  const stores = useStores();
  const caps = useCapabilities();
  const commands = useCommands();
  const { self, people } = useConversationEnv();
  const sessionId = session.id;
  const branch = useStore(stores.worktrees, (state) => (session.root.kind === 'worktree' ? state.worktrees.get(session.root.worktreeId)?.branch : undefined)) ?? session.branch;
  // How many sessions each member is responsible for (the menu says it).
  const load = useStore(
    stores.sessions,
    (state) => {
      const counts: Record<string, number> = {};
      for (const one of selectAgentList(state)) if (one.responsible !== null && one.status !== 'ended') counts[one.responsible.userId] = (counts[one.responsible.userId] ?? 0) + 1;
      return JSON.stringify(counts);
    },
  );
  const [modeOpen, setModeOpen] = useState(false);
  const action = useAction();
  // Stop never waits for another request of the strip.
  const stop = useAction();
  const ended = session.status === 'ended';

  const responsible = session.responsible;
  const who = responsible === null ? t('responsible.nobody') : t('responsible.is', { name: responsible.userId === self?.userId ? t('person.you', { name: responsible.displayName }) : responsible.displayName });
  const whoLead = responsible === null ? <IconUsers size={14} /> : <Avatar name={responsible.displayName} color={personOf(people, responsible.userId)?.color} size="xs" decorative />;

  let whoChip;
  if (caps.canDrive && !ended) {
    const counts = JSON.parse(load) as Record<string, number>;
    const items: MenuItem[] = [
      ...people
        .filter((person) => mayBeResponsible(person.role))
        .map((person) => {
          const count = counts[person.userId] ?? 0;
          const labelVars = { name: person.displayName, role: formatRole(person.role) };
          return {
            id: person.userId,
            label: count > 0 ? t('responsible.optionBusy', { ...labelVars, count }) : t('responsible.option', labelVars),
            checked: responsible?.userId === person.userId,
            onSelect: () => void action.run(() => stores.sessions.setResponsible(sessionId, person.userId)),
          };
        }),
      { id: '', label: t('responsible.none'), checked: responsible === null, onSelect: () => void action.run(() => stores.sessions.setResponsible(sessionId, null)) },
    ];
    whoChip = <Menu label={t('responsible.menu')} text={who} icon={whoLead} items={items} size="sm" align="start" className="conv-strip__who" />;
  } else {
    whoChip = (
      <Chip lead={whoLead} title={who} className="conv-strip__who">
        {who}
      </Chip>
    );
  }

  const openRoot = (): void => {
    void commands.dispatch('openInCodeMode', { root: session.root, sessionId }).catch(() => {});
  };
  const whereChip =
    session.root.kind === 'main' ? (
      <Chip lead={<IconFolder size={14} />} collapsible title={t('where.mainTitle')} onClick={openRoot}>
        {t('where.main')}
      </Chip>
    ) : (
      <Chip lead={<IconGitBranch size={14} />} collapsible title={t('where.worktree', { branch: branch ?? t('where.unknown') })} onClick={openRoot}>
        {branch ?? t('where.unknown')}
      </Chip>
    );

  const mode = session.modeFixed ? t('mode.fixed') : modeLabel(session.permissionMode);
  const modeChip = (
    <Chip lead={session.modeFixed ? <IconLock size={14} /> : <IconShield size={14} />} collapsible title={session.modeFixed ? t('mode.fixedTitle') : t('mode.title', { mode })} onClick={() => setModeOpen(true)}>
      {mode}
    </Chip>
  );

  const working = session.status === 'running' || session.status === 'starting' || session.status === 'waiting-answer' || session.status === 'waiting-permission';
  return (
    <div className="col-meta conv-strip" role="group" aria-label={t('strip.label')}>
      <div className="col-meta__chips">
        {whoChip}
        {whereChip}
        {modeChip}
      </div>
      <div className="col-meta__actions">
        {(action.error ?? stop.error) !== null ? (
          <span className="conv-card__problem" role="alert">
            {t('actionFailed', { message: action.error ?? stop.error ?? '' })}
          </span>
        ) : null}
        {working && caps.canDrive ? (
          <Button size="sm" icon={<IconStop />} title={t('stop.title')} loading={stop.busy} onClick={() => void stop.run(() => stores.sessions.interrupt(sessionId))}>
            {t('stop')}
          </Button>
        ) : null}
      </div>
      {modeOpen ? <ModeDialog session={session} onClose={() => setModeOpen(false)} /> : null}
    </div>
  );
}

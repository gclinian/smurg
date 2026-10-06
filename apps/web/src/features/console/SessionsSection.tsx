// Every session of the workspace (SPEC R11 "every session", "terminate any session with one click"; DESIGN §5.7):
// its name, the topic it belongs to, what it is for (a topic's discussion, a work item, a session without a topic, a
// plain terminal), its status in the words the session list uses, who is responsible, who opened it and where it
// runs. "Terminate" sends admin.session.terminate: at once for a terminal and for a session without a topic (one
// click, as SPEC R11 asks); for a topic's session after a confirmation that says what stops with it (a discussion
// that is terminated is lost until someone restarts it, §3.9).
//
// Above the table: the state of the host's Claude account (`session.host`: ONE state per workspace, §2.7) and the
// disk space of the conversations, which is what the host's `account` and `storage` inbox items open; and the ONE
// notice the daemon sends the host when Claude Code reports a personal subscription login while other members are
// present (OWNER-DECISIONS Q6; `notice.personalSubscription` through activity.notify): it arrives as a toast, and
// stays here in the daemon's own words until the host says "Got it".
import { useState } from 'react';
import { isSessionOver, type AgentSession, type SessionInfo } from '@smurg/protocol';
import { describeError, renderWireText } from '../../lib/errors.ts';
import { formatDateTime, formatRelativeTime } from '../../lib/format.ts';
import { sessionGlyph, statusLabel } from '../../lib/session-status.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectAccount } from '../../lib/stores/host.ts';
import { plainSessionTitle, selectSessionList, sessionTitle } from '../../lib/stores/sessions.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Badge, Banner, Button, Dialog, Table, useToast, type GlyphStatus, type TableColumn, type Tone } from '../../ui/index.ts';
import { whereLabel } from './root-label.ts';
import { t } from './strings.ts';

const AGENT_TONE: Readonly<Record<GlyphStatus, Tone>> = {
  running: 'success',
  question: 'warning',
  permission: 'warning',
  stalled: 'warning',
  failed: 'danger',
  idle: 'neutral',
  done: 'neutral',
  ended: 'neutral',
  blocked: 'neutral',
  todo: 'neutral',
};

/** A session's status as the session list words it; a terminal keeps its own three states. */
export function statusView(session: SessionInfo): { label: string; tone: Tone } {
  if (session.kind === 'agent') {
    if (session.status === 'starting') return { label: t('sessions.status.starting'), tone: 'info' };
    const glyph = sessionGlyph(session) ?? 'ended';
    return { label: statusLabel(glyph), tone: AGENT_TONE[glyph] };
  }
  if (isSessionOver(session)) {
    return { label: session.exitCode !== undefined ? t('sessions.status.exitedCode', { code: session.exitCode }) : t('sessions.status.exited'), tone: 'neutral' };
  }
  if (session.status === 'starting') return { label: t('sessions.status.starting'), tone: 'info' };
  return { label: t('sessions.status.running'), tone: 'success' };
}

/** What a session is for. */
export function purposeLabel(session: SessionInfo): string {
  if (session.kind === 'terminal') return t('sessions.purpose.terminal');
  if (session.purpose === 'discussion') return t('sessions.purpose.discussion');
  if (session.purpose === 'free') return t('sessions.purpose.free');
  return (session.attempt ?? 1) > 1 ? t('sessions.purpose.itemAttempt', { attempt: session.attempt ?? 1 }) : t('sessions.purpose.item');
}

/** A topic's session: terminating it stops more than the session, so the host confirms. */
function isTopicSession(session: SessionInfo): session is AgentSession {
  return session.kind === 'agent' && session.purpose !== 'free';
}

/**
 * A session's name in a sentence that also names who opened it ('Terminate "login page", opened by Amy'): a topic's
 * session by what it is ("Discussion", "2 · Payment form"), any other by its typed title or its bare kind.
 */
function nameBesideOpener(session: SessionInfo): string {
  return isTopicSession(session) ? sessionTitle(session) : plainSessionTitle(session);
}

/** The wire id of the daemon's one notice about a personal subscription login used by a group (OWNER-DECISIONS Q6). */
const PERSONAL_SUBSCRIPTION = 'notice.personalSubscription';

/** The state of the host's Claude account, and the conversations' disk space when the daemon says it is over the limit. */
function HostFacts() {
  const stores = useStores();
  const account = useStore(stores.host, selectAccount);
  const storageFull = useStore(stores.inbox, (state) => [...state.items.values()].some((item) => item.kind === 'attention' && item.subject === 'storage'));
  const subscription = useStore(stores.activity, (state) => state.notifications.find((notification) => notification.msg?.id === PERSONAL_SUBSCRIPTION));
  return (
    <div className="console-facts">
      {subscription ? (
        <Banner
          tone="warning"
          live="none"
          title={t('account.title')}
          actions={
            <Button size="sm" variant="ghost" onClick={() => stores.activity.dismissNotification(subscription.id)}>
              {t('account.noticeDismiss')}
            </Button>
          }
        >
          {renderWireText(subscription.msg, subscription.fallback ?? '')}
        </Banner>
      ) : null}
      {account === null ? null : account.state === 'ok' ? (
        <p className="console-hint">{t('account.ok')}</p>
      ) : (
        <Banner tone={account.state === 'logged-out' ? 'danger' : 'warning'} live="none" title={t('account.title')}>
          <p>
            {account.state === 'logged-out'
              ? t('account.loggedOut')
              : account.resetsAt !== undefined
                ? t('account.usageLimitUntil', { time: formatDateTime(account.resetsAt) })
                : t('account.usageLimit')}
          </p>
          {account.sessions > 0 ? <p>{t('account.sessionsWait', { count: account.sessions })}</p> : null}
        </Banner>
      )}
      {storageFull ? (
        <Banner tone="warning" live="none" title={t('storage.title')}>
          {t('storage.full')}
        </Banner>
      ) : null}
    </div>
  );
}

export function SessionsSection({ now }: { now: number }) {
  const stores = useStores();
  const toast = useToast();
  const sessions = useStore(stores.sessions, selectSessionList, shallowEqual);
  const status = useStore(stores.sessions, (state) => state.status);
  const loadError = useStore(stores.sessions, (state) => state.error);
  const worktrees = useStore(stores.worktrees, (state) => state.worktrees);
  const agents = useStore(stores.presence, (state) => state.agents);
  const [terminating, setTerminating] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<AgentSession | null>(null);
  const [showExited, setShowExited] = useState(false);

  const live = sessions.filter((session) => !isSessionOver(session));
  const exited = sessions.filter((session) => isSessionOver(session));
  const rows = showExited ? [...live, ...exited] : live;

  const terminate = async (session: SessionInfo): Promise<void> => {
    setTerminating((previous) => new Set(previous).add(session.id));
    try {
      await stores.admin.terminateSession(session.id);
      toast.show({ tone: 'success', title: t('sessions.terminated', { owner: session.openedBy.displayName, title: nameBesideOpener(session) }) });
    } catch (failure) {
      toast.show({ tone: 'danger', title: t('sessions.terminateFailed', { title: sessionTitle(session), message: describeError(failure) }) });
    } finally {
      setTerminating((previous) => {
        const next = new Set(previous);
        next.delete(session.id);
        return next;
      });
    }
  };

  const columns: TableColumn<SessionInfo>[] = [
    {
      id: 'title',
      header: t('sessions.col.title'),
      cell: (session) => {
        // What the agent is working on right now (presence.state), e.g. the file it is editing.
        const file = isSessionOver(session) ? undefined : agents.find((agent) => agent.sessionId === session.id)?.activeFile;
        return (
          <span className="console-session">
            <span className="console-session__title">{sessionTitle(session)}</span>
            <span className="console-muted">{formatRelativeTime(session.createdAt, now)}</span>
            {file ? <span className="console-session__file">{t('sessions.agentFile', { path: file.path })}</span> : null}
            {session.kind === 'terminal' && !isSessionOver(session) && session.attached > 0 ? <span className="console-muted">{t('sessions.viewers', { count: session.attached })}</span> : null}
          </span>
        );
      },
    },
    {
      id: 'topic',
      header: t('sessions.col.topic'),
      cell: (session) => (session.kind === 'agent' && session.topicName !== undefined ? session.topicName : <span className="console-muted">{t('sessions.topic.none')}</span>),
    },
    { id: 'purpose', header: t('sessions.col.purpose'), cell: (session) => purposeLabel(session) },
    {
      id: 'status',
      header: t('sessions.col.status'),
      cell: (session) => {
        const view = statusView(session);
        return <Badge tone={view.tone}>{view.label}</Badge>;
      },
    },
    {
      id: 'responsible',
      header: t('sessions.col.responsible'),
      cell: (session) => (session.kind !== 'agent' ? null : session.responsible ? session.responsible.displayName : <span className="console-muted">{t('sessions.responsible.nobody')}</span>),
    },
    { id: 'owner', header: t('sessions.col.owner'), cell: (session) => session.openedBy.displayName },
    { id: 'where', header: t('sessions.col.where'), cell: (session) => whereLabel(session, worktrees) },
    {
      id: 'actions',
      header: t('sessions.col.actions'),
      hideHeader: true,
      align: 'end',
      cell: (session) =>
        isSessionOver(session) ? null : (
          <Button
            size="sm"
            variant="danger"
            loading={terminating.has(session.id)}
            aria-label={t('sessions.terminateLabel', { owner: session.openedBy.displayName, title: nameBesideOpener(session) })}
            onClick={() => (isTopicSession(session) ? setConfirming(session) : void terminate(session))}
          >
            {t('sessions.terminate')}
          </Button>
        ),
    },
  ];

  return (
    <>
      <HostFacts />
      {status === 'error' && loadError ? (
        <Banner tone="danger" live="none">
          {t('sessions.loadFailed', { message: loadError })}
        </Banner>
      ) : null}
      <Table caption={t('sessions.caption')} hideCaption columns={columns} rows={rows} rowKey={(session) => session.id} empty={t('sessions.empty')} />
      {exited.length > 0 ? (
        <Button size="sm" variant="ghost" className="console-toggle" aria-expanded={showExited} onClick={() => setShowExited((value) => !value)}>
          {showExited ? t('sessions.hideExited') : t('sessions.showExited', { count: exited.length })}
        </Button>
      ) : null}
      <Dialog
        open={confirming !== null}
        role="alertdialog"
        onClose={() => setConfirming(null)}
        title={confirming ? t('sessions.confirm.title', { title: sessionTitle(confirming) }) : ''}
        description={
          confirming
            ? confirming.purpose === 'discussion'
              ? t('sessions.confirm.discussion', { topic: confirming.topicName ?? '' })
              : t('sessions.confirm.item', { topic: confirming.topicName ?? '' })
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {tApp('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!confirming) return;
                setConfirming(null);
                void terminate(confirming);
              }}
            >
              {t('sessions.terminate')}
            </Button>
          </>
        }
      />
    </>
  );
}

// Every session of the workspace (SPEC R11 「所有 session（狀態、擁有者、所在 worktree）」「一鍵終止任何 session」): status,
// owner, where it runs (main workspace or which worktree), sandboxed or not, viewers; 「終止」 sends
// admin.session.terminate at once (one click, as SPEC R11 asks; the session's worktree is kept).
import { useState } from 'react';
import type { SessionInfo, WorktreeInfo } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { formatRelativeTime } from '../../lib/format.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectSessionList } from '../../lib/stores/sessions.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Badge, Banner, Button, Table, useToast, type TableColumn, type Tone } from '../../ui/index.ts';
import { t } from './strings.ts';
import { plainSessionTitle } from '../../lib/stores/sessions.ts';
import { worktreeLabel } from '../../lib/stores/worktrees.ts';

function statusView(session: SessionInfo): { label: string; tone: Tone } {
  switch (session.status) {
    case 'starting':
      return { label: t('sessions.status.starting'), tone: 'info' };
    case 'running':
      return { label: t('sessions.status.running'), tone: 'success' };
    case 'exited':
      return {
        label: session.exitCode !== undefined ? t('sessions.status.exitedCode', { code: session.exitCode }) : t('sessions.status.exited'),
        tone: 'neutral',
      };
  }
}

export function whereLabel(session: SessionInfo, worktrees: ReadonlyMap<string, WorktreeInfo>, selfUserId: string | null = null): string {
  if (session.root.kind === 'main') return t('sessions.where.main');
  const worktree = worktrees.get(session.root.worktreeId);
  // Whose worktree and for what (review WEB-18), not its branch id.
  return worktree ? worktreeLabel(worktree, { selfUserId, name: plainSessionTitle(session) }) : t('sessions.where.worktreeGone');
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
  const [showExited, setShowExited] = useState(false);

  const live = sessions.filter((session) => session.status !== 'exited');
  const exited = sessions.filter((session) => session.status === 'exited');
  const rows = showExited ? [...live, ...exited] : live;

  const terminate = async (session: SessionInfo): Promise<void> => {
    setTerminating((previous) => new Set(previous).add(session.id));
    try {
      await stores.admin.terminateSession(session.id);
      toast.show({ tone: 'success', title: t('sessions.terminated', { owner: session.ownerName, title: plainSessionTitle(session) }) });
    } catch (failure) {
      toast.show({ tone: 'danger', title: t('sessions.terminateFailed', { title: session.title, message: describeError(failure) }) });
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
        const file = session.status === 'exited' ? undefined : agents.find((agent) => agent.sessionId === session.id)?.activeFile;
        return (
          <span className="console-session">
            <Badge>{session.kind === 'agent' ? t('sessions.kind.agent') : t('sessions.kind.terminal')}</Badge>
            <span className="console-session__title">{session.title}</span>
            <span className="console-muted">{formatRelativeTime(session.createdAt, now)}</span>
            {file ? <span className="console-session__file">{t('sessions.agentFile', { path: file.path })}</span> : null}
          </span>
        );
      },
    },
    { id: 'owner', header: t('sessions.col.owner'), cell: (session) => session.ownerName },
    {
      id: 'status',
      header: t('sessions.col.status'),
      cell: (session) => {
        const view = statusView(session);
        return <Badge tone={view.tone}>{view.label}</Badge>;
      },
    },
    { id: 'where', header: t('sessions.col.where'), cell: (session) => whereLabel(session, worktrees) },
    {
      id: 'sandbox',
      header: t('sessions.col.sandbox'),
      cell: (session) => <Badge tone={session.sandboxed ? 'info' : 'warning'}>{session.sandboxed ? t('sessions.sandboxed') : t('sessions.unsandboxed')}</Badge>,
    },
    { id: 'viewers', header: t('sessions.col.viewers'), align: 'end', cell: (session) => t('sessions.viewers', { count: session.attached }) },
    {
      id: 'actions',
      header: t('sessions.col.actions'),
      hideHeader: true,
      align: 'end',
      cell: (session) =>
        session.status === 'exited' ? null : (
          <Button
            size="sm"
            variant="danger"
            loading={terminating.has(session.id)}
            aria-label={t('sessions.terminateLabel', { owner: session.ownerName, title: plainSessionTitle(session) })}
            onClick={() => void terminate(session)}
          >
            {t('sessions.terminate')}
          </Button>
        ),
    },
  ];

  return (
    <>
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
    </>
  );
}

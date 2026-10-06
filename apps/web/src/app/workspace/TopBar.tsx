// The top bar of a workspace, in both modes and in the console: workspace name and host, connection status, member
// avatars with presence, own role, the console link (host), the mode switch "Sessions | Code mode" (DESIGN §5.1),
// the layout toggles of the mode on screen, language, theme, and "Leave" (channel.leave).
//
// The mode switch is two links (the mode is a route): the current one is marked aria-current. While code mode is on
// screen the "Sessions" segment carries the two inbox counts, so a question is not missed while hand-coding; the
// "Code mode" segment carries the number of open conflicts, because a conflict can hold a person's unsaved text.
import { useState } from 'react';
import type { PresenceAgent, PresenceMember } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { formatRole } from '../../lib/format.ts';
import { routePath } from '../../lib/router.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectOpenConflicts } from '../../lib/stores/conflicts.ts';
import { selectInboxCounts } from '../../lib/stores/inbox.ts';
import type { WorkspaceMode } from '../../lib/commands.ts';
import { useCapabilities, useConnectionState, useMember, useStores, useWorkspaceInfo, useWorkspaceSession } from '../../lib/workspace/context.tsx';
import { tWorkbench } from '../../strings/workbench.ts';
import { Avatar, Badge, Button, Dialog, IconButton, LanguageMenu, Segmented, Tooltip, useToast } from '../../ui/index.ts';
import { IconCode, IconLogOut, IconPanelBottom, IconPanelLeft, IconPanelRight, IconSessions, IconSettings, IconUsers } from '../../ui/icons.tsx';
import { InboxCounts } from '../../features/sidebar/index.tsx';
import { tUi } from '../../strings/ui.ts';
import { tApp } from '../../strings/app.ts';
import { ConnectionStatusPill } from '../connection/indicators.tsx';
import { Link } from '../navigation.tsx';
import { useAppServices } from '../services.tsx';
import { ThemeMenu } from '../ThemeMenu.tsx';

/** The folds the top bar toggles: the left column of the sessions view; code mode's three panels. */
export interface LayoutToggles {
  readonly left: boolean;
  readonly files: boolean;
  readonly side: boolean;
  readonly drawer: boolean;
  toggle(which: 'left' | 'files' | 'side' | 'drawer'): void;
}

export type TopBarView = WorkspaceMode | 'console';

const MAX_AVATARS = 6;

export function TopBar({ view, layout }: { view: TopBarView; layout?: LayoutToggles }) {
  const session = useWorkspaceSession();
  const info = useWorkspaceInfo();
  const member = useMember();
  const caps = useCapabilities();
  const state = useConnectionState();
  const [leaving, setLeaving] = useState(false);

  return (
    <header className="app-topbar" aria-label={tWorkbench('topbar.label')}>
      <div className="app-topbar__identity">
        <Link to="/" className="app-wordmark app-wordmark--small">
          smurg
        </Link>
        <span className="app-topbar__divider" aria-hidden="true" />
        <div className="app-topbar__workspace">
          <h1 className="app-topbar__name">{info?.name ?? session.workspaceId}</h1>
          {info ? <span className="app-topbar__host app-hide-narrow">{tWorkbench('topbar.host', { name: info.hostName })}</span> : null}
        </div>
        <ConnectionStatusPill state={state} />
      </div>

      <div className="app-topbar__people">
        <MemberAvatars />
        {member ? (
          <Badge tone={member.role === 'host' ? 'info' : 'neutral'}>
            <span className="ui-visually-hidden">{tWorkbench('topbar.rolePrefix')}</span>
            {formatRole(member.role)}
          </Badge>
        ) : null}
      </div>

      <nav className="app-topbar__actions" aria-label={tWorkbench('topbar.more')}>
        {caps.can('admin') ? (
          // Below 1100 px the link is its icon (the words stay its name).
          <Link
            to={routePath({ name: 'console', workspaceId: session.workspaceId })}
            className="ui-button ui-button--ghost ui-button--sm app-topbar__console"
            aria-current={view === 'console' ? 'page' : undefined}
            aria-label={tWorkbench('topbar.console')}
            title={tWorkbench('topbar.console')}
          >
            <IconSettings /> <span className="app-hide-narrow">{tWorkbench('topbar.console')}</span>
          </Link>
        ) : null}
        <ModeSwitch view={view} />
        {layout && view !== 'console' ? (
          <div className="app-topbar__toggles" role="group" aria-label={tWorkbench('topbar.togglePanels')}>
            {view === 'sessions' ? (
              <IconButton label={tWorkbench('topbar.toggleLeft')} icon={<IconPanelLeft />} size="sm" pressed={layout.left} onClick={() => layout.toggle('left')} />
            ) : (
              <>
                <IconButton label={tWorkbench('topbar.toggleSidebar')} icon={<IconPanelLeft />} size="sm" pressed={layout.files} onClick={() => layout.toggle('files')} />
                <IconButton label={tWorkbench('topbar.toggleDrawer')} icon={<IconPanelBottom />} size="sm" pressed={layout.drawer} onClick={() => layout.toggle('drawer')} />
                <IconButton label={tWorkbench('topbar.toggleSide')} icon={<IconPanelRight />} size="sm" pressed={layout.side} onClick={() => layout.toggle('side')} />
              </>
            )}
          </div>
        ) : null}
        <LanguageMenu />
        <ThemeMenu />
        <Button size="sm" variant="secondary" icon={<IconLogOut />} onClick={() => setLeaving(true)}>
          {tWorkbench('topbar.leave')}
        </Button>
      </nav>
      <LeaveDialog open={leaving} onClose={() => setLeaving(false)} isHost={caps.isHost} />
    </header>
  );
}

/** "Sessions | Code mode": two links, the current one marked; neither is current in the host console. */
function ModeSwitch({ view }: { view: TopBarView }) {
  const session = useWorkspaceSession();
  const { router } = useAppServices();
  const stores = useStores();
  const counts = useStore(stores.inbox, selectInboxCounts, shallowEqual);
  const conflicts = useStore(stores.conflicts, (state) => selectOpenConflicts(state).length);
  const paths: Record<WorkspaceMode, string> = {
    sessions: routePath({ name: 'workspace', workspaceId: session.workspaceId }),
    code: routePath({ name: 'code', workspaceId: session.workspaceId }),
  };
  // The inbox is one click away while hand-coding; in the sessions view the left column shows the counts itself.
  const showCounts = view !== 'sessions' && counts.waiting + counts.look > 0;
  const showConflicts = view !== 'code' && conflicts > 0;
  return (
    <div className="app-topbar__mode">
      <Segmented<WorkspaceMode>
        label={tWorkbench('mode.label')}
        variant="links"
        value={view === 'console' ? null : view}
        onChange={(mode) => router.navigate(paths[mode])}
        options={[
          {
            id: 'sessions',
            label: tWorkbench('mode.sessions'),
            icon: <IconSessions size={14} />,
            href: paths.sessions,
            title: tWorkbench('mode.sessions.title'),
            ...(showCounts ? { badge: <InboxCounts waiting={counts.waiting} look={counts.look} />, ariaLabel: tWorkbench('mode.sessions.counts', { waiting: counts.waiting, look: counts.look }) } : {}),
          },
          {
            id: 'code',
            label: tWorkbench('mode.code'),
            icon: <IconCode size={14} />,
            href: paths.code,
            title: tWorkbench('mode.code.title'),
            ...(showConflicts
              ? {
                  badge: (
                    <span className="ui-count ui-count--waiting" aria-hidden="true">
                      {conflicts}
                    </span>
                  ),
                  ariaLabel: tWorkbench('mode.code.conflicts', { count: conflicts }),
                }
              : {}),
          },
        ]}
      />
    </div>
  );
}

function MemberAvatars() {
  const { presence } = useStores();
  const members = useStore(presence, (state) => state.members.filter((m) => m.online), shallowArray);
  const agents = useStore(presence, (state) => state.agents.filter((a) => a.status !== 'ended'), shallowArray);
  const shown: (PresenceMember | PresenceAgent)[] = [...members, ...agents].slice(0, MAX_AVATARS);
  const hidden = members.length + agents.length - shown.length;
  return (
    <div className="app-avatars" role="group" aria-label={tWorkbench('topbar.members')}>
      <IconUsers className="app-avatars__icon" />
      <ul className="app-avatars__list">
        {shown.map((person) =>
          'sessionId' in person ? (
            <li key={`agent:${person.sessionId}`}>
              <Tooltip content={person.displayName}>
                {/* A tab stop needs a role and a name of its own. */}
                <span tabIndex={0} className="app-avatars__item" role="img" aria-label={person.displayName}>
                  <Avatar name={person.displayName} color={person.color} size="sm" status="agent" />
                </span>
              </Tooltip>
            </li>
          ) : (
            <li key={person.userId}>
              <Tooltip content={`${person.displayName} · ${formatRole(person.role)}`}>
                <span tabIndex={0} className="app-avatars__item" role="img" aria-label={`${person.displayName} · ${formatRole(person.role)}`}>
                  <Avatar name={person.displayName} color={person.color} size="sm" status="online" />
                </span>
              </Tooltip>
            </li>
          ),
        )}
      </ul>
      {hidden > 0 ? <span className="app-avatars__more">{tUi('avatar.more', { count: hidden })}</span> : null}
    </div>
  );
}

function shallowArray<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => shallowEqual(item, b[index]));
}

function LeaveDialog({ open, onClose, isHost }: { open: boolean; onClose(): void; isHost: boolean }) {
  const { manager, router } = useAppServices();
  const session = useWorkspaceSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const leave = (): void => {
    setBusy(true);
    manager
      .leave(session.workspaceId)
      .catch((error: unknown) => toast.show({ tone: 'warning', title: tWorkbench('leave.failed', { reason: describeError(error) }) }))
      .finally(() => {
        setBusy(false);
        onClose();
        router.navigate('/');
      });
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      title={tWorkbench('leave.title')}
      description={isHost ? tWorkbench('leave.bodyHost') : tWorkbench('leave.body')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{tApp('common.cancel')}</Button>
          <Button variant="danger" loading={busy} onClick={leave}>
            {tWorkbench('leave.confirm')}
          </Button>
        </>
      }
    />
  );
}

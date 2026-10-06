// The workbench top bar: workspace name and host, connection status, member avatars with presence, own role, console
// link (host), layout toggles, language, theme, and "Leave" (channel.leave).
import { useState } from 'react';
import type { PresenceAgent, PresenceMember } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { formatRole } from '../../lib/format.ts';
import { routePath } from '../../lib/router.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { useCapabilities, useConnectionState, useMember, useStores, useWorkspaceInfo, useWorkspaceSession } from '../../lib/workspace/context.tsx';
import { tWorkbench } from '../../strings/workbench.ts';
import { Avatar, Badge, Button, Dialog, IconButton, LanguageMenu, Tooltip, useToast } from '../../ui/index.ts';
import { IconLogOut, IconPanelBottom, IconPanelLeft, IconPanelRight, IconSettings, IconUsers } from '../../ui/icons.tsx';
import { tUi } from '../../strings/ui.ts';
import { tApp } from '../../strings/app.ts';
import { ConnectionStatusPill } from '../connection/indicators.tsx';
import { Link } from '../navigation.tsx';
import { useAppServices } from '../services.tsx';
import { ThemeMenu } from '../ThemeMenu.tsx';

export interface LayoutToggles {
  readonly sidebar: boolean;
  readonly right: boolean;
  readonly drawer: boolean;
  toggle(which: 'sidebar' | 'right' | 'drawer'): void;
}

const MAX_AVATARS = 6;

export function TopBar({ view, layout }: { view: 'workbench' | 'console'; layout?: LayoutToggles }) {
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
          {info ? <span className="app-topbar__host">{tWorkbench('topbar.host', { name: info.hostName })}</span> : null}
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
          view === 'workbench' ? (
            <Link to={routePath({ name: 'console', workspaceId: session.workspaceId })} className="ui-button ui-button--ghost ui-button--sm">
              <IconSettings /> {tWorkbench('topbar.console')}
            </Link>
          ) : (
            <Link to={routePath({ name: 'workspace', workspaceId: session.workspaceId })} className="ui-button ui-button--ghost ui-button--sm">
              {tWorkbench('topbar.workbench')}
            </Link>
          )
        ) : null}
        {layout ? (
          <div className="app-topbar__toggles" role="group" aria-label={tWorkbench('topbar.togglePanels')}>
            <IconButton label={tWorkbench('topbar.toggleSidebar')} icon={<IconPanelLeft />} size="sm" pressed={layout.sidebar} onClick={() => layout.toggle('sidebar')} />
            <IconButton label={tWorkbench('topbar.toggleDrawer')} icon={<IconPanelBottom />} size="sm" pressed={layout.drawer} onClick={() => layout.toggle('drawer')} />
            <IconButton label={tWorkbench('topbar.toggleRight')} icon={<IconPanelRight />} size="sm" pressed={layout.right} onClick={() => layout.toggle('right')} />
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

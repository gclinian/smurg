// Members (SPEC R2, R11 "online members shown live", "remove any member with one click"): online state, role, devices and what everyone is doing;
// change a role with a select, kick with one click and a confirmation that says exactly what will happen. Choosing
// "Agent access" first shows the risk (RoleRiskDialog) and applies only after the host confirms; losing it ends the
// sessions the member opened (the daemon does), which is confirmed too.
import { useState } from 'react';
import { GUEST_ROLES, can, isSessionOver, type GuestRole, type MemberWithDevices, type PresenceMember, type SessionInfo } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { compareText, formatRelativeTime, formatRole } from '../../lib/format.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectSessionList } from '../../lib/stores/sessions.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { isRiskyRole } from '../../lib/capabilities.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Avatar, Badge, Banner, Button, Dialog, Select, Table, useToast, type TableColumn } from '../../ui/index.ts';
import { RoleRiskDialog } from './RoleRiskDialog.tsx';
import { t } from './strings.ts';

interface MemberRow {
  readonly member: MemberWithDevices;
  readonly presence: PresenceMember | undefined;
  readonly running: readonly SessionInfo[];
}

const ROLE_ORDER = { host: 0, agent: 1, editor: 2, viewer: 3 } as const;

/** Online first (host on top), then by name. */
function sortRows(rows: MemberRow[]): MemberRow[] {
  const online = (row: MemberRow): boolean => row.presence?.online ?? row.member.online;
  return rows.sort(
    (a, b) =>
      Number(b.member.role === 'host') - Number(a.member.role === 'host') ||
      Number(online(b)) - Number(online(a)) ||
      ROLE_ORDER[a.member.role] - ROLE_ORDER[b.member.role] ||
      compareText(a.member.displayName, b.member.displayName),
  );
}

/** Whether moving `from` → `to` takes away the right to open sessions (the daemon then ends the ones they opened). */
function losesSessions(from: MemberWithDevices['role'], to: GuestRole): boolean {
  return can(from, 'session.create') && !can(to, 'session.create');
}

export function MembersSection({ now }: { now: number }) {
  const stores = useStores();
  const toast = useToast();
  const members = useStore(stores.admin, (state) => state.members);
  const presence = useStore(stores.presence, (state) => state.members);
  const sessions = useStore(stores.sessions, selectSessionList, shallowEqual);
  const selfId = useStore(stores.workspace, selectUserId);
  const [busy, setBusy] = useState<string | null>(null);
  const [kicking, setKicking] = useState<MemberWithDevices | null>(null);
  const [demoting, setDemoting] = useState<{ member: MemberWithDevices; role: GuestRole; count: number } | null>(null);
  /** A member about to get agent access: nothing is sent before the host confirms the risk. */
  const [granting, setGranting] = useState<{ member: MemberWithDevices; role: GuestRole } | null>(null);

  const rows = sortRows(
    members.map((member) => ({
      member,
      presence: presence.find((p) => p.userId === member.userId),
      running: sessions.filter((session) => session.openedBy.userId === member.userId && !isSessionOver(session)),
    })),
  );

  const applyRole = async (member: MemberWithDevices, role: GuestRole): Promise<void> => {
    setBusy(member.userId);
    try {
      await stores.admin.setRole(member.userId, role);
      toast.show({ tone: 'success', title: t('members.roleChanged', { name: member.displayName, role: formatRole(role) }) });
    } catch (failure) {
      toast.show({ tone: 'danger', title: t('members.roleFailed', { name: member.displayName, message: describeError(failure) }) });
    } finally {
      setBusy(null);
    }
  };

  const changeRole = (row: MemberRow, role: GuestRole): void => {
    if (role === row.member.role) return;
    if (isRiskyRole(role)) {
      setGranting({ member: row.member, role });
      return;
    }
    if (losesSessions(row.member.role, role) && row.running.length > 0) {
      setDemoting({ member: row.member, role, count: row.running.length });
      return;
    }
    void applyRole(row.member, role);
  };

  const roleOptions = GUEST_ROLES.map((role) => ({ value: role, label: formatRole(role) }));

  const columns: TableColumn<MemberRow>[] = [
    {
      id: 'member',
      header: t('members.col.member'),
      cell: ({ member }) => (
        <span className="console-member">
          <Avatar name={member.displayName} color={member.color} size="sm" decorative />
          <span className="console-member__name">
            {member.displayName}
            {member.userId === selfId ? <span className="console-muted">{t('members.you')}</span> : null}
          </span>
          <span className="console-member__id">{member.userId}</span>
        </span>
      ),
    },
    {
      id: 'status',
      header: t('members.col.status'),
      cell: ({ member, presence: live }) => {
        const online = live?.online ?? member.online;
        return (
          <Badge tone={online ? 'success' : 'neutral'}>
            {online ? (live && live.connections > 1 ? t('members.onlineConnections', { count: live.connections }) : t('members.online')) : t('members.offline')}
          </Badge>
        );
      },
    },
    {
      id: 'role',
      header: t('members.col.role'),
      cell: (row) =>
        row.member.role === 'host' ? (
          formatRole('host')
        ) : (
          <Select<GuestRole>
            label={t('members.roleLabel', { name: row.member.displayName })}
            hideLabel
            options={roleOptions}
            value={row.member.role}
            disabled={busy === row.member.userId}
            onChange={(role) => changeRole(row, role)}
          />
        ),
    },
    {
      id: 'devices',
      header: t('members.col.devices'),
      cell: ({ member, presence: live }) => {
        if (member.devices.length === 0) return <span className="console-muted">{t('members.devices.none')}</span>;
        // Which devices are connected is not reported per device: while the member is online, the most recently seen
        // ones (as many as they have connections) are the connected ones — never "Last seen 15 minutes ago" for a device in
        // use right now.
        const online = live?.online ?? member.online;
        const connected = new Set(
          online
            ? member.devices
                .filter((device) => !device.revoked)
                .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
                .slice(0, Math.max(1, live?.connections ?? 1))
                .map((device) => device.deviceId)
            : [],
        );
        return (
          <ul className="console-devices">
            {member.devices.map((device) => (
              <li key={device.deviceId} className={device.revoked ? 'console-devices__revoked' : undefined}>
                <span>{t('members.device.item', { name: device.name, kind: device.kind === 'web' ? t('members.device.web') : t('members.device.cli') })}</span>
                <span className="console-muted">
                  {device.revoked
                    ? t('members.device.revoked')
                    : connected.has(device.deviceId)
                      ? t('members.device.connected', { time: formatRelativeTime(device.lastSeenAt, now) })
                      : t('members.device.lastSeen', { time: formatRelativeTime(device.lastSeenAt, now) })}
                </span>
              </li>
            ))}
          </ul>
        );
      },
    },
    {
      id: 'activity',
      header: t('members.col.activity'),
      cell: ({ presence: live, running }) => {
        const parts: string[] = [];
        const file = live?.online ? live.activeFile : undefined;
        if (file) parts.push(file.root.kind === 'main' ? t('members.activity.file', { path: file.path }) : t('members.activity.fileWorktree', { path: file.path }));
        if (running.length > 0) parts.push(t('members.activity.sessions', { count: running.length }));
        return parts.length === 0 ? <span className="console-muted">{t('members.activity.none')}</span> : <span className="console-activity">{parts.join(' · ')}</span>;
      },
    },
    {
      id: 'actions',
      header: t('members.col.actions'),
      hideHeader: true,
      align: 'end',
      cell: ({ member }) =>
        member.role === 'host' ? null : (
          <Button size="sm" variant="danger" aria-label={t('members.kickLabel', { name: member.displayName })} onClick={() => setKicking(member)}>
            {t('members.kick')}
          </Button>
        ),
    },
  ];

  return (
    <>
      <Table
        caption={t('members.caption')}
        hideCaption
        columns={columns}
        rows={rows}
        rowKey={(row) => row.member.userId}
        empty={t('members.empty')}
      />
      <p className="console-hint">{t('members.hint')}</p>
      <RoleRiskDialog
        open={granting !== null}
        title={granting ? t('roleRisk.memberTitle', { name: granting.member.displayName }) : ''}
        confirmLabel={t('roleRisk.confirmMember')}
        onCancel={() => setGranting(null)}
        onConfirm={() => {
          if (!granting) return;
          setGranting(null);
          void applyRole(granting.member, granting.role);
        }}
      />
      <KickDialog member={kicking} sessions={kicking ? rows.find((row) => row.member.userId === kicking.userId)?.running.length ?? 0 : 0} onClose={() => setKicking(null)} />
      <Dialog
        open={demoting !== null}
        role="alertdialog"
        onClose={() => setDemoting(null)}
        title={demoting ? t('demote.title', { name: demoting.member.displayName }) : ''}
        description={demoting ? t('demote.body', { name: demoting.member.displayName, count: demoting.count, role: formatRole(demoting.role) }) : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDemoting(null)}>
              {tApp('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!demoting) return;
                setDemoting(null);
                void applyRole(demoting.member, demoting.role);
              }}
            >
              {t('demote.confirm')}
            </Button>
          </>
        }
      />
    </>
  );
}

/** One click on "Remove" opens this; it names every consequence (SPEC R2) before the irreversible request. */
function KickDialog({ member, sessions, onClose }: { member: MemberWithDevices | null; sessions: number; onClose(): void }) {
  if (!member) return null;
  return <KickConfirm key={member.userId} member={member} sessions={sessions} onClose={onClose} />;
}

function KickConfirm({ member, sessions, onClose }: { member: MemberWithDevices; sessions: number; onClose(): void }) {
  const stores = useStores();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = member.displayName;

  const kick = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await stores.admin.kick(member.userId);
      toast.show({ tone: 'success', title: t('kick.done', { name }) });
      onClose();
    } catch (failure) {
      setError(t('kick.failed', { name, message: describeError(failure) }));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      title={t('kick.title', { name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void kick()}>
            {t('kick.confirm', { name })}
          </Button>
        </>
      }
    >
      <div className="console-kick">
        <p>{t('kick.lead')}</p>
        <ul>
          <li>{t('kick.sessions', { name, count: sessions })}</li>
          <li>{t('kick.keys', { name })}</li>
        </ul>
        <p className="console-kick__final">{t('kick.irreversible', { name })}</p>
        {error ? (
          <Banner tone="danger" live="alert">
            {error}
          </Banner>
        ) : null}
      </div>
    </Dialog>
  );
}

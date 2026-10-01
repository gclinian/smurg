// Invites (SPEC R2 「主人產生邀請連結，可設定角色、有效期限、使用次數」): create one, see the ones on file with their
// remaining uses, revoke. An invite with 「可使用 agent」 is created only after the host confirmed the risk
// (RoleRiskDialog): whoever uses it runs anything on the host's computer, with the host's Claude account.
//
// The link carries the one-time secret (ARCHITECTURE §4.1). It is shown ONCE, in the dialog right after creation, and
// lives only in that dialog's React state: the admin store never keeps it (it returns it from createInvite), nothing
// logs it, and closing the dialog drops it. Losing it means revoking the invite and creating a new one.
import { useState } from 'react';
import { GUEST_ROLES, type GuestRole, type InviteInfo } from '@smurg/protocol';
import { isRiskyRole } from '../../lib/capabilities.ts';
import { describeError } from '../../lib/errors.ts';
import { formatDateTime, formatRole } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Badge, Banner, Button, CopyButton, Dialog, Input, Select, Table, useToast, type TableColumn } from '../../ui/index.ts';
import { IconKey, IconPlus } from '../../ui/icons.tsx';
import {
  DEFAULT_EXPIRY,
  EXPIRY_CHOICES,
  expiryLabel,
  expirySeconds,
  inviteState,
  inviteStateLabel,
  parseMaxUses,
  usesLabel,
  type ExpiryId,
  type InviteState,
} from './invite-form.ts';
import { RoleRiskDialog } from './RoleRiskDialog.tsx';
import { t } from './strings.ts';

const ROLE_HINT: Record<GuestRole, () => string> = {
  agent: () => t('invites.roleHint.agent'),
  editor: () => t('invites.roleHint.editor'),
  viewer: () => t('invites.roleHint.viewer'),
};

const STATE_TONE: Record<InviteState, 'success' | 'neutral' | 'warning'> = { active: 'success', revoked: 'neutral', expired: 'neutral', usedUp: 'warning' };

/** What the link dialog shows: gone as soon as the dialog closes. */
interface CreatedLink {
  readonly url: string;
  readonly invite: InviteInfo;
  readonly expiry: ExpiryId;
}

export function InvitesSection({ now }: { now: number }) {
  const stores = useStores();
  const toast = useToast();
  const invites = useStore(stores.admin, (state) => state.invites);
  const [role, setRole] = useState<GuestRole>('editor');
  const [expiry, setExpiry] = useState<ExpiryId>(DEFAULT_EXPIRY);
  // Single use by default: a link that leaks can then admit at most one stranger.
  const [maxUses, setMaxUses] = useState('1');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());
  /** The risk of 「可使用 agent」 is on screen: the invite is created only on 「我了解」. */
  const [confirmingRisk, setConfirmingRisk] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const uses = parseMaxUses(maxUses);
  const usesError = 'error' in uses ? uses.error : null;

  const create = async (): Promise<void> => {
    if ('error' in uses) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await stores.admin.createInvite({
        role,
        expiresInSec: expirySeconds(expiry),
        ...(uses.value !== undefined ? { maxUses: uses.value } : {}),
      });
      setCreated({ url: result.url, invite: result.invite, expiry });
    } catch (failure) {
      setCreateError(t('invites.createFailed', { message: describeError(failure) }));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (invite: InviteInfo): Promise<void> => {
    setRevoking((previous) => new Set(previous).add(invite.id));
    try {
      await stores.admin.revokeInvite(invite.id);
      toast.show({ tone: 'success', title: t('invites.revoked') });
    } catch (failure) {
      toast.show({ tone: 'danger', title: t('invites.revokeFailed', { message: describeError(failure) }) });
    } finally {
      setRevoking((previous) => {
        const next = new Set(previous);
        next.delete(invite.id);
        return next;
      });
    }
  };

  const sorted = [...invites].sort((a, b) => b.createdAt - a.createdAt);
  const active = sorted.filter((invite) => inviteState(invite, now) === 'active');
  const inactive = sorted.filter((invite) => inviteState(invite, now) !== 'active');
  const rows = showInactive ? [...active, ...inactive] : active;

  const columns: TableColumn<InviteInfo>[] = [
    { id: 'role', header: t('invites.col.role'), cell: (invite) => formatRole(invite.role) },
    { id: 'created', header: t('invites.col.created'), cell: (invite) => formatDateTime(invite.createdAt) },
    { id: 'expires', header: t('invites.col.expires'), cell: (invite) => (invite.expiresAt !== undefined ? formatDateTime(invite.expiresAt) : t('invites.expires.none')) },
    { id: 'uses', header: t('invites.col.uses'), cell: (invite) => usesLabel(invite) },
    {
      id: 'status',
      header: t('invites.col.status'),
      cell: (invite) => {
        const state = inviteState(invite, now);
        return <Badge tone={STATE_TONE[state]}>{inviteStateLabel(state)}</Badge>;
      },
    },
    {
      id: 'actions',
      header: t('invites.col.actions'),
      hideHeader: true,
      align: 'end',
      cell: (invite) =>
        inviteState(invite, now) === 'active' ? (
          <Button
            size="sm"
            variant="ghost"
            loading={revoking.has(invite.id)}
            aria-label={t('invites.revokeLabel', { time: formatDateTime(invite.createdAt), role: formatRole(invite.role) })}
            onClick={() => void revoke(invite)}
          >
            {t('invites.revoke')}
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <form
        className="console-invite-form"
        onSubmit={(event) => {
          event.preventDefault();
          if ('error' in uses || creating) return;
          if (isRiskyRole(role)) setConfirmingRisk(true);
          else void create();
        }}
      >
        <Select<GuestRole>
          label={t('invites.role')}
          options={GUEST_ROLES.map((value) => ({ value, label: formatRole(value) }))}
          value={role}
          onChange={setRole}
          hint={ROLE_HINT[role]()}
        />
        <Select<ExpiryId> label={t('invites.expiry')} options={EXPIRY_CHOICES.map((choice) => ({ value: choice.id, label: expiryLabel(choice.id) }))} value={expiry} onChange={setExpiry} />
        <Input
          label={t('invites.maxUses')}
          inputMode="numeric"
          value={maxUses}
          onChange={(event) => setMaxUses(event.currentTarget.value)}
          hint={t('invites.maxUsesHint')}
          error={usesError ?? undefined}
        />
        <div className="console-invite-form__submit">
          <Button type="submit" variant="primary" icon={<IconPlus />} loading={creating} disabled={usesError !== null}>
            {t('invites.create')}
          </Button>
        </div>
      </form>
      {createError ? (
        <Banner tone="danger" live="alert">
          {createError}
        </Banner>
      ) : null}
      <Table caption={t('invites.caption')} hideCaption columns={columns} rows={rows} rowKey={(invite) => invite.id} empty={t('invites.empty')} />
      {inactive.length > 0 ? (
        <Button size="sm" variant="ghost" className="console-toggle" aria-expanded={showInactive} onClick={() => setShowInactive((value) => !value)}>
          {showInactive ? t('invites.hideInactive') : t('invites.showInactive', { count: inactive.length })}
        </Button>
      ) : null}
      <RoleRiskDialog
        open={confirmingRisk}
        title={t('roleRisk.inviteTitle')}
        confirmLabel={t('roleRisk.confirmInvite')}
        onCancel={() => setConfirmingRisk(false)}
        onConfirm={() => {
          setConfirmingRisk(false);
          void create();
        }}
      />
      <InviteLinkDialog created={created} onClose={() => setCreated(null)} />
    </>
  );
}

function InviteLinkDialog({ created, onClose }: { created: CreatedLink | null; onClose(): void }) {
  if (!created) return null;
  const { invite, url, expiry } = created;
  return (
    <Dialog
      open
      onClose={onClose}
      // Shown once: a stray Escape or backdrop click must not throw the link away; only the explicit button closes.
      dismissible={false}
      title={t('invites.link.title')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('invites.link.done')}
        </Button>
      }
    >
      <div className="console-invite-link">
        <p>
          {t('invites.link.summary', {
            role: formatRole(invite.role),
            expiry: expiryLabel(expiry),
            uses: invite.maxUses !== undefined ? t('invites.link.usesLimited', { count: invite.maxUses }) : t('invites.link.usesUnlimited'),
          })}
        </p>
        <div className="console-invite-link__row">
          <Input label={t('invites.link.label')} value={url} readOnly spellCheck={false} autoComplete="off" onFocus={(event) => event.currentTarget.select()} />
          <CopyButton text={url} label={t('invites.link.copy')} size="md" />
        </div>
        <Banner tone="warning" live="none" icon={<IconKey />}>
          {t('invites.link.secret')}
        </Banner>
        <p className="console-hint">{t('invites.link.once')}</p>
      </div>
    </Dialog>
  );
}

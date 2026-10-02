// Invites (SPEC R2 "the host creates invite links with a role, an expiry and a number of uses") as pure functions: the expiry choices, the
// uses field, and an invite's state for the list.
import { INVITE_MAX_USES_MAX, type InviteInfo } from '@smurg/protocol';
import { t } from './strings.ts';

const HOUR = 3_600;
const DAY = 24 * HOUR;

export const EXPIRY_CHOICES = [
  { id: '1h', seconds: HOUR },
  { id: '1d', seconds: DAY },
  { id: '7d', seconds: 7 * DAY },
  { id: '30d', seconds: 30 * DAY },
] as const;

export type ExpiryId = (typeof EXPIRY_CHOICES)[number]['id'];

/** 7 days, the daemon's default too: a link should not be a standing credential (ARCHITECTURE §4.1). */
export const DEFAULT_EXPIRY: ExpiryId = '7d';

const EXPIRY_LABEL: Record<ExpiryId, () => string> = {
  '1h': () => t('invites.expiry.1h'),
  '1d': () => t('invites.expiry.1d'),
  '7d': () => t('invites.expiry.7d'),
  '30d': () => t('invites.expiry.30d'),
};

export function expiryLabel(id: ExpiryId): string {
  return EXPIRY_LABEL[id]();
}

export function expirySeconds(id: ExpiryId): number {
  return EXPIRY_CHOICES.find((choice) => choice.id === id)?.seconds ?? 7 * DAY;
}

/** Empty ⇒ unlimited within the expiry; otherwise an integer 1 … INVITE_MAX_USES_MAX. */
export function parseMaxUses(text: string): { readonly value: number | undefined } | { readonly error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { value: undefined };
  if (!/^\d+$/.test(trimmed)) return { error: t('invites.maxUsesInvalid', { max: INVITE_MAX_USES_MAX }) };
  const value = Number(trimmed);
  if (value < 1 || value > INVITE_MAX_USES_MAX) return { error: t('invites.maxUsesInvalid', { max: INVITE_MAX_USES_MAX }) };
  return { value };
}

export type InviteState = 'active' | 'revoked' | 'expired' | 'usedUp';

export function inviteState(invite: InviteInfo, now: number): InviteState {
  if (invite.revoked) return 'revoked';
  if (invite.maxUses !== undefined && invite.uses >= invite.maxUses) return 'usedUp';
  if (invite.expiresAt !== undefined && invite.expiresAt <= now) return 'expired';
  return 'active';
}

const STATE_LABEL: Record<InviteState, () => string> = {
  active: () => t('invites.status.active'),
  revoked: () => t('invites.status.revoked'),
  expired: () => t('invites.status.expired'),
  usedUp: () => t('invites.status.usedUp'),
};

export function inviteStateLabel(state: InviteState): string {
  return STATE_LABEL[state]();
}

export function usesLabel(invite: InviteInfo): string {
  return invite.maxUses === undefined
    ? t('invites.uses.unlimited', { uses: invite.uses })
    : t('invites.uses.limited', { uses: invite.uses, left: Math.max(0, invite.maxUses - invite.uses) });
}

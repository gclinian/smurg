// admit() (ARCHITECTURE §4; noise.md §1.3-1.4, V1/V2/V8): runs exactly once per handshake, SYNCHRONOUSLY, after msg3
// authenticated the client's static key (and, in invite mode, the PSK). Nothing is ever decided on the
// unauthenticated msg3 key, and every outcome travels encrypted in the verdict.
//
// Order: ClientHello → purpose matches the socket → identity token (signature, iss, aud, age) → the relay-asserted
// user of this connection is the token's subject → cnf binds the token to THIS device key → device registry
// (revoked keys are refused even through a fresh invite) → invite (unusable, bound to another user, the host's user
// id without the host invite, an active member through an invite of another role, older than a kick) or device
// (registered, member active) → connection cap → logical channel (resume) → Welcome.
// Invite use and device registration happen in the same synchronous step as the checks (no await in between).
import {
  decodeClientHello,
  encodeVerdict,
  verifyIdentityCnf,
  type AdmitContext,
  type AdmitDecision,
  type ChannelPurpose,
  type ClientHello,
  type HandshakeMode,
  type VerdictRejectReason,
  type WorkspaceInfo,
} from '@smurg/protocol';
import type { LimitsConfig } from '../core/config.ts';
import type { AuditLog, EventBus, InviteService, MemberRecord, SettingsService, UserId } from '../core/interfaces.ts';
import type { Clock } from '../core/lifecycle.ts';
import type { Logger } from '../core/logger.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import type { HubAdmission, HubImpl } from '../core/hub.ts';
import type { MemberDirectoryImpl } from '../admin/members.ts';
import { isTimeFailure, type IdentityVerifier } from './identity.ts';

/** What the relay said about the connection (peer.open): a claim to cross-check, not proof. */
export interface RelayPeer {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
}

export interface AdmissionDeps {
  readonly invites: InviteService;
  readonly members: MemberDirectoryImpl;
  readonly hub: HubImpl;
  readonly identity: IdentityVerifier;
  readonly settings: SettingsService;
  readonly audit: AuditLog;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly log: Logger;
  readonly limits: LimitsConfig;
  readonly workspace: () => WorkspaceInfo;
  /** Called when a token names a key the daemon does not know yet (rate-limited by the caller). */
  readonly requestKeyRefresh: () => void;
}

/** Everything the channel server needs after daemonAccept resolved. */
export interface Admitted {
  readonly userId: UserId;
  readonly deviceId: string;
  readonly hello: ClientHello;
  readonly mode: HandshakeMode;
  readonly hub: HubAdmission;
}

export type AdmissionResult = { readonly decision: AdmitDecision; readonly admitted: Admitted | null };

export function admitConnection(ctx: AdmitContext, purpose: ChannelPurpose, peer: RelayPeer, deps: AdmissionDeps): AdmissionResult {
  const now = deps.clock.now();
  const reject = (reason: VerdictRejectReason, detail: string, userId: UserId | null): AdmissionResult => {
    const member = userId ? deps.members.get(userId) : null;
    deps.audit.record({
      actor: member ? { kind: 'user', userId: member.userId, displayName: member.displayName } : SYSTEM_ACTOR,
      action: 'auth.rejected',
      outcome: 'denied',
      target: userId ?? peer.userId,
      detail: { reason, why: detail, mode: ctx.mode, purpose },
    });
    return { decision: encodeVerdict({ ok: false, reason }), admitted: null };
  };

  const decoded = decodeClientHello(ctx.helloPayload);
  if (!decoded.ok) return reject(decoded.reason === 'version' ? 'version' : 'identity-invalid', `hello-${decoded.reason}`, null);
  const hello = decoded.hello;
  if (hello.purpose !== purpose) return reject('identity-invalid', 'purpose-mismatch', null);

  const verified = deps.identity.verify(hello.identityToken);
  if (!verified.ok) {
    if (verified.reason === 'unknown-key') {
      // The relay may have rotated its key: fetch the JWKS and let the client retry ('busy' is retried by the SDK).
      deps.requestKeyRefresh();
      return reject('busy', 'identity-key-unknown', null);
    }
    if (isTimeFailure(verified.reason)) {
      // Almost always the host's clock, not the token: say so where the host looks, and re-measure the
      // relay's time (the key fetch reads its Date) so the next attempt is checked against it.
      deps.log.warn("an identity token failed its time check: this computer's clock is probably wrong", {
        why: verified.reason,
        tokenIssuedInSec: verified.iatDeltaMs === undefined ? null : Math.round(verified.iatDeltaMs / 1000),
      });
      deps.requestKeyRefresh();
    }
    return reject('identity-invalid', `token-${verified.reason}`, null);
  }
  const claims = verified.claims;
  const userId = claims.sub;
  if (userId !== peer.userId) return reject('identity-invalid', 'relay-user-mismatch', userId);
  if (!verifyIdentityCnf(claims.cnf, hello.cnfNonce, ctx.clientStaticKey)) return reject('identity-invalid', 'cnf-mismatch', userId);

  let device = deps.members.deviceByKey(ctx.clientStaticKey);
  if (device?.revoked) return reject('device-revoked', 'device-revoked', userId);
  // Its own reason: the person can do something about it (log in as the account the device belongs to, or use another
  // browser profile), which the catch-all identity-invalid could not tell them.
  if (device && device.userId !== userId) return reject('device-other-account', 'device-bound-to-other-user', userId);

  let member: MemberRecord | null = deps.members.get(userId);
  if (ctx.mode === 'invite') {
    // A single-use invite must not be spent on a transfer socket; the client SDK never does this.
    if (purpose !== 'interactive') return reject('invite-invalid', 'invite-on-transfer', userId);
    const invite = ctx.inviteId ? deps.invites.byKeyId(ctx.inviteId) : null;
    if (!invite) return reject('invite-invalid', 'invite-unknown', userId);
    const unusable = deps.invites.unusableReason(invite, now);
    if (unusable !== null) return reject('invite-invalid', `invite-${unusable}`, userId);
    if (invite.boundUserId !== undefined && invite.boundUserId !== userId) return reject('identity-invalid', 'invite-bound-to-other-user', userId);
    // Host power only through the host's own, host-bound invite: the identity comes from the relay, so a relay (or a
    // host OAuth account) under attacker control plus any leaked guest link must not add a host device.
    const isHostUser = userId === deps.members.hostUserId() || (member?.status === 'active' && member.role === 'host');
    if (isHostUser && !(invite.host && invite.role === 'host' && invite.boundUserId === userId)) return reject('invite-invalid', 'host-needs-host-invite', userId);
    if (!isHostUser && invite.role === 'host') return reject('invite-invalid', 'host-invite-for-guest', userId);
    // An active member keeps their role (admitMember): a link of another role must not quietly add a device to them.
    if (member?.status === 'active' && member.role !== invite.role) return reject('invite-invalid', 'invite-role-mismatch', userId);
    if (member?.status === 'kicked' && invite.createdAt <= (member.kickedAt ?? Number.POSITIVE_INFINITY)) return reject('kicked', 'kicked-before-invite', userId);
    if (!withinConnectionCap(deps, userId)) return reject('busy', 'connection-cap', userId);
    // ---- check done: consume and register in the same synchronous step ----
    deps.invites.consume(invite.id, now);
    const admitted = deps.members.admitMember({
      userId,
      displayName: claims.name,
      ...(peer.avatarUrl === undefined ? {} : { avatarUrl: peer.avatarUrl }),
      role: invite.role,
      at: now,
    });
    member = admitted.member;
    const isNewDevice = device === null;
    device = deps.members.addDevice({ userId, publicKey: ctx.clientStaticKey, name: hello.deviceName, kind: hello.clientKind, inviteId: invite.id, at: now });
    deps.audit.record({
      actor: { kind: 'user', userId, displayName: member.displayName },
      action: 'auth.join',
      outcome: 'ok',
      target: invite.id,
      detail: { role: member.role, deviceId: device.deviceId, newMember: admitted.joined, clientKind: hello.clientKind },
    });
    if (admitted.joined) deps.bus.emit('member.joined', { member, device, inviteId: invite.id });
    if (isNewDevice) deps.bus.emit('device.added', { device });
  } else {
    // There is no "device-unknown" reason on the wire: an unknown key is refused like a revoked one.
    if (!device) return reject('device-revoked', 'device-unknown', userId);
    if (!member || member.status !== 'active') return reject('kicked', 'not-a-member', userId);
    if (!withinConnectionCap(deps, userId)) return reject('busy', 'connection-cap', userId);
    deps.members.admitMember({ userId, displayName: claims.name, ...(peer.avatarUrl === undefined ? {} : { avatarUrl: peer.avatarUrl }), role: member.role, at: now });
    deps.members.touch(userId, device.deviceId, now);
    member = deps.members.get(userId) as MemberRecord;
  }

  const hub = deps.hub.prepareAdmission({ purpose, userId, deviceId: device.deviceId, resume: hello.resume });
  deps.audit.record({
    actor: { kind: 'user', userId, displayName: member.displayName },
    action: 'auth.connect',
    outcome: 'ok',
    target: device.deviceId,
    detail: { mode: ctx.mode, purpose, resumed: hub.resumed, clientKind: hello.clientKind },
  });
  const decision = encodeVerdict({
    ok: true,
    welcome: {
      channelId: hub.channelId,
      resumed: hub.resumed,
      member: { ...deps.members.toMember(member), online: true },
      workspace: deps.workspace(),
      settings: deps.settings.public(),
      serverTime: now,
    },
  });
  return { decision, admitted: { userId, deviceId: device.deviceId, hello, mode: ctx.mode, hub } };
}

function withinConnectionCap(deps: AdmissionDeps, userId: UserId): boolean {
  return deps.hub.connections({ userId }).length < deps.limits.maxConnectionsPerUser;
}

// TEST ONLY. A daemon of THIS tree on a copy of what a published smurg wrote, and a person at its door.
//
// The door is net/admission.ts admitConnection(): the one function that decides every handshake, called here as the
// channel server calls it once the Noise handshake has authenticated the knocker's static key (and, with an invite,
// the invite's secret). The handshake and the relay's identity token are replaced by a stand-in that says
// "authentic"; neither reads state.json. Everything else is the daemon's own: its member directory, its invites, its
// hub. The keys are the device keys the people of the fixture's story really used (`devices/<label>/device.key`), the
// links are the ones they really held (`ledger.json`).
//
// Like fixture.ts, this file imports from src/ only what tag v0.5.0 already had.
import { join } from 'node:path';
import { CNF_NONCE_BYTES, PROTOCOL_VERSION, decodeVerdict, deriveInviteKeys, encodeClientHello, identityCnf, parseInviteUrl, toHex, type AdmitContext } from '@smurg/protocol';
import { CLI_DEVICE_KEY_FILE, loadStaticKey, nodeCryptoSuite } from '@smurg/protocol/node';
import { ShiftableClock } from '../../src/core/lifecycle.ts';
import { silentLogger, type Logger } from '../../src/core/logger.ts';
import { admitConnection, type AdmissionDeps } from '../../src/net/admission.ts';
import type { IdentityVerifier } from '../../src/net/identity.ts';
import { createTestDaemon, type TestDaemon } from '../../src/testing/index.ts';
import type { FixtureCopy } from './fixture.ts';

/** A clock that stands at `at` (the instant a fixture was taken) and runs on from there, as a host's clock does. */
export function clockAt(at: number): ShiftableClock {
  const clock = new ShiftableClock();
  clock.advance(at - Date.now());
  return clock;
}

/**
 * The daemon of this tree, every module of the release, started on the copy: the fixture's `~/.smurg`, its workspace
 * id, the (empty) folder its state names as the shared one, the clock at the fixture's instant; the host is the
 * account that hosted the fixture (`dev:host`). Rejects with the daemon's own refusal when the start is refused.
 */
export function startOn(copy: FixtureCopy, options: { readonly clock?: ShiftableClock; readonly log?: Logger } = {}): Promise<TestDaemon> {
  return createTestDaemon({ stateDir: copy.hostHome, workspaceId: copy.workspaceId, root: copy.project, clock: options.clock ?? clockAt(copy.at), ...(options.log === undefined ? {} : { log: options.log }) });
}

/** The public key of a device of the fixture's story: `<dir>/device.key` (32 bytes, the command's format). */
export async function publicKeyIn(dir: string): Promise<Uint8Array> {
  return (await loadStaticKey(dir, CLI_DEVICE_KEY_FILE)).publicKey;
}

export const deviceKeyOf = (copy: FixtureCopy, label: string): Promise<Uint8Array> => publicKeyIn(join(copy.devices, label));

/** A key nobody has seen before. */
export const freshKey = (): Uint8Array => nodeCryptoSuite.generateKeyPair().publicKey;

/** The 16 bytes a handshake names an invite by, from the link a person holds (its secret is the part after `s=`). */
export function inviteIdOfLink(link: string): Uint8Array {
  return deriveInviteKeys(parseInviteUrl(link).secret).inviteId;
}
export const inviteIdHexOfLink = (link: string): string => toHex(inviteIdOfLink(link));

export interface Knock {
  readonly userId: string;
  readonly name?: string;
  /** The device's static public key (what the Noise handshake authenticated). */
  readonly key: Uint8Array;
  /** With an invite link: the handshake is in invite mode. */
  readonly link?: string;
  readonly clientKind?: 'web' | 'cli';
}

/** `in as <role>` or `refused: <the verdict's reason>`. */
export type Answer = `in as ${string}` | `refused: ${string}`;

/** What the daemon answers this person at the door (and, when it lets them in, everything that follows from it). */
export function knock(t: TestDaemon, who: Knock): Answer {
  const nonce = new Uint8Array(CNF_NONCE_BYTES).fill(7);
  const name = who.name ?? who.userId.slice(who.userId.indexOf(':') + 1);
  // The relay's token, as verified: it names the account and is bound to THIS device key.
  const identity = { verify: () => ({ ok: true, claims: { sub: who.userId, name, cnf: identityCnf(nonce, who.key) } }) } as unknown as IdentityVerifier;
  const helloPayload = encodeClientHello({ protocolVersion: PROTOCOL_VERSION, purpose: 'interactive', identityToken: 'stand.in.token', cnfNonce: nonce, clientKind: who.clientKind ?? 'web', deviceName: 'a device of the upgrade tests' });
  const ctx: AdmitContext = { mode: who.link === undefined ? 'device' : 'invite', clientStaticKey: who.key, helloPayload, handshakeHash: new Uint8Array(32), ...(who.link === undefined ? {} : { inviteId: inviteIdOfLink(who.link) }) };
  const { members, invites, hub } = t.daemon.internals;
  const deps: AdmissionDeps = { invites, members, hub, identity, settings: t.ctx.settings, audit: t.ctx.audit, bus: t.ctx.bus, clock: t.clock, log: silentLogger, limits: t.ctx.config.limits, workspace: () => t.ctx.workspace.info, requestKeyRefresh: () => {} };
  const result = admitConnection(ctx, 'interactive', { userId: who.userId, displayName: name }, deps);
  const verdict = decodeVerdict(result.decision.accept, result.decision.payload);
  if (!verdict.ok) throw new Error('the daemon answered with a verdict that cannot be decoded');
  return verdict.verdict.ok ? `in as ${verdict.verdict.welcome.member.role}` : `refused: ${verdict.verdict.reason}`;
}

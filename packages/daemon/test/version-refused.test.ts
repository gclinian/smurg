// A peer of another protocol version (DESIGN B4; ARCHITECTURE §4): admission answers the verdict `version` and says
// so on the bus, with the number the peer speaks and whether the peer is KNOWN. The verdict itself carries the word
// `version` and nothing else, and the audit entry is exactly the one 0.5.0 writes: no new key anywhere on the wire.
//
// Who can make the daemon answer `version`: anyone who can finish the handshake, which takes a relay login and the
// daemon's public key (it is in every invite link ever sent). A kicked member, or an account that never joined, can
// send a hello that says protocol 99. So `known` is true only for a registered, unrevoked device of an active member,
// or for a handshake that used an invite that is usable now; `smurg host` prints its line for those alone.
import { PROTOCOL_VERSION, type AdmitContext } from '@smurg/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonEvents } from '../src/core/interfaces.ts';
import { silentLogger } from '../src/core/logger.ts';
import { SYSTEM_PRINCIPAL } from '../src/core/permissions.ts';
import { admitConnection, type AdmissionDeps } from '../src/net/admission.ts';
import type { IdentityVerifier } from '../src/net/identity.ts';
import { createTestDaemon, type TestDaemon } from '../src/testing/index.ts';

/** msgpack of `{ protocolVersion: n }` (0 <= n < 128): all that is read of a hello of another version. */
const helloOf = (protocolVersion: number): Uint8Array => Uint8Array.from([0x81, 0xa0 | 15, ...Buffer.from('protocolVersion', 'utf8'), protocolVersion]);
const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
/** msgpack of the string `version`: the whole body of the reject verdict. */
const VERSION_VERDICT = Uint8Array.from([0xa0 | 7, ...Buffer.from('version', 'utf8')]);

let t: TestDaemon;
let events: DaemonEvents['peer.version-refused'][];
let tokensLookedAt: number;
let deps: AdmissionDeps;

beforeEach(async () => {
  t = await createTestDaemon({ modules: [] });
  events = [];
  tokensLookedAt = 0;
  t.ctx.bus.on('peer.version-refused', (event) => events.push(event));
  const identity = {
    verify: () => {
      tokensLookedAt += 1;
      return { ok: false, reason: 'malformed' };
    },
  } as unknown as IdentityVerifier;
  const { members, invites, hub } = t.daemon.internals;
  deps = { invites, members, hub, identity, settings: t.ctx.settings, audit: t.ctx.audit, bus: t.ctx.bus, clock: t.clock, log: silentLogger, limits: t.ctx.config.limits, workspace: () => t.ctx.workspace.info, requestKeyRefresh: () => {} };
});
afterEach(async () => {
  await t.cleanup();
});

function knock(key: Uint8Array, protocolVersion: number, inviteKeyId?: Uint8Array): ReturnType<typeof admitConnection> {
  const ctx: AdmitContext = { mode: inviteKeyId === undefined ? 'device' : 'invite', clientStaticKey: key, helloPayload: helloOf(protocolVersion), handshakeHash: new Uint8Array(32), ...(inviteKeyId === undefined ? {} : { inviteId: inviteKeyId }) };
  return admitConnection(ctx, 'interactive', { userId: 'dev:somebody', displayName: 'Somebody' }, deps);
}
const deviceKeyOf = (userId: string): Uint8Array => fromHex((t.daemon.internals.members.devicesOf(userId)[0] as { publicKeyHex: string }).publicKeyHex);
const strangerKey = (): Uint8Array => Uint8Array.from({ length: 32 }, (_, index) => 200 - index);

describe('a peer of another protocol version', () => {
  it('a registered, unrevoked device of an active member: the event says known, with the peer\'s number and the direction', async () => {
    (await t.connect({ userId: 'dev:amy', role: 'editor' })).close();
    const key = deviceKeyOf('dev:amy');

    const newer = knock(key, PROTOCOL_VERSION + 1);
    expect(newer.admitted).toBeNull();
    expect(newer.decision).toEqual({ accept: false, payload: VERSION_VERDICT });
    expect(events).toEqual([{ direction: 'peer-newer', peerProtocol: PROTOCOL_VERSION + 1, known: true }]);

    knock(key, PROTOCOL_VERSION - 1);
    expect(events[1]).toEqual({ direction: 'peer-older', peerProtocol: PROTOCOL_VERSION - 1, known: true });
    // Before anything else is decided: the identity token was never looked at.
    expect(tokensLookedAt).toBe(0);
  });

  it('a hello of this protocol version says nothing on the bus', async () => {
    (await t.connect({ userId: 'dev:amy', role: 'editor' })).close();
    knock(deviceKeyOf('dev:amy'), PROTOCOL_VERSION); // not a whole hello: malformed, another refusal
    expect(events).toEqual([]);
  });

  it('a kicked member with their revoked key, and a key that never joined: not known (the host\'s terminal stays silent)', async () => {
    (await t.connect({ userId: 'dev:erin', role: 'editor' })).close();
    const erin = deviceKeyOf('dev:erin');
    t.ctx.members.kick('dev:erin', SYSTEM_PRINCIPAL);
    knock(erin, PROTOCOL_VERSION + 1);
    knock(strangerKey(), 99);
    expect(events).toEqual([
      { direction: 'peer-newer', peerProtocol: PROTOCOL_VERSION + 1, known: false },
      { direction: 'peer-newer', peerProtocol: 99, known: false },
    ]);
    expect(tokensLookedAt).toBe(0);
  });

  it('a handshake with an invite that is usable now is known; a revoked, a used-up, an expired or an unknown one is not, and no use is spent', async () => {
    const keyIdOf = (id: string): Uint8Array => fromHex((t.ctx.invites.get(id) as { keyIdHex: string }).keyIdHex);
    const usable = t.ctx.invites.create({ role: 'editor', maxUses: 1 }, SYSTEM_PRINCIPAL).invite;
    const revoked = t.ctx.invites.create({ role: 'editor', maxUses: 1 }, SYSTEM_PRINCIPAL).invite;
    t.ctx.invites.revoke(revoked.id, SYSTEM_PRINCIPAL);
    const used = t.ctx.invites.create({ role: 'editor', maxUses: 1 }, SYSTEM_PRINCIPAL).invite;
    t.ctx.invites.consume(used.id, t.clock.now());
    const expiring = t.ctx.invites.create({ role: 'editor', expiresInSec: 60 }, SYSTEM_PRINCIPAL).invite;

    knock(strangerKey(), PROTOCOL_VERSION + 1, keyIdOf(usable.id));
    knock(strangerKey(), PROTOCOL_VERSION + 1, keyIdOf(revoked.id));
    knock(strangerKey(), PROTOCOL_VERSION + 1, keyIdOf(used.id));
    knock(strangerKey(), PROTOCOL_VERSION + 1, keyIdOf(expiring.id));
    knock(strangerKey(), PROTOCOL_VERSION + 1, new Uint8Array(16));
    t.advanceClock(120_000);
    knock(strangerKey(), PROTOCOL_VERSION - 1, keyIdOf(expiring.id));
    expect(events.map((event) => event.known)).toEqual([true, false, false, true, false, false]);
    expect(events.at(-1)).toEqual({ direction: 'peer-older', peerProtocol: PROTOCOL_VERSION - 1, known: false });
    // A `version` refusal is decided before any invite is consumed.
    expect(t.ctx.invites.get(usable.id)).toMatchObject({ uses: 0, revoked: false });
    // The invite's own key does not make a DEVICE-mode knock known.
    knock(strangerKey(), PROTOCOL_VERSION + 1);
    expect(events.at(-1)?.known).toBe(false);
  });

  it('the audit entry is the one 0.5.0 writes: no number, no new key (the audit detail vocabulary is part of the wire)', async () => {
    (await t.connect({ userId: 'dev:amy', role: 'editor' })).close();
    knock(deviceKeyOf('dev:amy'), PROTOCOL_VERSION + 1);
    await t.ctx.audit.flush();
    const entry = (await t.ctx.audit.query({ limit: 50 })).find((candidate) => candidate.action === 'auth.rejected');
    expect(entry).toMatchObject({ actor: { kind: 'system' }, outcome: 'denied', target: 'dev:somebody' });
    expect(entry?.detail).toEqual({ reason: 'version', why: 'hello-version', mode: 'device', purpose: 'interactive' });
  });
});

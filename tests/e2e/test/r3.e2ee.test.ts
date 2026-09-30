// SPEC R3 acceptance: end-to-end encryption. HARD GATE (SPEC §0): every criterion is an automated test here, against
// the real relay (local workerd with the byte tap), the real daemon and SDK clients.
//  (a) 「在 relay 端記錄所有經過的位元組，找不到任何明文的檔案內容、終端機輸出或指令」
//  (b) 「relay 把 daemon 公鑰替換成自己的公鑰時，客戶端拒絕連線並顯示警告」
//  (c) 「沒有有效邀請片段的客戶端無法完成第一次握手」
//  (d) 「被撤銷的裝置金鑰無法再建立連線」
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHANNEL_FRAME,
  MAIN_ROOT,
  daemonKeyFingerprint,
  deriveInviteKeys,
  equalBytes,
  isGenericAbortFrame,
  parseInviteUrl,
  toBase64Url,
  x25519KeyPair,
} from '@smurg/protocol';
import { RelayApi } from '@smurg/protocol/client';
import { prefixFrame, wsClientUrl } from '@smurg/protocol/relay';
import { connectRelaySocket, findPlaintext, startLocalRelay, type LocalRelay, type TapFrame } from '@smurg/relay/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The daemon's test Yjs client (a provider over doc.*): test-only relative import.
import { DocClient } from '../../../packages/daemon/test/docs/helpers.ts';
import { startStack, waitUntil, type Stack, type StackClient, type StackDevice } from '../src/harness.ts';
import { startMaliciousRelay, type KeySubstitution, type MaliciousRelay } from '../src/mitm-relay.ts';
import { missingFrom } from '../src/wire.ts';

let relay: LocalRelay;

beforeAll(async () => {
  relay = await startLocalRelay({ tap: true });
});

afterAll(async () => {
  await relay?.stop();
});

/** A unique marker of well over 16 bytes (shorter ones occur in ciphertext by chance; noise.md gotcha 18). */
function marker(label: string): string {
  return `SMURG-R3-${label}-${nodeRandomBytes(12).toString('hex')}`;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function tapOf(stack: Stack): TapFrame[] {
  return (relay.tap?.frames() ?? []).filter((f) => f.workspaceId === stack.workspaceId);
}

function tapped(stack: Stack, direction: 'in' | 'out'): Buffer[] {
  return tapOf(stack)
    .filter((f) => f.kind === 'binary' && f.direction === direction)
    .map((f) => f.data);
}

/** Raw byte needles (keys, secrets) anywhere in what the relay saw. */
function containsBytes(frames: readonly TapFrame[], needle: Uint8Array): boolean {
  const n = Buffer.from(needle);
  return frames.some((f) => f.data.includes(n));
}

async function terminal(client: StackClient, timeoutMs = 15_000) {
  return client.waitFor((s) => s.kind === 'rejected' || s.kind === 'closed' || s.kind === 'key-mismatch', timeoutMs);
}

/** Connection ids the relay gave this client's sockets (from its `hello` frames). */
function connIdsOf(stack: Stack, label: string): number[] {
  const conns: number[] = [];
  for (const frame of stack.wire.frames({ side: 'client', label, direction: 'received', kind: 'text' })) {
    try {
      const json = JSON.parse(frame.data.toString('utf8')) as { t?: string; conn?: number };
      if (json.t === 'hello' && typeof json.conn === 'number') conns.push(json.conn);
    } catch {
      // "pong"
    }
  }
  return conns;
}

describe('R3 (a) relay byte tap', () => {
  it('在 relay 端記錄所有經過的位元組，找不到任何明文的檔案內容、終端機輸出或指令', async () => {
    const stack = await startStack({ relay, projectFiles: { 'README.md': '# r3\n' } });
    try {
      const M = {
        fileContent: marker('FILE-CONTENT'),
        fileName: marker('FILE-NAME'),
        bigFile: marker('BIG-FILE'),
        uploadChunk: marker('UPLOAD-CHUNK'),
        terminalInput: marker('TERM-INPUT'),
        command: marker('COMMAND'),
        suggestion: marker('SUGGESTION'),
        terminalOutput: marker('TERM-OUTPUT'),
        docUpdate: marker('DOC-UPDATE'),
        changedPath: marker('CHANGED-PATH'),
        ptyOutput: marker('PTY-OUTPUT'),
        docEdit: marker('DOC-EDIT'),
      };
      const amy = await stack.join({ name: 'amy', role: 'runner' });
      const bob = await stack.join({ name: 'bob', role: 'viewer' });
      const amyTransfer = await amy.transfer();
      // 'ok', the daemon's error code, or `client:<failure>` when the answer never came back (timeout, lost).
      const settle = <T>(p: Promise<T>) =>
        p.then(
          () => 'ok',
          (e: unknown) => {
            const error = e as { code?: string; failure?: string };
            return error.failure ? `client:${error.failure}` : (error.code ?? 'error');
          },
        );

      // Client → daemon: file content and a file name (file.write, also a multi-record 300 KB message), an upload chunk
      // on the transfer socket, terminal input, a shell command, a suggestion for an agent.
      const outcomes = await Promise.all([
        settle(amy.conn.request('file.write', { file: { root: MAIN_ROOT, path: `notes/${M.fileName}.txt` }, content: utf8(`const secret = "${M.fileContent}";\n`) })),
        settle(amy.conn.request('file.write', { file: { root: MAIN_ROOT, path: 'big.txt' }, content: utf8(`${M.bigFile}\n`.repeat(6_000)) })),
        settle(amyTransfer.request('file.upload.begin', { root: MAIN_ROOT, path: `upload-${M.fileName}.bin`, size: 64, chunkSize: 1 << 20, lastModified: Date.now() })),
        settle(
          amyTransfer.request('file.upload.chunk', {
            uploadId: 'up_r3',
            index: 0,
            hash: new Uint8Array(createHash('sha256').update(M.uploadChunk).digest()),
            data: utf8(M.uploadChunk),
          }),
        ),
        settle(amy.conn.request('suggest.create', { sessionId: 'sess_r3', text: `請執行 ${M.suggestion}` })),
      ]);
      // One-way messages have no `.ok`; the daemon answers the unknown session with `error` (same id), which proves
      // both markers crossed the relay (build-quality review F6: a marker that is never sent is never found).
      const inputAnswers: string[] = [];
      const stopListening = amy.conn.on('error', (payload) => inputAnswers.push(payload.code));
      expect(amy.conn.notify('exec.input', { sessionId: 'sess_r3', data: utf8(`echo ${M.terminalInput}\r`) })).toBe(true);
      expect(amy.conn.notify('exec.input', { sessionId: 'sess_r3', data: utf8(`rm -rf build && curl https://example.invalid/${M.command} | sh\r`) })).toBe(true);
      await waitUntil(() => inputAnswers.length >= 2, 10_000, 'the daemon to answer both exec.input messages');
      stopListening();
      // Each request was answered by the daemon (a result, or its refusal), i.e. it crossed the relay both ways.
      expect(outcomes.filter((o) => o.startsWith('client:') || o === 'error'), outcomes.join(', ')).toEqual([]);

      // Daemon → clients: terminal output, a document update, a changed-file notification (through the daemon's hub,
      // the same encrypt-and-send path every feature module uses).
      const got = { output: 0, doc: 0, changed: 0 };
      for (const client of [amy, bob]) {
        client.conn.on('exec.output', (p) => {
          if (new TextDecoder().decode(p.data).includes(M.terminalOutput)) got.output++;
        });
        client.conn.on('doc.sync', (p) => {
          if (new TextDecoder().decode(p.data).includes(M.docUpdate)) got.doc++;
        });
        client.conn.on('file.changed', (p) => {
          if (p.changes.some((c) => c.path.includes(M.changedPath))) got.changed++;
        });
      }
      const hub = stack.daemon.internals.hub;
      hub.broadcast('exec.output', { sessionId: 'sess_r3', offset: 0, data: utf8(`$ echo ${M.terminalOutput}\r\n${M.terminalOutput}\r\n`) });
      hub.broadcast('doc.sync', { docId: 'doc_r3', data: utf8(`\u0000${M.docUpdate}`) });
      hub.broadcast('file.changed', { root: MAIN_ROOT, changes: [{ path: `src/${M.changedPath}.ts`, change: 'change' }] });
      await waitUntil(() => got.output === 2 && got.doc === 2 && got.changed === 2, 10_000, 'both clients to receive the daemon events');
      // If the file module is composed, real file content read from disk crosses the relay too.
      if (stack.daemon.ctx.router.has('file.read')) {
        await amy.conn.request('file.read', { file: { root: MAIN_ROOT, path: 'README.md' } });
      }
      // The real modules: a real terminal session's own output (the full marker exists only in what the PTY prints:
      // the input carries it in two halves) and a real Yjs edit of a document, fanned out to Bob and saved to disk.
      const { session } = await amy.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 });
      let ptyText = '';
      amy.conn.on('exec.output', (p) => {
        if (p.sessionId === session.id) ptyText += new TextDecoder().decode(p.data);
      });
      await amy.conn.request('session.attach', { sessionId: session.id });
      const half = Math.floor(M.ptyOutput.length / 2);
      amy.conn.notify('exec.input', { sessionId: session.id, data: utf8(`printf '%s%s\\n' '${M.ptyOutput.slice(0, half)}' '${M.ptyOutput.slice(half)}'\r`) });
      await waitUntil(() => ptyText.includes(M.ptyOutput), 20_000, 'the real PTY output');
      const amyDoc = await DocClient.open(amy.conn, { root: MAIN_ROOT, path: 'README.md' });
      const bobDoc = await DocClient.open(bob.conn, { root: MAIN_ROOT, path: 'README.md' });
      try {
        await waitUntil(() => amyDoc.synced && bobDoc.synced, 15_000, 'both editors');
        amyDoc.text.insert(amyDoc.text.length, `${M.docEdit}\n`);
        await waitUntil(() => bobDoc.text.toString().includes(M.docEdit), 15_000, 'the edit at Bob');
        await waitUntil(async () => (await readFile(join(stack.root, 'README.md'), 'utf8')).includes(M.docEdit), 15_000, 'the autosave');
      } finally {
        amyDoc.destroy();
        bobDoc.destroy();
      }

      // ---- Completeness: every frame any socket of this stack sent was recorded by the relay, and the relay recorded
      // nothing nobody sent (both directions, both Durable Objects, host frames with their 4-byte connection prefix).
      const sentBefore = stack.wire.frames({ direction: 'sent', kind: 'binary' }).map((f) => f.data);
      const receivedBefore = stack.wire.frames({ direction: 'received', kind: 'binary' }).map((f) => f.data);
      const tap = relay.tap;
      if (!tap) throw new Error('the relay runs without its tap');
      await tap.waitFor(() => missingFrom(tapped(stack, 'in'), sentBefore).length === 0 && missingFrom(tapped(stack, 'out'), receivedBefore).length === 0, 15_000);
      const tapIn = tapped(stack, 'in');
      const tapOut = tapped(stack, 'out');
      // A frame the relay recorded on its way out may still be in flight to its socket: give it a moment to land.
      const received = () => stack.wire.frames({ direction: 'received', kind: 'binary' }).map((f) => f.data);
      await waitUntil(() => missingFrom(received(), tapOut).length === 0, 5_000, 'every frame the relay sent to be received').catch(() => undefined);
      const sentAfter = stack.wire.frames({ direction: 'sent', kind: 'binary' }).map((f) => f.data);
      const receivedAfter = received();
      expect(missingFrom(tapIn, sentBefore), 'frames sent but not recorded by the relay').toEqual([]);
      expect(missingFrom(sentAfter, tapIn), 'frames the relay recorded that no socket sent').toEqual([]);
      expect(missingFrom(tapOut, receivedBefore), 'frames received but not recorded by the relay').toEqual([]);
      expect(missingFrom(receivedAfter, tapOut), 'frames the relay recorded as sent that no socket received').toEqual([]);
      const bytes = (list: readonly Buffer[]) => list.reduce((n, b) => n + b.length, 0);
      const sources = new Set(tapOf(stack).filter((f) => f.kind === 'binary').map((f) => f.source));
      expect(sources).toEqual(new Set(['WorkspaceDO', 'TransferDO']));
      console.info(
        `[R3a] requests answered: ${outcomes.join(', ')}; tap complete: ${sentBefore.length} frames / ${bytes(sentBefore)} bytes sent, all recorded (${tapIn.length} frames / ${bytes(tapIn)} bytes in, ${tapOut.length} out, ${tapOf(stack).length} records incl. control and requests)`,
      );

      // ---- No plaintext: no marker in any encoding, anywhere the relay could look (frames, control text, requests).
      const everything = tapOf(stack);
      for (const [name, value] of Object.entries(M)) expect(findPlaintext(everything, value), `marker ${name}`).toEqual([]);
      // Nor any key or secret: every invite's secret `s`, its invite id and PSK, the daemon's key and its fingerprint
      // `k`, every device key. (The relay may know the account behind a connection, never the device: SPEC R3.)
      const secrets: [string, Uint8Array][] = [
        ['daemon static key', stack.daemon.daemonPublicKey],
        ['daemon key fingerprint (k)', daemonKeyFingerprint(stack.daemon.daemonPublicKey)],
      ];
      expect(stack.invitesIssued.length).toBe(3); // host, amy, bob
      for (const [i, link] of stack.invitesIssued.entries()) {
        const { secret } = parseInviteUrl(link);
        const { inviteId, psk } = deriveInviteKeys(secret);
        secrets.push([`invite ${i} secret s`, secret], [`invite ${i} id`, inviteId], [`invite ${i} psk`, psk]);
      }
      for (const client of [stack.hostClient, amy, bob]) {
        secrets.push([`${client.name} device key`, (await client.device.deviceKeys.getKeyPair(stack.workspaceId)).publicKey]);
      }
      for (const [name, value] of secrets) {
        expect(containsBytes(everything, value), `${name} (raw)`).toBe(false);
        expect(findPlaintext(everything, toBase64Url(value)), `${name} (base64url text)`).toEqual([]);
      }

      // ---- Positive control on this very relay and workspace: plaintext on the same path IS found, both ways.
      const control = { up: marker('CONTROL-UP'), upBase64: marker('CONTROL-UP-B64'), down: marker('CONTROL-DOWN') };
      const mallory = await stack.login('mallory');
      const probe = connectRelaySocket(wsClientUrl(relay.origin, stack.workspaceId), { token: mallory.token });
      try {
        await probe.opened;
        const hello = await probe.nextControl('hello');
        probe.send(utf8(`plaintext frame: ${control.up}`));
        probe.send(utf8(`encoded frame: ${Buffer.from(control.upBase64).toString('base64')}`));
        expect(stack.hostLink.sendRaw('ws', prefixFrame(Number(hello['conn']), utf8(`plaintext down: ${control.down}`)))).toBe(true);
        // (The probe also gets the daemon's generic ABORTs for its garbage "handshake".)
        await probe.next((f) => f.kind === 'binary' && f.data.includes(Buffer.from(control.down)));
        await tap.waitFor(
          (frames) =>
            findPlaintext(frames.filter((f) => f.workspaceId === stack.workspaceId), control.up).length > 0 &&
            findPlaintext(frames.filter((f) => f.workspaceId === stack.workspaceId), control.upBase64).length > 0 &&
            findPlaintext(frames.filter((f) => f.workspaceId === stack.workspaceId && f.direction === 'out'), control.down).length > 0,
          10_000,
        );
        const after = tapOf(stack);
        expect(findPlaintext(after, control.up)).toContain('utf8');
        expect(findPlaintext(after, control.upBase64)).toContain('base64');
        expect(findPlaintext(after.filter((f) => f.direction === 'out' && f.role === 'client'), control.down)).toContain('utf8');
        // …while the real markers are still nowhere.
        for (const value of Object.values(M)) expect(findPlaintext(after, value)).toEqual([]);
      } finally {
        probe.terminate();
      }
    } finally {
      await stack.stop();
    }
  });
});

describe('R3 (b) key substitution by the relay', () => {
  /** A device of `name` whose relay is the attacker (logins and tokens still come from the real relay through it). */
  async function deviceBehind(stack: Stack, mitm: MaliciousRelay, name: string, device?: StackDevice): Promise<StackDevice> {
    const base = device ?? (await stack.newDevice(name));
    return { ...base, api: new RelayApi({ relayUrl: mitm.origin, auth: { kind: 'bearer', token: base.session.token } }) };
  }

  function assertNoMsg3(mitm: MaliciousRelay): void {
    expect(mitm.attempts.length).toBeGreaterThan(0);
    for (const attempt of mitm.attempts) {
      if (attempt.mode === null) continue;
      expect(attempt.replied, 'the attacker answered the HELLO with its own msg2').toBe(true);
      // FINISH carries msg3 (the client's static key and hello, encrypted to the attacker): never sent. No DATA either.
      expect(attempt.clientFrames.filter((f) => f[0] === CHANNEL_FRAME.FINISH)).toEqual([]);
      expect(attempt.clientFrames.filter((f) => f[0] === CHANNEL_FRAME.DATA)).toEqual([]);
      expect(attempt.clientFrames[0]?.[0]).toBe(CHANNEL_FRAME.HELLO);
    }
  }

  /** First contact through the malicious relay, then the same link through the honest one. */
  async function firstContactThroughAttacker(
    substitution: (secret: Uint8Array) => KeySubstitution,
    expectedDetail: 'unauthenticated' | 'fingerprint',
  ): Promise<void> {
    const stack = await startStack({ relay });
    let mitm: MaliciousRelay | null = null;
    try {
      const invite = await stack.createInvite('editor');
      const { secret } = parseInviteUrl(invite);
      mitm = await startMaliciousRelay({ upstream: relay.origin, workspaceId: stack.workspaceId, substitution: substitution(secret) });
      const victim = await deviceBehind(stack, mitm, 'amy');
      const amy = await stack.join({ name: 'amy', device: victim, invite, waitOnline: false });
      // The client refuses and surfaces the warning state (the web app renders it as the SPEC R3 warning).
      expect(await terminal(amy)).toEqual({ kind: 'key-mismatch', mode: 'invite', detail: expectedDetail });
      expect(amy.states.some((r) => r.state.kind === 'online')).toBe(false);
      assertNoMsg3(mitm);
      // Nothing of the attacker's key was accepted: no pin, and the real daemon never saw a join attempt.
      expect(await victim.pins.get(stack.workspaceId)).toBeNull();
      const { invites } = await stack.hostClient.conn.request('admin.invite.list', {});
      expect(invites.find((i) => i.role === 'editor')?.uses).toBe(0);
      expect(stack.daemon.ctx.members.get(amy.userId)).toBeNull();

      // Control: the same device and the same (still unused) link through the honest relay work, and pin the real key.
      const honest = await stack.join({ name: 'amy', device: { ...victim, api: (await stack.newDevice('amy')).api }, invite });
      expect(honest.welcome?.member.userId).toBe(amy.userId);
      expect(equalBytes((await victim.pins.get(stack.workspaceId)) ?? new Uint8Array(), stack.daemon.daemonPublicKey)).toBe(true);
    } finally {
      await mitm?.close();
      await stack.stop();
    }
  }

  it('relay 把 daemon 公鑰替換成自己的公鑰時，客戶端拒絕連線並顯示警告 — a relay that knows only what relays know (first contact)', () =>
    firstContactThroughAttacker(() => ({ kind: 'blind' }), 'unauthenticated'));

  it('relay 把 daemon 公鑰替換成自己的公鑰時，客戶端拒絕連線並顯示警告 — worst case: the relay also holds the invite secret (first contact)', () =>
    firstContactThroughAttacker((secret) => ({ kind: 'leaked-invite', secret }), 'fingerprint'));

  it('control: the attacker is real — a client told to trust its key completes the handshake up to msg3', async () => {
    // Guards the assertions above against vacuity: the malicious relay does produce a genuine handshake, and it does
    // observe a FINISH (msg3) whenever a client accepts its key. Here the invite fragment itself names the attacker's
    // key (k) and the attacker holds the secret: the client proceeds, the attacker sees msg3.
    const stack = await startStack({ relay });
    let mitm: MaliciousRelay | null = null;
    try {
      const secret = nodeRandomBytes(32);
      mitm = await startMaliciousRelay({ upstream: relay.origin, workspaceId: stack.workspaceId, substitution: { kind: 'leaked-invite', secret } });
      const trustingAttacker = `${relay.origin}/join/${stack.workspaceId}#k=${toBase64Url(daemonKeyFingerprint(mitm.attackerKey.publicKey))}&s=${toBase64Url(secret)}`;
      const victim = await deviceBehind(stack, mitm, 'vic');
      const vic = await stack.join({ name: 'vic', device: victim, invite: trustingAttacker, waitOnline: false });
      expect((await terminal(vic)).kind).toBe('rejected'); // the attacker's admit() refuses; it already has msg3
      const attempt = mitm.attempts.find((a) => a.mode === 'invite');
      expect(attempt?.replied).toBe(true);
      expect(attempt?.clientFrames.some((f) => f[0] === CHANNEL_FRAME.FINISH)).toBe(true);
      expect(equalBytes((await victim.pins.get(stack.workspaceId)) ?? new Uint8Array(), mitm.attackerKey.publicKey)).toBe(true);
    } finally {
      await mitm?.close();
      await stack.stop();
    }
  });

  it('relay 把 daemon 公鑰替換成自己的公鑰時，客戶端拒絕連線並顯示警告 — reconnect of a device that pinned the real key', async () => {
    const stack = await startStack({ relay });
    let mitm: MaliciousRelay | null = null;
    try {
      const amy = await stack.join({ name: 'amy', role: 'editor' });
      amy.close();
      const pinned = await amy.device.pins.get(stack.workspaceId);
      expect(pinned && equalBytes(pinned, stack.daemon.daemonPublicKey)).toBe(true);
      mitm = await startMaliciousRelay({ upstream: relay.origin, workspaceId: stack.workspaceId, substitution: { kind: 'blind' } });
      const behind = await deviceBehind(stack, mitm, 'amy', amy.device);
      const again = await stack.join({ name: 'amy', device: behind, invite: null, waitOnline: false });
      expect(await terminal(again)).toEqual({ kind: 'key-mismatch', mode: 'device', detail: 'fingerprint' });
      assertNoMsg3(mitm);
      expect(mitm.attempts.every((a) => a.mode === 'device' || a.mode === null)).toBe(true);
      // The pin is untouched: a changed daemon key is never accepted silently.
      expect(equalBytes((await amy.device.pins.get(stack.workspaceId)) ?? new Uint8Array(), stack.daemon.daemonPublicKey)).toBe(true);
    } finally {
      await mitm?.close();
      await stack.stop();
    }
  });
});

describe('R3 (c) no valid invite fragment', () => {
  it('沒有有效邀請片段的客戶端無法完成第一次握手', async () => {
    const stack = await startStack({ relay });
    try {
      const real = parseInviteUrl(await stack.createInvite('editor', { maxUses: 10 }));
      const url = (fingerprint: Uint8Array, secret: Uint8Array) =>
        `${relay.origin}/join/${stack.workspaceId}#k=${toBase64Url(fingerprint)}&s=${toBase64Url(secret)}`;
      const flipped = real.secret.slice();
      flipped[7] = (flipped[7] ?? 0) ^ 0x01;
      const toRevoke = await stack.hostClient.conn.request('admin.invite.create', { role: 'editor', maxUses: 10 });
      const revokedLink = toRevoke.url;
      await stack.hostClient.conn.request('admin.invite.revoke', { inviteId: toRevoke.invite.id });

      // 1. No fragment at all: nothing to trust, nothing is sent.
      const none = await stack.join({ name: 'nora', invite: null, waitOnline: false });
      expect(await terminal(none)).toEqual({ kind: 'closed', reason: 'no-trust' });
      expect(stack.wire.frames({ side: 'client', label: 'nora', direction: 'sent', kind: 'binary' })).toEqual([]);

      // 2. The right daemon key but a made-up secret, 3. a real secret with one bit flipped: the daemon cannot match
      // the HELLO to any invite and answers only the generic cleartext ABORT; the client gives up.
      const forged = await stack.join({ name: 'fred', invite: url(real.fingerprint, nodeRandomBytes(32)), waitOnline: false });
      const flip = await stack.join({ name: 'fiona', invite: url(real.fingerprint, flipped), waitOnline: false });
      expect(await terminal(forged)).toEqual({ kind: 'rejected', reason: 'aborted' });
      expect(await terminal(flip)).toEqual({ kind: 'rejected', reason: 'aborted' });

      // 4. A revoked invite: the HELLO matches, then the authenticated verdict refuses it.
      const revoked = await stack.join({ name: 'rita', invite: revokedLink, waitOnline: false });
      expect(await terminal(revoked)).toEqual({ kind: 'rejected', reason: 'invite-invalid' });

      // 5. The real secret with someone else's key fingerprint: the client itself refuses the daemon at msg2.
      const wrongK = await stack.join({ name: 'kate', invite: url(daemonKeyFingerprint(x25519KeyPair().publicKey), real.secret), waitOnline: false });
      expect(await terminal(wrongK)).toEqual({ kind: 'key-mismatch', mode: 'invite', detail: 'fingerprint' });

      for (const client of [none, forged, flip, revoked, wrongK]) {
        expect(client.states.some((r) => r.state.kind === 'online'), client.name).toBe(false);
        expect(stack.daemon.ctx.members.get(client.userId), client.name).toBeNull();
      }
      // Nobody got a device registered, and the real invite was never used.
      expect(stack.daemon.ctx.members.list().map((m) => m.userId)).toEqual([stack.host.userId]);
      const after = await stack.hostClient.conn.request('admin.invite.list', {});
      expect(after.invites.every((i) => i.role === 'host' || i.uses === 0)).toBe(true);

      // The relay's view of the forged-secret attempts: the daemon never sent a REPLY (msg2), only the ABORT.
      const tap = relay.tap;
      if (!tap) throw new Error('the relay runs without its tap');
      for (const name of ['fred', 'fiona']) {
        const conns = connIdsOf(stack, name);
        expect(conns.length, `${name} opened sockets`).toBeGreaterThan(0);
        await tap.waitFor((frames) => frames.some((f) => f.workspaceId === stack.workspaceId && f.role === 'client' && conns.includes(f.conn) && f.direction === 'out' && f.kind === 'binary'), 10_000);
        await tap.waitForQuiet(200, 10_000).catch(() => undefined);
        const toClient = tapOf(stack).filter((f) => f.role === 'client' && conns.includes(f.conn) && f.direction === 'out' && f.kind === 'binary');
        expect(toClient.length, `${name}: daemon frames`).toBeGreaterThan(0);
        expect(toClient.every((f) => isGenericAbortFrame(new Uint8Array(f.data))), `${name}: only generic ABORTs`).toBe(true);
      }
    } finally {
      await stack.stop();
    }
  });
});

describe('R3 (d) revoked device keys', () => {
  it('被撤銷的裝置金鑰無法再建立連線', async () => {
    const stack = await startStack({ relay });
    try {
      const amy = await stack.join({ name: 'amy', role: 'editor' });
      const key = await amy.device.deviceKeys.getKeyPair(stack.workspaceId);
      await stack.hostClient.conn.request('admin.member.kick', { userId: amy.userId });
      await amy.waitFor((s) => s.kind === 'closed');
      const devices = stack.daemon.ctx.members.devicesOf(amy.userId);
      expect(devices.length).toBe(1);
      expect(devices.every((d) => d.revoked)).toBe(true);

      // Interactive socket, device mode (the pinned daemon key; the handshake itself is fine, admission is not).
      const deviceMode = await amy.reconnect({ waitOnline: false });
      expect(await terminal(deviceMode)).toEqual({ kind: 'rejected', reason: 'device-revoked' });
      // A fresh invite made after the kick does not launder the revoked key.
      const freshLink = await stack.createInvite('editor');
      const viaFreshInvite = await amy.reconnect({ invite: freshLink, waitOnline: false, connection: { preferInvite: true } });
      expect(await terminal(viaFreshInvite)).toEqual({ kind: 'rejected', reason: 'device-revoked' });
      // The transfer socket (its own handshake through TransferDO) refuses it too.
      await expect(amy.transfer()).rejects.toMatchObject({ state: { kind: 'rejected', reason: 'device-revoked' } });
      expect(stack.daemon.internals.hub.connections({ userId: amy.userId })).toHaveLength(0);
      const denied = (await stack.audit()).filter((e) => e.action === 'auth.rejected' && e.target === amy.userId && e.detail?.['reason'] === 'device-revoked');
      expect(denied.length).toBeGreaterThanOrEqual(3);

      // Control: the fresh link (still unused) with a NEW key gets in; the revoked key stays revoked.
      const newDevice = await stack.join({ name: 'amy', invite: freshLink });
      expect(newDevice.welcome?.member.userId).toBe(amy.userId);
      const newKey = await newDevice.device.deviceKeys.getKeyPair(stack.workspaceId);
      expect(equalBytes(newKey.publicKey, key.publicKey)).toBe(false);
      expect(stack.daemon.ctx.members.deviceByKey(key.publicKey)?.revoked).toBe(true);
    } finally {
      await stack.stop();
    }
  });
});

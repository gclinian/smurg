// Self-test of the acceptance harness: the stack really is relay + daemon + clients over the network, the wire log
// sees both ends, and pauseHost() silences the host without closing its sockets (what R1's measurement relies on).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalRelay, type LocalRelay } from '@smurg/relay/testing';
import { startStack, waitUntil } from '../src/harness.ts';
import { missingFrom } from '../src/wire.ts';

let relay: LocalRelay;

beforeAll(async () => {
  relay = await startLocalRelay({ tap: true });
});

afterAll(async () => {
  await relay?.stop();
});

describe('acceptance harness', () => {
  it('compares frame multisets exactly (the R3 completeness check)', () => {
    const a = Buffer.from('frame-a');
    const b = Buffer.from('frame-b');
    expect(missingFrom([a, b, a], [a, a, b])).toEqual([]);
    expect(missingFrom([a, b], [a, a])).toEqual([a]);
    expect(missingFrom([a], [Buffer.from('frame-a!')])).toHaveLength(1);
    expect(missingFrom([], [])).toEqual([]);
  });

  it('can share a git repository (R9), with a fake home and socket paths that fit macOS (contract review C1, C5, C9)', async () => {
    const stack = await startStack({ relay, git: true, projectFiles: { 'src/app.ts': 'export {};\n' } });
    try {
      expect(stack.hostClient.welcome?.workspace.isGitRepo).toBe(true);
      expect(stack.daemon.config.sessions.hostHome).toBe(stack.homeDir);
      expect(Buffer.byteLength(stack.daemon.config.runPaths.hook)).toBeLessThanOrEqual(103);
      expect(stack.daemon.config.runDir).toBe(stack.runDir);
    } finally {
      await stack.stop();
    }
  });

  it('runs the real relay, the real daemon and SDK clients, and records both ends of the wire', async () => {
    const stack = await startStack({ relay });
    try {
      expect(stack.hostClient.welcome?.member.role).toBe('host');
      const amy = await stack.join({ name: 'amy', role: 'editor' });
      expect(amy.welcome?.member).toMatchObject({ userId: 'dev:amy', role: 'editor' });
      const { members } = await stack.hostClient.conn.request('admin.member.list', {});
      expect(members.map((m) => m.userId).sort()).toEqual(['dev:amy', 'dev:host']);
      // Both ends recorded: the daemon's host sockets and the clients' sockets.
      expect(stack.wire.frames({ side: 'host', direction: 'sent', kind: 'binary' }).length).toBeGreaterThan(0);
      expect(stack.wire.frames({ side: 'client', direction: 'sent', kind: 'binary', label: 'amy' }).length).toBeGreaterThan(0);
      const room = await relay.inspect('ws', stack.workspaceId);
      expect(room.clients.map((c) => c.userId).sort()).toEqual(['dev:amy', 'dev:host']);
    } finally {
      await stack.stop();
    }
  });

  it('pauseHost() keeps the host socket open but silent; resumeHost() brings the host back', async () => {
    const stack = await startStack({ relay });
    try {
      const amy = await stack.join({ name: 'amy' });
      const epochBefore = (await relay.inspect('ws', stack.workspaceId)).hostEpoch;
      const sentBefore = stack.wire.frames({ side: 'host', direction: 'sent' }).length;
      stack.pauseHost();
      // 4 s later the relay still counts the host as online (no close reached it), and nothing left the daemon.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const room = await relay.inspect('ws', stack.workspaceId);
      expect(room.hostStatus).toBe('online');
      expect(room.hostEpoch).toBe(epochBefore);
      expect(stack.wire.frames({ side: 'host', direction: 'sent' }).length).toBe(sentBefore);
      expect(stack.hostLink.heldActions).toBeGreaterThan(0);
      await amy.waitFor((s) => s.kind === 'host-offline', 10_000);
      stack.resumeHost();
      await amy.waitFor((s) => s.kind === 'online', 20_000);
      await waitUntil(async () => (await relay.inspect('ws', stack.workspaceId)).hostStatus === 'online', 10_000, 'the host back online');
    } finally {
      await stack.stop();
    }
  });
});

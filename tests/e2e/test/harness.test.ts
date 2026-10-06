// Self-test of the acceptance harness: the stack really is relay + daemon + clients over the network, the wire log
// sees both ends, and pauseHost() silences the host without closing its sockets (what R1's measurement relies on).
// Since protocol 4: an agent session of a stack is the stand-in for Claude Code or nothing (never a `claude` found on
// this computer), and a stack's daemon can stop and start again under clients that stay connected.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalRelay, type LocalRelay } from '@smurg/relay/testing';
import { member, refusal, sessionReady, turnsFinished } from '../src/flow.ts';
import { CLI_MAIN, startStack, waitUntil } from '../src/harness.ts';
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
  it('never starts the developer\'s own claude: a hook command without a named claude is refused, and a plain stack refuses agent sessions before it looks for one', async () => {
    // A hook command makes agent sessions startable; without a `claudePath` the daemon would take the first `claude`
    // on PATH, with the login it finds there: refused before a folder, a relay or a daemon is made.
    await expect(startStack({ relay, sessions: { selfCommand: { file: process.execPath, args: [CLI_MAIN] } } })).rejects.toThrow(/needs `sessions.claudePath`/);
    await expect(startStack({ relay, claude: true, sessions: { claudePath: '/usr/bin/true' } })).rejects.toThrow(/not both/);
    // A stack without `claude` and without `sessions`: no hook command, so an agent session is refused at once.
    const stack = await startStack({ relay });
    try {
      expect(stack.claude).toBeUndefined();
      expect(stack.daemon.config.sessions.selfCommand).toBeNull();
      expect(await refusal(stack.hostClient.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' } }))).toMatchObject({ id: 'session.hooks.notConfigured' });
      expect((await stack.hostClient.conn.request('session.list', {})).sessions).toEqual([]);
      expect(await stack.agentProcesses()).toEqual([]);
    } finally {
      await stack.stop();
    }
  });

  it('with `claude`, agent sessions run the stand-in with the real hook command; the daemon restarts on the same folder and state, and the clients come back by themselves', async () => {
    const stack = await startStack({ relay, git: true, claude: { turns: [{ steps: [{ text: 'ok' }] }] } });
    try {
      expect(stack.daemon.config.sessions).toMatchObject({ claudePath: stack.claude?.path, hostHome: stack.homeDir, selfCommand: { file: process.execPath, args: [CLI_MAIN] } });
      const host = member(stack.hostClient, 'Host', 'host');
      const amy = member(await stack.join({ name: 'amy', role: 'agent' }), 'Amy', 'agent');
      const { session } = await amy.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' } });
      await sessionReady(host, session.id);
      for (const one of [host, amy]) await one.watch(session.id);
      await amy.conn.request('session.message.send', { sessionId: session.id, text: 'Hello.' });
      await turnsFinished(host, session.id, 1);
      const processes = await stack.agentProcesses();
      expect(processes).toHaveLength(1);
      expect(processes[0]).toContain('fake-claude.mjs');
      expect((await stack.claude?.echoed())?.filter((entry) => entry.kind === 'argv')).toHaveLength(1);
      expect(await stack.git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');

      // The host stops sharing and shares again: another daemon object, the same workspace, state and home.
      const before = stack.daemon;
      const epoch = (await relay.inspect('ws', stack.workspaceId)).hostEpoch;
      await stack.restartDaemon();
      expect(stack.daemon).not.toBe(before);
      expect(stack.daemon.workspaceId).toBe(before.workspaceId);
      expect((await relay.inspect('ws', stack.workspaceId)).hostEpoch).toBeGreaterThan(epoch);
      expect(await stack.agentProcesses()).toEqual([]);
      // The same client connections are online again, with no new invite; the session and its conversation are there.
      for (const one of [host, amy]) await one.client.waitFor((state) => state.kind === 'online', 30_000);
      for (const one of [host, amy]) await one.sync();
      expect(amy.events(session.id).filter((event) => event.kind === 'message')).toHaveLength(1);
      await amy.conn.request('session.message.send', { sessionId: session.id, text: 'Hello again.' });
      await turnsFinished(host, session.id, 2);
      // The same Claude conversation went on (the stand-in keeps it under the host's home, which is the same).
      expect((await stack.claude?.echoed())?.filter((entry) => entry.kind === 'argv').map((entry) => ((entry.value as string[]).includes('--resume') ? 'resume' : 'new'))).toEqual(['new', 'resume']);
      await stack.stopDaemon();
      expect(() => stack.daemon).toThrow(/stopped/);
      await waitUntil(async () => (await stack.agentProcesses()).length === 0, 15_000, 'the agent process to be gone after the stop');
    } finally {
      await stack.stop();
    }
  });
});

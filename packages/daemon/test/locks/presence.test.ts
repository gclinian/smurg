// Presence (SPEC R7: people and agents both appear as users with a name and a colour; R11 members online): members online, their
// connections and active file, one entry per running agent session `Claude (owner)` with a stable readable colour,
// presence.state coalesced.
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type FileRef, type PayloadOf } from '@smurg/protocol';
import { AGENT_COLORS, DARK_BACKGROUND, LIGHT_BACKGROUND, READABLE_MEMBER_COLORS, contrastRatio, isReadableOnBothThemes, pickAgentColor } from '../../src/locks/colors.ts';
import type { ClientConnection } from '../../src/core/interfaces.ts';
import { ManualClock } from '../../src/core/lifecycle.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { locksModule } from '../../src/locks/module.ts';
import { PresenceServiceImpl } from '../../src/locks/presence.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { agentSession, preToolUse, recorder, sessionInfo } from './agent-sim.ts';
import { FakeTimers } from './support.ts';

const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function daemon(): Promise<TestDaemon> {
  t = await createTestDaemon({ modules: [locksModule], project: { files: { 'README.md': '# hi\n', 'src/app.ts': 'x\n' } } });
  return t;
}

type State = PayloadOf<'presence.state'>;
const EMPTY: State = { members: [], agents: [] };
/** The latest snapshot a client received (an empty one before the first). */
const last = (states: readonly State[]): State => states.at(-1) ?? EMPTY;
const memberOf = (state: State, userId: string) => state.members.find((m) => m.userId === userId);

describe('presence of members', () => {
  it('a new connection gets the current snapshot at once; members show online, their connection count and active file', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const hostStates = recorder(host.conn, 'presence.state');
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const amyStates = recorder(amy.conn, 'presence.state');
    const amy2 = await amy.reconnect(); // a second tab, same device
    await waitFor(() => memberOf(last(hostStates), 'dev:amy')?.connections === 2, { what: 'two connections of Amy' });
    expect(memberOf(last(hostStates), 'dev:amy')).toMatchObject({ displayName: 'Amy', role: 'editor', online: true });
    expect(memberOf(last(hostStates), 'dev:host')).toMatchObject({ online: true, connections: 1 });

    amy.conn.notify('presence.update', { activeFile: main('README.md') });
    await waitFor(() => memberOf(last(hostStates), 'dev:amy')?.activeFile?.path === 'README.md', { what: 'Amy’s active file' });
    amy2.conn.notify('presence.update', { activeFile: main('src/app.ts') }); // the most recent one wins
    await waitFor(() => memberOf(last(hostStates), 'dev:amy')?.activeFile?.path === 'src/app.ts', { what: 'the newer active file' });
    amy2.close();
    await waitFor(() => memberOf(last(hostStates), 'dev:amy')?.connections === 1, { what: 'one connection left' });
    expect(memberOf(last(hostStates), 'dev:amy')?.activeFile?.path).toBe('README.md');
    amy.conn.notify('presence.update', { activeFile: null });
    await waitFor(() => memberOf(last(hostStates), 'dev:amy')?.activeFile === undefined, { what: 'no active file' });
    expect(amyStates.length).toBeGreaterThan(0);
    for (const member of last(hostStates).members) expect(member.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('presence.state is coalesced: a burst of updates becomes a few broadcasts with the final state', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    await new Promise((resolve) => setTimeout(resolve, 400)); // connection-time broadcasts are over
    const states = recorder(host.conn, 'presence.state');
    for (let i = 0; i < 30; i++) amy.conn.notify('presence.update', { activeFile: main(i % 2 === 0 ? 'README.md' : 'src/app.ts') });
    amy.conn.notify('presence.update', { activeFile: main('README.md') });
    await waitFor(() => states.length > 0 && memberOf(last(states), 'dev:amy')?.activeFile?.path === 'README.md', { what: 'the final state' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    // 31 changes; how many windows they span depends on the machine's load (the exact count is the unit test below).
    expect(states.length).toBeLessThan(10);
  });

  it('presence.state is coalesced: every change inside one window becomes exactly one broadcast (deterministic)', () => {
    const clock = new ManualClock();
    const timers = new FakeTimers(clock);
    const broadcasts: unknown[] = [];
    const conn = { id: 'conn_1', purpose: 'interactive', userId: 'dev:amy', isOpen: true } as unknown as ClientConnection;
    const presence = new PresenceServiceImpl({
      clock,
      log: silentLogger,
      timers,
      coalesceMs: 150,
      hub: { broadcast: (_type: string, payload: unknown) => broadcasts.push(payload) as unknown as number, send: () => true, connections: () => [conn] } as never,
      members: { list: () => [], toMember: () => ({}) } as never,
    });
    for (let i = 0; i < 30; i++) presence.update(conn, main(i % 2 === 0 ? 'a.txt' : 'b.txt'));
    expect(broadcasts).toHaveLength(0);
    timers.advance(150);
    expect(broadcasts).toHaveLength(1);
    presence.update(conn, main('b.txt')); // no change: nothing to announce
    timers.advance(1_000);
    expect(broadcasts).toHaveLength(1);
    presence.setAgent({ sessionId: 'ses_1', ownerUserId: 'dev:ian', displayName: 'Claude (Ian)', color: '#000000', status: 'running' });
    timers.advance(150);
    expect(broadcasts).toHaveLength(2);
    expect(presence.snapshot().agents[0]?.color).not.toBe('#000000'); // unreadable colours are replaced
    presence.stop();
  });

  it('a hidden path is never announced, and a guest cannot even name one', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const states = recorder(amy.conn, 'presence.state');
    host.conn.notify('presence.update', { activeFile: main('README.md') });
    await waitFor(() => states.length > 0 && memberOf(last(states), 'dev:host')?.activeFile?.path === 'README.md', { what: 'host file' });
    host.conn.notify('presence.update', { activeFile: main('.smurg/worktrees') });
    await waitFor(() => memberOf(last(states), 'dev:host')?.activeFile === undefined, { what: 'the hidden file is not shown' });

    const audit: string[] = [];
    d.ctx.audit.subscribe((entry) => {
      if (entry.action === 'path.denied' && entry.actor.kind === 'user' && entry.actor.userId === 'dev:amy') audit.push(String(entry.detail?.['reason']));
    });
    amy.conn.notify('presence.update', { activeFile: main('.smurg/uploads') });
    await waitFor(() => audit.length === 1, { what: 'path.denied for the guest' });
    expect(audit).toEqual(['hidden']);
  });
});

describe('presence of agents', () => {
  it('presence of agents: one entry per running agent session, `Claude (owner)`, a stable readable colour, its current file', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    await d.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'agent' });
    const states = recorder(host.conn, 'presence.state');
    const ian = agentSession('ses_ian', 'dev:ian', 'Ian');
    const hosts = agentSession('ses_host', 'dev:host', 'Host');

    d.ctx.bus.emit('session.created', { session: sessionInfo(ian, 'starting') });
    d.ctx.bus.emit('session.created', { session: sessionInfo(agentSession('ses_term', 'dev:ian', 'Ian'), 'running', 'terminal') });
    await waitFor(() => states.length > 0 && last(states).agents.length === 1, { what: 'Ian’s agent' });
    const first = last(states).agents[0];
    expect(first).toMatchObject({ sessionId: 'ses_ian', ownerUserId: 'dev:ian', displayName: 'Claude (Ian)', status: 'starting' });
    expect(isReadableOnBothThemes(first?.color ?? '')).toBe(true);

    d.ctx.bus.emit('session.updated', { session: sessionInfo(ian, 'running') });
    d.ctx.bus.emit('session.created', { session: sessionInfo(hosts) });
    expect(preToolUse(d, ian, main('src/app.ts')).granted).toBe(true);
    await waitFor(() => last(states).agents.length === 2 && last(states).agents[0]?.activeFile?.path === 'src/app.ts', { what: 'two agents' });
    const [ianAgent, hostAgent] = last(states).agents;
    expect(ianAgent).toMatchObject({ status: 'running', color: first?.color }); // stable
    expect(hostAgent).toMatchObject({ displayName: 'Claude (Host)' });
    expect(hostAgent?.color).not.toBe(ianAgent?.color);
    const memberColors = last(states).members.map((m) => m.color.toLowerCase());
    expect(memberColors).not.toContain(ianAgent?.color.toLowerCase());

    d.ctx.bus.emit('session.exited', { session: sessionInfo(ian, 'exited'), reason: 'exit' });
    await waitFor(() => last(states).agents.length === 1, { what: 'the exited agent to disappear' });
    expect(last(states).agents[0]?.sessionId).toBe('ses_host');
  });
});

describe('presence colours', () => {
  it('every agent colour and every readable member colour has at least 3:1 contrast on the light and the dark editor theme', () => {
    for (const color of [...AGENT_COLORS, ...READABLE_MEMBER_COLORS]) {
      expect(contrastRatio(color, LIGHT_BACKGROUND), color).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(color, DARK_BACKGROUND), color).toBeGreaterThanOrEqual(3);
    }
    expect(isReadableOnBothThemes('#3cb44b')).toBe(false); // too light on white
    expect(isReadableOnBothThemes('#2f4b7c')).toBe(false); // too dark on dark
  });

  it('agent colours are distinguishable (hues at least 20° apart) and distinct from the member palette', () => {
    const hue = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const hues = AGENT_COLORS.map(hue);
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const gap = Math.abs((hues[i] as number) - (hues[j] as number));
        expect(Math.min(gap, 360 - gap), `${AGENT_COLORS[i]} vs ${AGENT_COLORS[j]}`).toBeGreaterThanOrEqual(20);
      }
    }
    for (const color of AGENT_COLORS) expect(READABLE_MEMBER_COLORS).not.toContain(color);
  });

  it('pickAgentColor is stable per session and skips colours in use', () => {
    const a = pickAgentColor('ses_a', new Set());
    expect(pickAgentColor('ses_a', new Set())).toBe(a);
    const other = pickAgentColor('ses_a', new Set([a.toLowerCase()]));
    expect(other).not.toBe(a);
    expect(AGENT_COLORS).toContain(other);
    expect(pickAgentColor('ses_a', new Set(AGENT_COLORS.map((c) => c.toLowerCase())))).toBe(a); // all taken: still stable
  });
});

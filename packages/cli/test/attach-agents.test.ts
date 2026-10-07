// `smurg attach` and agent sessions (DESIGN v0.5.0 §6): attach is a terminal for TERMINAL sessions only. The list shows
// the agent sessions too (status, topic, title: a topic's sessions together, free sessions last) with one line that
// says conversations open in the browser, naming the workspace's address; `smurg attach <an agent session>` prints
// that sentence and exits 2. First the list as text (both languages, the columns under their headers), then the real
// command against a daemon whose sessions are the in-memory fakes of @smurg/daemon/fakes (terminals without a PTY,
// agent sessions without a process), found through SMURG_HOME's run dir as in production.
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalControlModule } from '@smurg/daemon';
import { buildAgentSession, buildTerminalSession, fakesModule, fakesOf } from '@smurg/daemon/fakes';
import { createTestDaemon, type TestDaemon } from '@smurg/daemon/testing';
import type { AgentSession, AgentStatus, SessionInfo } from '@smurg/protocol';
import { runCli } from '../src/cli/run.ts';
import { displayWidth } from '../src/cli/columns.ts';
import { agentSessions, browserSentence, formatSessionList, pickSession, terminalSessions } from '../src/commands/attach.ts';
import { renderText } from '../src/i18n/index.ts';
import { workspaceAddress } from '../src/relay/relay.ts';
import { loadWorkspaces, rememberJoined } from '../src/state/workspaces.ts';
import { statePaths } from '../src/state/paths.ts';
import { fakeTerminal, makeDirs, testIo, type Dirs } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

const AMY = { userId: 'dev:amy', displayName: 'Amy' };
const HOST = { userId: 'dev:host', displayName: 'Host' };
const WEB = 'https://app.example/w/ws_list_0123456789ab';

const terminal = buildTerminalSession({ id: 'ses_term_build', openedBy: HOST, title: 'build', cols: 80, rows: 24, createdAt: 1 });
const amyTerminal = buildTerminalSession({ id: 'ses_term_amy', openedBy: AMY, cols: 80, rows: 24, createdAt: 2 });
const free = buildAgentSession({ id: 'ses_free_amy', openedBy: AMY, status: 'idle', createdAt: 3 });
const discussion = buildAgentSession({ id: 'ses_checkout_talk', purpose: 'discussion', topicId: 'tp_checkout', topicName: 'Checkout', status: 'waiting-answer', modeFixed: true, createdAt: 4 });
const named = buildAgentSession({ id: 'ses_free_named', openedBy: HOST, title: 'Try the cache', status: 'running', createdAt: 5 });
const search = buildAgentSession({ id: 'ses_search_talk', purpose: 'discussion', topicId: 'tp_search', topicName: 'Search', status: 'idle', modeFixed: true, createdAt: 6 });
const item = buildAgentSession({
  id: 'ses_checkout_item2',
  purpose: 'item',
  topicId: 'tp_checkout',
  topicName: 'Checkout',
  itemId: 'payment-form',
  item: { number: 2, title: 'Payment form' },
  attempt: 1,
  status: 'stalled',
  createdAt: 7,
});
const ALL: readonly SessionInfo[] = [terminal, amyTerminal, free, discussion, named, search, item];

/** The cell (0-based) at which `needle` starts in `line`. */
function cellOf(line: string, needle: string): number {
  const at = line.indexOf(needle);
  if (at < 0) throw new Error(`"${needle}" is not in "${line}"`);
  return displayWidth(line.slice(0, at));
}

describe('smurg attach: the session list with agent sessions', () => {
  it('terminals stay numbered as before; agent sessions follow with status, topic and title, a topic\'s sessions together and free sessions last', () => {
    expect(terminalSessions(ALL).map((s) => s.id)).toEqual(['ses_term_build', 'ses_term_amy']);
    expect(agentSessions(ALL).map((s) => s.id)).toEqual(['ses_checkout_talk', 'ses_checkout_item2', 'ses_search_talk', 'ses_free_amy', 'ses_free_named']);
    expect(formatSessionList(ALL, 'dev:amy', 'en', WEB)).toBe(
      [
        'No.   Session ID                            Type      Owner         Status      Title',
        '1     ses_term_build                        terminal  Host          running     build',
        '2     ses_term_amy                          terminal  Amy (you)     running     Terminal (Amy)',
        '',
        'Agent sessions (conversations):',
        'Session ID                            Status                    Topic                     Title',
        'ses_checkout_talk                     waiting for an answer     Checkout                  Discussion',
        'ses_checkout_item2                    stopped without a report  Checkout                  2 · Payment form',
        'ses_search_talk                       idle                      Search                    Discussion',
        'ses_free_amy                          idle                      No topic                  Claude (Amy)',
        'ses_free_named                        running                   No topic                  Try the cache',
        '',
        'Attach with smurg attach <number or session ID>.',
        `Agent conversations open in the browser: ${WEB}`,
      ].join('\n'),
    );
  });

  it('names every status of an agent session, in both languages', () => {
    const statuses: readonly [AgentStatus, string, string][] = [
      ['starting', 'starting', '啟動中'],
      ['running', 'running', '執行中'],
      ['waiting-answer', 'waiting for an answer', '等待回答'],
      ['waiting-permission', 'waiting for permission', '等待許可'],
      ['idle', 'idle', '待命'],
      ['stalled', 'stopped without a report', '沒寫報告就停下了'],
      ['done', 'done', '完成'],
      ['failed', 'failed', '失敗'],
      ['ended', 'ended', '已結束'],
    ];
    for (const [status, english, chinese] of statuses) {
      const session: AgentSession = { ...free, status };
      expect(formatSessionList([session], 'dev:host', 'en'), status).toContain(`ses_free_amy                          ${english.padEnd(24)}  No topic`);
      expect(formatSessionList([session], 'dev:host', 'zh-TW'), status).toContain(`  ${chinese}`);
    }
  });

  it('only agent sessions: says there is no terminal, and gives no attach hint; only terminals: nothing about conversations; none: the old sentence', () => {
    const onlyAgents = formatSessionList([free], 'dev:host', 'en', WEB);
    expect(onlyAgents.split('\n')[0]).toBe('This workspace has no terminal sessions.');
    expect(onlyAgents).not.toContain('Attach with');
    expect(onlyAgents).not.toContain('No.   Session ID');
    expect(onlyAgents.endsWith(`\nAgent conversations open in the browser: ${WEB}`)).toBe(true);
    const onlyTerminals = formatSessionList([terminal], 'dev:host', 'en', WEB);
    expect(onlyTerminals).not.toContain('Agent');
    expect(onlyTerminals.endsWith('\nAttach with smurg attach <number or session ID>.')).toBe(true);
    expect(formatSessionList([], 'dev:host', 'en', WEB)).toBe('This workspace has no sessions.');
    expect(formatSessionList([], 'dev:host', 'zh-TW', WEB)).toBe('這個工作區目前沒有 session。');
  });

  it('without an address to name (a host without a relay) the sentence points at the web app of the workspace', () => {
    expect(renderText('en', browserSentence(null))).toBe("Agent conversations open in the browser, in this workspace's web app.");
    expect(renderText('en', browserSentence(WEB))).toBe(`Agent conversations open in the browser: ${WEB}`);
    expect(renderText('zh-TW', browserSentence(WEB))).toBe(`agent 對話要在瀏覽器開啟：${WEB}`);
    expect(renderText('zh-TW', browserSentence(null))).toBe('agent 對話要在瀏覽器開啟：請開啟這個工作區的網頁。');
    expect(formatSessionList([free], 'dev:host', 'en').endsWith("\nAgent conversations open in the browser, in this workspace's web app.")).toBe(true);
    expect(workspaceAddress('https://app.smurg.ai', 'ws_abc')).toBe('https://app.smurg.ai/w/ws_abc');
    expect(workspaceAddress('http://localhost:5173', 'ws_abc')).toBe('http://localhost:5173/w/ws_abc');
  });

  it('a real session id (`ses_` and 32 hex digits) fills its column exactly: each cell of a row starts under its header, in both tables and both languages', () => {
    // The ids the daemon makes are 36 characters; a narrower id column put every row four cells to the right of its header.
    const realTerminal = buildTerminalSession({ id: `ses_${'0123456789abcdef'.repeat(2)}`, openedBy: HOST, title: 'build', cols: 80, rows: 24, createdAt: 1 });
    const realAgent = buildAgentSession({ id: `ses_${'fedcba9876543210'.repeat(2)}`, purpose: 'discussion', topicId: 'tp_checkout', topicName: 'Checkout', status: 'idle', modeFixed: true, createdAt: 2 });
    expect(realTerminal.id).toHaveLength(36);
    for (const lang of ['en', 'zh-TW'] as const) {
      const tr = (id: Parameters<typeof renderText>[1]): string => renderText(lang, id);
      const lines = formatSessionList([realTerminal, realAgent], 'dev:amy', lang, WEB).split('\n');
      const terminalHeader = lines[0] as string;
      const terminalRow = lines[1] as string;
      const terminalLabels = lang === 'en' ? ['No.', 'Session ID', 'Type', 'Owner', 'Status', 'Title'] : ['編號', 'session ID', '類型', '擁有者', '狀態', '標題'];
      const terminalCells = ['1', realTerminal.id, tr({ id: 'attach.kind.terminal' }), 'Host', tr({ id: 'attach.status.running' }), 'build'];
      expect(terminalCells.map((cell) => cellOf(terminalRow, cell)), lang).toEqual(terminalLabels.map((label) => cellOf(terminalHeader, label)));
      const agentHeader = lines.find((line) => line.startsWith(lang === 'en' ? 'Session ID' : 'session ID')) as string;
      const agentRow = lines.find((line) => line.startsWith(realAgent.id)) as string;
      const agentLabels = lang === 'en' ? ['Session ID', 'Status', 'Topic'] : ['session ID', '狀態', '主題'];
      const agentCells = [realAgent.id, tr({ id: 'attach.agent.idle' }), 'Checkout'];
      expect(agentCells.map((cell) => cellOf(agentRow, cell)), lang).toEqual(agentLabels.map((label) => cellOf(agentHeader, label)));
      expect(displayWidth(agentRow.slice(0, agentRow.lastIndexOf(lang === 'en' ? 'Discussion' : '討論'))), lang).toBe(cellOf(agentHeader, lang === 'en' ? 'Title' : '標題'));
    }
  });

  it('in zh-TW every column of both tables starts under its header, counted in terminal cells; a long or Chinese topic name is clipped to its column', () => {
    const longTopic = buildAgentSession({ id: 'ses_long_topic', purpose: 'discussion', topicId: 'tp_long', topicName: '重新設計結帳流程與購物車的所有頁面', status: 'waiting-permission', modeFixed: true, createdAt: 8 });
    const chineseTitle = buildAgentSession({ id: 'ses_free_title', openedBy: AMY, title: '試試快取', status: 'done', createdAt: 9 });
    for (const lang of ['en', 'zh-TW'] as const) {
      const lines = formatSessionList([...ALL, longTopic, chineseTitle], 'dev:amy', lang, WEB).split('\n');
      const tr = (id: Parameters<typeof renderText>[1]): string => renderText(lang, id);
      const terminalHeader = lines[0] as string;
      const own = lines[2] as string;
      // No. | Session ID | Type | Owner | Status | Title
      const ownTitle = lang === 'en' ? 'Terminal (Amy)' : '終端機（Amy）';
      const terminalStarts = [0, 6, 44, 54, 68, 80];
      const terminalLabels = lang === 'en' ? ['No.', 'Session ID', 'Type', 'Owner', 'Status', 'Title'] : ['編號', 'session ID', '類型', '擁有者', '狀態', '標題'];
      expect(terminalLabels.map((label) => cellOf(terminalHeader, label)), lang).toEqual(terminalStarts);
      const ownCells = ['2', 'ses_term_amy', tr({ id: 'attach.kind.terminal' }), tr({ id: 'attach.owner.you', params: { name: 'Amy' } }), tr({ id: 'attach.status.running' }), ownTitle];
      expect(ownCells.map((cell) => cellOf(own, cell)), lang).toEqual(terminalStarts);
      // Session ID | Status | Topic | Title
      const agentHeader = lines.find((line) => line.startsWith(lang === 'en' ? 'Session ID' : 'session ID')) as string;
      const agentStarts = [0, 38, 64, 90];
      const agentLabels = lang === 'en' ? ['Session ID', 'Status', 'Topic', 'Title'] : ['session ID', '狀態', '主題', '標題'];
      expect(agentLabels.map((label) => cellOf(agentHeader, label)), lang).toEqual(agentStarts);
      const long = lines.find((line) => line.startsWith('ses_long_topic')) as string;
      const longCells = ['ses_long_topic', tr({ id: 'attach.agent.waitingPermission' }), '重新設計結帳流程與購...'];
      expect(longCells.map((cell) => cellOf(long, cell)), lang).toEqual(agentStarts.slice(0, 3));
      // The title (the wire catalog's name of a discussion) starts in the last column although the topic was clipped.
      expect(displayWidth(long.slice(0, long.lastIndexOf(lang === 'en' ? 'Discussion' : '討論'))), lang).toBe(90);
      expect(long).not.toContain('所有頁面');
      const titled = lines.find((line) => line.startsWith('ses_free_title')) as string;
      expect(cellOf(titled, '試試快取'), lang).toBe(90);
    }
  });

  it('a number picks a terminal only; an id or a unique prefix may name an agent session, which the caller refuses', () => {
    expect(pickSession(ALL, '2').id).toBe('ses_term_amy');
    expect(() => pickSession(ALL, '3')).toThrowError(/No session "3"/);
    expect(pickSession(ALL, 'ses_checkout_item2').kind).toBe('agent');
    expect(pickSession(ALL, 'ses_search').id).toBe('ses_search_talk');
    expect(() => pickSession(ALL, 'ses_free')).toThrowError(/matches more than one session/);
    expect(() => pickSession(ALL, 'ses_checkout')).toThrowError(/matches more than one session/);
    expect(() => pickSession(ALL, 'ses_nope')).toThrowError(/No session "ses_nope"/);
  });
});

interface Local {
  readonly dirs: Dirs;
  readonly env: Record<string, string>;
  readonly t: TestDaemon;
}

/** A daemon with fake sessions of both kinds and the real control socket; SMURG_HOME is its state dir. */
async function local(): Promise<Local> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const control = createLocalControlModule();
  const t = await createTestDaemon({ stateDir: dirs.stateDir, modules: [fakesModule({ handlers: true }), control] });
  cleanups.push(async () => {
    await t.cleanup();
    await control.whenClosed();
  });
  return { dirs, env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir }, t };
}

describe('smurg attach against a workspace with agent sessions (the control socket, as the host)', () => {
  it('lists terminals and agent sessions, with the workspace\'s address in the web app; in zh-TW too', async () => {
    const l = await local();
    const host = await l.t.connectHost();
    // Opened from the web, as in production (the control socket cannot open sessions).
    const { session: shell } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24, title: 'build' });
    const { session: claude } = await host.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' } });
    fakesOf(l.t.ctx).agents.adopt({ ...discussion, createdAt: l.t.clock.now() + 1 });
    const address = `https://relay.smurg.test/w/${l.t.workspaceId}`;
    const io = testIo({ env: l.env });
    expect(await runCli(['attach'], io)).toBe(0);
    const hostName = host.welcome?.member.displayName as string;
    expect(io.out()).toContain('on this computer');
    expect(io.out()).toMatch(new RegExp(`\\n1     ${shell.id}\\s+terminal  ${hostName} \\(you\\)\\s+running     build\\n`));
    expect(io.out()).toContain('\nAgent sessions (conversations):\nSession ID                            Status                    Topic                     Title\n');
    expect(io.out()).toContain(`\nses_checkout_talk                     waiting for an answer     Checkout                  Discussion\n`);
    expect(io.out()).toMatch(new RegExp(`\\n${claude.id}\\s+\\S.*  No topic                  Claude \\(${hostName}\\)\\n`));
    expect(io.out().endsWith(`\nAttach with smurg attach <number or session ID>.\nAgent conversations open in the browser: ${address}\n`)).toBe(true);
    const zh = testIo({ env: { ...l.env, SMURG_LANG: 'zh-TW' } });
    expect(await runCli(['attach'], zh)).toBe(0);
    expect(zh.out()).toContain('\nagent session（對話）：\n');
    expect(zh.out()).toContain('等待回答');
    expect(zh.out()).toContain('未分主題');
    expect(zh.out().endsWith(`\nagent 對話要在瀏覽器開啟：${address}\n`)).toBe(true);
  });

  it('smurg attach <an agent session> says where conversations open and exits 2: by id, by a unique prefix, in zh-TW; nothing is attached', async () => {
    const l = await local();
    const fakes = fakesOf(l.t.ctx);
    fakes.agents.adopt(discussion);
    fakes.agents.adopt(item);
    const address = `https://relay.smurg.test/w/${l.t.workspaceId}`;
    const byId = testIo({ env: l.env });
    expect(await runCli(['attach', 'ses_checkout_talk'], byId)).toBe(2);
    expect(byId.err()).toBe(`smurg: Session "Discussion" is an agent conversation, not a terminal\n  Agent conversations open in the browser: ${address}\n`);
    expect(byId.terminal.rawModeHistory).toEqual([]);
    const byPrefix = testIo({ env: l.env });
    expect(await runCli(['attach', 'ses_checkout_i'], byPrefix)).toBe(2);
    expect(byPrefix.err()).toBe(`smurg: Session "2 · Payment form" is an agent conversation, not a terminal\n  Agent conversations open in the browser: ${address}\n`);
    const zh = testIo({ env: { ...l.env, SMURG_LANG: 'zh-TW' } });
    expect(await runCli(['attach', 'ses_checkout_talk'], zh)).toBe(2);
    expect(zh.err()).toBe(`smurg：session「討論」是 agent 對話，不是終端機\n  agent 對話要在瀏覽器開啟：${address}\n`);
    // A number never reaches an agent session (numbers are the terminals'), and an ambiguous prefix is still refused.
    const number = testIo({ env: l.env });
    expect(await runCli(['attach', '1'], number)).toBe(2);
    expect(number.err()).toContain('No session "1"');
    const ambiguous = testIo({ env: l.env });
    expect(await runCli(['attach', 'ses_checkout'], ambiguous)).toBe(2);
    expect(ambiguous.err()).toContain('matches more than one session');
    // Outside a terminal the first refusal is still the terminal one (nothing was connected for it).
    const noTty = testIo({ env: l.env, terminal: fakeTerminal({ isTTY: false }) });
    expect(await runCli(['attach', 'ses_checkout_talk'], noTty)).toBe(2);
    expect(noTty.err()).toContain('smurg attach must run in a terminal');
  });

  it('--help says that attach is for terminal sessions and that agent sessions open in the browser', async () => {
    const io = testIo({ env: {} });
    expect(await runCli(['attach', '--help'], io)).toBe(0);
    expect(io.out()).toContain('Attach a terminal session to this terminal. Without a session, list every session.');
    expect(io.out()).toContain('Agent sessions are conversations: they are listed with their topic and status, and they open in the browser,\n  not in a terminal.');
    const root = testIo({ env: {} });
    expect(await runCli(['--help'], root)).toBe(0);
    expect(root.out()).toContain('  attach [session]     Attach a terminal session to this terminal (lists the sessions when none is given)\n');
    expect(root.out()).not.toContain('Attach an agent session');
  });
});

describe('the web app\'s origin of a joined workspace (workspaces.json)', () => {
  it('is remembered only when given (an invite link that did not point at the relay), read back, and dropped when it is not an http(s) origin', async () => {
    const dirs = await makeDirs();
    cleanups.push(() => dirs.cleanup());
    const paths = statePaths({ HOME: dirs.home, SMURG_HOME: dirs.stateDir });
    await rememberJoined(paths, { workspaceId: 'ws_joined_aaaaaaaaaaaa', relay: 'http://localhost:8787', name: 'dev', joinedAt: 1, web: 'http://localhost:5173' });
    await rememberJoined(paths, { workspaceId: 'ws_joined_bbbbbbbbbbbb', relay: 'https://app.smurg.ai', name: 'prod', joinedAt: 2 });
    for (const [index, bad] of ['javascript:alert(1)', 'https://app.example/path', 'not a url', 'https://user@app.example'].entries()) {
      await rememberJoined(paths, { workspaceId: `ws_joined_bad${index}aaaaaaaa`, relay: 'https://app.smurg.ai', name: null, joinedAt: 3, web: bad });
    }
    const joined = (await loadWorkspaces(paths)).joined;
    expect(joined.find((j) => j.workspaceId === 'ws_joined_aaaaaaaaaaaa')).toEqual({ workspaceId: 'ws_joined_aaaaaaaaaaaa', relay: 'http://localhost:8787', name: 'dev', joinedAt: 1, web: 'http://localhost:5173' });
    expect(joined.find((j) => j.workspaceId === 'ws_joined_bbbbbbbbbbbb')).toEqual({ workspaceId: 'ws_joined_bbbbbbbbbbbb', relay: 'https://app.smurg.ai', name: 'prod', joinedAt: 2 });
    expect(joined.filter((j) => j.workspaceId.startsWith('ws_joined_bad')).map((j) => j.web)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

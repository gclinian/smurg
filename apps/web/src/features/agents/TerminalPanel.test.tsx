// The Terminal tab of code mode's drawer with a FakeConnection and the REAL xterm.js viewer (jsdom): every plain
// terminal of the workspace has a tab,
// the terminal attaches while shown (snapshot or delta, then live output placed by offset: no gap, no duplicate),
// detaches when hidden, attaches again after a reconnect from the last offset, never answers terminal queries, sends
// input for whoever may type (the host and members with agent access, into ANY session: session.drive) and the size only from the
// panel of the member who opened the session (SPEC R4, R7 agent panel, goal 2; ARCHITECTURE §5.5, §7.6; protocol v2).
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SmurgError, worktreeRoot, type TerminalSession } from '@smurg/protocol';
import type { ILink } from '@xterm/xterm';
import { HOST_USER, makeEntry, makeSession, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { TerminalPanel } from './index.tsx';
import { REFUSALS_PER_MINUTE } from './path-links.ts';
import { bytes, flushTerm, nextRequest, recordingViewerFactory, renderWithSessions, terminalText } from './test-support.tsx';


const decoder = new TextDecoder();

const hostAgent = makeSession({ id: 'sess_host', title: 'Claude', openedBy: { userId: HOST_USER, displayName: 'Ian' }, createdAt: 1 });
const hostShell = makeSession({ id: 'sess_shell', kind: 'terminal', title: 'shell', openedBy: { userId: HOST_USER, displayName: 'Ian' }, createdAt: 1, cols: 80, rows: 24 });
const amyTerminal = makeSession({
  id: 'sess_amy',
  kind: 'terminal',
  title: 'tests',
  openedBy: { userId: 'dev:amy', displayName: 'Amy' },
  root: worktreeRoot('wt_1'),
  createdAt: 2,
  cols: 80,
  rows: 24,
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Answers the pending session.attach with a snapshot. */
function snapshot(conn: Awaited<ReturnType<typeof renderWithSessions>>['conn'], session: TerminalSession, text: string, nextOffset: number) {
  return conn.respond('session.attach', { session, mode: 'snapshot', data: bytes(text), cols: session.cols, rows: session.rows, nextOffset });
}

describe('terminal panel: every session of the workspace, for everyone (SPEC goal 2)', () => {
  it('shows a tab per session with who opened it, kind, status, where it runs and that it runs as the host — also to a viewer', async () => {
    const { conn } = await renderWithSessions(<TerminalPanel />, { role: 'viewer', sessions: [hostAgent, { ...amyTerminal, status: 'exited', exitCode: 3 }] });
    await act(async () => {
      conn.respond('worktree.list', { worktrees: [makeWorktree({ id: 'wt_1', branch: 'smurg/amy/wt_1' })] });
      conn.respond('worktree.merge.list', { requests: [] });
    });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([expect.stringContaining('Claude (Ian)'), expect.stringContaining('tests (Amy)')]);

    // One compact line; the rest behind "Details".
    const hostSummary = screen.getByLabelText('About Claude');
    expect(hostSummary.textContent).toContain('By Ian');
    expect(hostSummary.textContent).toContain('Running');
    expect(hostSummary.textContent).toContain('Main workspace');
    fireEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Details' }));
    const hostInfo = screen.getByLabelText('Details of Claude');
    expect(hostInfo.textContent).toContain('Opened by:Ian');
    expect(hostInfo.textContent).toContain("The host's computer, with the host's Claude account");
    expect(hostInfo.textContent).not.toMatch(/sandbox/i);

    fireEvent.click(tabs[1]!);
    fireEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Details' }));
    const amyInfo = screen.getByLabelText('Details of tests');
    expect(amyInfo.textContent).toContain('Ended (exit code 3)');
    // Whose worktree and for what, with the branch as a detail.
    expect(amyInfo.textContent).toContain('My worktree (tests) · smurg/amy/wt_1');
    expect(amyInfo.textContent).toContain("The host's computer, with the host's Claude account");
    // A viewer can watch but cannot open terminals: the dialog says why.
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(await screen.findByText(/^As a viewer you can only watch sessions\./)).toBeTruthy();
  });

  it('a session nobody named is called after its kind and the person who opened it, once: "Terminal (Ming)"', async () => {
    // The host sends no default title (protocol 3): the panel builds it in the viewer's language.
    const { title: _title, ...untitled } = makeSession({ id: 'sess_ming', kind: 'terminal', openedBy: { userId: 'dev:ming', displayName: 'Ming' } });
    await renderWithSessions(<TerminalPanel />, { role: 'editor', sessions: [untitled] });
    expect(screen.getByRole('tab').textContent).toContain('Terminal (Ming)');
    expect(screen.getByRole('tab').textContent).not.toContain('(Ming) (Ming)');
    // Where the session stands alone, its name carries the opener too.
    expect(screen.getByLabelText('About Terminal (Ming)')).toBeTruthy();
  });

  it('offers no guest login, API key or settings import to anyone: only "New terminal"', async () => {
    for (const role of ['agent', 'host'] as const) {
      const view = await renderWithSessions(<TerminalPanel />, { role, sessions: [hostAgent] });
      expect(screen.queryByRole('button', { name: /more actions/i })).toBeNull();
      expect(screen.queryByText(/import|subscription|API key/i)).toBeNull();
      expect(screen.getByRole('button', { name: 'New terminal' })).toBeTruthy();
      view.unmount();
    }
  });

  it('shows a guest the exact commands to attach the session in their own terminal, and that the host must send a CLI link', async () => {
    await renderWithSessions(<TerminalPanel />, { role: 'agent', sessions: [hostAgent] });
    fireEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Attach from your own terminal' }));
    const dialog = screen.getByRole('dialog', { name: 'Attach to this session from your own terminal' });
    const origin = window.location.origin;
    const codes = within(dialog).getAllByText(/^smurg /).map((node) => node.textContent);
    expect(codes).toEqual([`smurg login --relay ${origin}`, `smurg attach --invite - --relay ${origin}`, expect.stringMatching(new RegExp(`^smurg attach sess_host --workspace \\S+ --relay ${origin}$`))]);
    expect(dialog.textContent).toContain('Ask the host to create a new invite link with your role in the console');
  });

  it('a new session reported by the daemon appears as a tab for everyone', async () => {
    const { conn } = await renderWithSessions(<TerminalPanel />, { role: 'editor', sessions: [] });
    expect(screen.getByText('No terminals yet')).toBeTruthy();
    await act(async () => {
      conn.emit('session.state', { session: hostAgent });
    });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });
});

describe('terminal panel: terminal stream by offset', () => {
  it('attaches when shown: the snapshot, then live output at nextOffset — duplicates dropped, overlaps trimmed', async () => {
    const { conn, recording } = await renderWithSessions(<TerminalPanel />, { role: 'editor', sessions: [hostAgent] });
    const attach = await nextRequest(conn, 'session.attach');
    // A viewer (not the owner) never proposes a size and asks for a snapshot first.
    expect(attach.payload).toEqual({ sessionId: 'sess_host' });
    await act(async () => {
      snapshot(conn, hostAgent, 'hello ', 100);
    });
    await act(async () => {
      conn.emit('exec.output', { sessionId: 'sess_host', offset: 100, data: bytes('wor') });
      conn.emit('exec.output', { sessionId: 'sess_host', offset: 100, data: bytes('wor') }); // duplicate
      conn.emit('exec.output', { sessionId: 'sess_host', offset: 101, data: bytes('orld') }); // overlaps "or"
      conn.emit('exec.output', { sessionId: 'other', offset: 0, data: bytes('NOT MINE') });
    });
    const term = recording.viewers[0]!.term;
    await flushTerm(term);
    expect(terminalText(term)).toBe('hello world');
    expect(term.cols).toBe(120);
    expect(term.rows).toBe(40);
  });

  it('output that arrives before the attach reply is applied after the snapshot, in stream order with exec.resize', async () => {
    const { conn, recording } = await renderWithSessions(<TerminalPanel />, { role: 'editor', sessions: [hostAgent] });
    await nextRequest(conn, 'session.attach');
    await act(async () => {
      conn.emit('exec.output', { sessionId: 'sess_host', offset: 10, data: bytes('A') });
      conn.emit('exec.resize', { sessionId: 'sess_host', cols: 90, rows: 20 });
      conn.emit('exec.output', { sessionId: 'sess_host', offset: 11, data: bytes('B') });
      snapshot(conn, hostAgent, '0123456789', 10);
    });
    const term = recording.viewers[0]!.term;
    await flushTerm(term);
    expect(terminalText(term)).toBe('0123456789AB');
    // The viewer renders at the PTY size it was told, never at the panel's.
    expect([term.cols, term.rows]).toEqual([90, 20]);
  });

  it('bytes that never arrived make it attach again from the rendered offset (a delta): no gap, no duplicate', async () => {
    const { conn, recording } = await renderWithSessions(<TerminalPanel />, { role: 'editor', sessions: [hostAgent] });
    await nextRequest(conn, 'session.attach');
    await act(async () => {
      snapshot(conn, hostAgent, 'abc', 3);
    });
    await act(async () => {
      conn.emit('exec.output', { sessionId: 'sess_host', offset: 5, data: bytes('fg') }); // [3,5) missing
    });
    // The feed fences on the channel first (the old attachment's events), then asks for a delta from offset 3.
    await act(async () => {
      conn.respond('session.list', { sessions: [hostAgent], hasMore: false });
    });
    const again = await nextRequest(conn, 'session.attach');
    expect(again.payload).toEqual({ sessionId: 'sess_host', haveOffset: 3 });
    await act(async () => {
      conn.respond('session.attach', { session: hostAgent, mode: 'delta', data: bytes('defg'), cols: 120, rows: 40, nextOffset: 7 });
    });
    await act(async () => {
      conn.emit('exec.output', { sessionId: 'sess_host', offset: 7, data: bytes('h') });
    });
    const term = recording.viewers[0]!.term;
    await flushTerm(term);
    expect(terminalText(term)).toBe('abcdefgh');
  });

  it('detaches when its tab is hidden and attaches again from the last offset when shown', async () => {
    const { conn, recording } = await renderWithSessions(<TerminalPanel />, { role: 'editor', sessions: [hostAgent, amyTerminal] });
    await nextRequest(conn, 'session.attach');
    await act(async () => {
      snapshot(conn, hostAgent, 'first', 5);
    });
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    await settle();
    expect(conn.notificationsOf('session.detach').map((n) => n.payload)).toEqual([{ sessionId: 'sess_host' }]);
    // Output of the hidden session is ignored (it is re-sent by the next attach).
    await act(async () => {
      conn.emit('exec.output', { sessionId: 'sess_host', offset: 5, data: bytes(' LATE') });
    });
    const amyAttach = await nextRequest(conn, 'session.attach');
    expect(amyAttach.payload.sessionId).toBe('sess_amy');
    await act(async () => {
      snapshot(conn, amyTerminal, '$ ', 2);
    });

    fireEvent.click(screen.getAllByRole('tab')[0]!);
    await settle();
    expect(conn.notificationsOf('session.detach').map((n) => n.payload.sessionId)).toEqual(['sess_host', 'sess_amy']);
    await act(async () => {
      conn.respond('session.list', { sessions: [hostAgent, amyTerminal], hasMore: false }); // the fence
    });
    const back = await nextRequest(conn, 'session.attach');
    expect(back.payload).toEqual({ sessionId: 'sess_host', haveOffset: 5 });
    await act(async () => {
      conn.respond('session.attach', { session: hostAgent, mode: 'delta', data: bytes(' LATE'), cols: 120, rows: 40, nextOffset: 10 });
    });
    const term = recording.viewers[0]!.term;
    await flushTerm(term);
    expect(terminalText(term)).toBe('first LATE');
  });

  it('after a reconnect that could not resume, attaches again from the last offset (no fence: a new channel)', async () => {
    const { conn, recording } = await renderWithSessions(<TerminalPanel />, { role: 'editor', sessions: [hostAgent] });
    await nextRequest(conn, 'session.attach');
    await act(async () => {
      snapshot(conn, hostAgent, 'before', 6);
    });
    await act(async () => {
      conn.admit(makeWelcome({ role: 'editor', channelId: 'ch_2' }), { resumed: false });
    });
    const reattach = await nextRequest(conn, 'session.attach');
    expect(reattach.payload).toEqual({ sessionId: 'sess_host', haveOffset: 6 });
    // The terminal is the same one: nothing was torn down while the session list reloaded.
    expect(recording.viewers).toHaveLength(1);
    await act(async () => {
      conn.respond('session.attach', { session: hostAgent, mode: 'delta', data: bytes(' after'), cols: 120, rows: 40, nextOffset: 12 });
    });
    const term = recording.viewers[0]!.term;
    await flushTerm(term);
    expect(terminalText(term)).toBe('before after');
  });
});

// The queries a program may send (pty-packaging.md §6.2 and V5): the daemon's mirror answers each exactly once, so a
// web viewer that answered too would put a second reply into the owner's PTY.
const TERMINAL_QUERIES: readonly (readonly [string, string])[] = [
  ['DA1', '\x1b[c'],
  ['DA1 with 0', '\x1b[0c'],
  ['DA2', '\x1b[>c'],
  ['DA2 with 0', '\x1b[>0c'],
  ['DA3', '\x1b[=c'],
  ['DSR status', '\x1b[5n'],
  ['CPR', '\x1b[6n'],
  ['DECXCPR', '\x1b[?6n'],
  ['DECRQM (ANSI)', '\x1b[4$p'],
  ['DECRQM (DEC)', '\x1b[?2004$p'],
  ['DECRQSS SGR', '\x1bP$qm\x1b\\'],
  ['DECRQSS DECSTBM', '\x1bP$qr\x1b\\'],
  ...[11, 13, 14, 15, 16, 18, 19, 20, 21].map((n) => [`XTWINOPS ${n}`, `\x1b[${n}t`] as const),
  ['OSC 4 (BEL)', '\x1b]4;1;?\x07'],
  ['OSC 10 (BEL)', '\x1b]10;?\x07'],
  ['OSC 11 (ST)', '\x1b]11;?\x1b\\'],
  ['OSC 12 (ST)', '\x1b]12;?\x1b\\'],
  ['XTVERSION', '\x1b[>0q'],
  ['kitty keyboard flags', '\x1b[?u'],
];

describe('terminal panel: the viewer never answers terminal queries', () => {
  for (const role of ['host', 'editor'] as const) {
    it(`${role === 'host' ? "the owner's" : "a watcher's"} terminal sends nothing back for DA1/DA2/DA3, DSR/CPR, DECRQM, DECRQSS, XTWINOPS and OSC colour queries`, async () => {
      const { conn, recording } = await renderWithSessions(<TerminalPanel />, { role, sessions: [hostAgent] });
      await nextRequest(conn, 'session.attach');
      // Queries inside the snapshot, then inside live output.
      await act(async () => {
        snapshot(conn, hostAgent, `prompt${TERMINAL_QUERIES.map(([, q]) => q).join('')}`, 1000);
      });
      let offset = 1000;
      await act(async () => {
        for (const [, query] of TERMINAL_QUERIES) {
          conn.emit('exec.output', { sessionId: 'sess_host', offset, data: bytes(query) });
          offset += bytes(query).byteLength;
        }
        conn.emit('exec.output', { sessionId: 'sess_host', offset, data: bytes('done') });
      });
      const term = recording.viewers[0]!.term;
      await flushTerm(term);
      expect(terminalText(term)).toBe('promptdone');
      expect(conn.notificationsOf('exec.input')).toEqual([]);
      if (role === 'host') {
        // The positive control: the owner's terminal does send what the owner types.
        await act(async () => {
          term.input('ok', true);
        });
        expect(conn.notificationsOf('exec.input').map((n) => decoder.decode(n.payload.data))).toEqual(['ok']);
      }
    });
  }
});

describe('terminal panel: input from the host and members with agent access (any session), the size only from the owner', () => {
  it("the owner's keystrokes go to the PTY as exec.input, and the owner's viewport is proposed as the PTY size", async () => {
    const recording = recordingViewerFactory();
    recording.proposed = { cols: 132, rows: 43 };
    const { conn } = await renderWithSessions(<TerminalPanel />, { role: 'host', sessions: [hostAgent], recording });
    const attach = await nextRequest(conn, 'session.attach');
    expect(attach.payload).toEqual({ sessionId: 'sess_host', cols: 132, rows: 43 });
    await act(async () => {
      conn.respond('session.attach', { session: hostAgent, mode: 'snapshot', data: bytes('$ '), cols: 132, rows: 43, nextOffset: 2 });
    });
    const term = recording.viewers[0]!.term;
    expect(term.options.disableStdin).toBe(false);
    await act(async () => {
      term.input('ls -la\r', true);
    });
    expect(conn.notificationsOf('exec.input').map((n) => [n.payload.sessionId, decoder.decode(n.payload.data)])).toEqual([['sess_host', 'ls -la\r']]);
    expect(screen.queryByText(/you can only watch/)).toBeNull();
  });

  it("a member with agent access types straight into the HOST's session (exec.input), but proposes no size and cannot end it", async () => {
    const recording = recordingViewerFactory();
    recording.proposed = { cols: 200, rows: 60 };
    const { conn } = await renderWithSessions(<TerminalPanel />, { role: 'agent', sessions: [hostAgent], recording });
    const attach = await nextRequest(conn, 'session.attach');
    // Not the owner: no viewport with the attach (the PTY size stays the owner's).
    expect(attach.payload).toEqual({ sessionId: 'sess_host' });
    await act(async () => {
      snapshot(conn, hostAgent, '$ ', 2);
    });
    const term = recording.viewers[0]!.term;
    expect(term.options.disableStdin).toBe(false);
    await act(async () => {
      term.input('echo from-amy\r', true);
    });
    expect(conn.notificationsOf('exec.input').map((n) => [n.payload.sessionId, decoder.decode(n.payload.data)])).toEqual([['sess_host', 'echo from-amy\r']]);
    expect(conn.notificationsOf('exec.resize')).toEqual([]);
    expect(within(screen.getByRole('tabpanel')).queryByText('Watch only')).toBeNull();
    // Ending stays with the person who opened it (and the host's "Terminate").
    expect(within(screen.getByRole('tabpanel')).queryByRole('button', { name: /End session|Terminate/ })).toBeNull();
  });

  for (const role of ['editor', 'viewer'] as const) {
    it(`${role === 'editor' ? 'an editor' : 'a viewer'} watches read-only: typing sends nothing, no size is proposed, the hint says how to take part`, async () => {
      const recording = recordingViewerFactory();
      recording.proposed = { cols: 200, rows: 60 };
      const { conn } = await renderWithSessions(<TerminalPanel />, { role, sessions: [hostAgent], recording });
      const attach = await nextRequest(conn, 'session.attach');
      expect(attach.payload).toEqual({ sessionId: 'sess_host' });
      await act(async () => {
        snapshot(conn, hostAgent, '$ ', 2);
      });
      const term = recording.viewers[0]!.term;
      expect(term.options.disableStdin).toBe(true);
      await act(async () => {
        term.input('rm -rf /\r', true);
        term.paste('echo pasted');
      });
      expect(conn.notificationsOf('exec.input')).toEqual([]);
      expect(conn.notificationsOf('exec.resize')).toEqual([]);
      // A compact badge on the session's line; the full hint in the details (it cost the watcher 3 rows).
      expect(within(screen.getByRole('tabpanel')).getByText('Watch only')).toBeTruthy();
      fireEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Details' }));
      // A terminal takes no suggestions (protocol 4): the hint says who types, to an editor and a viewer alike.
      const hint = screen.getByText(/^Ian opened this terminal; you can only watch\./);
      expect(hint.textContent).toContain('The host and members with agent access can type into it.');
      expect(hint.textContent).not.toMatch(/suggest/i);
      expect(within(screen.getByRole('tabpanel')).queryByRole('button', { name: 'End session' })).toBeNull();
    });
  }

  it("an ended session's terminal is read-only for its owner too", async () => {
    const ended = { ...hostAgent, status: 'exited' as const, exitCode: 0 };
    const { conn, recording } = await renderWithSessions(<TerminalPanel />, { role: 'host', sessions: [ended] });
    await nextRequest(conn, 'session.attach');
    await act(async () => {
      snapshot(conn, ended, 'bye', 3);
    });
    const term = recording.viewers[0]!.term;
    expect(term.options.disableStdin).toBe(true);
    await act(async () => {
      term.input('x', true);
    });
    expect(conn.notificationsOf('exec.input')).toEqual([]);
  });
});

describe('terminal panel: file paths in the output open the file (SPEC R7)', () => {
  it("links only paths that exist in the session's own root, and opens them at the line; paths outside the tree are never looked up", async () => {
    const worktreeAgent = makeSession({ id: 'sess_wt', openedBy: { userId: 'dev:bob', displayName: 'Bob' }, root: worktreeRoot('wt_1') });
    const { conn, recording, session } = await renderWithSessions(<TerminalPanel />, { role: 'editor', sessions: [worktreeAgent] });
    const stats: string[] = [];
    conn.handle('file.stat', (ref) => {
      stats.push(`${ref.root.kind === 'worktree' ? ref.root.worktreeId : 'main'}:${ref.path}`);
      if (ref.root.kind === 'worktree' && ref.path === 'src/app.ts') return { entry: makeEntry('src/app.ts') };
      throw new SmurgError('not_found');
    });
    const opened: unknown[] = [];
    session.commands.handle('openFile', (payload) => {
      opened.push(payload);
    });
    await nextRequest(conn, 'session.attach');
    await act(async () => {
      snapshot(conn, worktreeAgent, 'Updated src/app.ts:12 and ../escape.ts /etc/passwd missing.ts', 60);
    });
    const { term, providers } = recording.viewers[0]!;
    await flushTerm(term);
    expect(providers).toHaveLength(1);
    const links = await act(async () => new Promise<ILink[] | undefined>((resolve) => providers[0]!.provideLinks(1, resolve)));
    expect(links?.map((link) => link.text)).toEqual(['src/app.ts:12']);
    expect(stats.sort()).toEqual(['wt_1:missing.ts', 'wt_1:src/app.ts']);
    await act(async () => {
      links![0]!.activate(new MouseEvent('click'), links![0]!.text);
    });
    expect(opened).toEqual([{ file: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'src/app.ts' }, line: 12 }]);
  });
});

describe('terminal panel: what a pointer over the output asks the host (review R4-04)', () => {
  const hover = async (role: 'host' | 'editor', line: string): Promise<{ stats: string[]; links: string[] }> => {
    const agent = makeSession({ id: 'sess_p', openedBy: { userId: 'dev:bob', displayName: 'Bob' } });
    const { conn, recording, unmount } = await renderWithSessions(<TerminalPanel />, { role, sessions: [agent] });
    const stats: string[] = [];
    conn.handle('file.stat', (ref) => {
      stats.push(ref.path);
      if (ref.path === 'src/app.ts') return { entry: makeEntry('src/app.ts') };
      // A name through a link that leads out of the workspace is refused for everyone; everything else the host has
      // nothing to say about (a private file, a path through a file) is simply not there.
      throw new SmurgError(ref.path.startsWith('data/') ? 'path_denied' : 'not_found');
    });
    await nextRequest(conn, 'session.attach');
    await act(async () => {
      snapshot(conn, agent, line, 60);
    });
    const { term, providers } = recording.viewers[0]!;
    await flushTerm(term);
    const links = await act(async () => new Promise<ILink[] | undefined>((resolve) => providers[0]!.provideLinks(1, resolve)));
    unmount();
    return { stats, links: (links ?? []).map((link) => link.text) };
  };

  it("a host-private name in terminal output is not asked about by a member who is not the host; the host's page asks", async () => {
    const line = 'cat .envrc .git/config CLAUDE.local.md .smurg/audit.log src/app.ts';
    expect(await hover('editor', line)).toEqual({ stats: ['src/app.ts'], links: ['src/app.ts'] });
    expect(await hover('host', line)).toEqual({ stats: ['.envrc', '.git/config', 'CLAUDE.local.md', '.smurg/audit.log', 'src/app.ts'], links: ['src/app.ts'] });
  });

  it('a line of names the host refuses costs a handful of refused requests, not one per name, and a refused name turns no other link off', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `data/a${index + 1}`);
    const refused = { stats: names.slice(0, REFUSALS_PER_MINUTE), links: [] };
    expect(await hover('editor', names.join(' '))).toEqual(refused);
    expect(await hover('host', names.join(' '))).toEqual(refused);
    expect(await hover('editor', 'data/a1 src/app.ts README.md/x')).toEqual({ stats: ['data/a1', 'src/app.ts', 'README.md/x'], links: ['src/app.ts'] });
  });
});

describe("terminal panel: the owner's viewport drives the PTY size (policy `owner`)", () => {
  type Callback = (entries: unknown[], observer: unknown) => void;
  const observers: { callback: Callback; targets: Element[] }[] = [];
  class FakeResizeObserver {
    private readonly record: { callback: Callback; targets: Element[] };
    constructor(callback: Callback) {
      this.record = { callback, targets: [] };
      observers.push(this.record);
    }
    observe(target: Element): void {
      this.record.targets.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      this.record.targets = [];
    }
  }

  async function withResizeObserver(run: () => Promise<void>): Promise<void> {
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    observers.length = 0;
    try {
      await run();
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    }
  }

  const fireResize = async (): Promise<void> => {
    await act(async () => {
      for (const observer of observers) if (observer.targets.length > 0) observer.callback([], observer);
      await new Promise((resolve) => setTimeout(resolve, 250)); // past the debounce
    });
  };

  it('the owner proposes the size its panel can show (exec.resize); the daemon answers in stream order', async () => {
    await withResizeObserver(async () => {
      const recording = recordingViewerFactory();
      recording.proposed = { cols: 120, rows: 40 };
      const { conn } = await renderWithSessions(<TerminalPanel />, { role: 'host', sessions: [hostAgent], recording });
      await nextRequest(conn, 'session.attach');
      await act(async () => {
        snapshot(conn, hostAgent, '$ ', 2);
      });
      recording.proposed = { cols: 150, rows: 50 };
      await fireResize();
      expect(conn.notificationsOf('exec.resize').map((n) => n.payload)).toEqual([{ sessionId: 'sess_host', cols: 150, rows: 50 }]);
      await act(async () => {
        conn.emit('exec.resize', { sessionId: 'sess_host', cols: 150, rows: 50 });
      });
      const term = recording.viewers[0]!.term;
      await flushTerm(term);
      expect([term.cols, term.rows]).toEqual([150, 50]);
      // The same size again is not re-sent.
      await fireResize();
      expect(conn.notificationsOf('exec.resize')).toHaveLength(1);
    });
  });

  for (const role of ['agent', 'editor'] as const) {
    it(`${role === 'agent' ? 'a member with agent access (who may type)' : 'a watcher'} never resizes someone else's PTY, whatever the size of its panel`, async () => {
      await withResizeObserver(async () => {
        const recording = recordingViewerFactory();
        recording.proposed = { cols: 60, rows: 20 };
        const { conn } = await renderWithSessions(<TerminalPanel />, { role, sessions: [hostAgent], recording });
        await nextRequest(conn, 'session.attach');
        await act(async () => {
          snapshot(conn, hostAgent, '$ ', 2);
        });
        await fireResize();
        expect(conn.notificationsOf('exec.resize')).toEqual([]);
        const term = recording.viewers[0]!.term;
        expect([term.cols, term.rows]).toEqual([120, 40]);
        // It may draw the PTY-sized terminal smaller instead (never reflowed), and it is told why the panel scrolls.
        expect(screen.getByRole('button', { name: 'Scale to fit the width' })).toBeTruthy();
        expect(screen.getByTestId('terminal-size-hint').textContent).toContain('Actual size 120 × 40');
        fireEvent.click(screen.getByRole('button', { name: 'Scale to fit the width' }));
        expect(screen.queryByTestId('terminal-size-hint')).toBeNull();
        expect(screen.getByRole('button', { name: 'Show at original size' }).getAttribute('aria-pressed')).toBe('true');
        expect(conn.notificationsOf('exec.resize')).toEqual([]);
      });
    });
  }

  it('the owner of a shell in a narrow panel gets the columns the panel shows (not 80 clipped at its edge), and every later size', async () => {
    await withResizeObserver(async () => {
      const recording = recordingViewerFactory();
      recording.proposed = { cols: 50, rows: 28 };
      const { conn } = await renderWithSessions(<TerminalPanel />, { role: 'host', sessions: [hostShell], recording });
      const attach = await nextRequest(conn, 'session.attach');
      expect(attach.payload).toEqual({ sessionId: 'sess_shell', cols: 50, rows: 28 });
      await act(async () => {
        conn.respond('session.attach', { session: { ...hostShell, cols: 50, rows: 28 }, mode: 'snapshot', data: bytes('$ '), cols: 50, rows: 28, nextOffset: 2 });
      });
      await act(async () => {
        await flushTerm(recording.viewers[0]!.term);
      });
      const viewport = screen.getByRole('region', { name: /^Terminal of / });
      expect(viewport.dataset).toMatchObject({ cols: '50', rows: '28', fitCols: '50', fitRows: '28', driving: 'true' });
      expect(screen.queryByTestId('terminal-size-hint')).toBeNull();
      // The panel is made wider (a pane toggled, the separator dragged): columns and rows follow.
      recording.proposed = { cols: 140, rows: 30 };
      await fireResize();
      expect(conn.notificationsOf('exec.resize').map((n) => n.payload)).toEqual([{ sessionId: 'sess_shell', cols: 140, rows: 30 }]);
    });
  });

  it("the owner's second window, while the other one drives the size: the PTY's size scrolls with the hint, nothing is sent", async () => {
    await withResizeObserver(async () => {
      const recording = recordingViewerFactory();
      recording.proposed = { cols: 100, rows: 30 };
      const { conn } = await renderWithSessions(<TerminalPanel />, { role: 'host', sessions: [hostShell], recording });
      await nextRequest(conn, 'session.attach');
      await act(async () => {
        conn.respond('session.attach', { session: hostShell, mode: 'snapshot', data: bytes('$ '), cols: 100, rows: 30, nextOffset: 2 });
      });
      // The owner's other window (a bigger screen) typed or resized: the daemon follows it.
      await act(async () => {
        conn.emit('exec.resize', { sessionId: 'sess_shell', cols: 160, rows: 50 });
        await flushTerm(recording.viewers[0]!.term);
      });
      const viewport = screen.getByRole('region', { name: /^Terminal of / });
      expect(viewport.dataset).toMatchObject({ cols: '160', rows: '50', fitCols: '100', fitRows: '30' });
      expect(viewport.dataset['driving']).toBeUndefined();
      expect(screen.getByTestId('terminal-size-hint').textContent).toContain('Actual size 160 × 50');
      expect(conn.notificationsOf('exec.resize')).toEqual([]);
    });
  });

  it('the browser tab becoming visible again, and a font that finished loading, re-measure and send the new size', async () => {
    const fonts = new EventTarget() as EventTarget & { ready: Promise<unknown> };
    fonts.ready = new Promise(() => {});
    const original = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    try {
      await withResizeObserver(async () => {
        const recording = recordingViewerFactory();
        recording.proposed = { cols: 100, rows: 30 };
        const { conn } = await renderWithSessions(<TerminalPanel />, { role: 'host', sessions: [hostShell], recording });
        await nextRequest(conn, 'session.attach');
        await act(async () => {
          conn.respond('session.attach', { session: hostShell, mode: 'snapshot', data: bytes('$ '), cols: 100, rows: 30, nextOffset: 2 });
        });
        recording.proposed = { cols: 90, rows: 30 };
        await act(async () => {
          document.dispatchEvent(new Event('visibilitychange'));
          await new Promise((resolve) => setTimeout(resolve, 250));
        });
        expect(conn.notificationsOf('exec.resize').map((n) => n.payload)).toEqual([{ sessionId: 'sess_shell', cols: 90, rows: 30 }]);

        recording.proposed = { cols: 95, rows: 31 };
        await act(async () => {
          fonts.dispatchEvent(new Event('loadingdone'));
          await new Promise((resolve) => setTimeout(resolve, 250));
        });
        expect(recording.remeasured).toBeGreaterThan(0);
        expect(conn.notificationsOf('exec.resize').map((n) => n.payload)).toEqual([
          { sessionId: 'sess_shell', cols: 90, rows: 30 },
          { sessionId: 'sess_shell', cols: 95, rows: 31 },
        ]);
      });
    } finally {
      if (original) Object.defineProperty(document, 'fonts', original);
      else delete (document as { fonts?: unknown }).fonts;
    }
  });
});

describe('terminal panel: ending sessions', () => {
  it('the person who opened a session may end it; the host may terminate anyone’s; others neither', async () => {
    const amyAgent = makeSession({ id: 'sess_amy', openedBy: { userId: 'dev:amy', displayName: 'Amy' }, createdAt: 5 });
    const asAgent = await renderWithSessions(<TerminalPanel />, { role: 'agent', sessions: [amyAgent, hostAgent] });
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs.find((tab) => tab.textContent?.includes('Amy'))!);
    // Named "End session"; the one-line bar shows the short word (the panel is 420 px wide).
    expect(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'End session' }).textContent).toBe('End');
    fireEvent.click(tabs.find((tab) => tab.textContent?.includes('Ian'))!);
    expect(within(screen.getByRole('tabpanel')).queryByRole('button', { name: /End session|Terminate/ })).toBeNull();
    asAgent.unmount();

    await renderWithSessions(<TerminalPanel />, { role: 'host', sessions: [amyAgent] });
    fireEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Terminate' }));
    expect(screen.getByRole('alertdialog', { name: 'Terminate session' })).toBeTruthy();
  });
});

// `smurg attach` as a person uses it: the real CLI process inside a PTY created by the test (the "terminal window",
// rendered by a headless xterm), attached through the control socket to a real daemon process (real sessions module,
// a host terminal session running /bin/sh). Checks raw mode while attached and the terminal restored after a detach,
// after the remote session exits (its exit code becomes the CLI's), and after the daemon crashes (SIGKILL of the
// fixture's recorded pid); keystrokes and SIGWINCH reach the session; terminal queries get exactly one answer (the
// daemon mirror's); and R4.1: what the CLI renders equals what a second viewer renders.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '@smurg/daemon/testing';
import type { SessionInfo } from '@smurg/protocol';
import { LocalWorkspaceChannel } from '../src/channel/local-channel.ts';
import { CLI_MAIN, isolatedEnv, makeDirs, startDaemonProc, type DaemonProc, type Dirs } from './helpers.ts';
import { SecondViewer, drained, localTerminal, viewportOf, type LocalTerminal } from './viewer.ts';

const run = promisify(execFile);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

interface Stack {
  readonly dirs: Dirs;
  readonly daemon: DaemonProc;
  readonly workspaceId: string;
  readonly host: LocalWorkspaceChannel;
  readonly session: SessionInfo;
}

async function stack(): Promise<Stack> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const workspaceId = `ws_pty_${Math.random().toString(36).slice(2, 14)}`;
  const daemon = await startDaemonProc(dirs, workspaceId);
  cleanups.push(() => daemon.stop());
  const host = await LocalWorkspaceChannel.open(daemon.ctlPath, { deviceName: 'test host' });
  cleanups.push(() => host.close());
  const { session } = await host.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24, title: 'pty test' });
  return { dirs, daemon, workspaceId, host, session };
}

function attachScript(s: Stack): string {
  const cli = `${process.execPath} ${CLI_MAIN} attach ${s.session.id} --workspace ${s.workspaceId}`;
  // Non-interactive sh: nothing but the CLI touches the tty modes (an interactive shell would re-apply its own).
  return `tty; echo "before:$(stty -a | tr '\\n' ' ')"; ${cli}; echo "attach-exit=$?"; echo "after:$(stty -a | tr '\\n' ' ')"; exec sleep 120`;
}

function openLocal(s: Stack, cols = 100, rows = 30): LocalTerminal {
  const local = localTerminal(attachScript(s), isolatedEnv(s.dirs), s.dirs.project, cols, rows);
  cleanups.push(() => local.kill());
  return local;
}

const has = (flags: string, flag: string): boolean => new RegExp(`(^|\\s)${flag.replace('-', '\\-')}(\\s|$)`).test(flags);

async function sttyOf(device: string): Promise<string> {
  const { stdout } = await run('stty', [process.platform === 'darwin' ? '-f' : '-F', device, '-a']);
  return stdout.replace(/\n/g, ' ');
}

function cooked(flags: string): boolean {
  return has(flags, 'icanon') && has(flags, 'echo') && has(flags, 'isig');
}

function raw(flags: string): boolean {
  return has(flags, '-icanon') && has(flags, '-echo') && has(flags, '-isig');
}

async function attached(local: LocalTerminal): Promise<string> {
  await waitFor(() => /\/dev\/\S+/.test(local.text) && local.text.includes('before:'), { timeoutMs: 20_000, what: 'the outer terminal' });
  const device = (/\/dev\/\S+/.exec(local.text) as RegExpExecArray)[0];
  // The CLI switched the terminal to raw mode once the snapshot was painted (RIS clears the "before" lines).
  await waitFor(async () => raw(await sttyOf(device)), { timeoutMs: 20_000, what: 'raw mode' });
  return device;
}

async function typeAndSee(local: LocalTerminal, text: string, expected: string, timeoutMs = 15_000): Promise<void> {
  const mark = local.text.length;
  local.outer.write(text);
  await waitFor(() => local.since(mark).includes(expected), { timeoutMs, what: `"${expected}" on the local terminal` });
}

const afterFlags = (local: LocalTerminal): string => /after:([^\r\n]*)/.exec(local.text)?.[1] ?? '';

describe('smurg attach in a real terminal (control socket, host)', () => {
  it('raw mode while attached; keystrokes, ^C and SIGWINCH reach the session; Ctrl-] detaches and restores the terminal; the session keeps running', async () => {
    const s = await stack();
    const local = openLocal(s);
    const before = /before:([^\r\n]*)/.exec(local.text)?.[1] ?? '';
    const device = await attached(local);
    if (before) expect(cooked(before)).toBe(true);
    await typeAndSee(local, 'echo hello-$((40+2))\r', 'hello-42');
    // The owner's CLI drives the PTY size (resize policy `owner`).
    await waitFor(async () => (await s.host.request('session.list', {})).sessions.some((x) => x.id === s.session.id && x.cols === 100 && x.rows === 30), { what: 'the PTY at 100x30' });
    // ^C goes to the REMOTE shell (isig is off locally): sleep is interrupted, attach stays alive.
    let mark = local.text.length;
    local.outer.write('sleep 30\r');
    await new Promise((resolve) => setTimeout(resolve, 300));
    local.outer.write('\x03');
    local.outer.write('echo after-interrupt-$((1+1))\r');
    await waitFor(() => local.since(mark).includes('after-interrupt-2'), { timeoutMs: 15_000, what: 'the interrupted sleep' });
    // SIGWINCH: the window grows, the PTY follows.
    local.resize(120, 40);
    await waitFor(async () => (await s.host.request('session.list', {})).sessions.some((x) => x.id === s.session.id && x.cols === 120 && x.rows === 40), { what: 'the PTY at 120x40' });
    await typeAndSee(local, 'stty size\r', '40 120');
    // A remote TUI switches modes in the local terminal...
    await typeAndSee(local, `printf '\\033[?1049h\\033[?2004h\\033[?1004h\\033[?1002h\\033[?1006h\\033[?25lALT-%s' SCREEN\r`, 'ALT-SCREEN');
    await waitFor(() => local.term.buffer.active.type === 'alternate' && local.term.modes.bracketedPasteMode, { what: 'alt screen' });
    expect(local.cursorHidden).toBe(true);
    // ...and Ctrl-] detaches: exit 0, terminal back to cooked mode with every mode off.
    mark = local.text.length;
    local.outer.write('\x1d');
    await waitFor(() => local.since(mark).includes('after:'), { timeoutMs: 15_000, what: 'the CLI to exit' });
    expect(local.text).toContain('attach-exit=0');
    expect(cooked(afterFlags(local))).toBe(true);
    expect(cooked(await sttyOf(device))).toBe(true);
    await drained(local.term);
    expect(local.term.buffer.active.type).toBe('normal');
    expect(local.term.modes.bracketedPasteMode).toBe(false);
    expect(local.term.modes.sendFocusMode).toBe(false);
    expect(local.term.modes.mouseTrackingMode).toBe('none');
    expect(local.cursorHidden).toBe(false);
    const after = await s.host.request('session.list', {});
    expect(after.sessions.find((x) => x.id === s.session.id)?.status).toBe('running');
  });

  it('a terminal query from the session gets exactly one answer (the daemon mirror); the local terminal stays silent', async () => {
    const s = await stack();
    const local = openLocal(s);
    await attached(local);
    const mark = local.text.length;
    local.outer.write(`printf '\\033[c'; read -rs -t 2 -d c r1; read -rs -t 1 -d c r2; printf 'DA%s<%s><%s>\\n' 1 "\${r1#?}" "\${r2:-none}"\r`);
    await waitFor(() => /DA1<.*?><.*?>/.test(local.since(mark)), { timeoutMs: 15_000, what: 'the DA1 probe' });
    const replies = /DA1<(.*?)><(.*?)>/.exec(local.since(mark)) as RegExpExecArray;
    expect(replies[1]).toMatch(/^\[\?\d/);
    expect(replies[2]).toBe('none');
    local.outer.write('\x1d');
    await waitFor(() => local.text.includes('attach-exit=0'), { timeoutMs: 15_000, what: 'detach' });
  });

  it('the remote exit code becomes the CLI exit code, and the terminal is restored', async () => {
    const s = await stack();
    const local = openLocal(s);
    const device = await attached(local);
    local.outer.write('exit 7\r');
    await waitFor(() => local.text.includes('attach-exit=7'), { timeoutMs: 20_000, what: 'the remote exit code' });
    await waitFor(() => local.text.includes('after:'), { what: 'after' });
    expect(cooked(afterFlags(local))).toBe(true);
    expect(cooked(await sttyOf(device))).toBe(true);
    expect(local.text).toContain('結束代碼 7');
  });

  it('a daemon crash ends the attach with an error exit, and the terminal is restored', async () => {
    const s = await stack();
    const local = openLocal(s);
    const device = await attached(local);
    await typeAndSee(local, `printf '\\033[?1049h\\033[?25l'; echo in-alt\r`, 'in-alt');
    await s.daemon.crash();
    await waitFor(() => local.text.includes('attach-exit='), { timeoutMs: 20_000, what: 'the CLI to notice the crash' });
    expect(local.text).toContain('attach-exit=1');
    await waitFor(() => local.text.includes('after:'), { what: 'after' });
    expect(cooked(afterFlags(local))).toBe(true);
    expect(cooked(await sttyOf(device))).toBe(true);
    await drained(local.term);
    expect(local.term.buffer.active.type).toBe('normal');
    expect(local.cursorHidden).toBe(false);
    expect(local.text).toContain('與 smurg host 的連線中斷了');
  });

  it('R4.1 同一個 session 同時被網頁和 CLI 接上時，畫面保持一致 — the CLI renders what a second (web-like) viewer renders', async () => {
    const s = await stack();
    const local = openLocal(s, 100, 30);
    await attached(local);
    const viewerChannel = await LocalWorkspaceChannel.open(s.daemon.ctlPath, { deviceName: 'second viewer' });
    cleanups.push(() => viewerChannel.close());
    const viewer = new SecondViewer(viewerChannel, s.session);
    cleanups.push(() => viewer.dispose());
    await viewer.attach();
    await typeAndSee(local, `printf '\\033[1;32mgreen\\033[0m plain \\033[7minverse\\033[0m\\n'; seq 1 45; printf 'tab\\there\\n'; echo R41-DONE-$((6*7))\r`, 'R41-DONE-42');
    const done = (lines: string[]): boolean => lines.some((line) => line.includes('R41-DONE-42'));
    await waitFor(async () => {
      await drained(local.term);
      await drained(viewer.term);
      return done(viewportOf(local.term)) && done(viewer.viewport());
    }, { timeoutMs: 15_000, what: 'both screens to show the output' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await drained(local.term);
    await drained(viewer.term);
    expect(viewer.size()).toEqual({ cols: 100, rows: 30 });
    expect(viewportOf(local.term)).toEqual(viewer.viewport());
    // Same cursor, same attributes on the colored cell.
    expect(local.term.buffer.active.cursorY).toBe(viewer.term.buffer.active.cursorY);
    expect(local.term.buffer.active.cursorX).toBe(viewer.term.buffer.active.cursorX);
    local.outer.write('\x1d');
    await waitFor(() => local.text.includes('attach-exit=0'), { timeoutMs: 15_000, what: 'detach' });
  });
});

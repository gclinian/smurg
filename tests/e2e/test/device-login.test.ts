// The CLI's device-code login end to end (ARCHITECTURE §6, decided 2026-10-01): the REAL `smurg` (packages/cli from
// source, in a process of its own with a temporary HOME and SMURG_HOME, never a browser) against the REAL relay (local
// workerd). The test plays the person's browser over plain HTTP: the relay's dev login, then the /device forms exactly
// as the page submits them (same-origin form POSTs carrying the session cookie). Allowed: the CLI saves a session
// (0600) that the relay accepts. 「拒絕」: exit 4, nothing saved. Ctrl-C: exit 130 at once, nothing saved.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTestProcess, waitFor } from '@smurg/daemon/testing';
import { RELAY_PATHS, normalizeDeviceUserCode, relayHttpUrl } from '@smurg/protocol/relay';
import { startLocalRelay, type LocalRelay } from '@smurg/relay/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../src/temp.ts';

const CLI_MAIN = fileURLToPath(new URL('../../../packages/cli/src/main.ts', import.meta.url));
const WARNING = '只有你自己剛在終端機執行 smurg login 時才按「允許」；如果是別人給你這個代碼，請按「拒絕」。';

let relay: LocalRelay;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  relay = await startLocalRelay({ tap: false });
});

afterEach(async () => {
  while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)().catch(() => {});
});

afterAll(async () => {
  await relay?.stop();
});

interface CliLogin {
  readonly child: ChildProcess;
  readonly smurgHome: string;
  readonly exited: Promise<number | null>;
  out(): string;
}

/** `smurg login --relay <relay>` as its own process; only this child is ever signalled (ARCHITECTURE §0 rule 1). */
async function startCliLogin(): Promise<CliLogin> {
  const home = await createTempDir('device-login');
  const smurgHome = join(home, '.smurg');
  const child = spawn(process.execPath, [CLI_MAIN, 'login', '--relay', relay.origin], {
    cwd: home,
    // SMURG_NO_BROWSER and pipes: the CLI never opens a browser here (cli/io.ts browserBlock).
    env: { PATH: '/usr/bin:/bin', HOME: home, SMURG_HOME: smurgHome, SMURG_NO_BROWSER: '1', TMPDIR: process.env['TMPDIR'] ?? '/tmp' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 1 || pid === process.pid) throw new Error('the CLI did not start');
  registerTestProcess(pid as number, CLI_MAIN);
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code, signal) => resolve(code ?? (signal === null ? null : -1))));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await removeTempDir(home);
  });
  return { child, smurgHome, exited, out: () => out };
}

/** What the CLI printed: the page and the code, once it waits. */
async function printed(cli: CliLogin): Promise<{ page: string; code: string }> {
  await waitFor(() => cli.out().includes('等待你在瀏覽器裡按「允許」') || cli.child.exitCode !== null, { timeoutMs: 30_000, what: 'the CLI to print the page and the code' });
  const match = /在任何裝置（電腦或手機）打開：\n {2}(\S+)\n輸入代碼：([A-Z]{4}-[A-Z]{4}) {3}（10 分鐘內有效）\n/.exec(cli.out());
  expect(match, cli.out()).not.toBeNull();
  return { page: (match as RegExpExecArray)[1] as string, code: (match as RegExpExecArray)[2] as string };
}

/** The person's browser over HTTP: the relay's session cookie, and forms posted the way the /device page posts them. */
class Person {
  private cookie = '';

  async logIn(user: string): Promise<void> {
    const res = await fetch(relayHttpUrl(relay.origin, `${RELAY_PATHS.devStart}?user=${user}&return_to=%2Fdevice`), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(relayHttpUrl(relay.origin, RELAY_PATHS.device));
    this.cookie = (res.headers.getSetCookie().find((line) => line.startsWith('smurg_session=')) ?? '').split(';')[0] as string;
    expect(this.cookie).toMatch(/^smurg_session=\S+$/);
  }

  async open(page: string): Promise<string> {
    const res = await fetch(page, { headers: { cookie: this.cookie } });
    expect(res.status).toBe(200);
    return res.text();
  }

  async submit(fields: Record<string, string>): Promise<{ status: number; body: string }> {
    const res = await fetch(relayHttpUrl(relay.origin, RELAY_PATHS.device), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: relay.origin, 'sec-fetch-site': 'same-origin', cookie: this.cookie },
      body: new URLSearchParams(fields).toString(),
    });
    return { status: res.status, body: await res.text() };
  }
}

describe('smurg login by device code, the real CLI against the real relay', () => {
  it('allowed: the CLI prints /device and a code; the person logs in, types the code, sees who and where, presses 允許; the CLI saves a session the relay accepts', async () => {
    const cli = await startCliLogin();
    const { page, code } = await printed(cli);
    expect(page).toBe(relayHttpUrl(relay.origin, RELAY_PATHS.device));
    expect(cli.out()).not.toContain('已經用這台電腦的瀏覽器打開');

    const erin = new Person();
    await erin.logIn('erin');
    const form = await erin.open(page);
    expect(form).toContain('<strong>erin</strong>（dev:erin）');
    expect(form).not.toContain(code);
    // A typo first (one wrong code is just a message), then the code as a person might type it.
    const wrong = await erin.submit({ code: 'BCDF-GHJK' === code ? 'BCDF-GHJL' : 'BCDF-GHJK' });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toContain('代碼不正確或已失效');
    const confirm = await erin.submit({ code: code.toLowerCase().replace('-', '') });
    expect(confirm.status).toBe(200);
    expect(confirm.body).toContain(`<dd class="code" data-testid="device-user-code">${code}</dd>`);
    expect(confirm.body).toContain('<strong>erin</strong>（dev:erin）');
    expect(confirm.body).toMatch(/IP 位址 [0-9a-f.:]+，位置大約在 /);
    expect(confirm.body).toContain(WARNING);
    const allowed = await erin.submit({ code: normalizeDeviceUserCode(code) as string, account: 'dev:erin', decision: 'allow' });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toContain('<h1>已允許</h1>');

    // The CLI polls every 5 s.
    await waitFor(() => cli.child.exitCode !== null, { timeoutMs: 30_000, what: 'the CLI to finish the login' });
    expect(await cli.exited, cli.out()).toBe(0);
    expect(cli.out()).toContain(`已登入 ${relay.origin}：erin（dev:erin）`);
    const file = join(cli.smurgHome, 'credentials.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { relays: Record<string, { token: string; userId: string }> };
    expect(saved.relays[relay.origin]?.userId).toBe('dev:erin');
    expect(cli.out()).not.toContain(saved.relays[relay.origin]?.token as string);
    const me = await fetch(relayHttpUrl(relay.origin, RELAY_PATHS.me), { headers: { authorization: `Bearer ${saved.relays[relay.origin]?.token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { userId: string } }).user.userId).toBe('dev:erin');
    // One-time: the code is gone for everybody now.
    expect((await erin.submit({ code })).status).toBe(400);
  });

  it('「拒絕」 in the browser ends the CLI with exit 4 and a zh-TW message; nothing is saved', async () => {
    const cli = await startCliLogin();
    const { code } = await printed(cli);
    const frank = new Person();
    await frank.logIn('frank');
    const denied = await frank.submit({ code: normalizeDeviceUserCode(code) as string, account: 'dev:frank', decision: 'deny' });
    expect(denied.body).toContain('<h1>已拒絕</h1>');
    await waitFor(() => cli.child.exitCode !== null, { timeoutMs: 30_000, what: 'the CLI to give up' });
    expect(await cli.exited, cli.out()).toBe(4);
    expect(cli.out()).toContain('smurg：登入被拒絕：瀏覽器裡按了「拒絕」');
    await expect(stat(join(cli.smurgHome, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Ctrl-C while the CLI waits ends it at once (exit 130); nothing is saved', async () => {
    const cli = await startCliLogin();
    await printed(cli);
    const pressed = Date.now();
    cli.child.kill('SIGINT');
    expect(await cli.exited).toBe(130);
    expect(Date.now() - pressed).toBeLessThan(4_000);
    expect(cli.out()).toContain('smurg：已取消登入');
    await expect(stat(join(cli.smurgHome, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

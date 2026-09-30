// ARCHITECTURE §11 D-12: what a guest has to do after the login process succeeded while one of their agent sessions
// was already running. The question is Claude Code's own behaviour with its config dir, so it is asked of the REAL
// `claude` directly (every verified version available: SMURG_TEST_CLAUDE_BIN, SMURG_TEST_CLAUDE_BINS, PATH) in a PTY,
// outside the sandbox: an isolated HOME / CLAUDE_CONFIG_DIR, a local mock of the Messages API, a FAKE OAuth
// credential written into the config dir while the session runs (what the login process leaves there), and every other
// network access through a dead proxy (ARCHITECTURE §0 rule 2). Skips LOUDLY without a verified claude.
//
// Measured (2.1.220, 2.1.283): the next prompt is sent with the new credential; nothing to restart. 2.1.220 keeps its
// status line 「Not logged in · Run /login」 until the session is restarted (cosmetic).
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_VERIFIED_VERSIONS, claudeVersionVerdict } from '../../src/core/config.ts';
import { ClaudeVersionProbe, resolveClaude } from '../../src/sessions/claude.ts';
import { runProcess } from '../../src/sessions/process-run.ts';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';

const TIMEOUT = 120_000;

async function verifiedClaudes(scratch: string): Promise<{ readonly path: string; readonly version: string }[]> {
  const candidates = [process.env['SMURG_TEST_CLAUDE_BIN'], ...(process.env['SMURG_TEST_CLAUDE_BINS'] ?? '').split(':')].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const probe = new ClaudeVersionProbe({ scratchParent: scratch, run: runProcess });
  const found: { path: string; version: string }[] = [];
  for (const binary of [...(await Promise.all(candidates.map((c) => resolveClaude(c, undefined)))), await resolveClaude(null, process.env['PATH'])]) {
    if (!binary || found.some((f) => f.path === binary.realPath)) continue;
    const verdict = claudeVersionVerdict(await probe.output(binary), { claudeMinVersion: CLAUDE_VERIFIED_VERSIONS[0] as string, claudeVerifiedVersions: CLAUDE_VERIFIED_VERSIONS });
    if (verdict.ok && verdict.warning === null && !found.some((f) => f.version === verdict.version)) found.push({ path: binary.realPath, version: verdict.version });
  }
  return found;
}

interface MockApi {
  readonly url: string;
  readonly requests: { readonly url: string; readonly auth: 'bearer' | 'x-api-key' | 'none' }[];
  close(): Promise<void>;
}

async function mockApi(): Promise<MockApi> {
  const requests: MockApi['requests'][number][] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = req.url ?? '';
      requests.push({ url, auth: req.headers['authorization'] ? 'bearer' : req.headers['x-api-key'] ? 'x-api-key' : 'none' });
      if (!url.startsWith('/v1/messages') || url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(url.includes('count_tokens') ? '{"input_tokens":1}' : '{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (event: string, data: unknown): boolean => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-mock', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MOCK-REPLY-OK' } });
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const flat = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\s+/g, '');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) await sleep(100);
  return predicate();
}

describe('D-12: a running agent session and a login that completed meanwhile (real claude, mock API)', () => {
  let claudes: { readonly path: string; readonly version: string }[] = [];
  let scratch: string | undefined;

  beforeAll(async () => {
    scratch = await createTempDir('login-pickup');
    claudes = await verifiedClaudes(scratch);
    if (claudes.length === 0) process.stderr.write('\n*** claude-login-pickup.test.ts SKIPPED: no verified Claude Code binary ***\n\n');
  }, TIMEOUT);

  afterAll(async () => {
    if (scratch) await removeTempDir(scratch);
  });

  it('the next prompt of the running session uses the credential the login left in the config dir (no restart needed)', async (ctx) => {
    if (claudes.length === 0) return ctx.skip('no verified Claude Code binary');
    for (const claude of claudes) {
      const base = join(scratch as string, `v${claude.version}`);
      const [home, cfg, tmp, proj] = ['home', 'cfg', 'tmp', 'proj'].map((d) => join(base, d)) as [string, string, string, string];
      for (const dir of [home, cfg, tmp, proj]) await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(cfg, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [await realpath(proj)]: { hasTrustDialogAccepted: true } } }));
      const api = await mockApi();
      const env = {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: home,
        CLAUDE_CONFIG_DIR: cfg,
        TMPDIR: tmp,
        USER: 'smurg-test',
        LANG: 'en_US.UTF-8',
        TERM: 'xterm-256color',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        BROWSER: '/usr/bin/true',
        ANTHROPIC_BASE_URL: api.url,
        HTTPS_PROXY: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost',
      };
      const child = pty.spawn(claude.path, [], { name: 'xterm-256color', cols: 160, rows: 50, cwd: proj, env });
      let out = '';
      child.onData((data) => (out += data));
      try {
        expect(await until(() => flat(out).includes('?forshortcuts') || flat(out).includes('automodeon'), 30_000), `claude ${claude.version} prompt`).toBe(true);
        child.write('first prompt');
        await sleep(500);
        child.write('\r');
        await until(() => flat(out).includes('Notloggedin·Pleaserun/login') || flat(out).includes('MOCK-REPLY-OK'), 15_000);
        expect(flat(out)).not.toContain('MOCK-REPLY-OK');
        expect(api.requests.filter((r) => r.url.startsWith('/v1/messages'))).toEqual([]);
        // What the login process leaves in the guest's config dir (a fake token: it only has to look like one).
        await writeFile(join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-SMURG-FAKE-not-real', refreshToken: 'sk-ant-ort01-SMURG-FAKE-not-real', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'], subscriptionType: 'pro' } }), { mode: 0o600 });
        await sleep(1_000);
        const mark = out.length;
        child.write('second prompt');
        await sleep(500);
        child.write('\r');
        expect(await until(() => flat(out.slice(mark)).includes('MOCK-REPLY-OK'), 20_000), `claude ${claude.version} answered with the new login`).toBe(true);
        const messages = api.requests.filter((r) => r.url.startsWith('/v1/messages'));
        expect(messages.length).toBeGreaterThan(0);
        expect(messages.every((r) => r.auth === 'bearer')).toBe(true);
        console.info(`[login-pickup] claude ${claude.version}: picked up the new credential on the next prompt (${messages.length} request(s), bearer)`);
      } finally {
        child.kill('SIGKILL'); // our own child only
        await api.close();
      }
    }
  }, TIMEOUT * 2);
});

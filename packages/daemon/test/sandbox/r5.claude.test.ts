// SPEC R5.3 and R5.5 with the REAL `claude` binary inside the real guest sandbox (srt through node-pty, as a session).
// The model is a local mock of the Messages API (mock-anthropic.ts): ANTHROPIC_BASE_URL on 127.0.0.1, a dummy key,
// the guest's own temp HOME / CLAUDE_CONFIG_DIR, and an allow-list that contains nothing but the mock, so the binary
// can reach neither Anthropic nor any account (ARCHITECTURE §0 rule 2). The host home is the fixture's FAKE home.
//
// Claude's own permission layer is switched off here (--dangerously-skip-permissions, test only; sessions never pass
// it) so that the OS sandbox is the only thing between the tools and the files: a denial must come back as EPERM.
//
// No usable claude (not configured, not on PATH, or a version below the minimum) SKIPS these tests loudly with the
// reason; they never pass silently.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { claudeVersionVerdict } from '../../src/core/config.ts';
import { startMockAnthropic, type MockAnthropic, type ScriptedToolCall } from './mock-anthropic.ts';
import {
  claudeVersionOutput,
  createSandboxFixture,
  findClaude,
  guestEnv,
  marker,
  printWarningsOnFailure,
  q,
  runWrapped,
  sandboxPlatform,
  type GuestDirs,
  type SandboxFixture,
} from './helpers.ts';

const TIMEOUT = 240_000;
const EPERM = /EPERM|operation not permitted/i;

interface ClaudeAvailability {
  readonly path: string | null;
  readonly reason: string | null;
}

let availability: ClaudeAvailability = { path: null, reason: 'not checked' };

describe.runIf(sandboxPlatform)('R5 客人沙盒 with the real claude binary', () => {
  let f: SandboxFixture | undefined;

  beforeAll(async () => {
    const configured = process.env['SMURG_TEST_CLAUDE_PATH'];
    f = await createSandboxFixture({
      // SMURG_TEST_CLAUDE_PATH=<absolute path> runs these tests against a specific claude (config.sessions.claudePath).
      ...(configured !== undefined && configured !== '' ? { claudePath: configured } : {}),
      files: {
        'README.md': 'project\n',
        'src/app.ts': 'export const x = 1;\n',
        'data/dataset.csv': 'id,v\n1,42\n',
        '.claude/settings.json': '{"note":"host-owned"}\n',
        'CLAUDE.md': 'SHARE-ROOT-MEMORY placeholder\n',
        'sub/dir/placeholder.txt': 'x\n',
      },
    });
    const claude = await findClaude(f.ctx.config.sessions.claudePath);
    if (claude === null) {
      availability = { path: null, reason: 'no `claude` binary: config.sessions.claudePath is unset and none is on PATH' };
    } else {
      const output = await claudeVersionOutput(claude, f.base);
      const verdict = output === null ? null : claudeVersionVerdict(output, f.ctx.config.sessions);
      if (verdict === null) availability = { path: null, reason: `\`${claude} --version\` failed` };
      else if (!verdict.ok) availability = { path: null, reason: `claude ${verdict.version ?? '(unreadable version)'} is not usable: ${verdict.reason}` };
      else {
        availability = { path: claude, reason: null };
        if (verdict.warning !== null) process.stderr.write(`r5.claude: claude ${verdict.version} runs with warning ${verdict.warning}\n`);
      }
    }
    if (availability.reason !== null) process.stderr.write(`\n*** r5.claude.test.ts SKIPPED: ${availability.reason} ***\n\n`);
  }, TIMEOUT);

  afterEach((context) => printWarningsOnFailure(f, context));

  afterAll(async () => {
    await f?.cleanup();
  }, TIMEOUT);

  function skipUnlessClaude(context: { skip: (note?: string) => void }): string {
    if (availability.path === null) {
      context.skip(`SKIPPED LOUDLY: ${availability.reason ?? 'claude unavailable'}`);
      throw new Error('unreachable');
    }
    return availability.path;
  }

  /** Runs `claude -p` in the guest sandbox against `mock`; `cwdRel` is the working directory inside the share. */
  async function runClaude(fixture: SandboxFixture, claude: string, mock: MockAnthropic, guest: GuestDirs, options: { readonly cwdRel?: string; readonly env?: Record<string, string> } = {}): Promise<{ exitCode: number; output: string }> {
    await fixture.setAllowedDomains([`127.0.0.1:${mock.port}`]);
    const cwd = join(fixture.share, options.cwdRel ?? '.');
    // srt sets NO_PROXY for loopback in the sandbox; the mock is reached THROUGH the proxy (its allow-list entry).
    const command = `export NO_PROXY= no_proxy=; cd ${q(cwd)} && exec ${q(claude)} -p 'run the scripted tools' --dangerously-skip-permissions --max-turns 16 --output-format json`;
    const spec = fixture.spec({
      command,
      guest,
      settingsDir: await fixture.settingsDir(`ses_claude_${Date.now()}`, '{}\n'),
      extraReadPaths: [claude],
      readOnlyPaths: [join(fixture.share, 'data')],
      env: options.env ?? guestEnv(guest, { ANTHROPIC_API_KEY: 'sk-ant-api03-SMURG-TEST-FAKE-KEY-not-a-real-key', ANTHROPIC_BASE_URL: mock.baseUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }),
    });
    const wrapped = await fixture.sandbox.wrap(spec);
    return runWrapped(wrapped, 180_000);
  }

  it('R5.3 agent 的 Edit、Write 工具同樣受到限制（不只 Bash）', async (context) => {
    const claude = skipUnlessClaude(context);
    const fx = f as SandboxFixture;
    const guest = await fx.guest('r53');
    const outsidePath = join(fx.home, 'pwned-by-write-tool.txt');
    const settingsPath = join(fx.share, '.claude', 'settings.json');
    const dataPath = join(fx.share, 'data', 'dataset.csv');
    const script: ScriptedToolCall[] = [
      { name: 'Read', input: { file_path: join(fx.home, '.ssh', 'id_ed25519') } },
      // Write outside the session root (into the host home)
      { name: 'Write', input: { file_path: outsidePath, content: 'guest escaped\n' } },
      // Write a host-only path inside the share (would be loaded by the host's unsandboxed Claude)
      { name: 'Write', input: { file_path: join(fx.share, '.mcp.json'), content: '{"mcpServers":{"x":{"command":"evil"}}}\n' } },
      { name: 'Write', input: { file_path: join(fx.share, '.vscode', 'settings.json'), content: '{}\n' } },
      // Edit a host-only file that exists and is readable
      { name: 'Read', input: { file_path: settingsPath } },
      { name: 'Edit', input: { file_path: settingsPath, old_string: 'host-owned', new_string: 'guest-owned' } },
      // Edit a file of a shared read-only dir
      { name: 'Read', input: { file_path: dataPath } },
      { name: 'Edit', input: { file_path: dataPath, old_string: '1,42', new_string: '1,43' } },
      // positive control: the tools do run, inside the session root
      { name: 'Write', input: { file_path: join(fx.share, 'src', 'from-agent.ts'), content: 'export const y = 2;\n' } },
    ];
    const mock = await startMockAnthropic(script);
    try {
      const run = await runClaude(fx, claude, mock, guest);
      expect(run.exitCode, run.output.slice(-2000)).toBe(0);
      expect(mock.toolResults.length).toBe(script.length);
      const [readKey, writeOutside, writeMcp, writeVscode, readSettings, editSettings, readData, editData, writeInside] = mock.toolResults;
      // The Read of the host key fails too: EPERM on 2.1.220; 2.1.283's Read tool refuses by itself once the sandbox's
      // EPERM stops it from resolving the path ("Refusing to read …"). Either way the key never reaches the model.
      expect(readKey?.isError).toBe(true);
      expect(readKey?.text).toMatch(/EPERM|operation not permitted|Refusing to read/i);
      // The criterion itself: Write and Edit are stopped by the OS sandbox (EPERM), not by Claude's own checks.
      for (const result of [writeOutside, writeMcp, writeVscode, editSettings, editData]) {
        expect(result?.isError, JSON.stringify(result)).toBe(true);
        expect(result?.text).toMatch(EPERM);
      }
      expect(readSettings?.isError).toBe(false);
      expect(readData?.isError).toBe(false);
      expect(writeInside?.isError, JSON.stringify(writeInside)).toBe(false);
      // and on disk: nothing escaped, nothing host-only changed, the control was written
      expect(existsSync(outsidePath)).toBe(false);
      expect(existsSync(join(fx.share, '.mcp.json'))).toBe(false);
      expect(existsSync(join(fx.share, '.vscode'))).toBe(false);
      expect(await readFile(settingsPath, 'utf8')).toBe('{"note":"host-owned"}\n');
      expect(await readFile(dataPath, 'utf8')).toBe('id,v\n1,42\n');
      expect(await readFile(join(fx.share, 'src', 'from-agent.ts'), 'utf8')).toBe('export const y = 2;\n');
      expect(mock.seenText()).not.toContain(fx.markers.sshKey);
    } finally {
      await mock.close();
    }
  }, TIMEOUT);

  it('R5.5 主人的 `~/.claude/CLAUDE.md` 不會被載入客人 session', async (context) => {
    const claude = skipUnlessClaude(context);
    const fx = f as SandboxFixture;
    const guest = await fx.guest('r55');
    const guestMemory = marker('GUEST-OWN-MEMORY');
    const shareRoot = marker('SHARE-ROOT-MEMORY');
    const shareAncestor = marker('SHARE-SUB-ANCESTOR');
    await writeFile(join(guest.cfg, 'CLAUDE.md'), `${guestMemory}\n`);
    await writeFile(join(fx.share, 'CLAUDE.md'), `${shareRoot}\n`);
    await mkdir(join(fx.share, 'sub'), { recursive: true });
    await writeFile(join(fx.share, 'sub', 'CLAUDE.md'), `${shareAncestor}\n`);
    const hostOnly = [fx.markers.hostClaudeMd, fx.markers.homeAncestorMd, fx.markers.projectsAncestorMd, fx.markers.hostClaudeSettings];

    // (a) the guest layout: own HOME / CLAUDE_CONFIG_DIR, working in a subdirectory of the share, so Claude walks up
    //     through the share (readable: loaded, the control) into the fake host home (denied: not loaded).
    const mockA = await startMockAnthropic([]);
    try {
      const run = await runClaude(fx, claude, mockA, guest, { cwdRel: 'sub/dir' });
      expect(run.exitCode, run.output.slice(-2000)).toBe(0);
      expect(mockA.requests.length).toBeGreaterThan(0);
      const seen = mockA.seenText();
      // controls: the mock sees memory files, both the guest's own and ancestors inside the share
      expect(seen).toContain(guestMemory);
      expect(seen).toContain(shareRoot);
      expect(seen).toContain(shareAncestor);
      for (const secret of hostOnly) expect(seen).not.toContain(secret);
    } finally {
      await mockA.close();
    }

    // (b) worst case, a misconfigured guest session that points HOME at the host home and sets no CLAUDE_CONFIG_DIR:
    //     Claude then looks for ~/.claude/CLAUDE.md of the host itself, and the sandbox still keeps it out.
    const mockB = await startMockAnthropic([]);
    try {
      const env = guestEnv(guest, { HOME: fx.home, ANTHROPIC_API_KEY: 'sk-ant-api03-SMURG-TEST-FAKE-KEY-not-a-real-key', ANTHROPIC_BASE_URL: mockB.baseUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
      delete env['CLAUDE_CONFIG_DIR'];
      const run = await runClaude(fx, claude, mockB, guest, { env });
      expect(run.exitCode, run.output.slice(-2000)).toBe(0);
      expect(mockB.requests.length).toBeGreaterThan(0);
      const seen = mockB.seenText();
      expect(seen).toContain(shareRoot);
      for (const secret of hostOnly) expect(seen).not.toContain(secret);
      // nothing was written into the host home either
      expect(existsSync(join(fx.home, '.claude.json'))).toBe(false);
      expect(existsSync(dirname(join(fx.home, '.claude', 'projects', 'x')))).toBe(false);
    } finally {
      await mockB.close();
    }
  }, TIMEOUT);
});

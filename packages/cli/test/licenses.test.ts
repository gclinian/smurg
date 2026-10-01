// `smurg licenses [--third-party]` from source: smurg's LICENSE, then the executable's third-party notices (srt's
// Apache-2.0 text among them) with the Node.js section of the running Node; --third-party prints the notices alone.
// The single executable prints its embedded copies instead: packages/cli/test/sea.test.ts.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run.ts';
import { runLicenses } from '../src/commands/licenses.ts';
import { composeExecutableNotices, nodeDistributionLicense } from '../src/licenses/notices.ts';
import { CLI_MAIN, testIo } from './helpers.ts';

const run = promisify(execFile);
const ROOT = join(CLI_MAIN, '..', '..', '..', '..');
const LICENSE = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
const COMMITTED = readFileSync(join(ROOT, 'packages', 'cli', 'THIRD-PARTY-NOTICES.txt'), 'utf8');
const MAX = 16 * 1024 * 1024;

describe('smurg licenses', () => {
  it('prints LICENSE and then the third-party notices of the executable (from source)', async () => {
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', SMURG_NO_BROWSER: '1' };
    const all = await run(process.execPath, [CLI_MAIN, 'licenses'], { env, timeout: 30_000, maxBuffer: MAX });
    const notices = await run(process.execPath, [CLI_MAIN, 'licenses', '--third-party'], { env, timeout: 30_000, maxBuffer: MAX });
    expect(all.stdout).toBe(`${LICENSE}\n${notices.stdout}`);
    expect(LICENSE).toMatch(/^smurg\n\nCopyright \(c\) 2026 .+\. All rights reserved\.\n/);
    expect(notices.stdout.startsWith('smurg: third-party notices of the smurg executable\n')).toBe(true);
    expect(notices.stdout).toContain('\n@anthropic-ai/sandbox-runtime@');
    expect(notices.stdout).toContain('Apache License');
    // The Node.js section comes from the running Node's distribution when it has its LICENSE (nvm, setup-node).
    const node = nodeDistributionLicense(process.execPath, process.versions.node);
    expect(notices.stdout).toBe(node === null ? COMMITTED : composeExecutableNotices(COMMITTED, node));
  });

  it('prints the embedded texts as they are, --help, and refuses other arguments', async () => {
    const io = testIo({ env: {} });
    expect(runLicenses([], io, () => ({ license: 'L1\nL2', thirdParty: 'T1\n' }))).toBe(0);
    expect(io.out()).toBe('L1\nL2\n\nT1\n');
    const only = testIo({ env: {} });
    expect(runLicenses(['--third-party'], only, () => ({ license: 'L\n', thirdParty: 'T1\n' }))).toBe(0);
    expect(only.out()).toBe('T1\n');
    const help = testIo({ env: {} });
    expect(await runCli(['licenses', '--help'], help)).toBe(0);
    expect(help.out()).toContain('用法：smurg licenses [--third-party]');
    expect(help.out()).toContain('https://smurg.ai/license/');
    const extra = testIo({ env: {} });
    expect(await runCli(['licenses', 'more'], extra)).toBe(2);
    expect(extra.err()).toContain('多了不認得的參數「more」');
  });

  it('the help of every command points to the guides on smurg.ai, never to the (private) repository or self-hosting', async () => {
    const texts: Record<string, string> = {};
    for (const command of ['--help', 'host', 'attach', 'stop', 'status', 'login', 'logout', 'licenses']) {
      const io = testIo({ env: {} });
      expect(await runCli(command === '--help' ? ['--help'] : [command, '--help'], io)).toBe(0);
      texts[command] = io.out();
      expect(io.out(), command).not.toMatch(/github\.com|apps\/relay\/README|自己架設|open source|開源|Apache/i);
    }
    expect(texts['--help']).toContain('說明文件：https://smurg.ai/docs/');
    expect(texts['host']).toContain('https://smurg.ai/docs/hosting/');
    expect(texts['attach']).toContain('https://smurg.ai/docs/joining/#10-用終端機cli加入選用');
    // The anchor is the heading's slug as the docs site makes it (GitHub's rule).
    expect(readFileSync(join(ROOT, 'docs', 'JOINING.md'), 'utf8')).toContain('\n## 10. 用終端機（CLI）加入（選用）\n');
  });

  it('stops quietly when the reader goes away (a pager or `| head`: EPIPE)', () => {
    const io = testIo({ env: {} });
    let onError: ((err: NodeJS.ErrnoException) => void) | null = null;
    const stdout = { write: io.stdout.write, on: (_event: 'error', listener: (err: NodeJS.ErrnoException) => void) => (onError = listener) };
    expect(runLicenses([], { ...io, stdout }, () => ({ license: 'L\n', thirdParty: 'T\n' }))).toBe(0);
    (onError as unknown as (err: NodeJS.ErrnoException) => void)(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(io.exits).toEqual([0]);
  });
});

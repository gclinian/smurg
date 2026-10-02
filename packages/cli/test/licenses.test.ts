// `smurg licenses [--third-party]` from source: smurg's LICENSE (MIT), then the executable's third-party notices (an
// Apache-2.0 text among them: fast-diff's) with the Node.js section of the running Node; --third-party prints the
// notices alone.
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
/** The CLI's language is pinned: these tests are about the license texts, not the wording. */
const EN = { SMURG_LANG: 'en' };

describe('smurg licenses', () => {
  it('prints LICENSE and then the third-party notices of the executable (from source)', async () => {
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', SMURG_NO_BROWSER: '1', SMURG_LANG: 'en' };
    const all = await run(process.execPath, [CLI_MAIN, 'licenses'], { env, timeout: 30_000, maxBuffer: MAX });
    const notices = await run(process.execPath, [CLI_MAIN, 'licenses', '--third-party'], { env, timeout: 30_000, maxBuffer: MAX });
    expect(all.stdout).toBe(`${LICENSE}\n${notices.stdout}`);
    expect(LICENSE).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Guan-Chen, Lin\n\nPermission is hereby granted, free of charge, /);
    expect(LICENSE).not.toMatch(/all rights reserved|proprietary/i);
    expect(notices.stdout.startsWith('smurg: third-party notices of the smurg executable\n')).toBe(true);
    expect(notices.stdout).toContain('\nnode-pty@');
    expect(notices.stdout).toContain('\nfast-diff@');
    expect(notices.stdout).toContain('Apache License');
    // Nothing of the guest sandbox since it was removed (ARCHITECTURE §11 D-15).
    expect(notices.stdout).not.toContain('sandbox-runtime');
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
    const help = testIo({ env: EN });
    expect(await runCli(['licenses', '--help'], help)).toBe(0);
    expect(help.out()).toContain('smurg licenses [--third-party]');
    expect(help.out()).toContain('https://smurg.ai/license/');
    const extra = testIo({ env: EN });
    expect(await runCli(['licenses', 'more'], extra)).toBe(2);
    expect(extra.err()).toContain('more');
  });

  it('the help of every command points to the guides on smurg.ai; `licenses` says MIT and where the source is', async () => {
    const texts: Record<string, string> = {};
    for (const command of ['--help', 'host', 'attach', 'stop', 'status', 'login', 'logout', 'licenses']) {
      const io = testIo({ env: EN });
      expect(await runCli(command === '--help' ? ['--help'] : [command, '--help'], io)).toBe(0);
      texts[command] = io.out();
      // What the proprietary releases (0.1.0 to 0.3.0) said.
      expect(io.out(), command).not.toMatch(/proprietary|all rights reserved|private repository|source is private/i);
    }
    expect(texts['--help']).toContain('https://smurg.ai/docs/');
    expect(texts['host']).toContain('https://smurg.ai/docs/hosting/');
    expect(texts['attach']).toContain('https://smurg.ai/docs/joining/#');
    expect(texts['licenses']).toContain('MIT');
    expect(texts['licenses']).toContain('https://smurg.ai/github');
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

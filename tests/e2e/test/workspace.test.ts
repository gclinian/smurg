// Smoke test for the acceptance-test package: every workspace package resolves from here through pnpm's links, the
// source-first entry points load without a build, and the `smurg` bin runs. Real acceptance tests go next to this
// file, one per requirement (r1.*.test.ts … r11.*.test.ts, ARCHITECTURE §10).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DAEMON_VERSION } from '@smurg/daemon';
import { MAX_RELAY_FRAME, PROTOCOL_VERSION } from '@smurg/protocol';
import { MAX_RELAY_FRAME as RELAY_MAX_RELAY_FRAME, wsClientUrl } from '@smurg/protocol/relay';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const E2E_DIR = fileURLToPath(new URL('..', import.meta.url));

describe('workspace wiring', () => {
  it.each(['@smurg/protocol', '@smurg/daemon', '@smurg/cli', '@smurg/relay', '@smurg/web'])('%s resolves', (name) => {
    const pkgJson = require.resolve(`${name}/package.json`);
    expect(existsSync(pkgJson)).toBe(true);
    // pnpm links workspace packages; Node resolves them to their real directory outside node_modules, which is what
    // lets it strip types from their .ts sources.
    expect(pkgJson).not.toContain('node_modules');
  });

  it('loads the source-first entry points', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(DAEMON_VERSION).toBe('0.1.0');
    expect(RELAY_MAX_RELAY_FRAME).toBe(MAX_RELAY_FRAME);
    expect(wsClientUrl('http://127.0.0.1:8787', 'AbCdEfGh_-012345')).toBe('ws://127.0.0.1:8787/ws/AbCdEfGh_-012345/client');
  });

  it('finds the relay config for createTestHarness', () => {
    const relayDir = dirname(require.resolve('@smurg/relay/package.json'));
    expect(existsSync(join(relayDir, 'wrangler.jsonc'))).toBe(true);
  });

  it('runs the smurg bin installed by pnpm', async () => {
    const bin = join(E2E_DIR, 'node_modules', '.bin', 'smurg');
    const { stdout } = await run(bin, ['--version'], { timeout: 10_000 });
    expect(stdout).toMatch(/^smurg 0\.1\.0 \(protocol v1, daemon 0\.1\.0, node /);
  });
});

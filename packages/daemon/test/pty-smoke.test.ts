// Smoke test: the node-pty native module loads on this Node, its macOS spawn-helper is executable, and a PTY child
// really runs. Only processes spawned here are touched, and each one exits on its own (/bin/echo).
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as pty from 'node-pty';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

function spawnAndCollect(file: string, args: string[]): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = pty.spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/', env: { PATH: '/usr/bin:/bin' } });
    let output = '';
    const timer = setTimeout(() => {
      child.kill(); // our own child only
      reject(new Error(`pty child ${child.pid} did not exit within 5 s`));
    }, 5_000);
    child.onData((data) => {
      output += data;
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      // onExit can fire before the last onData on macOS; give the reader one turn to drain.
      setTimeout(() => resolve({ output, exitCode }), 50);
    });
  });
}

describe('node-pty', () => {
  it.runIf(process.platform === 'darwin')('ships an executable spawn-helper (macOS spawns through it)', () => {
    const ptyDir = dirname(require.resolve('node-pty/package.json'));
    const helpers = [
      join(ptyDir, 'build', 'Release', 'spawn-helper'),
      join(ptyDir, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
    ].filter((file) => existsSync(file));
    expect(helpers.length).toBeGreaterThan(0);
    for (const helper of helpers) expect(statSync(helper).mode & 0o111).toBe(0o111);
  });

  it('spawns /bin/echo in a PTY and reads its output', async () => {
    const marker = `smurg-pty-smoke-${process.pid}`;
    const { output, exitCode } = await spawnAndCollect('/bin/echo', [marker]);
    expect(exitCode).toBe(0);
    expect(output).toContain(marker);
    // a real terminal line discipline turned "\n" into "\r\n"
    expect(output).toContain(`${marker}\r\n`);
  });
});

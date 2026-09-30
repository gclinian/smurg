// node-pty spawns every PTY on macOS through its `spawn-helper` binary; if the file lost its execute bit (node-pty
// 1.1.0 shipped it as 0644, and some extractors drop modes) every spawn fails with "posix_spawnp failed"
// (pty-packaging.md F1/F27). This postinstall restores the bit and fails the install if the helper is missing.
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.platform !== 'darwin') process.exit(0); // Linux uses forkpty(); no helper involved

const require = createRequire(import.meta.url);
let ptyDir;
try {
  ptyDir = dirname(require.resolve('node-pty/package.json'));
} catch {
  // node-pty not installed yet (e.g. a filtered install); nothing to fix.
  process.exit(0);
}

const candidates = [
  join(ptyDir, 'build', 'Release', 'spawn-helper'),
  join(ptyDir, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
].filter((file) => existsSync(file));

if (candidates.length === 0) {
  console.error(`ensure-spawn-helper: no spawn-helper found under ${ptyDir}; node-pty cannot spawn on macOS`);
  process.exit(1);
}

for (const helper of candidates) {
  const mode = statSync(helper).mode & 0o777;
  if ((mode & 0o111) !== 0o111) {
    chmodSync(helper, mode | 0o755);
    console.log(`ensure-spawn-helper: made ${helper} executable`);
  }
}

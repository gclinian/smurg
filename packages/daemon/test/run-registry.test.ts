// The test run's safety net (src/testing/run-registry.ts): what a test registered and left behind is removed after the
// run, and ONLY that: a directory or process is touched only while it is still the one registered (a directory
// re-created at the same path, or a pid whose command line no longer carries the marker, is left alone), and only
// directories named like the test helpers' ones. Each test opens its own registry (nested inside the run's, which it
// restores); the only process a test signals itself is its own `sleep`, by its pid.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_REGISTRY_ENV, registerOwnChildren, registerTestDir, registerTestProcess, startRunRegistry } from '../src/testing/run-registry.ts';

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A `sleep` this test starts, with a duration nobody else uses (its identity marker). */
async function ownSleep(): Promise<{ child: ChildProcess; marker: string }> {
  const marker = `${randomInt(1_000_000, 9_999_999)}`;
  const child = spawn('/bin/sleep', [marker], { stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  return { child, marker };
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.signalCode);
  return new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
}

function captureStderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return lines;
}

describe('the test run registry (safety net for workers that die)', () => {
  it('removes a registered directory and ends a registered process that were left behind, and says so', async () => {
    const outer = process.env[RUN_REGISTRY_ENV];
    const teardown = startRunRegistry();
    expect(process.env[RUN_REGISTRY_ENV]).not.toBe(outer);
    const left = await tempDir('smurg-registry-test-');
    await mkdir(join(left, 'inside'));
    registerTestDir(left);
    const cleaned = await tempDir('smurg-registry-test-');
    registerTestDir(cleaned);
    await rm(cleaned, { recursive: true }); // its test cleaned up: nothing to report
    const job = await ownSleep();
    registerTestProcess(job.child.pid as number, `sleep ${job.marker}`);
    const stderr = captureStderr();
    await teardown();
    expect(existsSync(left)).toBe(false);
    expect(await exited(job.child)).toBe('SIGKILL');
    expect(stderr.join('')).toContain('removed 2 leftover(s)');
    expect(stderr.join('')).toContain(left);
    expect(stderr.join('')).not.toContain(cleaned);
    // The run's own registry is back for the rest of this worker.
    expect(process.env[RUN_REGISTRY_ENV]).toBe(outer);
  });

  it('touches only what is still the thing registered: not a directory re-created at the same path, not a pid without its marker, not a foreign name', async () => {
    const teardown = startRunRegistry();
    const recreated = await tempDir('smurg-registry-test-');
    registerTestDir(recreated);
    await rm(recreated, { recursive: true });
    await mkdir(recreated); // same path, another directory
    const foreign = await tempDir('not-smurg-registry-test-');
    registerTestDir(foreign);
    const job = await ownSleep();
    registerTestProcess(job.child.pid as number, `sleep ${job.marker}0`); // a marker its command line does not carry
    const stderr = captureStderr();
    await teardown();
    expect(existsSync(recreated)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(job.child.exitCode).toBeNull();
    expect(job.child.signalCode).toBeNull();
    expect(stderr.join('')).toBe('');
  });

  it('registers only its own children for a command (the workerd of a local relay), by their full command line', async () => {
    const teardown = startRunRegistry();
    const job = await ownSleep();
    await registerOwnChildren(`sleep ${job.marker}`);
    captureStderr();
    await teardown();
    expect(await exited(job.child)).toBe('SIGKILL');
  });

  it('a run without leftovers prints nothing and removes the registry itself', async () => {
    const teardown = startRunRegistry();
    const registry = process.env[RUN_REGISTRY_ENV] as string;
    expect(existsSync(registry)).toBe(true);
    const stderr = captureStderr();
    await teardown();
    expect(stderr.join('')).toBe('');
    expect(existsSync(registry)).toBe(false);
  });

  it("removes vitest's module dump dir when vitest closes, and only a directory directly in the OS temp dir", async () => {
    // As vitest names it: join(tmpdir(), nanoid()), not resolved through symlinks (/var → /private/var on macOS).
    const dump = await mkdtemp(join(tmpdir(), 'smurgvitestdump'));
    dirs.push(dump);
    const nested = await tempDir('smurgvitestdump');
    const deeper = join(nested, 'x');
    await mkdir(deeper);
    for (const tmpDir of [dump, deeper]) {
      const closers: (() => unknown)[] = [];
      const vitest = { _tmpDir: tmpDir, onClose: (fn: () => unknown) => closers.push(fn) };
      const teardown = startRunRegistry({ vitest });
      startRunRegistry({ vitest }); // a second project of the same run: registered once
      await teardown();
      expect(closers.length).toBe(tmpDir === dump ? 1 : 0);
      for (const close of closers) await close();
    }
    expect(existsSync(dump)).toBe(false);
    expect(existsSync(deeper)).toBe(true);
  });
});

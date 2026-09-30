// Keep-awake (SPEC R1): the inhibitor is a child THIS service spawned, tied to the daemon's lifetime, and stop()
// signals only that child (ARCHITECTURE §0 rule 1).
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.ts';
import { KeepAwake } from '../src/workspace/power.ts';
import { waitFor } from '../src/testing/index.ts';

const services: KeepAwake[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
});

/** Existence check of OUR child only (signal 0 sends nothing). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('KeepAwake', () => {
  it('runs the inhibitor with a stdin pipe and stops exactly that child', async () => {
    const service = new KeepAwake({ enabled: true, log: silentLogger, command: { file: '/bin/cat', args: [], mechanism: 'systemd-inhibit' } });
    services.push(service);
    const status = await service.start();
    expect(status).toMatchObject({ active: true, mechanism: 'systemd-inhibit' });
    const pid = status.pid as number;
    expect(pid).toBeGreaterThan(1);
    expect(pid).not.toBe(process.pid);
    expect(alive(pid)).toBe(true);
    await service.stop();
    await waitFor(() => !alive(pid), { what: 'inhibitor exit' });
    expect(service.status()).toMatchObject({ active: false, pid: null });
  });

  it.runIf(process.platform === 'darwin')('uses caffeinate -w <daemon pid> on macOS', async () => {
    const service = new KeepAwake({ enabled: true, log: silentLogger });
    services.push(service);
    const status = await service.start();
    expect(status).toMatchObject({ active: true, mechanism: 'caffeinate' });
    const pid = status.pid as number;
    expect(alive(pid)).toBe(true);
    await service.stop();
    await waitFor(() => !alive(pid), { what: 'caffeinate exit' });
  });

  it('reports why it is inactive instead of failing', async () => {
    const disabled = new KeepAwake({ enabled: false, log: silentLogger });
    expect(await disabled.start()).toMatchObject({ active: false, reason: 'disabled' });
    const unsupported = new KeepAwake({ enabled: true, log: silentLogger, platform: 'win32' });
    expect(await unsupported.start()).toMatchObject({ active: false, reason: 'unsupported platform win32' });
    const noInhibit = new KeepAwake({ enabled: true, log: silentLogger, platform: 'linux', findSystemdInhibit: async () => null });
    expect(await noInhibit.start()).toMatchObject({ active: false, reason: 'systemd-inhibit not found' });
    const broken = new KeepAwake({ enabled: true, log: silentLogger, command: { file: '/nonexistent/inhibitor', args: [], mechanism: 'caffeinate' } });
    expect(await broken.start()).toMatchObject({ active: false });
    await broken.stop();
  });
});

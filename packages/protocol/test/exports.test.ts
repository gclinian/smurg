// Smoke test: every entry of the package "exports" map exists and loads, and the barrel re-exports constants.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, string>;
};

describe('@smurg/protocol exports map', () => {
  it('declares exactly the agreed entry points', () => {
    expect(pkg.name).toBe('@smurg/protocol');
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './browser', './client', './node', './package.json', './relay']);
  });

  it.each(Object.entries(pkg.exports))('%s -> %s exists', (_entry, target) => {
    expect(existsSync(resolve(PKG_DIR, target))).toBe(true);
  });

  it.each(Object.entries(pkg.exports).filter(([entry]) => entry !== './package.json'))(
    '%s loads (source-first, no build step)',
    async (_entry, target) => {
      const mod: unknown = await import(resolve(PKG_DIR, target));
      expect(typeof mod).toBe('object');
    },
  );

  it('re-exports the constants from the barrel', async () => {
    const barrel = await import('../src/index.ts');
    expect(barrel.PROTOCOL_VERSION).toBe(2);
    expect(barrel.MAX_RELAY_FRAME).toBe(8 * 1024 * 1024 + 64 * 1024);
  });

  it('exposes the relay helpers from ./relay', async () => {
    const relay = await import('../src/relay/index.ts');
    expect(relay.wsClientUrl('https://smurg.app', 'AbCdEfGh_-012345')).toBe('wss://smurg.app/ws/AbCdEfGh_-012345/client');
    expect(relay.RELAY_CLOSE_CODES.kicked).toBe(4003);
  });
});

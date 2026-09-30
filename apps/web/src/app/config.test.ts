// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RELAY_DEV_PROXY_PREFIXES } from '@smurg/protocol/relay';
import viteConfig from '../../vite.config.ts';

describe('vite config', () => {
  it('proxies every relay prefix to the relay dev server with WebSocket upgrades', () => {
    const proxy = viteConfig.server?.proxy ?? {};
    expect(Object.keys(proxy).sort()).toEqual([...RELAY_DEV_PROXY_PREFIXES].sort());
    const target = process.env['SMURG_RELAY_DEV_ORIGIN'] ?? 'http://127.0.0.1:8787';
    for (const options of Object.values(proxy)) {
      expect(options).toMatchObject({ target, ws: true, changeOrigin: false });
    }
  });

  it('keeps the y-monaco alias and the Yjs dedupe from the research', () => {
    expect(viteConfig.resolve?.dedupe).toEqual(['yjs', 'y-protocols', 'lib0']);
    const alias = viteConfig.resolve?.alias as { find: RegExp; replacement: string }[];
    const rewrite = alias.find((a) => a.find.test('monaco-editor/esm/vs/editor/editor.api.js'));
    expect('monaco-editor/esm/vs/editor/editor.api.js'.replace(rewrite!.find, rewrite!.replacement)).toBe('monaco-editor/editor/editor.api.js');
  });

  it('emits the build manifest the chunk check reads', () => {
    expect(viteConfig.build?.manifest).toBe(true);
    expect(viteConfig.server?.host).toBe('localhost');
  });
});

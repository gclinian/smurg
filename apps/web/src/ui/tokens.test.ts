// @vitest-environment node
// WCAG AA for the design tokens: every text colour against every surface it is used on, in both themes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../lib/color.ts';

const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

/** The custom properties of the first block that `selector` opens (`:root {`, `:root[data-theme='light'] {`, …). */
function tokens(blockStart: string): Map<string, string> {
  const start = css.indexOf(blockStart);
  if (start < 0) throw new Error(`block not found: ${blockStart}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const map = new Map<string, string>();
  for (const match of css.slice(open + 1, end).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) map.set(match[1] as string, (match[2] as string).trim());
  return map;
}

const dark = tokens(':root {');
const light = tokens(":root[data-theme='light'] {");
const lightMedia = tokens(":root:not([data-theme='dark']) {");

const TEXT_ON_SURFACES: readonly (readonly [string, readonly string[]])[] = [
  ['--color-text', ['--color-bg', '--color-surface-1', '--color-surface-2', '--color-surface-3']],
  ['--color-text-muted', ['--color-bg', '--color-surface-1', '--color-surface-2', '--color-surface-3']],
  ['--color-text-subtle', ['--color-bg', '--color-surface-1', '--color-surface-2']],
  ['--color-accent', ['--color-bg', '--color-surface-1', '--color-surface-2']],
  ['--color-danger', ['--color-bg', '--color-surface-1', '--color-surface-2']],
  ['--color-success', ['--color-bg', '--color-surface-1']],
  ['--color-accent-contrast', ['--color-accent-solid', '--color-accent-solid-hover']],
];

function hex(map: Map<string, string>, name: string): string {
  const value = map.get(name);
  if (!value || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${name} is not a #rrggbb token: ${value}`);
  return value;
}

describe('design tokens: WCAG AA contrast', () => {
  for (const [theme, map] of [
    ['dark', dark],
    ['light', light],
  ] as const) {
    it(`${theme}: every text colour is at least 4.5:1 on its surfaces`, () => {
      for (const [text, surfaces] of TEXT_ON_SURFACES) {
        for (const surface of surfaces) {
          const ratio = contrastRatio(hex(map, text), hex(map, surface));
          expect(ratio, `${theme} ${text} on ${surface}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      // White text on the danger button.
      expect(contrastRatio('#ffffff', hex(map, '--color-danger-solid'))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('the prefers-color-scheme light block and the explicit light theme are identical', () => {
    expect([...lightMedia.entries()].sort()).toEqual([...light.entries()].sort());
  });

  it('defines a CJK-capable font stack and a monospace stack', () => {
    const sans = dark.get('--font-sans') ?? '';
    for (const font of ['PingFang TC', 'Noto Sans TC', 'Microsoft JhengHei']) expect(sans).toContain(font);
    expect(dark.get('--font-mono')).toMatch(/monospace$/);
  });
});

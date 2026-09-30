import { describe, expect, it } from 'vitest';
import { FEATURE_STRING_MODULES, catalogueEntries, defineStrings, hasString, interpolate, registeredNamespaces, t } from './index.ts';

const CJK_TEXT = new RegExp('[\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef]', 'u');

describe('zh-TW string catalogue', () => {
  it('interpolates {placeholders} and leaves unknown ones visible', () => {
    expect(interpolate('你好 {name}，{n} 則', { name: 'Amy', n: 3 })).toBe('你好 Amy，3 則');
    expect(interpolate('缺 {missing}', { other: 1 })).toBe('缺 {missing}');
  });

  it('gives each namespace a typed translator and a global lookup', () => {
    const tt = defineStrings('test-ns', { hello: '哈囉 {who}' });
    expect(tt('hello', { who: '世界' })).toBe('哈囉 世界');
    expect(t('test-ns.hello', { who: 'x' })).toBe('哈囉 x');
    expect(hasString('test-ns.hello')).toBe(true);
    expect(t('test-ns.nope')).toBe('test-ns.nope');
  });

  it('refuses a namespace defined twice, bad names and empty strings', () => {
    defineStrings('test-dup', { a: '一' });
    expect(() => defineStrings('test-dup', { a: '二' })).toThrow(/twice/);
    expect(() => defineStrings('Bad Name', { a: '一' })).toThrow();
    expect(() => defineStrings('test-empty', { a: '' })).toThrow();
  });

  it('discovers every feature namespace by convention (features/*/strings.ts)', () => {
    expect(FEATURE_STRING_MODULES.map((path) => path.split('/').at(-2)).sort()).toEqual(
      ['activity', 'agents', 'console', 'editor', 'files', 'suggest', 'transfer', 'worktree'],
    );
    const namespaces = registeredNamespaces();
    for (const ns of ['app', 'conn', 'join', 'stores', 'ui', 'workbench', 'files', 'editor', 'agents', 'suggest', 'activity', 'transfer', 'worktree', 'console']) {
      expect(namespaces).toContain(ns);
    }
  });

  it('every user-facing string is Traditional Chinese (or a proper name) with well-formed placeholders', () => {
    // Latin-only strings allowed: the product name and the loanwords SPEC.md itself uses in Chinese text.
    const loanwords = new Set(['smurg', 'agent', 'worktree', 'agent session', 'session']);
    const simplifiedOnly = /[这们说为时会发现对应]/u; // a few common simplified-only characters
    for (const [key, value] of catalogueEntries()) {
      if (key.startsWith('test-')) continue;
      // CJK ideographs, CJK punctuation or full-width forms (「」（）…).
      if (!loanwords.has(value)) expect(value, key).toMatch(CJK_TEXT);
      expect(value, key).not.toMatch(simplifiedOnly);
      expect(value.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ''), key).not.toMatch(/[{}]/);
    }
  });
});

// The whole catalogue: registration rules, the features found by convention, and the three enforcement checks of the
// two-language catalogue: parity of the tables, the language of each table, and no key that nothing uses.
import { describe, expect, it } from 'vitest';
import { applyLocale } from '../lib/locale.ts';
import { catalogueEntries, catalogueTable, selectForm, type StringValue } from './catalog.ts';
import { FEATURE_STRING_MODULES, defineStrings, hasString, interpolate, registeredNamespaces, t } from './index.ts';

/** Han, Bopomofo, CJK punctuation (U+3000–303F) and full-width forms (U+FF00–FFEF): what English text never holds. */
const CJK = new RegExp('[\\u3000-\\u303f\\u3100-\\u312f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]', 'u');
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

const APP_WIDE = ['app', 'conn', 'join', 'stores', 'ui', 'workbench'];
const FEATURES = ['activity', 'agents', 'console', 'editor', 'files', 'suggest', 'transfer', 'worktree'];

/**
 * zh-TW values that are legitimately free of Chinese characters: proper names, loanwords the zh-TW text keeps in Latin
 * letters (docs/GLOSSARY.md), addresses, and templates made of placeholders and punctuation only.
 */
const SAME_IN_BOTH = new Set(['smurg', 'agent', 'worktree', 'agent session', 'session', 'Claude']);
const isAddress = (value: string): boolean => /^https:\/\/[^\s]+$/.test(value);

const placeholdersOf = (template: string): string[] => [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string))].sort();
const formsOf = (value: StringValue): string[] => (typeof value === 'string' ? [value] : [value.one, value.other]);
const namespaceOf = (fullKey: string): string => fullKey.slice(0, fullKey.indexOf('.'));
const isTestKey = (fullKey: string): boolean => fullKey.startsWith('test-');

describe('string catalogue: registration', () => {
  it('interpolates {placeholders} and leaves unknown ones visible', () => {
    expect(interpolate('Hello {name}, {n} new', { name: 'Amy', n: 3 })).toBe('Hello Amy, 3 new');
    expect(interpolate('Missing {missing}', { other: 1 })).toBe('Missing {missing}');
  });

  it('gives each namespace a typed translator and a global lookup', () => {
    const tt = defineStrings('test-ns', { hello: 'Hello {who}' }, { hello: '哈囉 {who}' });
    expect(tt('hello', { who: 'world' })).toBe('Hello world');
    expect(t('test-ns.hello', { who: 'x' })).toBe('Hello x');
    expect(hasString('test-ns.hello')).toBe(true);
    expect(t('test-ns.nope')).toBe('test-ns.nope');
  });

  it('refuses a namespace defined twice, bad names and empty strings', () => {
    defineStrings('test-dup', { a: 'one' }, { a: '一' });
    expect(() => defineStrings('test-dup', { a: 'two' }, { a: '二' })).toThrow(/twice/);
    expect(() => defineStrings('Bad Name', { a: 'one' }, { a: '一' })).toThrow();
    expect(() => defineStrings('test-empty', { a: '' }, { a: '一' })).toThrow();
  });

  it('discovers every feature namespace by convention (features/*/strings.ts)', () => {
    expect(FEATURE_STRING_MODULES.map((path) => path.split('/').at(-2)).sort()).toEqual(FEATURES);
    const namespaces = registeredNamespaces();
    for (const ns of [...APP_WIDE, ...FEATURES]) expect(namespaces).toContain(ns);
  });

});

describe('string catalogue: parity of the two languages', () => {
  const en = catalogueTable('en');
  const zh = catalogueTable('zh-TW');
  const keys = [...en.keys()].filter((key) => !isTestKey(key));

  it('has the same keys in both languages', () => {
    expect([...zh.keys()].filter((key) => !isTestKey(key)).sort()).toEqual([...keys].sort());
    expect(keys.length).toBeGreaterThan(1000);
  });

  it('uses the same placeholders in both languages and in both plural forms, and nothing malformed', () => {
    for (const key of keys) {
      const english = formsOf(en.get(key) as StringValue);
      const chinese = formsOf(zh.get(key) as StringValue);
      const names = placeholdersOf(english[0] as string);
      for (const form of [...english, ...chinese]) {
        expect(placeholdersOf(form), key).toEqual(names);
        expect(form.replace(PLACEHOLDER, ''), key).not.toMatch(/[{}]/);
      }
    }
  });

  it('selects a plural form by {count}; zh-TW has no plural forms', () => {
    for (const key of keys) {
      const english = en.get(key) as StringValue;
      if (typeof english !== 'string') {
        expect(placeholdersOf(english.other), key).toContain('count');
        expect(english.one, key).not.toBe(english.other);
      }
      expect(typeof zh.get(key), key).toBe('string');
    }
  });

  it('English text holds no Chinese character and no full-width punctuation', () => {
    for (const key of keys) for (const form of formsOf(en.get(key) as StringValue)) expect(form, key).not.toMatch(CJK);
  });

  it('zh-TW text is Traditional Chinese, except names, loanwords, addresses and bare templates', () => {
    const simplifiedOnly = /[这们说为时会发现对应]/u; // a few common simplified-only characters
    for (const key of keys) {
      const value = zh.get(key) as string;
      expect(value, key).not.toMatch(simplifiedOnly);
      const bare = value.replace(PLACEHOLDER, '').replace(/[\s\p{P}\p{S}]/gu, '') === '';
      if (SAME_IN_BOTH.has(value) || isAddress(value) || bare) continue;
      expect(value, key).toMatch(CJK);
    }
  });

  it('renders every key in both languages with sample values and leaves nothing unfilled', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      for (const [key, value] of catalogueTable(locale)) {
        if (isTestKey(key)) continue;
        const names = formsOf(value).flatMap(placeholdersOf);
        for (const count of [1, 2, 25]) {
          const vars = Object.fromEntries(names.map((name) => [name, name === 'count' ? count : `<${name}>`]));
          const text = interpolate(selectForm(value, vars, locale), vars);
          expect(text, key).not.toMatch(/[{}]|undefined|\[object/);
          expect(text.trim(), key).not.toBe('');
        }
      }
    }
  });
});

describe('string catalogue: the language', () => {
  it('translators and the global lookup follow the language', () => {
    expect(t('app.common.cancel')).toBe('Cancel');
    applyLocale('zh-TW');
    expect(t('app.common.cancel')).toBe('取消');
    expect(new Map(catalogueEntries()).get('app.common.cancel')).toBe('取消');
    expect(new Map(catalogueEntries('en')).get('app.common.cancel')).toBe('Cancel');
  });
});

describe('string catalogue: no key that nothing uses', () => {
  // Every source file as text (strings tables and tests excluded): a key counts as used when its quoted name appears
  // in the namespace's own code, or when a template literal there builds it (`status.${x}` covers every `status.*`).
  const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../strings/*.ts', '!../features/*/strings.ts', '!../features/*/strings.zh-TW.ts', '!../testing/**'], {
    eager: true,
    query: '?raw',
    import: 'default',
  });
  const files = Object.entries(sources);

  const scopeOf = (namespace: string): string => {
    const own = files.filter(([path]) => (FEATURES.includes(namespace) ? path.startsWith(`../features/${namespace}/`) : true));
    return own.map(([, text]) => text).join('\n');
  };

  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it.each([...APP_WIDE, ...FEATURES])('%s', (namespace) => {
    const code = scopeOf(namespace);
    const dynamic = [...code.matchAll(/`([A-Za-z][A-Za-z0-9_.-]*\.)\$\{/g)].map((m) => m[1] as string);
    const unused: string[] = [];
    for (const fullKey of catalogueTable('en').keys()) {
      if (namespaceOf(fullKey) !== namespace) continue;
      const key = fullKey.slice(namespace.length + 1);
      const quoted = [`'${key}'`, `"${key}"`, `\`${key}\``].some((literal) => code.includes(literal));
      if (!quoted && !dynamic.some((prefix) => key.startsWith(prefix))) unused.push(key);
    }
    expect(unused).toEqual([]);
  });
});

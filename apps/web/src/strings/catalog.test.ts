// The two-locale catalogue API: defineStrings(namespace, en, zhTW), plural forms and the locale switch. (The app's
// controller, src/lib/locale.ts, is the only caller of setCatalogLocale outside this file.)
import { afterEach, describe, expect, it } from 'vitest';
import {
  StringCatalogueError,
  catalogueEntries,
  catalogueTable,
  defineStrings,
  getCatalogLocale,
  hasString,
  selectForm,
  setCatalogLocale,
  t,
} from './catalog.ts';

const initialLocale = getCatalogLocale();
afterEach(() => {
  setCatalogLocale(initialLocale);
});

describe('defineStrings(namespace, en, zhTW)', () => {
  const tt = defineStrings(
    'test-two',
    {
      empty: 'This folder is empty',
      hello: 'Hello {who}',
      'selected.count': { one: '{count} file selected', other: '{count} files selected' },
    },
    { empty: '這個資料夾是空的', hello: '哈囉 {who}', 'selected.count': '已選取 {count} 個檔案' },
  );

  it('renders the current locale at call time (call sites do not change)', () => {
    setCatalogLocale('en');
    expect(tt('empty')).toBe('This folder is empty');
    expect(tt('hello', { who: 'Amy' })).toBe('Hello Amy');
    expect(t('test-two.hello', { who: 'Amy' })).toBe('Hello Amy');
    setCatalogLocale('zh-TW');
    expect(tt('empty')).toBe('這個資料夾是空的');
    expect(tt('hello', { who: 'Amy' })).toBe('哈囉 Amy');
    expect(t('test-two.hello', { who: 'Amy' })).toBe('哈囉 Amy');
    expect(getCatalogLocale()).toBe('zh-TW');
  });

  it('starts in English and treats anything that is not zh-TW as English', () => {
    expect(initialLocale).toBe('en');
    setCatalogLocale('fr' as 'en');
    expect(getCatalogLocale()).toBe('en');
  });

  it('selects a plural form by the variable `count`', () => {
    setCatalogLocale('en');
    expect([0, 1, 2, 25].map((count) => tt('selected.count', { count }))).toEqual([
      '0 files selected',
      '1 file selected',
      '2 files selected',
      '25 files selected',
    ]);
    // Without a numeric count the `other` form is used; the placeholder stays visible (a bug, never a crash).
    expect(tt('selected.count')).toBe('{count} files selected');
    expect(tt('selected.count', { count: '1' })).toBe('1 files selected');
    setCatalogLocale('zh-TW');
    expect([1, 2].map((count) => tt('selected.count', { count }))).toEqual(['已選取 1 個檔案', '已選取 2 個檔案']);
  });

  it('selectForm follows Intl.PluralRules of the locale', () => {
    const forms = { one: 'one', other: 'other' };
    expect(selectForm(forms, { count: 1 }, 'en')).toBe('one');
    expect(selectForm(forms, { count: 1.5 }, 'en')).toBe('other');
    expect(selectForm(forms, { count: 1 }, 'zh-TW')).toBe('other');
    expect(selectForm('plain', { count: 1 }, 'en')).toBe('plain');
  });

  it('lists both tables', () => {
    expect(hasString('test-two.empty')).toBe(true);
    expect(catalogueTable('en').get('test-two.selected.count')).toEqual({ one: '{count} file selected', other: '{count} files selected' });
    expect(catalogueTable('zh-TW').get('test-two.selected.count')).toBe('已選取 {count} 個檔案');
    const en = new Map(catalogueEntries('en'));
    expect(en.get('test-two.selected.count#one')).toBe('{count} file selected');
    expect(en.get('test-two.selected.count#other')).toBe('{count} files selected');
    expect(new Map(catalogueEntries('zh-TW')).get('test-two.empty')).toBe('這個資料夾是空的');
    setCatalogLocale('zh-TW');
    expect(new Map(catalogueEntries()).get('test-two.empty')).toBe('這個資料夾是空的');
  });

  it('keeps the translator typed: an unknown key and a missing zh-TW key are compile errors', () => {
    // @ts-expect-error unknown key
    expect(tt('nope')).toBe('test-two.nope');
    // @ts-expect-error the zh-TW table lacks `b`
    expect(() => defineStrings('test-missing', { a: 'A', b: 'B' }, { a: '甲' })).toThrow(StringCatalogueError);
  });

  it('refuses a zh-TW table with other keys, empty strings and malformed plural forms', () => {
    const extra = { a: '甲', b: '乙' };
    expect(() => defineStrings('test-extra', { a: 'A' }, extra)).toThrow(/without an English one/);
    expect(() => defineStrings('test-empty-zh', { a: 'A' }, { a: '' })).toThrow(/empty/);
    expect(() => defineStrings('test-plural-1', { a: { one: 'x', other: '' } }, { a: '甲' })).toThrow(StringCatalogueError);
    expect(() => defineStrings('test-plural-2', { a: { one: 'x' } as never }, { a: '甲' })).toThrow(StringCatalogueError);
    expect(() => defineStrings('test-plural-3', { a: { one: 'x', other: 'y', few: 'z' } as never }, { a: '甲' })).toThrow(StringCatalogueError);
    expect(() => defineStrings('test-plural-4', { a: null as never }, { a: '甲' })).toThrow(StringCatalogueError);
    // One table is not a namespace: both languages, always.
    // @ts-expect-error the zh-TW table is required
    expect(() => defineStrings('test-one-table', { a: 'A' })).toThrow(/no zh-TW table/);
    // A refused namespace registers nothing.
    expect(hasString('test-extra.a')).toBe(false);
    expect(hasString('test-one-table.a')).toBe(false);
  });
});

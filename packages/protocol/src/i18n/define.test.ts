import { describe, expect, expectTypeOf, it } from 'vitest';
import { MessageCatalogError, createCatalog, joinList, message, plural, type MessageRef } from './define.ts';

// A catalog of every parameter kind, with plural and list handling, in both locales.
const catalog = createCatalog({
  'test.plain': message({}, {
    en: () => 'Plain text',
    'zh-TW': () => '純文字',
  }),
  'test.files': message({ count: 'number' }, {
    en: (p) => `${p.count} ${plural(p.count, 'file', 'files')} changed`,
    'zh-TW': (p) => `${p.count} 個檔案有變更`,
  }),
  'test.inUse': message({ name: 'string', holders: 'list', forced: 'boolean' }, {
    en: (p) => `${p.name} is in use by ${joinList('en', p.holders)}${p.forced ? ' (forced)' : ''}`,
    'zh-TW': (p) => `${joinList('zh-TW', p.holders)} 正在使用 ${p.name}${p.forced ? '（強制）' : ''}`,
  }),
  'test.optional': message({ name: 'string?', count: 'number?', flag: 'boolean?', paths: 'list?' }, {
    en: (p) => `Saved${p.name === undefined ? '' : ` ${p.name}`}${p.count === undefined ? '' : ` x${p.count}`}${p.flag === true ? ' !' : ''}${p.paths === undefined ? '' : `: ${joinList('en', p.paths)}`}`,
    'zh-TW': (p) => `已儲存${p.name === undefined ? '' : ` ${p.name}`}${p.count === undefined ? '' : ` x${p.count}`}${p.flag === true ? ' !' : ''}${p.paths === undefined ? '' : `：${joinList('zh-TW', p.paths)}`}`,
  }),
  'test.mixed': message({ path: 'string', note: 'string?' }, {
    en: (p) => `Edited ${p.path}${p.note === undefined ? '' : ` (${p.note})`}`,
    'zh-TW': (p) => `修改了 ${p.path}${p.note === undefined ? '' : `（${p.note}）`}`,
  }),
  'test.zhThrows': message({}, {
    en: () => 'English works',
    'zh-TW': () => {
      throw new Error('broken form');
    },
  }),
  'test.bothThrow': message({}, {
    en: () => {
      throw new Error('broken form');
    },
    'zh-TW': () => {
      throw new Error('broken form');
    },
  }),
  'test.empty': message({}, {
    en: () => '',
    'zh-TW': () => '',
  }),
});
const { msg, render, renderEnglish } = catalog;

describe('helpers', () => {
  it('joinList uses a comma in English and the ideographic comma in zh-TW', () => {
    expect(joinList('en', ['a', 'b', 'c'])).toBe('a, b, c');
    expect(joinList('zh-TW', ['a', 'b', 'c'])).toBe('a、b、c');
    expect(joinList('en', ['a'])).toBe('a');
    expect(joinList('zh-TW', [])).toBe('');
  });

  it('plural picks one only for exactly 1', () => {
    expect([0, 1, 2, 25, -1, 1.5].map((n) => plural(n, 'file', 'files'))).toEqual(['files', 'file', 'files', 'files', 'files', 'files']);
  });
});

describe('msg (typed constructor)', () => {
  it('builds the wire shape: an id, and params only when there are any', () => {
    expect(msg('test.plain')).toEqual({ id: 'test.plain' });
    expect(Object.keys(msg('test.plain'))).toEqual(['id']);
    expect(msg('test.files', { count: 2 })).toEqual({ id: 'test.files', params: { count: 2 } });
    expect(msg('test.optional')).toEqual({ id: 'test.optional' });
    expect(msg('test.optional', {})).toEqual({ id: 'test.optional' });
    expect(msg('test.optional', { name: undefined, count: 3 })).toEqual({ id: 'test.optional', params: { count: 3 } });
  });

  it('copies lists (a later change of the caller\'s array does not change the reference)', () => {
    const holders = ['Amy', 'Bob'];
    const ref = msg('test.inUse', { name: 'wt', holders, forced: false });
    holders.push('Cat');
    expect(ref.params?.holders).toEqual(['Amy', 'Bob']);
  });

  it('is checked at compile time', () => {
    msg('test.plain');
    msg('test.files', { count: 1 });
    msg('test.mixed', { path: 'a' });
    msg('test.mixed', { path: 'a', note: 'b' });
    msg('test.optional');
    msg('test.inUse', { name: 'a', holders: ['b'] as readonly string[], forced: true });
    // @ts-expect-error unknown id
    msg('test.nope');
    // @ts-expect-error missing parameters
    msg('test.files');
    // @ts-expect-error wrong parameter type
    msg('test.files', { count: '2' });
    // @ts-expect-error unknown parameter
    msg('test.files', { count: 2, extra: 1 });
    // @ts-expect-error a message without parameters takes none
    msg('test.plain', { count: 2 });
    // @ts-expect-error missing required parameter
    msg('test.mixed', { note: 'b' });
    expectTypeOf(msg('test.plain')).toEqualTypeOf<MessageRef>();
  });
});

describe('render', () => {
  it('renders both locales', () => {
    expect(render('en', msg('test.plain'))).toBe('Plain text');
    expect(render('zh-TW', msg('test.plain'))).toBe('純文字');
  });

  it.each([
    [1, '1 file changed', '1 個檔案有變更'],
    [2, '2 files changed', '2 個檔案有變更'],
    [25, '25 files changed', '25 個檔案有變更'],
    [0, '0 files changed', '0 個檔案有變更'],
  ])('plural: count %d', (count, en, zh) => {
    expect(render('en', msg('test.files', { count }))).toBe(en);
    expect(render('zh-TW', msg('test.files', { count }))).toBe(zh);
  });

  it.each([
    [['Amy'], 'wt is in use by Amy', 'Amy 正在使用 wt'],
    [['Amy', 'Bob', 'Cat', 'Dan', 'Eve'], 'wt is in use by Amy, Bob, Cat, Dan, Eve', 'Amy、Bob、Cat、Dan、Eve 正在使用 wt'],
    [['A', 'B', 'C', 'D', 'E', 'F', 'G'], 'wt is in use by A, B, C, D, E, F, G', 'A、B、C、D、E、F、G 正在使用 wt'],
  ])('list: %j', (holders, en, zh) => {
    expect(render('en', msg('test.inUse', { name: 'wt', holders, forced: false }))).toBe(en);
    expect(render('zh-TW', msg('test.inUse', { name: 'wt', holders, forced: false }))).toBe(zh);
  });

  it('optional parameters may be absent, and never print "undefined"', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      for (const ref of [msg('test.optional'), msg('test.optional', { count: 0 }), msg('test.optional', { flag: false, paths: [] }), msg('test.mixed', { path: 'a.ts' })]) {
        const text = render(locale, ref);
        expect(text).toEqual(expect.any(String));
        expect(text).not.toMatch(/undefined|\[object|NaN/);
      }
    }
    expect(render('en', msg('test.optional', { name: 'a.ts', count: 2, flag: true, paths: ['x', 'y'] }))).toBe('Saved a.ts x2 !: x, y');
    expect(render('en', { id: 'test.optional', params: {} })).toBe('Saved');
  });

  it('ignores parameters the message does not declare (the form never sees them)', () => {
    expect(render('en', { id: 'test.files', params: { count: 2, extra: 'x' } })).toBe('2 files changed');
    expect(render('en', { id: 'test.plain', params: { anything: 1 } })).toBe('Plain text');
  });

  // Wire input is untrusted: every mismatch gives undefined, nothing throws.
  it.each<[string, unknown]>([
    ['an unknown id', { id: 'test.nope' }],
    ['an inherited property name as id', { id: 'constructor' }],
    ['toString as id', { id: 'toString' }],
    ['no id', {}],
    ['a numeric id', { id: 7 }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'test.plain'],
    ['a list', ['test.plain']],
    ['a missing required parameter', { id: 'test.files' }],
    ['a missing required parameter (empty params)', { id: 'test.files', params: {} }],
    ['a required parameter that is undefined', { id: 'test.files', params: { count: undefined } }],
    ['a string for a number', { id: 'test.files', params: { count: '2' } }],
    ['NaN', { id: 'test.files', params: { count: Number.NaN } }],
    ['Infinity', { id: 'test.files', params: { count: Number.POSITIVE_INFINITY } }],
    ['null for a number', { id: 'test.files', params: { count: null } }],
    ['a number for a string', { id: 'test.inUse', params: { name: 1, holders: [], forced: false } }],
    ['a string for a list', { id: 'test.inUse', params: { name: 'a', holders: 'Amy', forced: false } }],
    ['a list with a non-string', { id: 'test.inUse', params: { name: 'a', holders: ['Amy', 1], forced: false } }],
    ['a list of 11', { id: 'test.inUse', params: { name: 'a', holders: Array.from({ length: 11 }, () => 'x'), forced: false } }],
    ['a list item that is too long', { id: 'test.inUse', params: { name: 'a', holders: ['x'.repeat(501)], forced: false } }],
    ['a string that is too long', { id: 'test.inUse', params: { name: 'x'.repeat(1001), holders: [], forced: false } }],
    ['a string for a boolean', { id: 'test.inUse', params: { name: 'a', holders: [], forced: 'yes' } }],
    ['an object for a string', { id: 'test.mixed', params: { path: { toString: () => 'x' } } }],
    ['a wrong optional parameter', { id: 'test.mixed', params: { path: 'a', note: 5 } }],
    ['null for an optional parameter', { id: 'test.optional', params: { name: null } }],
    ['params that are a list', { id: 'test.plain', params: ['x'] }],
    ['params that are a string', { id: 'test.plain', params: 'x' }],
    ['params that are null', { id: 'test.plain', params: null }],
    ['a form that returns an empty string', { id: 'test.empty' }],
    ['forms that throw', { id: 'test.bothThrow' }],
  ])('gives undefined for %s', (_name, ref) => {
    for (const locale of ['en', 'zh-TW'] as const) {
      expect(() => render(locale, ref as MessageRef)).not.toThrow();
      expect(render(locale, ref as MessageRef)).toBeUndefined();
    }
  });

  it('does not throw on hostile objects', () => {
    const trap = new Proxy({}, { get: () => { throw new Error('trap'); }, has: () => { throw new Error('trap'); } });
    expect(render('en', trap as MessageRef)).toBeUndefined();
    expect(render('en', { id: 'test.files', params: trap as never })).toBeUndefined();
  });

  it('falls back to the English form when the zh-TW form fails, and for an unknown locale', () => {
    expect(render('zh-TW', msg('test.zhThrows'))).toBe('English works');
    expect(render('fr' as 'en', msg('test.plain'))).toBe('Plain text');
    expect(render(undefined as unknown as 'en', msg('test.files', { count: 1 }))).toBe('1 file changed');
  });

  it('a list parameter given to a form is a copy', () => {
    const seen: (readonly string[])[] = [];
    const spy = createCatalog({
      'spy.list': message({ items: 'list' }, {
        en: (p) => {
          seen.push(p.items);
          return 'ok';
        },
        'zh-TW': () => 'ok',
      }),
    });
    const items = ['a'];
    spy.render('en', { id: 'spy.list', params: { items } });
    expect(seen[0]).toEqual(['a']);
    expect(seen[0]).not.toBe(items);
  });
});

describe('renderEnglish', () => {
  it('is the English text, and always a string', () => {
    expect(renderEnglish(msg('test.files', { count: 1 }))).toBe('1 file changed');
    expect(renderEnglish({ id: 'test.nope' })).toBe('test.nope');
    expect(renderEnglish({ id: 'test.files', params: { count: 'x' as unknown as number } })).toBe('test.files');
    expect(renderEnglish(undefined as unknown as MessageRef)).toBe('message');
    expect(renderEnglish({ id: 7 } as unknown as MessageRef)).toBe('message');
  });
});

describe('createCatalog', () => {
  it('lists its ids and knows them', () => {
    expect(catalog.ids).toContain('test.plain');
    expect(catalog.has('test.plain')).toBe(true);
    expect(catalog.has('test.nope')).toBe(false);
    expect(catalog.has('hasOwnProperty')).toBe(false);
    expect(catalog.has(1)).toBe(false);
  });

  const form = { en: () => 'x', 'zh-TW': () => 'x' };

  it.each(['Test.x', '1test', 'test-x', 'test_x', 'test x', '', `a${'.b'.repeat(40)}`])('refuses the id %j', (id) => {
    expect(() => createCatalog({ [id]: message({}, form) })).toThrow(MessageCatalogError);
  });

  it.each(['Name', 'user_name', 'user-name', '1st', 'constructor', 'n'.repeat(33)])('refuses the parameter name %j', (name) => {
    expect(() => createCatalog({ 'test.x': message({ [name]: 'string' }, form) })).toThrow(MessageCatalogError);
  });

  it('refuses unknown kinds, more than 16 parameters, a missing form and a non-message', () => {
    expect(() => createCatalog({ 'test.x': message({ a: 'date' as 'string' }, form) })).toThrow(MessageCatalogError);
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, 'string' as const]));
    expect(() => createCatalog({ 'test.x': message(many, form) })).toThrow(MessageCatalogError);
    expect(() => createCatalog({ 'test.x': message({}, { en: () => 'x' } as never) })).toThrow(MessageCatalogError);
    expect(() => createCatalog({ 'test.x': 'text' as never })).toThrow(MessageCatalogError);
  });

  it('message() freezes the definition', () => {
    const def = message({ a: 'string' }, { en: (p) => p.a, 'zh-TW': (p) => p.a });
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.params)).toBe(true);
    expect(Object.isFrozen(def.forms)).toBe(true);
  });
});

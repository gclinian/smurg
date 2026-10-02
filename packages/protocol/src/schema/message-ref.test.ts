import { describe, expect, it } from 'vitest';
import { FORBIDDEN_RECORD_KEYS, SmurgError, errorPayloadSchema } from '../errors.ts';
import { MESSAGE_IDS, MESSAGES, msg, render } from '../i18n/index.ts';
import { messageRefSchema } from './message-ref.ts';

describe('messageRefSchema', () => {
  it('accepts an id alone and an id with parameters of the four kinds', () => {
    expect(messageRefSchema.parse({ id: 'role.agent' })).toEqual({ id: 'role.agent' });
    const ref = { id: 'worktree.inUse', params: { name: 'amy', count: 2, forced: false, holders: ['Amy', 'Bob'] } };
    expect(messageRefSchema.parse(ref)).toEqual(ref);
    expect(messageRefSchema.safeParse({ id: 'a', params: {} }).success).toBe(true);
  });

  it.each([
    ['no id', {}],
    ['an empty id', { id: '' }],
    ['an id that starts with a capital', { id: 'Role.agent' }],
    ['an id with a dash', { id: 'role.agent-access' }],
    ['an id with an underscore', { id: 'error.default.bad_request' }],
    ['an id of 81 characters', { id: 'a'.repeat(81) }],
    ['an extra key', { id: 'a.b', locale: 'en' }],
    ['params that are a list', { id: 'a.b', params: ['x'] }],
    ['a null parameter', { id: 'a.b', params: { x: null } }],
    ['a nested object', { id: 'a.b', params: { x: { y: 1 } } }],
    ['a list of numbers', { id: 'a.b', params: { x: [1] } }],
    ['a list of 11', { id: 'a.b', params: { x: Array.from({ length: 11 }, () => 'p') } }],
    ['a list item of 501 characters', { id: 'a.b', params: { x: ['p'.repeat(501)] } }],
    ['a string of 1001 characters', { id: 'a.b', params: { x: 'p'.repeat(1001) } }],
    ['NaN', { id: 'a.b', params: { x: Number.NaN } }],
    ['Infinity', { id: 'a.b', params: { x: Number.POSITIVE_INFINITY } }],
    ['a parameter name of 33 characters', { id: 'a.b', params: { ['n'.repeat(33)]: 1 } }],
    ['17 parameters', { id: 'a.b', params: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, i])) }],
    ['the key constructor', { id: 'a.b', params: { constructor: 'x' } }],
    ['the key prototype', { id: 'a.b', params: { prototype: 'x' } }],
  ])('refuses %s', (_name, value) => {
    expect(messageRefSchema.safeParse(value).success).toBe(false);
  });

  it('forbids the same record keys as the rest of the protocol', () => {
    for (const key of FORBIDDEN_RECORD_KEYS) {
      const parsed = messageRefSchema.safeParse({ id: 'a.b', params: JSON.parse(`{"${key}":"x"}`) as unknown });
      // zod's record never copies an own `__proto__` key into its output; the other two are refused outright.
      if (parsed.success) expect(Object.keys(parsed.data.params ?? {}), key).toEqual([]);
      else expect(parsed.success, key).toBe(false);
      if (key !== '__proto__') expect(parsed.success, key).toBe(false);
    }
    expect(FORBIDDEN_RECORD_KEYS.size).toBe(3);
    // A reference with an own `__proto__` parameter still renders nothing dangerous: render() only reads declared names.
    expect(render('en', { id: 'role.host', params: JSON.parse('{"__proto__":{"x":1}}') as never })).toBe('Host');
  });

  it('accepts every reference the catalog can make (ids and parameter names fit the wire shape)', () => {
    for (const id of MESSAGE_IDS) {
      expect(messageRefSchema.safeParse({ id }).success, id).toBe(true);
      for (const name of Object.keys(MESSAGES[id].params)) {
        expect(messageRefSchema.safeParse({ id, params: { [name]: 'x' } }).success, `${id} ${name}`).toBe(true);
      }
    }
    expect(messageRefSchema.parse(msg('role.agent'))).toEqual({ id: 'role.agent' });
  });
});

describe('error payload `text` (protocol 3, additive)', () => {
  it('is optional and is a message reference', () => {
    expect(errorPayloadSchema.safeParse({ code: 'forbidden', message: 'x' }).success).toBe(true);
    const payload = errorPayloadSchema.parse({ code: 'forbidden', message: 'You do not have permission to do this.', text: msg('error.default.forbidden') });
    expect(render('zh-TW', payload.text)).toMatch(/\p{Script=Han}/u);
    expect(render('en', payload.text)).toBe(payload.message);
    expect(errorPayloadSchema.safeParse({ code: 'forbidden', message: 'x', text: 'nope' }).success).toBe(false);
  });

  it('SmurgError payloads still parse (the class does not set `text` yet)', () => {
    expect(errorPayloadSchema.safeParse(new SmurgError('locked').toPayload()).success).toBe(true);
  });
});

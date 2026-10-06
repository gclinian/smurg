// Names with one language-neutral spelling, and the folder name a topic's name gives.
import { describe, expect, it } from 'vitest';
import { agentSafeName } from './agent-text.ts';
import { render } from './i18n/index.ts';
import { FIRST_MESSAGE_TITLE_CHARS, agentDisplayName, defaultSessionTitle, sessionTitleRef, slugFromName, titleFromFirstMessage } from './names.ts';
import { TOPIC_SLUG_PATTERN } from './schema/entities.ts';
import { displayNameSchema } from './schema/primitives.ts';

describe('agentDisplayName: the agent is named after its session', () => {
  it('a discussion after the topic, an execution session after the item, a free session after its opener', () => {
    expect(agentDisplayName('Checkout')).toBe('Claude (Checkout)');
    expect(agentDisplayName('Cart API')).toBe('Claude (Cart API)');
    expect(agentDisplayName('Ian')).toBe('Claude (Ian)');
  });

  it('always fits a display name, whatever the label', () => {
    for (const label of ['x'.repeat(300), '結'.repeat(300), `${'a'.repeat(246)}😀`]) {
      const name = agentDisplayName(label);
      expect(name.length).toBeLessThanOrEqual(256);
      expect(displayNameSchema.safeParse(name).success, label.slice(0, 8)).toBe(true);
    }
  });

  it('a label that went through agentSafeName cannot close the parenthesis', () => {
    expect(agentDisplayName(agentSafeName('Cart) [smurg k7f2] (x', 'dev:x'))).toBe('Claude (Cart smurg k7f2 x)');
  });
});

describe('sessionTitleRef: the name of a session nobody named, for every client', () => {
  const openedBy = { userId: 'dev:ian', displayName: 'Ian' };

  it('a terminal and a free agent session after their opener; a discussion; a work item by number and title', () => {
    expect(sessionTitleRef({ kind: 'terminal', openedBy })).toEqual({ id: 'session.title.terminal', params: { owner: 'Ian' } });
    expect(sessionTitleRef({ kind: 'agent', purpose: 'free', openedBy })).toEqual({ id: 'session.title.agent', params: { owner: 'Ian' } });
    expect(sessionTitleRef({ kind: 'agent', purpose: 'discussion', openedBy })).toEqual({ id: 'session.title.discussion' });
    const item = sessionTitleRef({ kind: 'agent', purpose: 'item', openedBy, item: { number: 2, title: 'Payment form' } });
    expect(item).toEqual({ id: 'session.title.item', params: { number: 2, title: 'Payment form' } });
    expect(render('en', item)).toBe('2 · Payment form');
    expect(render('en', sessionTitleRef({ kind: 'agent', purpose: 'discussion', openedBy }))).toBe('Discussion');
  });
});

describe('default titles', () => {
  it('English, for fixed-English text', () => {
    expect(defaultSessionTitle('agent', 'Ian')).toBe('Claude (Ian)');
    expect(defaultSessionTitle('terminal', 'Ian')).toBe('Terminal (Ian)');
  });

  it('a free session without a typed title is named after the start of its first message', () => {
    expect(titleFromFirstMessage('Look at src/cache.ts')).toBe('Look at src/cache.ts');
    expect(titleFromFirstMessage('  several\n\nlines\tand   spaces ')).toBe('several lines and spaces');
    const long = titleFromFirstMessage('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(FIRST_MESSAGE_TITLE_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('slugFromName', () => {
  it.each([
    ['Checkout', 'checkout'],
    ['Checkout flow v2', 'checkout-flow-v2'],
    ['  Cart & Payment!  ', 'cart-payment'],
    ['Café Über', 'cafe-uber'],
    ['API_v2.1', 'api-v2-1'],
    ['結帳 Checkout', 'checkout'],
    ['a/b\\c..d', 'a-b-c-d'],
    ['../../etc/passwd', 'etc-passwd'],
    ['x'.repeat(80), 'x'.repeat(48)],
    [`${'a'.repeat(47)}-bcd`, 'a'.repeat(47)],
  ])('%j → %j', (name, expected) => {
    expect(slugFromName(name)).toBe(expected);
    expect(TOPIC_SLUG_PATTERN.test(slugFromName(name))).toBe(true);
  });

  it('a name with fewer than three slug characters (a Chinese name) gets topic-<n>, the next free number', () => {
    expect(slugFromName('結帳流程')).toBe('topic-1');
    expect(slugFromName('結帳流程', ['topic-1', 'topic-2', 'checkout'])).toBe('topic-3');
    expect(slugFromName('結帳流程', new Set(['topic-2']))).toBe('topic-1');
    expect(slugFromName('v2')).toBe('topic-1');
    expect(slugFromName('a-b')).toBe('topic-1');
    expect(slugFromName('!!!')).toBe('topic-1');
    expect(slugFromName('')).toBe('topic-1');
  });

  it('a derived slug is returned even when it is taken: the daemon refuses it and the member changes the field', () => {
    expect(slugFromName('Checkout', ['checkout'])).toBe('checkout');
  });
});

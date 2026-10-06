// @vitest-environment node
// The slot registry: what the features registered, as one thing the shell asks.
import { buildAgentSession, buildInboxItem, buildTopic } from '@smurg/protocol/testing';
import { describe, expect, it } from 'vitest';
import { EMPTY_SLOT_REGISTRY, SlotConflictError, createSlotRegistry, defineSlots, type InboxRowView, type SlotEnv } from './slots.ts';

const env = {} as SlotEnv;
const Fake = () => null;
const Other = () => null;

describe('slot registry', () => {
  it('gives the component a feature registered for a column kind, and null for a kind nobody registered', () => {
    const registry = createSlotRegistry([defineSlots({ feature: 'topics', columns: { plan: Fake, spec: Other } }), defineSlots({ feature: 'conversation', columns: { conversation: Fake } })]);
    expect(registry.column('plan')).toBe(Fake);
    expect(registry.column('spec')).toBe(Other);
    expect(registry.column('conversation')).toBe(Fake);
    expect(registry.column('terminal')).toBeNull();
    expect(registry.features).toEqual(['topics', 'conversation']);
  });

  it('a column kind and an inbox kind belong to one feature; a feature registers once', () => {
    expect(() => createSlotRegistry([{ feature: 'a', columns: { plan: Fake } }, { feature: 'b', columns: { plan: Other } }])).toThrow(SlotConflictError);
    expect(() => createSlotRegistry([{ feature: 'a', columns: { plan: Fake } }, { feature: 'b', columns: { plan: Other } }])).toThrow(/"plan" is registered by a and by b/);
    const row = (_item: unknown, base: InboxRowView): InboxRowView => base;
    expect(() => createSlotRegistry([{ feature: 'a', inboxRows: { question: row } }, { feature: 'b', inboxRows: { question: row } }])).toThrow(/"question" are rendered by a and by b/);
    expect(() => createSlotRegistry([{ feature: 'a' }, { feature: 'a' }])).toThrow(/registered twice: a/);
  });

  it('overlays and menus add up, in registration order', () => {
    const registry = createSlotRegistry([
      { feature: 'conversation', overlays: [Fake], menus: { session: () => [{ id: 'rename', label: 'Rename', onSelect: () => {} }] } },
      { feature: 'agents', overlays: [Other, Fake], menus: { session: (session) => [{ id: `end-${session.id}`, label: 'End session', onSelect: () => {} }] } },
      { feature: 'topics', menus: { topic: (topic) => [{ id: 'archive', label: `Archive ${topic.name}`, onSelect: () => {} }] } },
    ]);
    expect(registry.overlays.map(({ feature, index, Component }) => [feature, index, Component])).toEqual([
      ['conversation', 0, Fake],
      ['agents', 0, Other],
      ['agents', 1, Fake],
    ]);
    expect(registry.sessionMenu(buildAgentSession({ id: 's1' }), env).map((item) => item.id)).toEqual(['rename', 'end-s1']);
    expect(registry.topicMenu(buildTopic(), env).map((item) => item.label)).toEqual(['Archive Checkout']);
  });

  it('an inbox row goes through the renderer of its kind, and is the shell\'s own without one', () => {
    const base: InboxRowView = { title: 'Where is the cart kept?', where: 'Checkout › Discussion' };
    const registry = createSlotRegistry([{ feature: 'conversation', inboxRows: { question: (item, row) => ({ ...row, where: `${row.where} · ${item.voted ?? 0} voted` }) } }]);
    expect(registry.inboxRow(buildInboxItem('question', { voted: 2 }), base, env)).toEqual({ title: base.title, where: 'Checkout › Discussion · 2 voted' });
    expect(registry.inboxRow(buildInboxItem('permission'), base, env)).toBe(base);
  });

  it('the empty registry has nothing', () => {
    expect(EMPTY_SLOT_REGISTRY.features).toEqual([]);
    expect(EMPTY_SLOT_REGISTRY.column('plan')).toBeNull();
    expect(EMPTY_SLOT_REGISTRY.overlays).toEqual([]);
    expect(EMPTY_SLOT_REGISTRY.sessionMenu(buildAgentSession(), env)).toEqual([]);
  });
});

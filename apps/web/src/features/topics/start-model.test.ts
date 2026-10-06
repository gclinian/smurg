// The lines of the Start dialog (DESIGN §4.5), from `StartPreflight`.
import { buildPlan, buildWorkItem, FAKE_HASH } from '@smurg/protocol/testing';
import { msg } from '@smurg/protocol/i18n';
import type { StartPreflight } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { START_WAITS_SHOWN, startCount, startLines } from './start-model.ts';

const IAN = { userId: 'dev:host', displayName: 'Ian' };
const MEI = { userId: 'dev:mei', displayName: 'Mei' };
const KEN = { userId: 'dev:ken', displayName: 'Ken' };

const plan = buildPlan({
  items: [
    buildWorkItem({ id: 'cart-api', number: 1, title: 'Cart API' }),
    buildWorkItem({ id: 'payment-form', number: 2, title: 'Payment form' }),
    buildWorkItem({ id: 'checkout-page', number: 3, title: 'Checkout page', dependsOn: ['cart-api', 'payment-form'] }),
  ],
});

function preflight(overrides: Partial<StartPreflight> = {}): StartPreflight {
  return {
    planRevision: 3,
    specHash: FAKE_HASH,
    planHash: FAKE_HASH,
    startsNow: ['cart-api', 'payment-form'],
    waits: [{ itemId: 'checkout-page', for: ['cart-api', 'payment-form'] }],
    alreadyStarted: [],
    responsible: [
      { itemId: 'cart-api', user: IAN, online: true },
      { itemId: 'payment-form', user: KEN, online: false },
      { itemId: 'checkout-page', user: IAN, online: true },
    ],
    youDecide: 0,
    commit: { needed: true, branch: 'main', as: MEI, files: ['specs/checkout/SPEC.md', 'specs/checkout/PLAN.md'], alsoInFolder: ['specs/checkout/notes.txt'] },
    handEdits: { spec: [], plan: [] },
    invisibleCharacters: [],
    stale: false,
    openQuestion: false,
    specOpenQuestions: 0,
    editingNow: [],
    projectSettings: 'used',
    rules: [],
    sharedDirs: [],
    blockers: [],
    ...overrides,
  };
}

const textOf = (lines: ReturnType<typeof startLines>, id: string): string[] => lines.filter((line) => line.id === id).map((line) => line.text);

describe('the Start dialog’s lines', () => {
  it('says what starts now, what waits for what, who is responsible and who is offline', () => {
    const lines = startLines(preflight(), plan, MEI.userId);
    expect(textOf(lines, 'starts')).toEqual(['2 items start now: 1 · Cart API and 2 · Payment form.']);
    expect(textOf(lines, 'waits')).toEqual(['3 · Checkout page starts by itself when 1 · Cart API and 2 · Payment form are merged, if the spec and the plan are still what you see now.']);
    expect(textOf(lines, 'responsible')).toEqual(['Responsible: Ian 2 · Ken 1.']);
    expect(textOf(lines, 'offline')).toEqual(['Ken is offline right now: their items start and wait for them.']);
    expect(lines.find((line) => line.id === 'offline')?.tone).toBe('warn');
    expect(startCount(preflight())).toBe(3);
  });

  it('names the commit, as "you" for the caller, and what in the folder is NOT committed', () => {
    expect(textOf(startLines(preflight(), plan, MEI.userId), 'commit')).toEqual([
      "smurg commits SPEC.md and PLAN.md to the branch main of the host's folder, as you. Also in the folder and NOT committed: specs/checkout/notes.txt.",
    ]);
    expect(textOf(startLines(preflight(), plan, IAN.userId), 'commit')[0]).toContain('as Mei.');
    const clean = preflight({ commit: { needed: false, branch: 'main', as: MEI, files: [], alsoInFolder: [] } });
    expect(textOf(startLines(clean, plan, MEI.userId), 'commit')).toEqual(['SPEC.md and PLAN.md are already committed on the branch main: nothing new is committed.']);
    expect(textOf(startLines(preflight({ commit: null }), plan, MEI.userId), 'commit')).toEqual([]);
  });

  it('warns about what changed since someone last looked', () => {
    const lines = startLines(
      preflight({
        handEdits: { spec: [{ by: { userId: 'dev:amy', displayName: 'Amy' }, at: 1_780_000_000_000 }], plan: [] },
        invisibleCharacters: ['spec', 'plan'],
        stale: true,
        openQuestion: true,
        specOpenQuestions: 2,
        editingNow: [IAN],
        projectSettings: 'ignored',
      }),
      plan,
      MEI.userId,
    );
    expect(textOf(lines, 'handEdits')[0]).toMatch(/^Edited by hand since the last Start: Amy \(SPEC\.md, .+\)\.$/);
    expect(textOf(lines, 'invisible')).toEqual(['SPEC.md and PLAN.md contain characters you cannot see. Look at the changes before you start.']);
    expect(textOf(lines, 'stale')).toEqual(['The spec changed after this plan was written.']);
    expect(textOf(lines, 'openQuestion')).toEqual(['A question is open in the discussion.']);
    expect(textOf(lines, 'specOpenQuestions')).toEqual(['The spec lists 2 open questions.']);
    expect(textOf(lines, 'editingNow')).toEqual(['Ian is editing the spec or the plan right now.']);
    expect(textOf(lines, 'settings')).toEqual(["The host has not confirmed this folder's Claude Code project settings: agents will not read CLAUDE.md."]);
    for (const id of ['handEdits', 'invisible', 'stale', 'openQuestion', 'specOpenQuestions', 'editingNow', 'settings']) expect(lines.find((line) => line.id === id)?.tone).toBe('warn');
  });

  it('with nobody assigned the caller decides; shared directories and confirmed settings are stated', () => {
    const lines = startLines(preflight({ responsible: [{ itemId: 'cart-api', user: null, online: false }], youDecide: 3, sharedDirs: ['node_modules', 'data'] }), plan, MEI.userId);
    expect(textOf(lines, 'responsible')).toEqual([]);
    expect(textOf(lines, 'youDecide')).toEqual(['You will decide the questions of these 3 sessions.']);
    expect(textOf(lines, 'shared')).toEqual(['Each item gets a fresh checkout. Shared into every checkout: node_modules, data.']);
    expect(textOf(lines, 'settings')).toEqual(["The folder's Claude Code project settings are confirmed: agents read CLAUDE.md."]);
    expect(textOf(startLines(preflight({ projectSettings: 'none' }), plan, null), 'settings')).toEqual([]);
    expect(textOf(startLines(preflight(), plan, null), 'shared')).toEqual(['Each item gets a fresh checkout. Nothing is shared into it, so agents install what they need first.']);
  });

  it('blockers come first, in the viewer’s language, and items already started are only mentioned', () => {
    const lines = startLines(preflight({ startsNow: [], waits: [], alreadyStarted: ['cart-api'], blockers: [{ text: msg('plan.start.invalid'), fallback: 'Fix PLAN.md before you start.' }] }), plan, null);
    expect(lines[0]).toEqual({ id: 'blocker', tone: 'danger', text: 'Fix PLAN.md before you start.' });
    expect(textOf(lines, 'starts')).toEqual(['No item starts now.']);
    expect(textOf(lines, 'already')).toEqual(['Already started, not touched: 1 · Cart API.']);
  });

  it('names at most six waiting items and counts the rest', () => {
    const many = buildPlan({ items: Array.from({ length: 9 }, (_, index) => buildWorkItem({ id: `i${index}`, number: index + 1, title: `T${index}`, dependsOn: index === 0 ? [] : ['i0'] })) });
    const lines = startLines(preflight({ startsNow: ['i0'], waits: Array.from({ length: 8 }, (_, index) => ({ itemId: `i${index + 1}`, for: ['i0'] })), responsible: [] }), many, null);
    expect(textOf(lines, 'waits')).toHaveLength(START_WAITS_SHOWN + 1);
    expect(textOf(lines, 'waits').at(-1)).toBe('2 more items wait for others.');
    expect(textOf(lines, 'waits')[0]).toBe('2 · T1 starts by itself when 1 · T0 is merged, if the spec and the plan are still what you see now.');
  });
});

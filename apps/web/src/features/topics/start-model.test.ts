// The lines of the Start dialog (DESIGN §4.5), from `StartPreflight`.
import { buildPlan, buildWorkItem, FAKE_HASH } from '@smurg/protocol/testing';
import { msg } from '@smurg/protocol/i18n';
import type { StartPreflight } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { START_WAITS_SHOWN, initialMerging, offersMergeChoice, startCount, startHeadCount, startLines, startMergingPatch, startedNotice } from './start-model.ts';

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
    // protocol 5: the folder's own git; the topic's agent settings (none chosen) and the mode its items would run with
    history: 'folder', direct: null, agent: { model: null, permissionMode: null, effective: 'auto' }, nestedRepos: [], cloudSynced: false, merging: { workspace: 'auto', proposed: 'auto', detached: false },
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

  it('one number for the title and the plan\'s button: what starts now, else what the Start arms; the notice says what happened', () => {
    expect(startHeadCount(preflight())).toBe(2);
    expect(startedNotice(preflight())).toEqual({ title: 'Started 2 items.', description: '1 more item starts by itself later.' });
    const all = preflight({ startsNow: ['cart-api'], waits: [] });
    expect(startHeadCount(all)).toBe(1);
    expect(startedNotice(all)).toEqual({ title: 'Started 1 item.' });
    const waiting = preflight({ startsNow: [], waits: [{ itemId: 'a', for: ['x'] }, { itemId: 'b', for: ['x'] }] });
    expect(startHeadCount(waiting)).toBe(2);
    expect(startedNotice(waiting)).toEqual({ title: '2 items start by themselves later.' });
  });

  it('names the commit, as "you" for the caller, the branch smurg merges into, and what in the folder is NOT committed', () => {
    // 0.7.0 (on purpose, DESIGN D19): under automatic merging the line also says that smurg merges into that branch only.
    expect(textOf(startLines(preflight(), plan, MEI.userId), 'commit')).toEqual([
      "smurg commits SPEC.md and PLAN.md to the branch main of the host's folder, as you. smurg merges each item into main; while the main workspace is on another branch, the merges wait for the host. Also in the folder and NOT committed: specs/checkout/notes.txt.",
    ]);
    expect(textOf(startLines(preflight(), plan, MEI.userId, { merging: 'host', host: 'Ian' }), 'commit')).toEqual([
      "smurg commits SPEC.md and PLAN.md to the branch main of the host's folder, as you. Also in the folder and NOT committed: specs/checkout/notes.txt.",
    ]);
    expect(textOf(startLines(preflight(), plan, IAN.userId), 'commit')[0]).toContain('as Mei.');
    const clean = preflight({ commit: { needed: false, branch: 'main', as: MEI, files: [], alsoInFolder: [] } });
    expect(textOf(startLines(clean, plan, MEI.userId, { merging: 'host', host: 'Ian' }), 'commit')).toEqual(['SPEC.md and PLAN.md are already committed on the branch main: nothing new is committed.']);
    expect(textOf(startLines(clean, plan, MEI.userId), 'commit')).toEqual([
      'SPEC.md and PLAN.md are already committed on the branch main: nothing new is committed. smurg merges each item into main; while the main workspace is on another branch, the merges wait for the host.',
    ]);
    expect(textOf(startLines(preflight({ commit: null }), plan, MEI.userId), 'commit')).toEqual([]);
  });

  it('says nothing about a commit that names no branch while the start is refused (a host before 0.5.2, a gitfile share)', () => {
    const noBranch = { needed: false, branch: '', as: MEI, files: [], alsoInFolder: [] };
    const blocked = preflight({ commit: noBranch, blockers: [{ text: { id: 'plan.start.noGit' }, fallback: 'Work items run in git worktrees, and this folder is not a git repository yet.' }] });
    expect(startLines(blocked, plan, MEI.userId).map((line) => line.id)).not.toContain('commit');
    // Another reason to wait does not hide what Start will commit, and where.
    const paused = preflight({ blockers: [{ text: msg('plan.paused'), fallback: 'The plan is paused.' }] });
    expect(textOf(startLines(paused, plan, MEI.userId), 'commit')[0]).toMatch(/^smurg commits SPEC\.md and PLAN\.md to the branch main/);
  });

  it('git’s reason for refusing comes first, in the host’s words for it, whatever fallback came along', () => {
    const lines = startLines(preflight({ commit: null, blockers: [{ text: msg('worktree.unavailable.noCommit'), fallback: 'x' }] }), plan, MEI.userId);
    expect(lines[0]).toEqual({ id: 'blocker', tone: 'danger', text: "The shared folder's git repository has no commit yet, so no worktree can be created. The host can commit once, without sharing again." });
    expect(textOf(lines, 'commit')).toEqual([]);
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

  it('without git an item waits for the others to be done, not merged (DESIGN 0.6.0 D15: nothing waits for a merge)', () => {
    const direct = startLines(preflight({ history: 'direct', commit: null, direct: { reason: { text: msg('worktree.unavailable.gitCannotRun'), fallback: '' }, hostOnly: false }, merging: null }), plan, null);
    expect(textOf(direct, 'waits')).toEqual(['3 · Checkout page starts by itself when 1 · Cart API and 2 · Payment form are done, if the spec and the plan are still what you see now.']);
    const one = startLines(preflight({ history: 'direct', commit: null, waits: [{ itemId: 'checkout-page', for: ['cart-api'] }], merging: null }), plan, null);
    expect(textOf(one, 'waits')).toEqual(['3 · Checkout page starts by itself when 1 · Cart API is done, if the spec and the plan are still what you see now.']);
    // With smurg's own history it still waits for the merge.
    expect(textOf(startLines(preflight({ history: 'smurg', commit: null }), plan, null), 'waits')[0]).toMatch(/are merged, if the spec/);
  });

  it('names at most six waiting items and counts the rest', () => {
    const many = buildPlan({ items: Array.from({ length: 9 }, (_, index) => buildWorkItem({ id: `i${index}`, number: index + 1, title: `T${index}`, dependsOn: index === 0 ? [] : ['i0'] })) });
    const lines = startLines(preflight({ startsNow: ['i0'], waits: Array.from({ length: 8 }, (_, index) => ({ itemId: `i${index + 1}`, for: ['i0'] })), responsible: [] }), many, null);
    expect(textOf(lines, 'waits')).toHaveLength(START_WAITS_SHOWN + 1);
    expect(textOf(lines, 'waits').at(-1)).toBe('2 more items wait for others.');
    expect(textOf(lines, 'waits')[0]).toBe('2 · T1 starts by itself when 1 · T0 is merged, if the spec and the plan are still what you see now.');
  });
});

describe('how the items of a Start reach the main workspace (protocol 6, DESIGN 0.7.0 D3, D19)', () => {
  it('automatic merging: what smurg merges, what stops the run, the end, and that nobody has to stay', () => {
    const lines = startLines(preflight(), plan, MEI.userId, { merging: 'auto', host: 'Ian' });
    expect(textOf(lines, 'merge')).toEqual([
      "smurg merges each item into the main workspace for Ian when its report says complete, at least one check passed and none failed (the host's setting). What waits for it then starts from the merged workspace.",
      "The run stops where a person must decide: a question, a request its mode asks, a report that is not complete and verified, work a person stopped or wrote to the agent about, files only the host may merge, the host's folder in the way, or a merge smurg cannot make cleanly by itself. Everything that does not depend on it goes on.",
      "When every item is merged, every member's inbox says the topic is ready to check: each report, the combined change and what the agents say they verified, with a way to undo an item.",
    ]);
    expect(textOf(lines, 'leave')).toEqual(["You can close this page: the work goes on while smurg host runs on Ian's computer, also after it was restarted."]);
    expect(textOf(startLines(preflight(), plan, IAN.userId, { merging: 'auto', host: null }), 'leave')).toEqual(['You can close this page: the work goes on while smurg host runs on your computer, also after it was restarted.']);
  });

  it('the host merges: chosen, the workspace\'s setting, or a detached HEAD (said first)', () => {
    expect(textOf(startLines(preflight(), plan, MEI.userId, { merging: 'host', host: 'Ian' }), 'merge')).toEqual(['Each item\'s change waits for Ian to read its diff and merge it. The items that depend on it start after that merge.']);
    const workspace = preflight({ merging: { workspace: 'host', proposed: 'host', detached: false } });
    expect(offersMergeChoice(workspace)).toBe(false);
    expect(initialMerging(workspace)).toBe('host');
    expect(textOf(startLines(workspace, plan, MEI.userId, { merging: 'auto', host: 'Ian' }), 'merge')).toEqual(['Each item\'s change waits for Ian to read its diff and merge it. The items that depend on it start after that merge.']);
    const detached = preflight({ merging: { workspace: 'auto', proposed: 'host', detached: true } });
    const lines = startLines(detached, plan, MEI.userId, { merging: 'host', host: 'Ian' });
    expect(textOf(lines, 'merge')[0]).toBe('The main workspace is not on a branch (a detached HEAD), so the host merges each item of this Start.');
    expect(lines.find((line) => line.id === 'merge')?.tone).toBe('warn');
    expect(offersMergeChoice(detached)).toBe(false);
  });

  it('what is chosen first and what plan.start sends: merging host only for the stricter choice', () => {
    expect(initialMerging(preflight())).toBe('auto');
    expect(initialMerging(preflight({ merging: { workspace: 'auto', proposed: 'host', detached: false } }))).toBe('host');
    expect(startMergingPatch(preflight(), 'auto')).toBeUndefined();
    expect(startMergingPatch(preflight(), 'host')).toEqual({ merging: 'host' });
    expect(startMergingPatch(preflight({ merging: { workspace: 'host', proposed: 'host', detached: false } }), 'host')).toBeUndefined();
  });

  it('items that run directly in the folder have nothing to merge: no merge lines', () => {
    const direct = preflight({ history: 'direct', direct: { reason: { text: msg('worktree.unavailable.gitNotFound', { minVersion: '2.42.0' }), fallback: 'no git' }, hostOnly: false }, merging: null, commit: null });
    const lines = startLines(direct, plan, IAN.userId, { merging: 'host', host: null });
    expect(textOf(lines, 'merge')).toEqual([]);
    expect(textOf(lines, 'leave')).toEqual([]);
  });
});

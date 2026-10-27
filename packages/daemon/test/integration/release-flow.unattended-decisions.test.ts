// The 0.7.0 acceptance test of a plan that runs by itself (DESIGN 0.7.0 D22), its cases of S4: what needs a person
// stops only its item and what depends on it, and the end. The same plan, people and composition as
// release-flow.unattended.test.ts (the head comment there says what was measured and why; the shared helpers are in
// release-flow.unattended.support.ts). A file of its own so that vitest runs it beside the other half (0.7.0 verify).
//
//   1 cart-api   2 receipt-email   3 checkout-page (depends on cart-api)        Mei starts it; Ian is the host
//
// M3 a question and M7 the cards auto mode still asks stop only their item and what depends on it (their rows say what
// waits), M6's partial report is a decision for the responsible person who leaves it out, M11 files only the host may
// merge are the host's decision and the agent takes them out when asked, M12 a branch the host switched to holds the
// merges for the host and nothing lands on it, M15 a turn a person stopped in a paused plan holds the version for its
// responsible person, an Editor's hand edit holds the item for the host; each topic is then ready to check for every
// member and "I've checked the result" completes it.
import { describe, expect, it } from 'vitest';
import type { FakeClaudeStep } from '../../src/testing/index.ts';
import { MEI, audited, inboxItem, inboxWithout, startFlow, waitFor } from './release-flow.support.ts';
import { CLEAN, FILES, PNPM_TEST, Q, THREE, UNATTENDED, checked, handIn, inMain, itemIs, itemOf, mergedBySmurg, planOf, readyForEveryone, report, reportPath, started, write, type PlanItemText } from './release-flow.unattended.support.ts';

// =====================================================================================================================
// S4: what needs a person stops only its item and what depends on it, and the end (DESIGN 0.7.0 D9, D10, D11, D13)
// =====================================================================================================================

describe('0.7.0 acceptance: a decision stops only its item and what depends on it (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('M3 an agent\'s question: the responsible person decides, the row says what waits for it, everything else merges meanwhile; answered, the rest runs to "Ready to check"', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [{ tool: 'AskUserQuestion', input: { questions: [Q] } }, ...(CLEAN[0] as FakeClaudeStep[])] },
        { match: 'Start work item 2 ', steps: CLEAN[1] as FakeClaudeStep[] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    const question = await inboxItem(flow.mei, (entry) => entry.kind === 'question', 'the question of item 1');
    expect(question).toMatchObject({ waiting: true, itemId: 'cart-api', unblocks: [3] });
    await itemIs(flow, topicId, 'cart-api', (item) => item.waiting === 'question', 'item 1 to say it waits for an answer');
    await mergedBySmurg(flow, topicId, 'receipt-email');
    expect(await itemOf(flow, topicId, 'checkout-page')).toMatchObject({ state: 'waiting', waitsFor: ['cart-api'] });
    await flow.mei.conn.request('question.submit', { questionId: question.anchor?.cardId as string, answers: [{ options: [0] }] });
    for (const id of ['cart-api', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    await readyForEveryone(flow, topicId);
    await checked(flow, topicId);
  });

  it('M7 what auto mode still asks (three blocks of its check in a row, a teammate\'s item writing outside its checkout): only those items and what depends on them wait, each for the right person; decided, everything merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      classifier: { block: ['curl'], category: 'network' },
      turns: [
        {
          match: 'Start work item 1 ',
          steps: [
            { tool: 'Bash', input: { command: 'curl -s https://example.invalid/a' } },
            { tool: 'Bash', input: { command: 'curl -s https://example.invalid/b' } },
            { tool: 'Bash', input: { command: 'curl -s https://example.invalid/c' } },
            ...(CLEAN[0] as FakeClaudeStep[]),
          ],
        },
        { match: 'Start work item 2 ', steps: [{ tool: 'Bash', input: { command: 'echo done >> ~/notes.txt' } }, ...(CLEAN[1] as FakeClaudeStep[])] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    for (const id of ['cart-api', 'receipt-email']) await itemIs(flow, topicId, id, (item) => item.waiting === 'permission', `${id} to wait for a permission`);
    expect(await itemOf(flow, topicId, 'checkout-page')).toMatchObject({ state: 'waiting', waitsFor: ['cart-api'] });
    // Item 1's request is the responsible person's (Mei); the row says item 3 waits for it.
    const first = await inboxItem(flow.mei, (entry) => entry.kind === 'permission' && entry.itemId === 'cart-api', 'item 1\'s request');
    expect(first).toMatchObject({ waiting: true, unblocks: [3] });
    // Item 2's request (writing outside its checkout) is the host's alone; nothing waits for item 2.
    const second = await inboxItem(flow.ian, (entry) => entry.kind === 'permission' && entry.itemId === 'receipt-email', 'item 2\'s request');
    expect(second.unblocks).toBeUndefined();
    expect((await flow.mei.inbox()).some((entry) => entry.kind === 'permission' && entry.itemId === 'receipt-email')).toBe(false);
    expect((await planOf(flow, topicId)).items.some((item) => item.merged !== undefined)).toBe(false);
    await flow.mei.conn.request('permission.decide', { requestId: first.anchor?.cardId as string, decision: 'allow' });
    await flow.ian.conn.request('permission.decide', { requestId: second.anchor?.cardId as string, decision: 'allow' });
    for (const id of ['cart-api', 'receipt-email', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    await readyForEveryone(flow, topicId);
  });

  it('M6 a partial report is a decision for its responsible person (what waits for it is named); she leaves it out with what depends on it, and the rest is ready to check', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    const partial: FakeClaudeStep[] = [
      write('src/cart/total.ts', 'export const total = 1;\n'),
      PNPM_TEST,
      { tool: 'Write', input: { file_path: reportPath('cart-api'), content: report('cart-api', 'Cart API', 'Half of the cart.', 'partial') } },
      { tool: 'mcp__smurg__check_report', input: {} },
      { text: 'Half of it.' },
    ];
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: partial },
        { match: 'Start work item 2 ', steps: CLEAN[1] as FakeClaudeStep[] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    const decision = await inboxItem(flow.mei, (entry) => entry.kind === 'decision', 'the decision on item 1', 60_000);
    expect(decision).toMatchObject({ waiting: true, itemId: 'cart-api', reason: 'partial', outcome: 'partial', checks: { passed: 1, notVerified: 1 }, unblocks: [3], target: { kind: 'report', topicId, itemId: 'cart-api' } });
    for (const person of [flow.ian, flow.amy, flow.leo]) expect((await person.inbox()).some((entry) => entry.kind === 'decision'), person.name).toBe(false);
    await mergedBySmurg(flow, topicId, 'receipt-email');
    expect((await planOf(flow, topicId)).waitingFor.map((entry) => [entry.user.userId, entry.decisions])).toEqual([[MEI, 1]]);
    // A member without agent access cannot leave it out; Mei does: items 1 and 3.
    expect(await flow.amy.conn.request('plan.item.leaveOut', { topicId, itemId: 'cart-api' }).then(() => 'left out', (err: { code?: string }) => err.code)).toBe('forbidden');
    const { plan } = await flow.mei.conn.request('plan.item.leaveOut', { topicId, itemId: 'cart-api' });
    expect(plan.items.filter((item) => item.leftOut !== undefined).map((item) => item.id)).toEqual(['cart-api', 'checkout-page']);
    await inboxWithout(flow.mei, (entry) => entry.kind === 'decision', 'the decision');
    expect(await inMain(flow, 'src/cart/total.ts').catch(() => null)).toBeNull();
    await readyForEveryone(flow, topicId);
    const ready = (await flow.leo.inbox()).find((entry) => entry.kind === 'ready');
    expect(ready).toMatchObject({ tally: { items: 3, merged: 1, leftOut: 2, undone: 0 }, checks: { passed: 1, notVerified: 0 } });
    await checked(flow, topicId);
  });

  it('M11 an item also writes CLAUDE.md (only the host may merge it): the host\'s decision with the file, what depends on it waits; asked, the agent takes it out and everything merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [{ tool: 'Bash', input: { command: 'echo "Use tabs." >> CLAUDE.md' }, run: true }, ...(CLEAN[0] as FakeClaudeStep[])] },
        { match: 'Start work item 2 ', steps: CLEAN[1] as FakeClaudeStep[] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { match: 'smurg does not merge changes to these files', steps: [{ tool: 'Bash', input: { command: 'rm CLAUDE.md' }, run: true }, ...handIn('cart-api', 'Cart API', 'The cart, without CLAUDE.md.')] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    const decision = await inboxItem(flow.ian, (entry) => entry.kind === 'decision', 'the host\'s decision on item 1', 60_000);
    expect(decision).toMatchObject({ itemId: 'cart-api', reason: 'policy', unblocks: [3] });
    expect((await itemOf(flow, topicId, 'cart-api')).autoMerge).toMatchObject({ state: 'held', reason: 'policy', hostOnly: true, paths: ['CLAUDE.md'] });
    for (const person of [flow.mei, flow.amy, flow.leo]) expect((await person.inbox()).some((entry) => entry.kind === 'decision'), person.name).toBe(false);
    await mergedBySmurg(flow, topicId, 'receipt-email');
    await flow.ian.conn.request('plan.item.removePaths', { topicId, itemId: 'cart-api' });
    for (const id of ['cart-api', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    expect(await inMain(flow, 'CLAUDE.md').catch(() => null)).toBeNull();
    await readyForEveryone(flow, topicId);
  });

  it('M12 the host switches the main workspace to another branch after Start: the merges are held for the host and nothing lands there; back on the Start\'s branch, everything merges by itself', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [{ sleep: 1_500 }, ...(CLEAN[0] as FakeClaudeStep[])] },
        { match: 'Start work item 2 ', steps: [{ sleep: 1_500 }, ...(CLEAN[1] as FakeClaudeStep[])] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    const startBranch = await flow.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    await flow.git(['checkout', '-q', '-b', 'experiment']);
    const decision = await inboxItem(flow.ian, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api', 'the host\'s decision on item 1', 60_000);
    expect(decision).toMatchObject({ reason: 'branch', unblocks: [3] });
    expect((await itemOf(flow, topicId, 'cart-api')).autoMerge).toMatchObject({ state: 'held', reason: 'branch', hostOnly: true, branch: { expected: startBranch, current: 'experiment' } });
    expect((await flow.git(['log', '--merges', '--format=%s', 'experiment'])).trim()).toBe('');
    expect(await itemOf(flow, topicId, 'checkout-page')).toMatchObject({ state: 'waiting' });
    // Back on the branch the Start used: smurg merges by itself at its next look.
    await flow.git(['checkout', '-q', startBranch]);
    flow.advance(61_000);
    for (const id of ['cart-api', 'receipt-email', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    expect((await flow.git(['log', '--merges', '--format=%s', 'experiment'])).trim()).toBe('');
    await readyForEveryone(flow, topicId);
  });
});

describe('0.7.0 acceptance: what a person did to a done item is theirs to decide (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('M15 in a paused plan, Mei writes to a done item\'s agent and stops that turn; after "Continue all" nothing merges and Mei has the decision; "Merge it as it is" lets it merge', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        // Item 1 stops without its report (it needs someone); then Mei pauses the plan (0.7.0 S6: a person's Pause; until
        // S6 the story restarted the host's smurg, which paused the plan of an armed item as 0.6.0 did).
        { match: 'Start work item 1 ', steps: [{ text: 'Looking at the cart.' }] },
        { match: 'You stopped without the result report', steps: [{ text: 'Not yet.' }] },
        { match: 'Finish the cart', steps: CLEAN[0] as FakeClaudeStep[] },
        { match: 'Also add a total row', steps: [{ sleep: 60_000 }, { text: 'never' }] },
        { match: 'Start work item 2 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow, [THREE[0] as PlanItemText, THREE[2] as PlanItemText]);
    await itemIs(flow, topicId, 'cart-api', (item) => item.state === 'stalled', 'item 1 to stop without a report');
    await flow.mei.conn.request('plan.pause', { topicId });
    await waitFor(async () => (await planOf(flow, topicId)).paused, { timeoutMs: 30_000, what: 'the plan to be paused' });
    const sessionId = (await itemOf(flow, topicId, 'cart-api')).sessionId as string;
    // Paused: its report comes in and nothing merges.
    await flow.mei.conn.request('session.message.send', { sessionId, text: 'Finish the cart, please.' });
    await itemIs(flow, topicId, 'cart-api', (item) => item.state === 'done', 'item 1\'s report');
    expect((await itemOf(flow, topicId, 'cart-api')).autoMerge).toMatchObject({ state: 'waiting', reason: 'paused' });
    // Mei writes to its agent again and stops that turn.
    await flow.mei.conn.request('session.message.send', { sessionId, text: 'Also add a total row.' });
    await flow.mei.watch(sessionId);
    const turns = (kind: string): number => flow.mei.events(sessionId).filter((event) => event.kind === kind).length;
    const before = turns('turn.finished');
    await waitFor(() => turns('turn.started') > before, { timeoutMs: 30_000, what: 'the turn of the second message to start' });
    await flow.mei.conn.request('session.interrupt', { sessionId });
    await waitFor(() => turns('turn.finished') > before, { timeoutMs: 30_000, what: 'the stopped turn to end' });
    await flow.mei.conn.request('plan.resume', { topicId });
    const decision = await inboxItem(flow.mei, (entry) => entry.kind === 'decision', 'the decision on item 1', 60_000);
    expect(decision).toMatchObject({ itemId: 'cart-api', reason: 'stopped', unblocks: [2] });
    expect((await itemOf(flow, topicId, 'cart-api')).merged).toBeUndefined();
    expect((await audited(flow, 'worktree.merge.auto')).filter((entry) => entry.outcome === 'ok')).toEqual([]);
    const version = (await itemOf(flow, topicId, 'cart-api')).report?.version as number;
    await flow.mei.conn.request('plan.item.release', { topicId, itemId: 'cart-api', version });
    for (const id of ['cart-api', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    await readyForEveryone(flow, topicId);
  });

  it('R-SAFE S8 an Editor\'s hand edit in an item\'s checkout holds it for the host; a hand edit of a member with agent access does not', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [{ sleep: 2_500 }, ...(CLEAN[0] as FakeClaudeStep[])] },
        { match: 'Start work item 2 ', steps: [{ sleep: 2_500 }, ...(CLEAN[1] as FakeClaudeStep[])] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow, THREE.slice(0, 2));
    const worktreeOf = async (id: string): Promise<string> => (await itemIs(flow, topicId, id, (item) => item.worktreeId !== undefined, `${id}'s checkout`)).worktreeId as string;
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    await flow.amy.conn.request('file.write', { file: { root: { kind: 'worktree', worktreeId: await worktreeOf('cart-api') }, path: 'AMY.md' }, content: bytes('Amy was here.\n') });
    await flow.mei.conn.request('file.write', { file: { root: { kind: 'worktree', worktreeId: await worktreeOf('receipt-email') }, path: 'MEI.md' }, content: bytes('Mei was here.\n') });
    await mergedBySmurg(flow, topicId, 'receipt-email');
    const decision = await inboxItem(flow.ian, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api', 'the host\'s decision on item 1', 60_000);
    expect(decision).toMatchObject({ reason: 'by-hand' });
    expect((await itemOf(flow, topicId, 'cart-api')).autoMerge).toMatchObject({ state: 'held', reason: 'by-hand', hostOnly: true, paths: ['AMY.md'] });
    expect((await flow.mei.inbox()).some((entry) => entry.kind === 'decision')).toBe(false);
    expect((await itemOf(flow, topicId, 'cart-api')).merged).toBeUndefined();
  });
});

// The 0.7.0 acceptance test (DESIGN 0.7.0 D22), built from the understanding report's measurements (U1's twelve cases,
// `measure.test.ts`): the RELEASE composition (every real module, real git, the real `smurg hook` / `smurg mcp`) with
// the stand-in `claude` (release-flow.support.ts), in a workspace that merges by itself (a new workspace's default)
// and in auto mode (0.6.0's default). One plan, three items, one dependency:
//
//   1 cart-api   2 receipt-email   3 checkout-page (depends on cart-api)        Mei starts it; Ian is the host
//
// What 0.6.0 measured (U1 M1): a team that left after Start found its plan stopped 1.2 s later and still stopped eight
// hours later, and a clean three-item plan needed six presses (three reviews, three merges). Here nobody presses
// anything after Start. The cases of the merge queue (S3): M1 and M8 converge with no person, M9 with the host away,
// M2 a conflict between two items resolved by the item's own agent, M13 a conflict with a member's saved edit (smurg's
// own history) held for the carers with the member's name, M14 a resolve turn that only rewrites the report verified
// again once, M16 a restart in the middle of a resolve turn. The cases of the decisions and the end (S4): M3 a
// question and M7 the cards auto mode still asks stop only their item and what depends on it (their rows say what
// waits), M6's partial report is a decision for the responsible person who leaves it out, M11 files only the host may
// merge are the host's decision and the agent takes them out when asked, M12 a branch the host switched to holds the
// merges for the host and nothing lands on it, M15 a turn a person stopped in a paused plan holds the version for its
// responsible person, an Editor's hand edit holds the item for the host; each topic is then ready to check for every
// member and "I've checked the result" completes it. The cases of keeping it running (S6): M4 a restart of the host's
// smurg in the middle of a turn goes on by itself, M5 a usage limit is continued when the account is back, M6's crash is
// resumed once by smurg, and M10 two sessions that wait for answers no longer keep an unrelated item from starting.
//
// The cases of S4 (M3, M6's partial report, M7, M11, M12, M15, R-SAFE S8) are in release-flow.unattended-decisions.test.ts,
// the plan, the people and the helpers in release-flow.unattended.support.ts: vitest runs the two files side by side
// (0.7.0 verify: with them, this one file took up to 522 s of the gate's P2 under load).
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type WorkItem } from '@smurg/protocol';
import type { FakeClaudeStep } from '../../src/testing/index.ts';
import { AMY, IAN, audited, inboxItem, startFlow, told, waitFor } from './release-flow.support.ts';
import { CLEAN, FILES, PNPM_TEST, THREE, UNATTENDED, handIn, inMain, itemIs, itemOf, mergedBySmurg, nobodyIsAsked, planOf, readyForEveryone, report, reportPath, started, write } from './release-flow.unattended.support.ts';

describe('0.7.0 acceptance: a plan runs to its end by itself (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('M1 walk away after Start: every item merges by itself, what waited starts from the merged state, nobody is asked anything', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: CLEAN[0] as FakeClaudeStep[] },
        { match: 'Start work item 2 ', steps: CLEAN[1] as FakeClaudeStep[] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId, at } = await started(flow);
    for (const id of ['cart-api', 'receipt-email', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    const took = Date.now() - at;
    // Everything is in the folder; the dependent item was started from the merged state.
    expect(await inMain(flow, 'src/cart/total.ts')).toBe('export const total = 1;\n');
    expect(await inMain(flow, 'src/receipt/send.ts')).toBe('export const send = 1;\n');
    expect(await inMain(flow, 'src/checkout/page.ts')).toBe('export const page = 1;\n');
    const page = await itemOf(flow, topicId, 'checkout-page');
    expect(Buffer.from((await flow.ian.conn.request('file.read', { file: { root: { kind: 'worktree', worktreeId: page.worktreeId as string }, path: 'src/cart/total.ts' } })).content).toString('utf8')).toBe('export const total = 1;\n');
    // Each merge is the host's standing consent applied by smurg: author Ian, committer smurg, the trailer.
    const log = (await flow.git(['log', '--merges', '--format=%an|%cn|%(trailers:key=Merged-by,valueonly,separator=;)'])).split('\n').filter(Boolean);
    expect(log).toHaveLength(3);
    for (const line of log) expect(line).toBe("Ian|smurg|smurg (automatic merging, the host's setting)");
    const merges = (await audited(flow, 'worktree.merge.auto')).filter((entry) => entry.outcome === 'ok');
    expect(merges.map((entry) => [entry.actor.kind, entry.detail?.['consent'], entry.detail?.['onBehalfOf']])).toEqual([
      ['system', 'host-setting', IAN],
      ['system', 'host-setting', IAN],
      ['system', 'host-setting', IAN],
    ]);
    // Nobody pressed anything, and nobody is asked anything: the reviews are marks, the merges are done.
    expect(await audited(flow, 'report.review', 'worktree.merge.approve')).toEqual([]);
    await nobodyIsAsked(flow);
    const topic = (await flow.leo.conn.request('topic.list', {})).topics.find((candidate) => candidate.id === topicId);
    expect(topic?.plan).toMatchObject({ items: 3, started: 3, merged: 3, reviewed: 0 });
    // (0.6.0: after Start the plan stopped, 1.2 s later, until six presses; here it is merged whole in seconds)
    expect(took).toBeLessThan(120_000);
  });

  it('M8 each clean, complete item merges as soon as its report is in, the oldest report first', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    // The second item takes a moment longer, so the order of the reports is known.
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: CLEAN[0] as FakeClaudeStep[] },
        { match: 'Start work item 2 ', steps: [{ sleep: 1_500 }, ...(CLEAN[1] as FakeClaudeStep[])] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    for (const id of ['cart-api', 'receipt-email', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    const plan = await planOf(flow, topicId);
    const times = plan.items.map((item) => ({ id: item.id, report: item.report?.writtenAt ?? 0, merged: item.merged?.at ?? 0 }));
    const order = (key: 'report' | 'merged'): string[] => [...times].sort((a, b) => a[key] - b[key]).map((item) => item.id);
    expect(order('merged')).toEqual(order('report'));
    for (const item of times) expect(item.merged - item.report, item.id).toBeLessThan(30_000);
  });

  it('M9 the host is not online: everything that is in order merges all the same, on the host\'s standing consent', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: CLEAN[0] as FakeClaudeStep[] },
        { match: 'Start work item 2 ', steps: CLEAN[1] as FakeClaudeStep[] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    flow.ian.client.close();
    for (const id of ['cart-api', 'receipt-email', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    const log = (await flow.git(['log', '--merges', '--format=%an|%cn'])).split('\n').filter(Boolean);
    expect(log).toEqual(['Ian|smurg', 'Ian|smurg', 'Ian|smurg']);
  });

  it('M2 two items change the same line: the second is brought up to date by smurg, its own agent resolves and verifies, and it merges; nobody is asked', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    const both = 'export const title = "Bookshop with a cart and receipts";\n';
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/app.ts', 'export const title = "Bookshop with a cart";\n'), ...handIn('cart-api', 'Cart API')] },
        { match: 'Start work item 2 ', steps: [write('src/app.ts', 'export const title = "Bookshop with receipts";\n'), ...handIn('receipt-email', 'Receipt email')] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        // Whichever is merged second resolves (the message names the one merged before it).
        { match: 'merged before yours: 1 \\(id cart-api\\)', steps: [write('src/app.ts', both), ...handIn('receipt-email', 'Receipt email', 'The receipt, and both titles.')] },
        { match: 'merged before yours: 2 \\(id receipt-email\\)', steps: [write('src/app.ts', both), ...handIn('cart-api', 'Cart API', 'The cart, and both titles.')] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    for (const id of ['cart-api', 'receipt-email', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    expect(await inMain(flow, 'src/app.ts')).toBe(both);
    // One of them conflicted once, and was brought up to date and resolved by its own agent (no person asked it).
    const tries = (await audited(flow, 'worktree.merge.auto')).filter((entry) => entry.outcome === 'error' && entry.detail?.['reason'] === 'conflict');
    expect(tries).toHaveLength(1);
    const resolved = tries[0]?.detail?.['itemId'] as string;
    const sessionId = (await itemOf(flow, topicId, resolved)).sessionId as string;
    expect(await told(flow, sessionId)).toEqual(expect.arrayContaining([expect.stringContaining('These files have conflict markers: ["src/app.ts"]. Other work items were merged before yours:')]));
    expect((await itemOf(flow, topicId, resolved)).report?.version).toBe(2);
    expect(await audited(flow, 'plan.item.resolve', 'worktree.merge.approve', 'report.review')).toEqual([]);
    await nobodyIsAsked(flow);
  });

  it('M14 a resolve turn that only rewrites the report is asked once to verify again, and merges after a turn that checks it', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    const both = 'export const title = "Bookshop with a cart and receipts";\n';
    // The resolving agent writes the same report again and does not check it: that version was checked before its change.
    const unchecked = (id: string, title: string): FakeClaudeStep[] => [write('src/app.ts', both), { tool: 'Write', input: { file_path: reportPath(id), content: report(id, title) } }, { text: 'Resolved.' }];
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/app.ts', 'export const title = "Bookshop with a cart";\n'), ...handIn('cart-api', 'Cart API')] },
        { match: 'Start work item 2 ', steps: [write('src/app.ts', 'export const title = "Bookshop with receipts";\n'), ...handIn('receipt-email', 'Receipt email')] },
        { match: 'merged before yours: 1 \\(id cart-api\\)', steps: unchecked('receipt-email', 'Receipt email') },
        { match: 'merged before yours: 2 \\(id receipt-email\\)', steps: unchecked('cart-api', 'Cart API') },
        { match: 'Verify again', steps: [PNPM_TEST, { tool: 'mcp__smurg__check_report', input: {} }, { text: 'Checked again.' }] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow, THREE.slice(0, 2));
    for (const id of ['cart-api', 'receipt-email']) await mergedBySmurg(flow, topicId, id);
    expect(await inMain(flow, 'src/app.ts')).toBe(both);
    const resolved = (await audited(flow, 'worktree.merge.auto')).find((entry) => entry.outcome === 'error' && entry.detail?.['reason'] === 'conflict')?.detail?.['itemId'] as string;
    const sessionId = (await itemOf(flow, topicId, resolved)).sessionId as string;
    const said = await told(flow, sessionId);
    expect(said.filter((text) => text.includes('You changed files after your report was last checked. Verify again'))).toHaveLength(1);
    await nobodyIsAsked(flow);
  });

  it('M14 a turn asked to verify again that does not check its report is a decision for the item\'s carers, and nothing of it merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    const both = 'export const title = "Bookshop with a cart and receipts";\n';
    const unchecked = (id: string, title: string): FakeClaudeStep[] => [write('src/app.ts', both), { tool: 'Write', input: { file_path: reportPath(id), content: report(id, title) } }, { text: 'Resolved.' }];
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/app.ts', 'export const title = "Bookshop with a cart";\n'), ...handIn('cart-api', 'Cart API')] },
        { match: 'Start work item 2 ', steps: [write('src/app.ts', 'export const title = "Bookshop with receipts";\n'), ...handIn('receipt-email', 'Receipt email')] },
        { match: 'merged before yours: 1 \\(id cart-api\\)', steps: unchecked('receipt-email', 'Receipt email') },
        { match: 'merged before yours: 2 \\(id receipt-email\\)', steps: unchecked('cart-api', 'Cart API') },
        { match: 'Verify again', steps: [{ text: 'It is fine as it is.' }] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow, THREE.slice(0, 2));
    await waitFor(async () => (await planOf(flow, topicId)).items.some((item) => item.autoMerge?.reason === 'stale-report' && item.autoMerge.state === 'held'), { timeoutMs: 60_000, what: 'the hold' });
    const held = (await planOf(flow, topicId)).items.find((item) => item.autoMerge?.state === 'held') as WorkItem;
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stale-report', hostOnly: false });
    expect(held.merged).toBeUndefined();
    expect(await inMain(flow, 'src/app.ts')).not.toBe(both);
    expect((await audited(flow, 'worktree.merge.held')).map((entry) => entry.detail?.['reason'])).toEqual(['stale-report']);
  });

  it('M16 smurg host restarts in the middle of a resolve turn: the resolve is asked again after the restart\'s line, no new try, and it merges with nobody asked', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    const both = 'export const title = "Bookshop with a cart and receipts";\n';
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/app.ts', 'export const title = "Bookshop with a cart";\n'), ...handIn('cart-api', 'Cart API')] },
        { match: 'Start work item 2 ', steps: [write('src/app.ts', 'export const title = "Bookshop with receipts";\n'), ...handIn('receipt-email', 'Receipt email')] },
        // The first resolve turn is still working when the host's smurg stops.
        { match: 'merged before yours', once: true, steps: [{ sleep: 60_000 }, { text: 'never' }] },
        { match: 'merged before yours: 1 \\(id cart-api\\)', steps: [write('src/app.ts', both), ...handIn('receipt-email', 'Receipt email', 'Both titles.')] },
        { match: 'merged before yours: 2 \\(id receipt-email\\)', steps: [write('src/app.ts', both), ...handIn('cart-api', 'Cart API', 'Both titles.')] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow, THREE.slice(0, 2));
    await waitFor(async () => (await planOf(flow, topicId)).items.some((item) => item.autoMerge?.state === 'resolving'), { timeoutMs: 60_000, what: 'one item to resolve' });
    const resolving = (await planOf(flow, topicId)).items.find((item) => item.autoMerge?.state === 'resolving') as WorkItem;
    const sessionId = resolving.sessionId as string;
    await waitFor(async () => (await told(flow, sessionId)).some((text) => text.includes('merged before yours')), { timeoutMs: 30_000, what: 'the resolve message' });
    expect(resolving.autoMerge).toMatchObject({ reason: 'conflict', tries: 1 });
    await flow.restart();
    for (const id of ['cart-api', 'receipt-email']) await mergedBySmurg(flow, topicId, id);
    expect(await inMain(flow, 'src/app.ts')).toBe(both);
    // The restart's line, then the same request again; still one try.
    await flow.leo.watch(sessionId);
    expect(flow.leo.events(sessionId).some((event) => event.kind === 'line' && event.text.id === 'conversation.continued.restart')).toBe(true);
    expect((await told(flow, sessionId)).filter((text) => text.includes('merged before yours'))).toHaveLength(2);
    expect((await audited(flow, 'worktree.merge.auto')).filter((entry) => entry.outcome === 'error' && entry.detail?.['reason'] === 'conflict')).toHaveLength(1);
    await nobodyIsAsked(flow);
  });
});

describe('0.7.0 acceptance: a conflict with a person\'s change is a person\'s decision (smurg\'s own history)', { timeout: 300_000 }, () => {
  it('M13 Amy saves a change of the line an item also changes: the item is held for its carers with her name, and nothing of it merges', async () => {
    const flow = await startFlow({ files: { 'README.md': '# Shop\n', 'config.txt': 'title: Shop\nprice: 10\nfooter: (c) 2026\n' }, git: false, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        // The agent works for a moment (Amy saves her change meanwhile), then changes the price line too.
        { match: 'Start work item 1 ', steps: [{ sleep: 2_000 }, write('config.txt', 'title: Shop\nprice: 12\nfooter: (c) 2026\n'), ...handIn('cart-api', 'Cart API')] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow, THREE.slice(0, 1));
    await itemIs(flow, topicId, 'cart-api', (item) => item.state === 'running', 'the item to run');
    const amys = 'title: Shop\nprice: 15 (Amy: agreed with the client)\nfooter: (c) 2026\n';
    await flow.amy.conn.request('file.write', { file: { root: MAIN_ROOT, path: 'config.txt' }, content: new TextEncoder().encode(amys) });
    const held = await itemIs(flow, topicId, 'cart-api', (item) => item.autoMerge?.state === 'held', 'the item to be held');
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'conflict', tries: 0, hostOnly: false, people: [{ path: 'config.txt', by: [{ userId: AMY, displayName: 'Amy' }], outside: false }] });
    expect(held.merged).toBeUndefined();
    expect(await inMain(flow, 'config.txt')).toBe(amys);
    const entry = (await audited(flow, 'worktree.merge.held'))[0];
    expect(entry?.detail).toMatchObject({ itemId: 'cart-api', reason: 'conflict', people: [{ path: 'config.txt', by: [AMY], outside: false }], tries: 0 });
    // smurg did not ask the agent to resolve over her line.
    expect((await told(flow, held.sessionId as string)).some((text) => text.includes('conflict markers'))).toBe(false);
  });
});


// =====================================================================================================================
// S6: keeping it running (DESIGN 0.7.0 D15, D16)
// =====================================================================================================================

describe('0.7.0 acceptance: the plan keeps running when the host\'s smurg restarts, the account is limited or an agent crashes (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('M4 the host\'s smurg restarts while an item works: after the start smurg says it continues the item, the item finishes, and everything merges with nobody pressing anything', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: CLEAN[0] as FakeClaudeStep[] },
        // Item 2 is still working when the host's smurg stops.
        { match: 'Start work item 2 ', steps: [write('src/receipt/send.ts', 'export const send = 1;\n'), { sleep: 60_000 }, { text: 'never' }] },
        { match: 'Continue the work item', steps: handIn('receipt-email', 'Receipt email') },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    // Items 1 and 3 (which waited for 1) are merged; item 2 works.
    for (const id of ['cart-api', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    const receipt = await itemIs(flow, topicId, 'receipt-email', (item) => item.state === 'running' && item.sessionId !== undefined, 'item 2 to work');
    const sessionId = receipt.sessionId as string;
    await waitFor(async () => (await told(flow, sessionId)).length > 0, { timeoutMs: 30_000, what: 'item 2 to have its first message' });
    await flow.restart();
    await mergedBySmurg(flow, topicId, 'receipt-email');
    expect((await planOf(flow, topicId)).paused).toBe(false);
    await flow.leo.watch(sessionId);
    const lines = flow.leo.events(sessionId).flatMap((event) => (event.kind === 'line' ? [event.text.id] : []));
    expect(lines).toContain('conversation.continued.restart');
    expect(flow.leo.events(sessionId).find((event) => event.kind === 'smurg' && event.purpose === 'continue-item')).toMatchObject({ purpose: 'continue-item' });
    expect(flow.leo.events(sessionId).find((event) => event.kind === 'smurg' && event.purpose === 'continue-item' && 'by' in event && event.by !== undefined)).toBeUndefined();
    expect((await audited(flow, 'plan.item.autoContinue')).map((entry) => [entry.actor.kind, entry.detail?.['itemId'], entry.detail?.['cause']])).toEqual([['system', 'receipt-email', 'restart']]);
    await readyForEveryone(flow, topicId);
  });

  it('M5 the usage limit: the item that hit it waits, and when the account is back (its reset time) smurg continues it; everything merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    const resetsAt = Math.floor((Date.now() + 2 * 3600_000) / 1000);
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: CLEAN[0] as FakeClaudeStep[] },
        { match: 'Start work item 2 ', steps: [{ rateLimit: { status: 'rejected', resetsAt } }, { text: "You've hit your limit", apiError: 'rate_limit' }, { result: { subtype: 'success', is_error: true, terminal_reason: 'api_error' } }] },
        { match: 'Continue the work item', steps: CLEAN[1] as FakeClaudeStep[] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    const stalled = await itemIs(flow, topicId, 'receipt-email', (item) => item.state === 'stalled', 'item 2 to stop at the limit');
    const sessionId = stalled.sessionId as string;
    // While the account is limited, nothing is sent to it.
    flow.advance(30 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await told(flow, sessionId)).filter((text) => text.includes('Continue the work item'))).toEqual([]);
    // Past the reset time the account works again: smurg continues the item.
    flow.advance(2 * 3600_000);
    await mergedBySmurg(flow, topicId, 'receipt-email');
    await flow.leo.watch(sessionId);
    expect(flow.leo.events(sessionId).some((event) => event.kind === 'line' && event.text.id === 'conversation.continued.usageLimit')).toBe(true);
    expect((await audited(flow, 'plan.item.autoContinue')).map((entry) => [entry.detail?.['itemId'], entry.detail?.['cause'], entry.detail?.['count']])).toEqual([['receipt-email', 'usage-limit', 1]]);
    for (const id of ['cart-api', 'checkout-page']) await mergedBySmurg(flow, topicId, id);
    await readyForEveryone(flow, topicId);
  });

  it('M6 an agent\'s process is killed while it works: a minute later smurg starts it again (as smurg) and tells it to continue; it finishes and merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: CLEAN[0] as FakeClaudeStep[] },
        { match: 'Start work item 2 ', steps: CLEAN[1] as FakeClaudeStep[] },
        { match: 'Start work item 3 ', steps: [write('src/checkout/page.ts', 'export const page = 1;\n'), { sleep: 60_000 }, { text: 'never' }] },
        { match: 'Continue the work item', steps: handIn('checkout-page', 'Checkout page') },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { topicId } = await started(flow);
    await mergedBySmurg(flow, topicId, 'cart-api');
    const page = await itemIs(flow, topicId, 'checkout-page', (item) => item.state === 'running' && item.sessionId !== undefined, 'item 3 to work');
    const sessionId = page.sessionId as string;
    await waitFor(async () => (await flow.processes()).some((line) => line.includes(Buffer.from(sessionId, 'utf8').toString('hex'))), { timeoutMs: 30_000, what: 'item 3\'s process' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await flow.killProcessOf(sessionId)).toBe(1);
    await itemIs(flow, topicId, 'checkout-page', (item) => item.state === 'failed', 'item 3 to fail');
    flow.advance(61_000);
    await mergedBySmurg(flow, topicId, 'checkout-page');
    await flow.leo.watch(sessionId);
    const lines = flow.leo.events(sessionId).flatMap((event) => (event.kind === 'line' ? [event.text.id] : []));
    expect(lines).toContain('conversation.continued.crash');
    expect((await audited(flow, 'session.retry')).map((entry) => entry.actor.kind)).toEqual(['system']);
    expect((await audited(flow, 'plan.item.autoContinue')).map((entry) => [entry.detail?.['itemId'], entry.detail?.['cause'], entry.detail?.['count']])).toEqual([['checkout-page', 'crash', 1]]);
    await readyForEveryone(flow, topicId);
  });
});

describe('0.7.0 acceptance: sessions that wait for a person do not keep unrelated items from starting (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('M10 two agents allowed, two items wait for answers: the unrelated third starts at once and merges; answered, the two merge too', async () => {
    const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging: 'auto', maxLiveAgents: 2 } });
    const ask = (header: string) => ({ question: `${header}?`, header, multiSelect: false, options: [{ label: 'Yes', description: 'y' }, { label: 'No', description: 'n' }] });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [{ tool: 'AskUserQuestion', input: { questions: [ask('Totals')] } }, ...(CLEAN[0] as FakeClaudeStep[])] },
        { match: 'Start work item 2 ', steps: [{ tool: 'AskUserQuestion', input: { questions: [ask('Sender')] } }, ...(CLEAN[1] as FakeClaudeStep[])] },
        { match: 'Start work item 3 ', steps: CLEAN[2] as FakeClaudeStep[] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const independent = THREE.map((item) => ({ id: item.id, title: item.title, touches: item.touches }));
    const { topicId } = await started(flow, independent);
    await waitFor(async () => (await planOf(flow, topicId)).slots.waitingForPeople === 2, { timeoutMs: 60_000, what: 'two sessions to wait for an answer' });
    await mergedBySmurg(flow, topicId, 'checkout-page');
    expect((await planOf(flow, topicId)).slots).toMatchObject({ max: 2, waitingForPeople: 2 });
    const first = await inboxItem(flow.mei, (entry) => entry.kind === 'question' && entry.itemId === 'cart-api', 'item 1\'s question');
    const second = await inboxItem(flow.ian, (entry) => entry.kind === 'question' && entry.itemId === 'receipt-email', 'item 2\'s question');
    await flow.mei.conn.request('question.submit', { questionId: first.anchor?.cardId as string, answers: [{ options: [0] }] });
    await flow.ian.conn.request('question.submit', { questionId: second.anchor?.cardId as string, answers: [{ options: [0] }] });
    for (const id of ['cart-api', 'receipt-email']) await mergedBySmurg(flow, topicId, id);
    await readyForEveryone(flow, topicId);
  });
});

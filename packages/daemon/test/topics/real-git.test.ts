// The topics module with the REAL worktree module and a real git repository (everything else is a fake): what only
// shows when the two meet. The checkpoint commit of a Start holds exactly the two files, the pin is what git says is
// at HEAD, an item's worktree is a checkout of that commit, the report's changes are a real draft merge request, and
// merging it starts what waited (the pin still holds: a merge that does not touch SPEC.md / PLAN.md moves HEAD, not
// their blobs).
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { topicPlanPath, topicReportPath, topicSpecPath } from '@smurg/protocol';
import { fakesModule, fakesOf, type Fakes } from '../../src/core/fakes/index.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createTestDaemon, isolatedGitEnv, waitFor, type TestClient, type TestDaemon } from '../../src/testing/index.ts';
import { createTopicsModule } from '../../src/topics/module.ts';
import { createWorktreeModule } from '../../src/worktree/module.ts';
import { SPEC_TEXT, planText, reportText } from './support.ts';

const run = promisify(execFile);

let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
}, 60_000);

async function git(daemon: TestDaemon, cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: isolatedGitEnv(join(daemon.stateDir, 'git-home')) });
  return stdout.trim();
}

describe('topics with the real worktree module and git', { timeout: 120_000 }, () => {
  it('Start commits the two files, pins them at HEAD, runs items in worktrees of that commit; the report is a draft the host merges, and the merge starts what waited', async () => {
    t = await createTestDaemon({
      modules: [locksModule, createWorktreeModule({ limits: { treeCheckDelayMs: 100 } }), fakesModule({ except: ['topics', 'plans', 'reports', 'worktrees'], handlers: true }), createTopicsModule({ fileDebounceMs: 20 })],
      project: { git: true, files: { 'src/app.ts': 'export const answer = 42;\n' } },
    });
    const d = t;
    const fakes: Fakes = fakesOf(d.ctx);
    const host = await d.connectHost();
    const mei: TestClient = await d.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const headBefore = await git(d, d.root, 'rev-parse', 'HEAD');

    const { topic } = await mei.conn.request('topic.create', { name: 'Checkout' });
    expect(topic.versioned).toBe(true);
    const specPath = topicSpecPath(topic.slug);
    const planPath = topicPlanPath(topic.slug);
    await writeFile(join(d.root, specPath), SPEC_TEXT);
    await writeFile(join(d.root, planPath), planText([{ id: 'cart-api', title: 'Cart API' }, { id: 'checkout-page', title: 'Checkout page', dependsOn: ['cart-api'] }]));
    await writeFile(join(d.root, 'specs/checkout/mockup.txt'), 'not part of the checkpoint\n');
    d.ctx.bus.emit('file.changed', { root: { kind: 'main' }, changes: [{ path: planPath, change: 'add' }] });
    await waitFor(() => d.ctx.services.plans.get(topic.id)?.items.length === 2, { what: 'the plan to be read' });
    await mei.conn.request('plan.assign', { topicId: topic.id, itemId: 'cart-api', userId: 'dev:amy' });

    // ---- the Start dialog knows the commit is needed, and names what is NOT committed ----
    const { preflight } = await mei.conn.request('plan.preflight', { topicId: topic.id });
    expect(preflight.blockers).toEqual([]);
    expect(preflight.commit).toMatchObject({ needed: true, as: { userId: 'dev:mei' }, files: [specPath, planPath], alsoInFolder: ['specs/checkout/mockup.txt'] });
    expect(preflight.commit?.branch).toBe(await git(d, d.root, 'rev-parse', '--abbrev-ref', 'HEAD'));
    expect((await mei.conn.request('plan.changes', { topicId: topic.id })).files.map((file) => file.target).sort()).toEqual(['plan', 'spec']);

    // ---- Start: the checkpoint commit ----
    const { plan } = await mei.conn.request('plan.start', { topicId: topic.id, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash });
    const head = await git(d, d.root, 'rev-parse', 'HEAD');
    expect(head).not.toBe(headBefore);
    expect(await git(d, d.root, 'log', '-1', '--format=%s')).toBe('smurg: spec and plan of checkout');
    expect((await git(d, d.root, 'show', '--name-only', '--format=', 'HEAD')).split('\n').sort()).toEqual([planPath, specPath].sort());
    expect(await git(d, d.root, 'status', '--porcelain', '--', 'specs')).toBe('?? specs/checkout/mockup.txt');
    // The dialog would now say nothing is to be committed, and nothing changed since the Start.
    expect((await mei.conn.request('plan.preflight', { topicId: topic.id })).preflight.commit?.needed).toBe(false);
    expect(await mei.conn.request('plan.changes', { topicId: topic.id })).toEqual({ files: [] });

    // ---- the first item runs in a worktree that is a checkout of that commit ----
    const cart = plan.items.find((item) => item.id === 'cart-api');
    expect(plan.items.map((item) => item.state)).toEqual(['running', 'waiting']);
    const worktreeId = cart?.worktreeId as string;
    const sessionId = cart?.sessionId as string;
    const worktree = d.ctx.roots.get({ kind: 'worktree', worktreeId });
    expect(worktree?.item).toEqual({ topicId: topic.id, topicSlug: 'checkout', itemId: 'cart-api' });
    const checkout = worktree?.realPath as string;
    expect(await readFile(join(checkout, specPath), 'utf8')).toBe(SPEC_TEXT);
    expect(d.ctx.services.worktrees.get(worktreeId)).toMatchObject({ branch: 'smurg/checkout/cart-api', topicId: topic.id, itemId: 'cart-api', ownerUserId: 'dev:mei' });
    expect(fakes.agents.get(sessionId)).toMatchObject({ purpose: 'item', root: { kind: 'worktree', worktreeId } });

    // ---- the agent works, writes its report, checks it, stops ----
    await writeFile(join(checkout, 'src/cart.ts'), 'export const cart: string[] = [];\n');
    await mkdir(join(checkout, 'specs/checkout/reports'), { recursive: true });
    await writeFile(join(checkout, topicReportPath('checkout', 'cart-api')), reportText('cart-api'));
    const reports = d.ctx.services.reports as typeof d.ctx.services.reports & { prepareCheck(context: unknown): Promise<void> };
    const context = { sessionId, purpose: 'item' as const, topic: { id: topic.id, slug: 'checkout' }, itemId: 'cart-api', root: { kind: 'worktree' as const, worktreeId }, agent: fakes.agents.agentActor(sessionId) };
    await reports.prepareCheck(context);
    expect(reports.checkReport(context)).toEqual({ ok: true });
    fakes.agents.edit(sessionId, { root: { kind: 'worktree', worktreeId }, path: 'src/cart.ts' });
    fakes.agents.finishTurn(sessionId, { finalText: 'Done.' });
    await waitFor(() => d.ctx.services.reports.get(topic.id, 'cart-api') !== null, { timeoutMs: 30_000, what: 'the report to be registered' });

    const report = (await amy.conn.request('report.get', { topicId: topic.id, itemId: 'cart-api' })).report;
    expect(report).toMatchObject({ version: 1, outcome: 'complete', state: 'to-review', reviewers: [{ userId: 'dev:amy' }] });
    // The report's diff is a real draft merge request: the new file and the report itself.
    expect(report.changes?.files).toBe(2);
    const requestId = report.changes?.requestId as string;
    expect(d.ctx.services.worktrees.listMerges(d.ctx.members.principalOf('dev:host') as NonNullable<ReturnType<typeof d.ctx.members.principalOf>>).find((request) => request.id === requestId)).toMatchObject({ status: 'draft', reviewed: false, topicId: topic.id, itemId: 'cart-api' });

    // ---- reviewed by the responsible Editor; the host merges the draft; the item is finished ----
    await amy.conn.request('report.review', { topicId: topic.id, itemId: 'cart-api', version: 1 });
    expect(d.ctx.services.plans.get(topic.id)?.items[0]).toMatchObject({ state: 'reviewed', merge: { requestId, status: 'draft', ready: true } });
    await host.conn.request('worktree.merge.approve', { requestId });
    await waitFor(() => d.ctx.services.plans.get(topic.id)?.items[0]?.merge?.status === 'merged', { timeoutMs: 30_000, what: 'the merge' });
    expect(await readFile(join(d.root, 'src/cart.ts'), 'utf8')).toBe('export const cart: string[] = [];\n');
    expect(await readFile(join(d.root, topicReportPath('checkout', 'cart-api')), 'utf8')).toBe(reportText('cart-api'));
    await waitFor(() => fakes.agents.get(sessionId)?.status === 'ended', { what: 'the finished item\'s session to end' });
    expect(fakes.agents.get(sessionId)?.endReason).toBe('merged');
    await waitFor(() => d.ctx.services.worktrees.get(worktreeId) === null, { timeoutMs: 30_000, what: 'the worktree to be released' });

    // ---- HEAD moved, SPEC.md and PLAN.md did not: the pin holds and what waited starts ----
    await waitFor(() => d.ctx.services.plans.get(topic.id)?.items[1]?.state === 'running', { timeoutMs: 30_000, what: 'the dependent item to start' });
    const page = d.ctx.services.plans.get(topic.id)?.items[1];
    expect(page?.disarmed).toBeUndefined();
    const pageRoot = d.ctx.roots.get({ kind: 'worktree', worktreeId: page?.worktreeId as string });
    // Its checkout already holds what the first item merged.
    expect(await readFile(join(pageRoot?.realPath as string, 'src/cart.ts'), 'utf8')).toContain('cart');
    expect(d.ctx.services.topics.get(topic.id)).toMatchObject({ phase: 'executing', plan: { items: 2, started: 2, reviewed: 1, merged: 1 } });
  });
});

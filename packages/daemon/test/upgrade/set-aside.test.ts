// ONE file of the workspace folder set aside (0.5.1, the last fixes: V5-1).
//
// A host whose inbox.json was cut off read only the last resort: a new workspace, which costs the members, the invite
// links and the daemon's key, for a file of read marks. A document that is not state.json can be moved out of the
// folder instead, IF the rest of the state then still makes sense. Whether it does is not a matter of opinion: this
// file starts the daemon on what smurg 0.5.0 really wrote (test/fixtures/published/0.5.0: every document full) with
// that one file moved away, for EVERY declared document other than state.json and for every other persisted file
// that can refuse a start, and looks at what a member can then see.
//
//   - It starts. The members, their devices, the invite links and the daemon's key are what they are with the file.
//   - Every list a member can ask for answers.
//   - Nothing a member sees names a topic, a session or a worktree that is not there, unless it also does so WITH the
//     file (the fixture holds no shared folder, so its worktrees are gone in every start: an ended session keeps the
//     root it ran in, a merged item keeps its worktree's id; those are what the product shows for "gone").
//   - What is lost is said exactly, per file (the assertions below; the host guide's table is made from them).
//
// A document passes or it does not, and its declaration says which (`canSetAside`, src/core/state-store.ts): the
// refusal of an unreadable document carries it to the command, which then names "move this one file" before, and in
// place of, the last resort. For the three documents that do NOT pass, the test holds the evidence: whoever makes the
// rest of the state handle their absence turns that evidence around and may then say `canSetAside: true`.
//
// The table for the command and the guide: W/X1/SET-ASIDE.md of the 0.5.1 work, docs/HOSTING.md §9.3.
import { chmod, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentDeclaration } from '../../src/core/state-store.ts';
import type { TestDaemon } from '../../src/testing/index.ts';
import { startOn } from './daemon-on.ts';
import { PUBLISHED_DIR, copyOf, readJson, type FixtureCopy } from './fixture.ts';
import { documentsOfThisSmurg } from './persisted.ts';

type Json = Record<string, unknown>;

/**
 * Every declared document other than state.json: may a host set it aside? PROVEN below, one test each. A document a
 * later smurg adds is not in this list and fails the first test: decide it here, with its proof.
 */
const CAN_BE_SET_ASIDE: Readonly<Record<string, boolean>> = {
  conflicts: true,
  worktrees: true,
  sessions: true,
  'host-rules': true,
  'claude-trust': true,
  'agent-sessions': false,
  cards: true,
  suggestions: true,
  topics: false,
  reports: false,
  inbox: true,
};

/**
 * The persisted files that are no document (DESIGN A10) and CAN refuse a start: the three logs (owner, mode and kind
 * are checked in phase 1) and a segment of a session's transcript (opened without following a link when the sessions
 * module starts). Per-session cards.json, role.md, an upload's manifest, journal and part and a conflict's bytes
 * never refuse a start, whatever is in their place (found by trying each as garbage, 0644, a link, a folder, gone).
 */
const OTHER_FILES = ['audit.jsonl', 'audit-text.jsonl', 'activity.jsonl', 'a transcript segment'] as const;

/** Said when the evidence against one of the three is gone. */
const HANDLED_NOW = 'THE REST OF THE STATE NOW HANDLES THIS DOCUMENT BEING MISSING? Then it can be set aside: prove it here like the others (what is lost, nothing points nowhere), say `canSetAside: true` in its declaration and CAN_BE_SET_ASIDE, and add its row to docs/HOSTING.md §9.3';

let running: TestDaemon | null = null;
const copies: FixtureCopy[] = [];

afterEach(async () => {
  await running?.cleanup().catch(() => {});
  running = null;
  for (const copy of copies.splice(0)) await copy.remove().catch(() => {});
});

const declared = (): readonly DocumentDeclaration[] => documentsOfThisSmurg().filter((document) => document.name !== 'state');

/** Who may come in and with what: the members with their roles and state, every device, every invite link, the key. */
function whoOf(t: TestDaemon): Json {
  const members = t.ctx.members.list({ includeKicked: true });
  // Every start makes the host's own link anew (a fresh id and time): the links are the ones the folder held.
  const held = new Set((t.daemon.internals.folder.loaded.get('state')?.value as { invites: { id: string }[] }).invites.map((invite) => invite.id));
  return {
    fingerprint: t.daemon.fingerprint,
    workspaceId: t.daemon.workspaceId,
    members: members.map((member) => `${member.userId} ${member.role} ${member.status}`),
    devices: members.flatMap((member) => t.daemon.internals.members.devicesOf(member.userId)).map((device) => `${device.deviceId} ${device.userId} ${device.kind} ${device.revoked ? 'revoked' : 'in use'}`).sort(),
    invites: t.ctx.invites.list().filter((invite) => held.has(invite.id)).map((invite) => `${invite.id} ${invite.role} ${invite.uses}/${invite.maxUses ?? '-'} ${invite.revoked ? 'revoked' : 'open'} ${invite.expiresAt ?? '-'}`).sort(),
    settings: t.ctx.settings.get(),
  };
}

interface View {
  readonly topics: Json[];
  readonly plans: Json[];
  readonly items: Json[];
  readonly reports: Json[];
  readonly sessions: Json[];
  /** Per session: its events, how many of them are cards, how many cards came with their content, how many were promised for later. */
  readonly histories: { readonly sessionId: string; readonly events: number; readonly cardEvents: number; readonly cards: number; readonly promised: number }[];
  readonly worktrees: Json[];
  readonly merges: Json[];
  readonly inbox: Json[];
  readonly conflicts: Json[];
  readonly suggestions: Json[];
  readonly hostRules: Json;
  readonly claudeConfig: Json;
  readonly audit: Json[];
  readonly activity: Json[];
  /** Every request that was answered with an error. */
  readonly errors: string[];
}

/** Everything the host's page can ask for, asked through a real connection of the host. */
async function viewOf(t: TestDaemon): Promise<View> {
  const host = await t.connectHost();
  const errors: string[] = [];
  const ask = async (type: string, payload: Json): Promise<Json> => {
    try {
      return await (host.conn.request as unknown as (type: string, payload: Json) => Promise<Json>)(type, payload);
    } catch (err) {
      errors.push(`${type} ${JSON.stringify(payload)}: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  };
  const list = async (type: string, payload: Json, key: string): Promise<Json[]> => ((await ask(type, payload))[key] as Json[] | undefined) ?? [];
  const topics = [...(await list('topic.list', {}, 'topics')), ...(await list('topic.list', { archived: true }, 'topics'))];
  const plans: Json[] = [];
  const reports: Json[] = [];
  for (const topic of topics) {
    const plan = (await ask('plan.get', { topicId: topic['id'] }))['plan'] as Json | null | undefined;
    if (plan === null || plan === undefined) continue;
    plans.push(plan);
    for (const item of plan['items'] as Json[]) {
      if (item['report'] === undefined) continue;
      const report = (await ask('report.get', { topicId: topic['id'], itemId: item['id'] }))['report'] as Json | undefined;
      if (report !== undefined) reports.push(report);
    }
  }
  const sessions = await list('session.list', {}, 'sessions');
  const histories: View['histories'][number][] = [];
  for (const session of sessions) {
    const history = await ask('session.history', { sessionId: session['id'], afterSeq: 0, limit: 50 });
    const events = (history['events'] as Json[] | undefined) ?? [];
    histories.push({
      sessionId: String(session['id']),
      events: events.length,
      cardEvents: events.filter((event) => event['kind'] === 'card').length,
      cards: ((history['questions'] as unknown[] | undefined) ?? []).length + ((history['permissions'] as unknown[] | undefined) ?? []).length,
      promised: ((history['moreCards'] as unknown[] | undefined) ?? []).length,
    });
  }
  const view: View = {
    topics,
    plans,
    items: plans.flatMap((plan) => plan['items'] as Json[]),
    reports,
    sessions,
    histories,
    worktrees: await list('worktree.list', {}, 'worktrees'),
    merges: await list('worktree.merge.list', {}, 'requests'),
    inbox: await list('inbox.list', {}, 'items'),
    conflicts: await list('doc.conflict.list', {}, 'conflicts'),
    suggestions: await list('suggest.list', {}, 'suggestions'),
    hostRules: await ask('admin.hostRules.get', {}),
    claudeConfig: await ask('admin.claudeConfig.get', {}),
    audit: await list('admin.audit.query', { limit: 200 }, 'entries'),
    activity: await list('activity.list', { limit: 200 }, 'events'),
    errors,
  };
  host.close();
  return view;
}

/** Every `<where>.<topicId|sessionId|worktreeId> = <id>` below `value`. */
function namedIn(value: unknown, path: string, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) namedIn(item, `${path}[]`, into);
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'topicId' || key === 'sessionId' || key === 'worktreeId') && typeof child === 'string') into.push(`${path}.${key} = ${child}`);
      else namedIn(child, `${path}.${key}`, into);
    }
  }
  return into;
}

/**
 * What a member sees that names a topic, a session or a worktree which is in no list: `<where> = <id>`. (Not the
 * audit log and the activity feed: they are history, and name what was removed long ago.)
 */
function pointsNowhere(view: View): string[] {
  const there: Readonly<Record<string, ReadonlySet<string>>> = {
    topicId: new Set(view.topics.map((topic) => String(topic['id']))),
    sessionId: new Set(view.sessions.map((session) => String(session['id']))),
    worktreeId: new Set(view.worktrees.map((worktree) => String(worktree['id']))),
  };
  const out: string[] = [];
  for (const part of ['topics', 'plans', 'reports', 'sessions', 'worktrees', 'merges', 'inbox', 'conflicts', 'suggestions'] as const) {
    for (const named of namedIn(view[part], part)) {
      const [where, id] = named.split(' = ') as [string, string];
      if (!(there[where.slice(where.lastIndexOf('.') + 1)] as ReadonlySet<string>).has(id)) out.push(named);
    }
  }
  return [...new Set(out)].sort();
}

interface Started {
  readonly t: TestDaemon;
  readonly who: Json;
  readonly view: View;
  readonly nowhere: string[];
}

/** The daemon on a copy of what 0.5.0 wrote, after `prepare` changed the workspace folder. */
async function startWith(prepare: (copy: FixtureCopy) => Promise<void>): Promise<Started & { readonly copy: FixtureCopy }> {
  const copy = await copyOf('0.5.0');
  copies.push(copy);
  await prepare(copy);
  const t = (running = await startOn(copy));
  const who = whoOf(t); // before anybody connected: a connection is a device and a last-seen time
  const view = await viewOf(t);
  return { copy, t, who, view, nowhere: pointsNowhere(view) };
}

/** What the command adds to the name of a file it tells the host to set aside (a date and a time). */
const ASIDE = '.set-aside-20261008-140507';

/**
 * Sets one file of the workspace folder aside as a host would: `mv <file> <file>.set-aside-<date>-<time>`, in the
 * SAME folder. smurg reads the names it knows and nothing else there, so the file stays beside the new one, for
 * whoever wants to look into it later.
 */
async function setAside(copy: FixtureCopy, name: string): Promise<void> {
  await rename(join(copy.workspaceDir, name), join(copy.workspaceDir, `${name}${ASIDE}`));
}

const keysOf = (items: readonly Json[]): string[] => items.map((item) => String(item['key'])).sort();
const idsOf = (items: readonly Json[]): string[] => items.map((item) => String(item['id'])).sort();

describe('one file of the workspace folder set aside: what smurg 0.5.0 wrote, started without it', { timeout: 120_000 }, () => {
  /** The same folder with nothing moved: what "as it was" means below. */
  let whole: Omit<Started, 't'>;

  beforeAll(async () => {
    const started = await startWith(async () => {});
    whole = { who: started.who, view: started.view, nowhere: started.nowhere };
    await running?.cleanup();
    running = null;
    await started.copy.remove();
    copies.length = 0;
  }, 120_000);
  it('every declared document says whether it can be set aside, and state.json never can', () => {
    expect(Object.fromEntries(declared().map((document) => [document.name, document.canSetAside === true])), 'A DOCUMENT WAS ADDED OR ITS ANSWER CHANGED: prove it in this file (start without it; what is lost; nothing points nowhere), then say so in its declaration and in docs/HOSTING.md §9.3').toEqual(CAN_BE_SET_ASIDE);
    expect(documentsOfThisSmurg().find((document) => document.name === 'state')?.canSetAside).toBeUndefined();
  });

  it('the fixture is full: with every file in place the host sees topics, sessions, merge requests, conflicts, suggestions, an inbox, and every request answers', () => {
    expect(whole.view.errors).toEqual([]);
    for (const part of ['topics', 'plans', 'reports', 'sessions', 'merges', 'inbox', 'conflicts', 'suggestions', 'audit', 'activity'] as const) expect(whole.view[part].length, part).toBeGreaterThan(0);
    expect((whole.who['members'] as string[]).length).toBeGreaterThan(5);
    expect((whole.who['invites'] as string[]).length).toBeGreaterThan(5);
  });

  describe.each(declared().map((document) => document.name))('%s.json', (name) => {
    const sound = CAN_BE_SET_ASIDE[name] === true;

    it(`moved away: the daemon starts; the members, devices, invite links, settings and key are as they were; a new ${name}.json is made; every request answers${sound ? '; nothing a member sees points at something that is gone' : ''}`, async () => {
      const { copy, t, who, view, nowhere } = await startWith((made) => setAside(made, `${name}.json`));
      expect(who).toEqual(whole.who);
      expect(t.daemon.upgraded).toEqual([]);
      expect(view.errors).toEqual([]);
      // The document is there again, made from its `init` (and passes today's schema).
      const document = declared().find((candidate) => candidate.name === name) as DocumentDeclaration;
      expect(document.schema.safeParse(await readJson(join(copy.workspaceDir, `${name}.json`))).success).toBe(true);
      // ... and the file that was set aside lies beside it, untouched.
      expect((await readFile(join(copy.workspaceDir, `${name}.json${ASIDE}`))).equals(await readFile(join(PUBLISHED_DIR, '0.5.0', 'stopped', 'host', 'workspaces', copy.workspaceId, `${name}.json`)))).toBe(true);
      // (For the three that cannot be set aside, what a start without them leaves is in their own tests below.)
      if (sound) expect(nowhere.filter((named) => !whole.nowhere.includes(named)), 'what a member sees and names something that is not there (and did not without the file moved)').toEqual([]);
    });
  });

  // ---- what exactly is lost, document by document (the guide's table says this, and nothing more) ----

  it('conflicts.json: the kept conflicts are no longer listed (the bytes of the agents\' versions stay in conflicts/, unused); nothing else changes', async () => {
    const { copy, view } = await startWith((made) => setAside(made, 'conflicts.json'));
    expect(whole.view.conflicts.length).toBeGreaterThan(0);
    expect(view.conflicts).toEqual([]);
    expect((await readdir(join(copy.workspaceDir, 'conflicts'))).length).toBeGreaterThan(0);
    expect(idsOf(view.topics)).toEqual(idsOf(whole.view.topics));
    expect(idsOf(view.sessions)).toEqual(idsOf(whole.view.sessions));
    expect(keysOf(view.inbox)).toEqual(keysOf(whole.view.inbox));
  });

  it('worktrees.json: no worktree is known and no merge request is left; every worktree root is unregistered (the folders stay on disk); no work item still points at a request that waits', async () => {
    const { copy, t, view } = await startWith(async (made) => {
      // One item whose merge a member had asked for (the fixture's items point at drafts, a conflict and merged ones).
      const path = join(made.workspaceDir, 'topics.json');
      const topics = await readJson<{ topics: { items: { merge?: { status: string; ready: boolean } }[] }[] }>(path);
      const waiting = topics.topics.flatMap((topic) => topic.items).find((item) => item.merge?.status === 'draft');
      if (waiting?.merge === undefined) throw new Error('the fixture has no item with a draft request');
      waiting.merge.status = 'pending';
      waiting.merge.ready = false;
      await writeFile(path, `${JSON.stringify(topics, null, 2)}\n`, { mode: 0o600 });
      await setAside(made, 'worktrees.json');
    });
    expect(whole.view.merges.length).toBeGreaterThan(0);
    expect(view.merges).toEqual([]);
    expect(view.worktrees).toEqual([]);
    // state.json named 22 roots; a root without a record is unregistered, in memory and in the file.
    expect((t.daemon.internals.folder.loaded.get('state')?.value as { worktreeRoots: unknown[] }).worktreeRoots.length).toBeGreaterThan(5);
    expect(t.ctx.roots.list().map((root) => root.key)).toEqual(['main']);
    await t.daemon.internals.store.flush();
    expect((await readJson<{ worktreeRoots: unknown[] }>(join(copy.workspaceDir, 'state.json'))).worktreeRoots).toEqual([]);
    // A request that was decided is history (the item keeps saying "merged"); one that still waited is gone, and the
    // item no longer says that it waits.
    const pointers = view.items.map((item) => (item['merge'] as { status: string } | undefined)?.status).filter((status) => status !== undefined);
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers.filter((status) => status !== 'merged' && status !== 'rejected')).toEqual([]);
    // The inbox no longer asks anybody to look at a merge request.
    expect(keysOf(whole.view.inbox).some((key) => key.startsWith('merge:'))).toBe(true);
    expect(keysOf(view.inbox).filter((key) => key.startsWith('merge:'))).toEqual([]);
    expect(idsOf(view.topics)).toEqual(idsOf(whole.view.topics));
    expect(idsOf(view.sessions)).toEqual(idsOf(whole.view.sessions));
  });

  it('sessions.json: nothing a member sees changes (it holds which terminals ran when smurg last wrote it: after a hard stop their processes are then not ended by the next start)', async () => {
    const { copy, view } = await startWith((made) => setAside(made, 'sessions.json'));
    expect(await readJson(join(copy.workspaceDir, 'sessions.json'))).toEqual({ live: [] });
    for (const part of ['topics', 'sessions', 'merges', 'conflicts', 'suggestions'] as const) expect(idsOf(view[part]), part).toEqual(idsOf(whole.view[part]));
    expect(keysOf(view.inbox)).toEqual(keysOf(whole.view.inbox));
  });

  it('host-rules.json: the list of the host\'s own Claude Code allow rules is empty until an agent session starts again, and the host is told about them once more', async () => {
    const { view } = await startWith((made) => setAside(made, 'host-rules.json'));
    expect((whole.view.hostRules['rules'] as unknown[]).length).toBeGreaterThan(0);
    expect(view.hostRules).toEqual({ rules: [], seen: true });
    expect(keysOf(whole.view.inbox)).toContain('attention:host-rules:workspace');
    expect(keysOf(view.inbox)).toEqual(keysOf(whole.view.inbox).filter((key) => key !== 'attention:host-rules:workspace'));
  });

  it('claude-trust.json: no decision about a project\'s Claude Code settings is in force (the closed side: sessions start without them until the host confirms again)', async () => {
    const { copy, view } = await startWith((made) => setAside(made, 'claude-trust.json'));
    expect(await readJson(join(copy.workspaceDir, 'claude-trust.json'))).toEqual({ decisions: [], loaded: { trusted: [], ignored: [] } });
    for (const part of ['topics', 'sessions', 'merges', 'conflicts', 'suggestions'] as const) expect(idsOf(view[part]), part).toEqual(idsOf(whole.view[part]));
  });

  it('cards.json: the questions and permission requests of the conversations so far are no longer shown (the place of each stays in the conversation, as a card that is no longer kept)', async () => {
    const { view } = await startWith((made) => setAside(made, 'cards.json'));
    const sum = (histories: View['histories'], key: 'events' | 'cardEvents' | 'cards' | 'promised'): number => histories.reduce((total, history) => total + history[key], 0);
    expect(sum(whole.view.histories, 'cards')).toBeGreaterThan(0);
    // No content, and none promised for later: the answer is complete, the card is simply not kept.
    expect(sum(view.histories, 'cards')).toBe(0);
    expect(sum(view.histories, 'promised')).toBe(0);
    expect(sum(view.histories, 'cardEvents')).toBe(sum(whole.view.histories, 'cardEvents'));
    expect(sum(view.histories, 'events')).toBe(sum(whole.view.histories, 'events'));
    expect(idsOf(view.sessions)).toEqual(idsOf(whole.view.sessions));
  });

  it('suggestions.json: every suggestion is gone, the waiting ones too, and the inbox no longer names one', async () => {
    const { view } = await startWith((made) => setAside(made, 'suggestions.json'));
    expect(whole.view.suggestions.length).toBeGreaterThan(0);
    expect(view.suggestions).toEqual([]);
    expect(keysOf(whole.view.inbox).some((key) => key.startsWith('suggestion:'))).toBe(true);
    expect(keysOf(view.inbox)).toEqual(keysOf(whole.view.inbox).filter((key) => !key.startsWith('suggestion:')));
  });

  it('inbox.json: what each member had read or dismissed and the mentions kept for them are gone; everything the inbox is made of is listed again', async () => {
    const { copy, view } = await startWith((made) => setAside(made, 'inbox.json'));
    const before = await readJson<{ members: Record<string, { notes: unknown[] }> }>(join(copy.workspaceDir, `inbox.json${ASIDE}`));
    expect(Object.values(before.members).some((member) => member.notes.length > 0)).toBe(true);
    const after = await readJson<{ members: Record<string, { notes?: unknown[] }> }>(join(copy.workspaceDir, 'inbox.json'));
    expect(Object.values(after.members).flatMap((member) => member.notes ?? [])).toEqual([]);
    expect(keysOf(view.inbox)).toEqual(keysOf(whole.view.inbox));
  });

  // ---- the three that cannot: what a start without them leaves (the evidence) ----

  it('agent-sessions.json CANNOT: no agent session is left, and every topic still says its discussion is live and names a session that is not there', async () => {
    const { view } = await startWith((made) => setAside(made, 'agent-sessions.json'));
    expect(view.sessions).toEqual([]);
    const live = view.topics.filter((topic) => topic['discussion'] === 'live' && topic['discussionSessionId'] !== undefined);
    expect(live.length, HANDLED_NOW).toBeGreaterThan(0);
    expect(view.items.filter((item) => item['sessionId'] !== undefined).length).toBeGreaterThan(0);
  });

  it('topics.json CANNOT: no topic is left, and their discussion sessions stay in the list, not ended, naming a topic that is not there', async () => {
    const { view } = await startWith((made) => setAside(made, 'topics.json'));
    expect(view.topics).toEqual([]);
    const orphans = view.sessions.filter((session) => session['purpose'] === 'discussion' && session['status'] !== 'ended' && session['topicId'] !== undefined);
    expect(orphans.length, HANDLED_NOW).toBeGreaterThan(0);
    // (An item's session that no item names IS ended by the start: that half is handled.)
    expect(view.sessions.filter((session) => session['purpose'] === 'item' && session['status'] !== 'ended')).toEqual([]);
  });

  it('reports.json CANNOT: the items still say that they are done or reviewed, and none has a report', async () => {
    const { view } = await startWith((made) => setAside(made, 'reports.json'));
    const finished = view.items.filter((item) => item['state'] === 'done' || item['state'] === 'reviewed');
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.filter((item) => item['report'] === undefined).length, HANDLED_NOW).toBe(finished.length);
    expect(whole.view.items.filter((item) => (item['state'] === 'done' || item['state'] === 'reviewed') && item['report'] !== undefined).length).toBe(finished.length);
  });

  // ---- the other persisted files that can refuse a start ----

  describe.each(OTHER_FILES)('%s', (which) => {
    it('moved away: the daemon starts; the members, devices, invite links, settings and key are as they were; every request answers; nothing new points nowhere', async () => {
      const { who, view, nowhere } = await startWith(async (made) => {
        if (which !== 'a transcript segment') return setAside(made, which);
        const sessions = (await readdir(join(made.workspaceDir, 'transcripts'))).sort();
        await setAside(made, join('transcripts', sessions[0] as string, 'events-000001.jsonl'));
      });
      expect(who).toEqual(whole.who);
      expect(view.errors).toEqual([]);
      expect(nowhere.filter((named) => !whole.nowhere.includes(named))).toEqual([]);
      for (const part of ['topics', 'sessions', 'merges', 'conflicts', 'suggestions'] as const) expect(idsOf(view[part]), part).toEqual(idsOf(whole.view[part]));
      // What is lost: the history that file held, and nothing else.
      if (which === 'audit.jsonl') expect(view.audit.length).toBeLessThan(whole.view.audit.length);
      else expect(view.audit.length).toBe(whole.view.audit.length);
      if (which === 'activity.jsonl') expect(view.activity).toEqual([]);
      else expect(view.activity.length).toBe(whole.view.activity.length);
      const events = (histories: View['histories']): number => histories.reduce((total, history) => total + history.events, 0);
      if (which === 'a transcript segment') expect(events(view.histories)).toBeLessThan(events(whole.view.histories));
      else expect(events(view.histories)).toBe(events(whole.view.histories));
    });
  });
});

describe('what the refusal of a file says about setting it aside (the contract with the command)', { timeout: 120_000 }, () => {
  async function refusalWith(damage: (copy: FixtureCopy) => Promise<void>): Promise<Json> {
    const copy = await copyOf('0.5.0');
    copies.push(copy);
    await damage(copy);
    try {
      running = await startOn(copy);
    } catch (err) {
      return err as Json;
    }
    throw new Error('the daemon STARTED on a folder it must refuse');
  }

  it.each(declared().map((document) => document.name))('%s.json cut off: `unreadable`, the document\'s name, and whether this one file can be set aside', async (name) => {
    const refusal = await refusalWith((copy) => writeFile(join(copy.workspaceDir, `${name}.json`), '{"cut', { mode: 0o600 }));
    expect(refusal).toMatchObject({ name: 'StateFileError', kind: 'unreadable', reason: 'not-json', phase: 1, document: name, canSetAside: CAN_BE_SET_ASIDE[name] });
  });

  it('state.json and the key can never be set aside, whatever is wrong with them', async () => {
    expect(await refusalWith((copy) => writeFile(join(copy.workspaceDir, 'state.json'), '{"cut', { mode: 0o600 }))).toMatchObject({ kind: 'unreadable', reason: 'not-json', document: 'state', canSetAside: false });
    expect(await refusalWith((copy) => setAside(copy, 'state.json'))).toMatchObject({ kind: 'unreadable', reason: 'missing', document: 'state', canSetAside: false });
    const key = await refusalWith((copy) => writeFile(join(copy.workspaceDir, 'identity.key'), 'short', { mode: 0o600 }));
    expect(key).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape', canSetAside: false });
    expect(key['document']).toBeUndefined();
  });

  it('only an UNREADABLE document: one that is open to others is cured by a chmod, one of a newer smurg by an update, and a log is no document', async () => {
    const mode = await refusalWith((copy) => chmod(join(copy.workspaceDir, 'inbox.json'), 0o644));
    expect(mode).toMatchObject({ kind: 'insecure', cause: 'mode', document: 'inbox', canSetAside: false });
    const newer = await refusalWith(async (copy) => {
      const path = join(copy.workspaceDir, 'inbox.json');
      await writeFile(path, `${JSON.stringify({ ...(JSON.parse(await readFile(path, 'utf8')) as Json), version: 2 })}\n`, { mode: 0o600 });
    });
    expect(newer).toMatchObject({ kind: 'newer', document: 'inbox', canSetAside: false });
    const log = await refusalWith((copy) => chmod(join(copy.workspaceDir, 'audit.jsonl'), 0o644));
    expect(log).toMatchObject({ kind: 'insecure', cause: 'mode', canSetAside: false });
    expect(log['document']).toBeUndefined();
  });
});

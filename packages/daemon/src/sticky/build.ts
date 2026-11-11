// "Build this" (DESIGN 0.8.0 D5): a topic made from a sticky note, whose spec is the note and the notes it links to
// directly, and whose plan is one work item. It starts nothing: the member presses Start in the topic's own Start
// dialog, whose checks and pins apply as to every topic (D5.3).
//
//   sticky.spec   the text that would become the spec, composed here from what the CALLER reads (each note decoded as
//                 `doc.open` decodes a file: LF, no byte order mark), and the SHA-256 of its UTF-8
//   sticky.build  composes again and refuses another hash; checks what can be checked before anything is made (the
//                 topic limit, the agent sessions' limit, a free slug, the plan it writes); then, as the caller: the
//                 topic (`topic.create` starts its discussion, which is kept, D5.5), the record of the build as soon
//                 as the topic exists, SPEC.md, PLAN.md, the audit entry. A step that fails after the topic exists
//                 leaves the topic as it is and names the step (D5.4).
//
// A note is read as the caller AND by the index's rules (no symlink at the end, a regular file of one link, directly
// in the real `notes/`), so the host's "Build this" never copies into a spec, which every member reads, a file a link
// leads to. A note the index lists as unreadable is unreadable here too; a note that cannot be read is refused by its
// name, never left out without a word.
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAIN_ROOT,
  NOTE_BUILDS_MAX,
  NOTE_INFO_BUILDS_MAX,
  NOTE_MAX_BYTES,
  SPECS_DIR,
  SPEC_FROM_NOTES_MAX_BYTES,
  SmurgError,
  TOPICS_MAX,
  TOPIC_SLUG_MAX_CHARS,
  can,
  foldNoteName,
  foldPathName,
  isSessionOver,
  notePath,
  slugFromName,
  topicPlanPath,
  topicSpecPath,
  wikiLinks,
  type NoteBuild,
  type PayloadOf,
  type ResultInputOf,
  type UserRef,
} from '@smurg/protocol';
import { msg, type BuildStep } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError, PathDeniedError } from '../core/errors.ts';
import type { PersistentDocument, Principal } from '../core/interfaces.ts';
import { SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { classifyText } from '../docs/text-codec.ts';
import { PLAN_MARKER_END, PLAN_MARKER_START, parsePlan } from '../topics/plan-format.ts';
import { PASSING_DENIALS, lookAtNotesFolder, type NoteIndex } from './index.ts';
import type { StickyDocument } from './store.ts';

/** A second build of a note gets `<slug>-2`, then `-3` … up to this; then `slug-unavailable` (D5.2). */
export const BUILD_SLUG_SUFFIX_MAX = 9;
/** The id of the one work item a build's PLAN.md holds. */
export const BUILD_ITEM_ID = 'build';

const KiB = 1024;
const encoder = new TextEncoder();

/** A note that goes into the spec: its name on disk and its text, or a linked one that is not written. */
export type SpecNote = { readonly name: string; readonly text: string } | { readonly name: string; readonly missing: true };

/**
 * PURE. The text "Build this" shows and writes as SPEC.md (D5.1): a first line naming the note's path as a JSON
 * string, the note's text, then each note it links to under a fixed heading with its path as a JSON string (one not
 * written yet says so), then the fixed last line. Fixed English around the people's text; a text's line breaks at its
 * end are left out, so that one blank line always parts the pieces.
 */
export function composeSpecFromNotes(note: { readonly name: string; readonly text: string }, linked: readonly SpecNote[]): string {
  const parts = [`Built from the sticky note ${JSON.stringify(notePath(note.name))}.`, bodyOf(note.text)];
  for (const other of linked) {
    parts.push(`## Linked sticky note ${JSON.stringify(notePath(other.name))}`);
    parts.push('missing' in other ? 'This sticky note is not written yet.' : bodyOf(other.text));
  }
  parts.push('Other sticky notes are not part of this spec.');
  return `${parts.join('\n\n')}\n`;
}

function bodyOf(text: string): string {
  if (text.trim() === '') return 'This sticky note is empty.';
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x0a) end -= 1;
  return text.slice(0, end);
}

/**
 * PURE. The PLAN.md of a build: one work item, id `build`, titled with the note's name (every valid name is a heading
 * title the plan format reads back exactly, plan-format.test.ts), in fixed English.
 */
export function buildPlanText(name: string): string {
  return [
    '# Plan',
    '',
    `One work item, made with "Build this" from the sticky note ${JSON.stringify(notePath(name))}.`,
    '',
    PLAN_MARKER_START,
    `### 1. ${name}`,
    `- id: ${BUILD_ITEM_ID}`,
    '',
    'Build what SPEC.md of this topic describes: the sticky note and the sticky notes it links to, as they were when the topic was made.',
    PLAN_MARKER_END,
    '',
  ].join('\n');
}

/**
 * PURE. The slug of a build's topic (D5.2): `slugFromName` of the name, or with `-2` … `-9` when that one is taken (a
 * suffix shortens the slug so that it stays within TOPIC_SLUG_MAX_CHARS); null when all are taken. `taken` holds
 * folded names (foldPathName): the stored slugs and every entry of `specs/`.
 */
export function freeSlug(name: string, taken: ReadonlySet<string>): string | null {
  const base = slugFromName(name, taken);
  if (!taken.has(foldPathName(base))) return base;
  for (let n = 2; n <= BUILD_SLUG_SUFFIX_MAX; n += 1) {
    const suffix = `-${n}`;
    let head = base.slice(0, TOPIC_SLUG_MAX_CHARS - suffix.length);
    while (head.endsWith('-')) head = head.slice(0, -1);
    const candidate = `${head}${suffix}`;
    if (!taken.has(foldPathName(candidate))) return candidate;
  }
  return null;
}

/** What reading one note as the caller gave. */
type NoteRead = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'missing' } | { readonly kind: 'oversized' } | { readonly kind: 'unreadable' };

/** The spec of a note as `sticky.spec` answers it. */
export type ComposedSpec = ResultInputOf<'sticky.spec'>;

export interface NoteBuilderDeps {
  readonly index: NoteIndex;
  readonly document: () => PersistentDocument<StickyDocument>;
  /** The sticky module's one-at-a-time queue (creates, starts of Claude, builds). */
  readonly serial: <T>(work: () => Promise<T>) => Promise<T>;
  /** The builds of `note` changed: tell every member the note's NoteInfo. */
  readonly buildsChanged: (note: string) => void;
}

export class NoteBuilder {
  private readonly ctx: DaemonContext;
  private readonly deps: NoteBuilderDeps;

  constructor(ctx: DaemonContext, deps: NoteBuilderDeps) {
    this.ctx = ctx;
    this.deps = deps;
  }

  /**
   * The topics made from the note `name` folds to that are there (open or archived), the newest first, at most
   * NOTE_INFO_BUILDS_MAX (D2.4). The record of a deleted topic stays but names nothing: the newest eight are eight
   * topics a member can open (D5.4, "the note shows the topic"), never records that hide older topics that are there.
   * `gone`: a topic being deleted right now (the bus tells of it before the topics module lets it go).
   */
  buildsOf(name: string, gone?: string): string[] {
    const key = foldNoteName(name);
    const topics = this.ctx.services.topics;
    const known = isStubService(topics) ? null : topics;
    const builds = this.deps.document().get().builds;
    const out: string[] = [];
    for (let at = builds.length - 1; at >= 0 && out.length < NOTE_INFO_BUILDS_MAX; at -= 1) {
      const build = builds[at] as NoteBuild;
      if (foldNoteName(build.note) !== key || build.topicId === gone) continue;
      if (known === null || known.get(build.topicId) !== null) out.push(build.topicId);
    }
    return out;
  }

  /** The note a topic was made from, as recorded (a name as it was built; the index finds it by its folded name). */
  noteOf(topicId: string): string | null {
    return this.deps.document().get().builds.find((build) => build.topicId === topicId)?.note ?? null;
  }

  /** `sticky.spec` (D5.1). */
  async spec(input: PayloadOf<'sticky.spec'>, principal: Principal): Promise<ComposedSpec> {
    return this.compose(input.note, principal);
  }

  /** `sticky.build` (D5.2): one at a time per workspace, so that two builds never pick the same slug. */
  async build(input: PayloadOf<'sticky.build'>, principal: Principal): Promise<ResultInputOf<'sticky.build'>> {
    return this.deps.serial(async () => {
      const by = this.memberWhoMayBuild(principal);
      if (this.ctx.stopping.aborted) throw new SmurgError('conflict', msg('daemon.stopping'), { reason: 'stopping' });
      const spec = await this.compose(input.note, principal);
      if (spec.hash !== input.hash) throw new SmurgError('conflict', msg('sticky.build.noteChanged'), { reason: 'note-changed' });
      const name = spec.notes[0] as string;
      const topics = this.ctx.services.topics;
      // Before anything is made: what topic.create and its discussion would refuse, the slug, the plan.
      const stored = this.allTopics();
      if (stored.length >= TOPICS_MAX) throw new SmurgError('conflict', msg('topic.limit', { max: TOPICS_MAX }), { reason: 'topic-limit' });
      const maxAgents = this.ctx.config.agents.maxAgentSessions;
      const agents = this.ctx.services.agents;
      const alive = isStubService(agents) ? 0 : agents.list().filter((session) => !isSessionOver(session)).length;
      if (alive >= maxAgents) throw new SmurgError('conflict', msg('session.limit.agents', { max: maxAgents }), { reason: 'agent-limit' });
      const taken = new Set<string>([...stored.map((topic) => foldPathName(topic.slug)), ...(await this.specsEntries()).map(foldPathName)]);
      const slug = freeSlug(name, taken);
      if (slug === null) throw new SmurgError('conflict', msg('sticky.build.slugUnavailable', { slug: slugFromName(name, taken) }), { reason: 'slug-unavailable' });
      const plan = buildPlanText(name);
      const parsed = parsePlan(plan);
      if (!parsed.ok || parsed.items.length !== 1 || parsed.items[0]?.id !== BUILD_ITEM_ID || parsed.items[0].title !== name) {
        throw new SmurgError('internal', undefined, { reason: 'plan-invalid' });
      }

      const { topic } = await topics.create({ name, slug }, principal);
      const detail = { note: name, topicId: topic.id, slug, specHash: spec.hash, notes: [...spec.notes] };
      const files = this.ctx.services.files;
      await this.step('record', principal, detail, async () => {
        this.deps.document().update((draft) => {
          draft.builds.push({ note: name, topicId: topic.id, by, at: this.ctx.clock.now(), hash: spec.hash });
          if (draft.builds.length > NOTE_BUILDS_MAX) draft.builds.splice(0, draft.builds.length - NOTE_BUILDS_MAX);
        });
        this.deps.buildsChanged(name);
        await this.deps
          .document()
          .flush()
          .catch((err: unknown) => this.ctx.log.error('sticky.json write failed', { module: 'sticky', error: err instanceof Error ? err.name : 'unknown' }));
      });
      await this.step('spec', principal, detail, () => files.write({ file: { root: MAIN_ROOT, path: topicSpecPath(slug) }, content: encoder.encode(spec.text) }, principal));
      await this.step('plan', principal, detail, () => files.write({ file: { root: MAIN_ROOT, path: topicPlanPath(slug) }, content: encoder.encode(plan) }, principal));
      this.ctx.audit.record({ actor: principal.actor, action: 'sticky.build', outcome: 'ok', target: topic.id, detail });
      return { topicId: topic.id };
    });
  }

  /** A step after the topic exists: a failure leaves the topic and says which step (D5.4), audited. */
  private async step(step: BuildStep, principal: Principal, detail: Readonly<Record<string, unknown>>, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (err) {
      const cause = err instanceof SmurgError ? (typeof err.detail?.['reason'] === 'string' ? err.detail['reason'] : err.code) : 'internal';
      this.ctx.audit.record({ actor: principal.actor, action: 'sticky.build', outcome: 'error', target: String(detail['topicId']), detail: { ...detail, step, reason: cause } });
      const code = err instanceof SmurgError ? err.code : 'internal';
      throw new SmurgError(code, msg('sticky.build.failedAt', { step }), { reason: 'failed-at', step, topicId: String(detail['topicId']), cause }, { cause: err });
    }
  }

  /**
   * The caller as a member who may start sessions NOW: this build may have waited its turn behind a create, a start or
   * another build, and a member removed or demoted meanwhile makes nothing (the router checked the role on arrival).
   */
  private memberWhoMayBuild(principal: Principal): UserRef {
    const member = principal.kind === 'user' && principal.userId !== null ? this.ctx.members.active(principal.userId) : null;
    if (member === null) throw new AuthorizationError(undefined, { reason: 'not-a-member' });
    if (!can(member.role, 'session.create')) throw new AuthorizationError(undefined, { reason: 'capability' });
    return { userId: member.userId, displayName: member.displayName };
  }

  /** Every stored topic, archived ones too (the topic limit counts them, and their folders keep their slugs). */
  private allTopics(): { readonly slug: string }[] {
    const topics = this.ctx.services.topics;
    if (isStubService(topics)) return [];
    const out: { readonly slug: string }[] = [];
    for (const archived of [false, true]) {
      let after: string | undefined;
      for (;;) {
        const page = topics.list({ archived, ...(after === undefined ? {} : { after }) });
        out.push(...page.topics);
        const last = page.topics.at(-1);
        if (!page.hasMore || last === undefined) break;
        after = last.id;
      }
    }
    return out;
  }

  /** The names in `specs/` of the main workspace (a folder there keeps its name even after its topic was deleted). */
  private async specsEntries(): Promise<string[]> {
    const resolved = await this.ctx.paths.resolve({ root: MAIN_ROOT, path: SPECS_DIR }, { principal: SYSTEM_PRINCIPAL, finalSymlink: 'self', audit: false });
    if (!resolved.exists || resolved.identity?.kind !== 'dir') return [];
    return readdir(resolved.realPath);
  }

  /** The spec of `note` as the caller reads it (D5.1). */
  private async compose(requested: string, principal: Principal): Promise<ComposedSpec> {
    const info = this.deps.index.find(requested);
    if (info === null) throw missingNote(requested);
    const folder = await lookAtNotesFolder(this.ctx);
    if (folder.kind !== 'real') throw missingNote(requested);
    const main = await this.readAs(folder.realPath, info.name, principal);
    if (main.kind === 'missing') throw missingNote(info.name);
    const text = this.textOf(info.name, main);
    const key = foldNoteName(info.name);
    const linked: SpecNote[] = [];
    const notes = [info.name];
    for (const link of wikiLinks(text)) {
      // Each linked note by its name on disk (D1.3); a link back to the note itself is the note.
      const onDisk = this.deps.index.find(link)?.name ?? link;
      if (foldNoteName(onDisk) === key) continue;
      const read = await this.readAs(folder.realPath, onDisk, principal);
      if (read.kind === 'missing') {
        linked.push({ name: link, missing: true });
        continue;
      }
      linked.push({ name: onDisk, text: this.textOf(onDisk, read) });
      notes.push(onDisk);
    }
    const composed = composeSpecFromNotes({ name: info.name, text }, linked);
    const bytes = encoder.encode(composed);
    if (bytes.byteLength > SPEC_FROM_NOTES_MAX_BYTES) throw new SmurgError('too_large', msg('sticky.spec.tooLarge', { maxKiB: SPEC_FROM_NOTES_MAX_BYTES / KiB }), { reason: 'spec-too-large' });
    return { text: composed, hash: createHash('sha256').update(bytes).digest('hex'), notes };
  }

  private textOf(name: string, read: NoteRead): string {
    if (read.kind === 'text') return read.text;
    if (read.kind === 'oversized') throw new SmurgError('too_large', msg('sticky.spec.oversized', { name, maxKiB: NOTE_MAX_BYTES / KiB }), { reason: 'note-oversized', note: name });
    throw new SmurgError('conflict', msg('sticky.spec.unreadable', { name }), { reason: 'note-unreadable', note: name });
  }

  /**
   * One note as the caller reads it, by the index's rules (index.ts readNote): PathGuard for the caller, no symlink at
   * the end, a regular file of one link whose real path is `<real notes>/<name>.md`, at most NOTE_MAX_BYTES, decoded as
   * `doc.open` decodes (classifyText: UTF-8, no NUL, the byte order mark dropped, LF). A failure that passes (an I/O
   * error, the file replaced while it was read) is thrown: the caller asks again.
   */
  private async readAs(folder: string, name: string, principal: Principal): Promise<NoteRead> {
    const options = { principal, finalSymlink: 'deny' as const, audit: false, mustExist: true };
    try {
      const resolved = await this.ctx.paths.resolve({ root: MAIN_ROOT, path: notePath(name) }, options);
      const identity = resolved.identity;
      if (identity === null || identity.kind !== 'file' || identity.nlink !== 1) return { kind: 'unreadable' };
      if (resolved.parentRealPath !== folder || resolved.realPath !== join(folder, `${name}.md`)) return { kind: 'unreadable' };
      if (identity.size > NOTE_MAX_BYTES) return { kind: 'oversized' };
      const file = await this.ctx.paths.openRead(resolved, options);
      try {
        if (file.identity.nlink !== 1) return { kind: 'unreadable' };
        const buffer = Buffer.alloc(NOTE_MAX_BYTES + 1);
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await file.handle.read(buffer, filled, buffer.length - filled, filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        const decoded = classifyText(new Uint8Array(buffer.buffer, buffer.byteOffset, filled), NOTE_MAX_BYTES);
        if (decoded.ok) return { kind: 'text', text: decoded.text };
        return decoded.reason === 'too-large' ? { kind: 'oversized' } : { kind: 'unreadable' };
      } finally {
        await file.close();
      }
    } catch (err) {
      if (err instanceof PathDeniedError) {
        if (PASSING_DENIALS.has(err.reason)) throw err;
        return { kind: 'unreadable' };
      }
      if (err instanceof SmurgError && err.code === 'not_found') return { kind: 'missing' };
      if (err instanceof SmurgError && err.code === 'bad_request' && err.detail?.['reason'] === 'not-a-file') return { kind: 'unreadable' };
      throw err;
    }
  }
}

function missingNote(name: string): SmurgError {
  return new SmurgError('not_found', msg('sticky.note.missing', { name }), { reason: 'unknown-note' });
}

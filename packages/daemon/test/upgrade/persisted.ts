// TEST ONLY. Everything smurg PERSISTS, by kind: where a file of the kind lies, how it is read into instances, and
// the schema an instance must pass. The store documents (DESIGN A1) and the other persisted things under a workspace
// that are not store documents (A10: per-session cards, upload manifests with their journals and parts, transcript
// segments, the lines of the audit and activity logs), and the command's own two files.
//
// And the two files 0.5.1 added beside the documents (DESIGN A5, A9): the stamp `written-by.json`, and the kept copy
// `<name>.json.before-upgrade-from-<step>[-n]` a step leaves of the file it upgraded (one kind per step: the file as
// the step found it has the frozen shape that step reads).
//
// The kinds carry the names the fixtures' coverage.json gives them (test/fixtures/published/<version>/coverage.json).
// Used by the coverage test of the fixtures and by the pin.
import { totalmem } from 'node:os';
import { activityEventSchema, auditEntrySchema, conversationEventSchema } from '@smurg/protocol';
import { z } from 'zod';
import { cardsFileSchema } from '../../src/conversation/cards-store.ts';
import { defaultHostSettings } from '../../src/core/config.ts';
import { compareVersionNames, workspaceStampSchema, type DocumentDeclaration } from '../../src/core/state-store.ts';
import { declaredDocuments } from '../../src/daemon.ts';
import { manifestSchema } from '../../src/files/upload-store.ts';
import type { PublishedVersion } from './fixture.ts';

type Schema = z.ZodType;

/**
 * The `since` of a kind no published smurg writes yet: the kept copy of a step that a version being built adds (0.7.0's
 * shapes 3, DESIGN 0.7.0 D4). When that version is published and its fixture made, FIRST_OF_SHAPES names it
 * (docs/RELEASING.md §4.5), as `2: '0.6.0'` does since 0.6.0's fixture is in the tree.
 */
export const NOT_PUBLISHED = 'not published yet';

/** Every document a daemon of the release declares, in module order (the core's `state` first). */
export function documentsOfThisSmurg(): readonly DocumentDeclaration[] {
  return declaredDocuments({ workspaceId: 'ws_persisted', defaultSettings: defaultHostSettings(totalmem()) });
}

/**
 * The first smurg that writes TODAY's shape of each document with a step (DESIGN 0.6.0 D6): from that version on a
 * file of the document is today's schema; before it, the shape of one of its steps. A document that gains a step in a
 * release is named here with that release's version in the same change (`agent-sessions`: 0.6.0; `state`: 0.7.0,
 * DESIGN 0.7.0 D4: what 0.6.0 wrote is the frozen shape of the step from 0.6.0).
 */
const TODAY_SINCE: Readonly<Record<string, string>> = { state: '0.7.0', 'agent-sessions': '0.6.0', suggestions: '0.5.0' };

/**
 * The shape a file of `document` has when smurg `version` wrote it. A step's shape covers the versions from its `from`
 * up to (not including) the next step's `from`; the last step's up to (not including) the document's TODAY_SINCE; a
 * version at or after that writes today's schema. A version before the first step wrote the first step's shape (the
 * document did not exist then, or had that shape). A document without steps is today's schema for every version.
 * `frozen`: the answer is a frozen shape, not today's schema. (The rule before 0.6.0 took the first step whose `from`
 * is at or after the version: with the steps from 0.4.0 and 0.5.0 it gave 0.5.1 and 0.5.2 today's schema, which
 * neither wrote.)
 */
export function shapeWrittenBy(document: DocumentDeclaration, version: string): { readonly schema: Schema; readonly frozen: boolean } {
  const steps = document.steps ?? [];
  if (steps.length === 0) return { schema: document.schema, frozen: false };
  const since = TODAY_SINCE[document.name];
  if (since === undefined) throw new Error(`${document.name}.json has steps: say in test/upgrade/persisted.ts (TODAY_SINCE) since which smurg it is written in today's shape`);
  if (compareVersionNames(version, since) >= 0) return { schema: document.schema, frozen: false };
  // The newest step whose `from` is at or before the version; before the first step, the first.
  let step = steps[0] as (typeof steps)[number];
  for (const candidate of steps) if (compareVersionNames(candidate.from, version) <= 0) step = candidate;
  return { schema: step.shape, frozen: true };
}

// ---- Shapes the code reads field by field (no schema in the tree): written here after the reader's own rules.
/** `~/.smurg/workspaces.json` (packages/cli/src/state/workspaces.ts loadWorkspaces). 0.4.0's command knew no `web`. */
const cliWorkspaces = (version: string): Schema =>
  z.strictObject({
    version: z.literal(1),
    shared: z.array(z.strictObject({ folder: z.string().min(1).max(4096), relay: z.string().min(1).max(2048), workspaceId: z.string().min(1).max(64), createdAt: z.number() })),
    joined: z.array(
      z.strictObject({ workspaceId: z.string().min(1).max(64), relay: z.string().min(1).max(2048), name: z.string().max(256).nullable(), joinedAt: z.number(), ...(compareVersionNames(version, '0.5.0') >= 0 ? { web: z.string().max(2048).optional() } : {}) }),
    ),
  });
/** `~/.smurg/credentials.json` (packages/cli/src/state/credentials.ts loadCredentials). */
const cliCredentials = z.strictObject({
  version: z.literal(1),
  defaultRelay: z.string().nullable(),
  relays: z.record(z.string(), z.strictObject({ token: z.string().regex(/^[A-Za-z0-9._-]+$/), userId: z.string().max(256), displayName: z.string().max(256), provider: z.string().max(32), savedAt: z.number(), expiresAt: z.number() })),
});
/** One line of audit-text.jsonl (src/core/audit-text.ts writes it and reads `text` back by its hash). */
const auditTextLine = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), at: z.number(), text: z.string() });
/** One line of an upload's journal (src/files/upload-store.ts JOURNAL_LINE). */
export const UPLOAD_JOURNAL_LINE = /^(\d{1,15}) ([0-9a-f]{64})$/;

const json = (bytes: Buffer): unknown[] => [JSON.parse(bytes.toString('utf8'))];
const lines = (bytes: Buffer): unknown[] =>
  bytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
/** A transcript segment: the reader takes `v` off and parses the rest strictly (src/sessions/agent/transcript.ts parseLine). */
const transcriptLines = (bytes: Buffer): unknown[] =>
  lines(bytes).map((line) => {
    const { v, ...event } = line as Record<string, unknown>;
    if (v !== 1) throw new Error('a transcript line whose v is not 1');
    return event;
  });
const key32 = (bytes: Buffer): string[] => (bytes.length === 32 ? [] : [`${bytes.length} bytes, expected 32`]);

export interface PersistedKind {
  /** The kind's name in coverage.json. */
  readonly kind: string;
  /**
   * Where a file of the kind lies: below a `~/.smurg` (`home`: the host's and a command member's), or below the
   * folder of one device of a member who joined with the client library (`device`: the command's key files).
   */
  readonly pattern: RegExp;
  readonly homes: readonly ('host' | 'member' | 'device')[];
  /**
   * The first published smurg that writes the kind, or NOT_PUBLISHED: no published smurg writes it yet (the kept
   * copy of a step that the version being built adds); no fixture may hold one.
   */
  readonly since: PublishedVersion | typeof NOT_PUBLISHED;
  /** For a kind whose instances have a schema in the code: the name of its pinned shape (test/upgrade/shapes/<name>.txt). */
  readonly pin?: string;
  /** The schema of an instance as smurg `version` wrote it, or null: bytes or text that no schema describes. */
  schema(version: string): { readonly schema: Schema; readonly frozen: boolean; readonly described?: true } | null;
  /** The instances a file holds (a document: one; a log: one per line). Kinds without a schema: the file itself. */
  read(bytes: Buffer): unknown[];
  /** For kinds without a schema: what is wrong with the bytes. */
  problems?(bytes: Buffer): string[];
}

const WS = 'workspaces/[^/]+/';
const noSchema = (): null => null;
const today = (schema: Schema) => (): { schema: Schema; frozen: boolean } => ({ schema, frozen: false });
const whole = (bytes: Buffer): unknown[] => [bytes];
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The first published smurg of each `shapes` number (WORKSPACE_SHAPES): the first that has a step of that number, and
 * so the first that can leave its kept copy. A step of a number no published smurg has yet needs its line here when
 * that smurg is published (until then its kept copies are of no published version).
 */
const FIRST_OF_SHAPES: Readonly<Record<number, PublishedVersion | typeof NOT_PUBLISHED>> = { 1: '0.5.1', 2: '0.6.0', 3: NOT_PUBLISHED };
const firstOfShapes = (shapes: number, what: string): PublishedVersion | typeof NOT_PUBLISHED => {
  const version = FIRST_OF_SHAPES[shapes];
  if (version === undefined) throw new Error(`no published smurg has shapes ${shapes} yet: say in test/upgrade/persisted.ts (FIRST_OF_SHAPES) since when ${what} is written`);
  return version;
};

/** Every kind of file smurg persists. The order is the one of coverage.json. */
export function persistedKinds(): PersistedKind[] {
  const documents: PersistedKind[] = [...documentsOfThisSmurg()]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((document) => ({
      kind: `${document.name}.json`,
      pattern: new RegExp(`^${WS}${document.name}\\.json$`),
      homes: ['host'] as const,
      since: DOCUMENT_SINCE[document.name] ?? '0.5.0',
      pin: `${document.name}.json`,
      schema: (version: string) => shapeWrittenBy(document, version),
      read: json,
    }));
  // A kept copy of each step: the file as that step found it, so of the frozen shape the step reads (`-2` … `-99`: a
  // further copy of the same step, src/core/state-store.ts keptCopyPath). No pin of its own: the frozen shape is the
  // step's, pinned as a frozen file.
  const keptCopies: PersistedKind[] = [...documentsOfThisSmurg()]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((document) =>
      (document.steps ?? []).map((step) => ({
        kind: `${document.name}.json.before-upgrade-from-${step.from}[-n] (a kept copy: ${document.name}.json as the step from ${step.from} found it)`,
        pattern: new RegExp(`^${WS}${escape(document.name)}\\.json\\.before-upgrade-from-${escape(step.from)}(-([2-9]|[1-9][0-9]))?$`),
        homes: ['host'] as const,
        since: firstOfShapes(step.sinceShapes, `the kept copy of the step from ${step.from} of ${document.name}.json`),
        schema: () => ({ schema: step.shape, frozen: true }),
        read: json,
      })),
    );
  return [
    ...documents,
    { kind: 'written-by.json (the stamp)', pattern: new RegExp(`^${WS}written-by\\.json$`), homes: ['host'], since: '0.5.1', pin: 'written-by.json', schema: today(workspaceStampSchema), read: json },
    ...keptCopies,
    { kind: 'transcripts/<hex of the session id>/cards.json', pattern: new RegExp(`^${WS}transcripts/[0-9a-f]+/cards\\.json$`), homes: ['host'], since: '0.5.0', pin: 'transcripts.cards.json', schema: today(cardsFileSchema), read: json },
    { kind: 'transcripts/<hex of the session id>/events-<6 digits>.jsonl (one line = { v: 1, …event })', pattern: new RegExp(`^${WS}transcripts/[0-9a-f]+/events-\\d{6}\\.jsonl$`), homes: ['host'], since: '0.5.0', pin: 'transcripts.events.line', schema: today(conversationEventSchema), read: transcriptLines },
    { kind: 'uploads/<upload id>.json', pattern: new RegExp(`^${WS}uploads/up_[A-Za-z0-9_-]{22}\\.json$`), homes: ['host'], since: '0.4.0', pin: 'uploads.manifest.json', schema: today(manifestSchema), read: json },
    {
      kind: 'uploads/<upload id>.log (journal: one line "<chunk index> <sha256 hex>" per durable chunk)',
      pattern: new RegExp(`^${WS}uploads/up_[A-Za-z0-9_-]{22}\\.log$`),
      homes: ['host'],
      since: '0.4.0',
      schema: noSchema,
      read: whole,
      problems: (bytes) => bytes.toString('utf8').split('\n').filter((line) => line.length > 0 && !UPLOAD_JOURNAL_LINE.test(line)).map((line) => `not a journal line: ${line.slice(0, 40)}`),
    },
    { kind: 'uploads/<upload id>.part (the bytes received so far, at their offsets)', pattern: new RegExp(`^${WS}uploads/up_[A-Za-z0-9_-]{22}\\.part$`), homes: ['host'], since: '0.4.0', schema: noSchema, read: whole },
    { kind: 'audit.jsonl, audit.<n>.jsonl (one entry per line)', pattern: new RegExp(`^${WS}audit(\\.\\d+)?\\.jsonl$`), homes: ['host'], since: '0.4.0', pin: 'audit.line', schema: today(auditEntrySchema), read: lines },
    { kind: 'audit-overflow.jsonl, audit-overflow.<n>.jsonl (one entry per line)', pattern: new RegExp(`^${WS}audit-overflow(\\.\\d+)?\\.jsonl$`), homes: ['host'], since: '0.5.0', pin: 'audit.line', schema: today(auditEntrySchema), read: lines },
    { kind: 'audit-text.jsonl, audit-text.<n>.jsonl (one text per line)', pattern: new RegExp(`^${WS}audit-text(\\.\\d+)?\\.jsonl$`), homes: ['host'], since: '0.5.0', schema: () => ({ schema: auditTextLine, frozen: false, described: true }), read: lines },
    { kind: 'activity.jsonl, activity.1.jsonl (one event per line)', pattern: new RegExp(`^${WS}activity(\\.\\d+)?\\.jsonl$`), homes: ['host'], since: '0.4.0', pin: 'activity.line', schema: today(activityEventSchema), read: lines },
    { kind: 'identity.key (the daemon\'s static private key: 32 bytes)', pattern: new RegExp(`^${WS}identity\\.key$`), homes: ['host'], since: '0.4.0', schema: noSchema, read: whole, problems: key32 },
    { kind: 'conflicts/<hex of the conflict id>.bin (the agent\'s version of a file, bytes)', pattern: new RegExp(`^${WS}conflicts/[0-9a-f]+\\.bin$`), homes: ['host'], since: '0.4.0', schema: noSchema, read: whole },
    { kind: 'workspaces.json (the command: shared folders and joined workspaces)', pattern: /^workspaces\.json$/, homes: ['host', 'member'], since: '0.4.0', schema: (version) => ({ schema: cliWorkspaces(version), frozen: false, described: true }), read: json },
    { kind: 'credentials.json (the command: relay logins)', pattern: /^credentials\.json$/, homes: ['host', 'member'], since: '0.4.0', schema: () => ({ schema: cliCredentials, frozen: false, described: true }), read: json },
    { kind: 'device.key (a device\'s private key) and pins/<hex of the workspace id>.pub (the daemon key it saw): 32 bytes each', pattern: /^(device\.key|pins\/[0-9a-f]+\.pub)$/, homes: ['host', 'member', 'device'], since: '0.4.0', schema: noSchema, read: whole, problems: key32 },
    { kind: 'logs/<workspace id>.log (the host log of `smurg host`: text lines, never read back by smurg)', pattern: /^logs\/[^/]+\.log$/, homes: ['host'], since: '0.4.0', schema: noSchema, read: whole },
    { kind: 'run/<12 characters>.pid (the process id of a running daemon; removed at a clean stop)', pattern: /^run\/[A-Za-z0-9]{12}\.pid$/, homes: ['host'], since: '0.4.0', schema: noSchema, read: whole },
    { kind: 'sessions/<workspace key>/<hex of the session id>/settings.json, mcp.json, role.md (launch files of a session that has a process; removed with it)', pattern: /^sessions\/[0-9a-f]+\/[0-9a-f]+\/(settings\.json|mcp\.json|role\.md)$/, homes: ['host'], since: '0.4.0', schema: noSchema, read: whole },
    { kind: 'transcripts/<hex of the session id>/role.md (the role text an agent session was started with)', pattern: new RegExp(`^${WS}transcripts/[0-9a-f]+/role\\.md$`), homes: ['host'], since: '0.5.0', schema: noSchema, read: whole },
  ];
}

/** The documents 0.4.0 already wrote; every other one is new in 0.5.0. A document a later smurg adds is named here with its version. */
const DOCUMENT_SINCE: Readonly<Record<string, PublishedVersion>> = { state: '0.4.0', conflicts: '0.4.0', worktrees: '0.4.0', sessions: '0.4.0', suggestions: '0.4.0' };

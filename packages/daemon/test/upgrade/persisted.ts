// TEST ONLY. Everything smurg PERSISTS, by kind: where a file of the kind lies, how it is read into instances, and
// the schema an instance must pass. The store documents (DESIGN A1) and the other persisted things under a workspace
// that are not store documents (A10: per-session cards, upload manifests with their journals and parts, transcript
// segments, the lines of the audit and activity logs), and the command's own two files.
//
// The kinds carry the names the fixtures' coverage.json gives them (test/fixtures/published/<version>/coverage.json).
// Used by the coverage test of the fixtures and by the pin.
import { totalmem } from 'node:os';
import { activityEventSchema, auditEntrySchema, conversationEventSchema } from '@smurg/protocol';
import { z } from 'zod';
import { cardsFileSchema } from '../../src/conversation/cards-store.ts';
import { defaultHostSettings } from '../../src/core/config.ts';
import { compareVersionNames, type DocumentDeclaration } from '../../src/core/state-store.ts';
import { declaredDocuments } from '../../src/daemon.ts';
import { manifestSchema } from '../../src/files/upload-store.ts';
import type { PublishedVersion } from './fixture.ts';

type Schema = z.ZodType;

/** Every document a daemon of the release declares, in module order (the core's `state` first). */
export function documentsOfThisSmurg(): readonly DocumentDeclaration[] {
  return declaredDocuments({ workspaceId: 'ws_persisted', defaultSettings: defaultHostSettings(totalmem()) });
}

/**
 * The shape a file of `document` has when smurg `version` wrote it: the frozen shape of the first step that starts
 * at that version or a later one (a version that changed nothing wrote the shape the next step reads), else today's
 * schema. `frozen`: the answer is a frozen shape, not today's schema.
 */
export function shapeWrittenBy(document: DocumentDeclaration, version: string): { readonly schema: Schema; readonly frozen: boolean } {
  const step = (document.steps ?? []).find((candidate) => compareVersionNames(candidate.from, version) >= 0);
  return step === undefined ? { schema: document.schema, frozen: false } : { schema: step.shape, frozen: true };
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
  /** The first published smurg that writes the kind. */
  readonly since: PublishedVersion;
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
  return [
    ...documents,
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

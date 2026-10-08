// THE PIN of everything smurg persists (DESIGN E-tests; ARCHITECTURE §7.1).
//
// 0.5.0 changed what state.json accepts without anyone deciding it: three settings were added to a schema of the WIRE
// (packages/protocol/src/schema/entities.ts), which the document's schema imports, and the file's own source did not
// change by a line. Every 0.4.0 workspace was refused. Nothing in the tree could have said "this is a stored shape".
// This test says it. It fails whenever what a stored file accepts MAY have changed, and asks one question:
//
//     DOES THIS CHANGE WHAT A STORED FILE ACCEPTS?
//     Then add a step (from the shape the last published smurg wrote: a frozen, literal copy under src/frozen/) and
//     raise `shapes` (WORKSPACE_SHAPES in src/core/state-store.ts). Then update this hash.
//     If it does not (a comment, a helper no stored value passes through): update the hash.
//
// Four pins:
//   1. FROZEN. What an earlier published smurg accepted (src/frozen/) is literal (it imports nothing but zod, so no
//      edit of today's code can move it) and never changes: its files are pinned byte for byte, and every step reads
//      one of them.
//   2. SOURCES. The source of every module of packages/protocol a persisted schema is built from, by hash: the rules
//      written as code (a path with too many combining marks, a blank name) are in no description of a schema.
//   3. SHAPES. What zod itself can say about every persisted schema, taken from the COMPOSED schema (the way the bug
//      happened), as text under test/upgrade/shapes/: every key, type, limit, pattern and branch. A reviewer reads
//      the change of a stored shape as a diff.
//   4. FORMATS that are no schema: the line of an upload's journal, of a transcript and of the audit texts, the names
//      of the stamp and of a kept copy, and the number `shapes` itself.
//
// The files of the published versions are the other half (test/upgrade/opens.test.ts, fixtures.test.ts): the pin says
// that something moved, the fixtures say whether what real installations hold still opens.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as protocol from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_SHAPES } from '../../src/core/state-store.ts';
import { documentsOfThisSmurg, persistedKinds } from './persisted.ts';
import { nodesOf, shapeOf } from './walker.ts';

const QUESTION =
  'DOES THIS CHANGE WHAT A STORED FILE ACCEPTS? Then add a step (a frozen, literal copy of the shape the last published smurg wrote, under src/frozen/) and raise `shapes` (WORKSPACE_SHAPES in src/core/state-store.ts); then update this hash. If it does not: update the hash.';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_SRC = join(HERE, '..', '..', 'src');
const PROTOCOL_SRC = join(HERE, '..', '..', '..', 'protocol', 'src');
const SHAPES_DIR = join(HERE, 'shapes');
/** `SMURG_PIN_WRITE=1 npx vitest run test/upgrade/pin.test.ts` writes test/upgrade/shapes/ anew (after the question was answered). */
const WRITE = process.env['SMURG_PIN_WRITE'] === '1';

const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// =====================================================================================================================
// The pinned values
// =====================================================================================================================

/** The number the pins below were taken at. Raised together with WORKSPACE_SHAPES, or not at all. */
const PINNED_AT_SHAPES = 1;

/** src/frozen/<file>: what a published smurg accepted. NEVER changes; a new file is added with the step that reads it. */
const FROZEN: Readonly<Record<string, string>> = {
  'v0.4.0.ts': '4084b3352d4938af13ec617ab2ab09570004f3cb65611125034453d590612f3c',
};

/**
 * packages/protocol/src/<module>: every module a persisted schema is built from (the walk below finds them).
 * Taken on the sources of 0.5.0 (these 22 files are byte for byte those of tag v0.5.0): 0.5.1 writes 0.5.0's shapes.
 */
const PROTOCOL_SOURCES: Readonly<Record<string, string>> = {
  'agent-text.ts': 'fcfc79b5fe3180bb8724d2800cb057a8b271299917d8a69319ccb49bd7064b75',
  'constants.ts': '22ff489650daef1108b99390553e12293bd71fd5fad29a30d22f568f5dc6a26b',
  'errors.ts': '0f2a058bb5226b4aad03f32560712ba9ca35838eb999e73ea2bd8e9611fddbf4',
  'i18n/define.ts': 'e6d7dd5a5ea9a26cbdf32dc3e2b118d8d8e13998360301089d4d17e81f4f4188',
  'normalize.ts': '5149ee3a744186ab39f5e27c77b26c14a54710d082d63d12811c79a5cc5b2378',
  'relay/binary.ts': 'ef4fc2b7c0166e9e5be18b3d5bc100ed1175cc1cd831a51b730d08a6cb401d4b',
  'relay/close-codes.ts': '9902b5aa33153f93751c4f8ebe9100b25bb5aec0f247812328a4e0f49a903ac1',
  'relay/frames.ts': '6cc87c1c2bf9aeec18facc53d8b78ed8c75dd2c2698f0ae73e0bb5babe136901',
  'relay/routes.ts': '223fb92a4cf5f0456e6f4e27f8860db2fddfe23ff06c5b133cc51fa5feb26ec5',
  'roles.ts': 'aefbcc4c97c5d783c99a6a3c5b1e9cb15668796446f5b3927c0655bcd23b6da2',
  'schema/conversation.ts': '09fa69867c6defe0d893c615c70edb61195f348781afc576c4ea2cb03f0c5efa',
  'schema/entities.ts': '002be307850d418c4eb49e3d9829cc0cfc7b816ff3b71fdcda1bfdd67e600034',
  'schema/inbox.ts': 'e67c396ab13d0d4f72972b1993c3bf73ec01433317f04c37503a77df8635f8f1',
  'schema/limits.ts': '2dd2114938ff6699b8c0544edb457479ed5f7a87edec0ce307fe895f9c11698a',
  'schema/message-ref.ts': 'ee4c2d08adecc61772f0da565141c2af9adf9fc32a7eb157ac8f9bf37d3a3019',
  'schema/messages/admin.ts': '092a5cbe67fdf0eafe618a55d9687448110d0546c92987ae5c81a1328fc5acbe',
  'schema/messages/channel.ts': '5652ac0034cf595cb6148c863713352672eb4e669630a269048eff1e07e1275c',
  'schema/messages/files.ts': '80131236ef63575912af25e0e66300e82c253f2197fa57235e480b0f70dacd96',
  'schema/messages/transfer.ts': '8e0ccfcd4ddc2c2858895fa9ea35e1f3931b0280dbaab046a2da54c1cb6147f7',
  'schema/paths.ts': '0ee840e274f57501b9c49baa8e4f16150ce0a3a543ee17bf49e2730777a6f6ca',
  'schema/primitives.ts': '7affdb6e9c22167df7607cf5dd6c7d66888d4e05d5058d4e8e9617555f62b549',
  'schema/topics.ts': '9f6fc7c85117054f3f3e7e74dc175fb3096ad6997071ab5bc6683778f9197d0f',
};

/**
 * Where the walk stops, and why that is right. Everything else a walked module imports is walked too.
 */
const WALK_STOPS: Readonly<Record<string, string>> = {
  'i18n/index.ts':
    'the text catalogs and how a reference is rendered (reached through errors.ts, for the English text of an error). No schema reads them: a stored message reference is bounded by schema/message-ref.ts and i18n/define.ts, which are pinned, and whether its id exists is decided when it is rendered, never when a file is read.',
};

/** Formats that are no schema: the exact line of the source that writes or reads them. */
const FORMAT_LINES: readonly { readonly file: string; readonly what: string; readonly line: string }[] = [
  { file: 'core/state-store.ts', what: 'the number for everything persisted under a workspace', line: `export const WORKSPACE_SHAPES = ${PINNED_AT_SHAPES};` },
  { file: 'core/state-store.ts', what: 'the name of the stamp', line: "export const STAMP_FILE = 'written-by.json';" },
  { file: 'core/state-store.ts', what: 'the name of a kept copy', line: "const COPY_MARK = '.json.before-upgrade-from-';" },
  { file: 'core/state-store.ts', what: 'how a document is serialized', line: '  return `${JSON.stringify(value, null, 2)}\\n`;' },
  { file: 'files/upload-store.ts', what: 'the three files of an upload', line: 'const STAGING_FILE = /^(up_[A-Za-z0-9_-]{22})\\.(json|log|part)$/;' },
  { file: 'files/upload-store.ts', what: 'a line of an upload\'s journal', line: 'const JOURNAL_LINE = /^(\\d{1,15}) ([0-9a-f]{64})$/;' },
  { file: 'sessions/agent/transcript.ts', what: 'a line of a transcript segment', line: '  return `${JSON.stringify({ v: 1, ...event })}\\n`;' },
  { file: 'core/audit-text.ts', what: 'a line of the audit texts', line: '    const line = `${JSON.stringify({ sha256, at: this.clock.now(), text })}\\n`;' },
];

// =====================================================================================================================
// The walk: which modules of packages/protocol a persisted schema is built from
// =====================================================================================================================

function sourceFiles(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'testing' && name !== 'node_modules') sourceFiles(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.fixture.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** What a module imports at run time: `import type` and `type` names are left out (a type accepts nothing). */
function runtimeImports(source: string): { readonly from: string; readonly names: string[] }[] {
  const out: { from: string; names: string[] }[] = [];
  const statement = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*'([^']+)'|(?:^|\n)\s*import\s*'([^']+)'/g;
  for (const match of source.matchAll(statement)) {
    if (match[5] !== undefined) {
      out.push({ from: match[5], names: ['*'] });
      continue;
    }
    if (match[2] !== undefined) continue;
    const clause = (match[3] ?? '').trim();
    const names: string[] = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of (braces[1] as string).split(',')) {
        const name = part.trim();
        if (name === '' || name.startsWith('type ')) continue;
        names.push((name.split(/\s+as\s+/)[0] as string).trim());
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    if (rest !== '') names.push('*'); // a default or a namespace import, or `export * from`
    if (braces && names.length === 0 && rest === '') continue; // only types in the braces
    out.push({ from: match[4] as string, names });
  }
  return out;
}

/** The files of the daemon that define a persisted schema: every one that declares a document, and those of DESIGN A10. */
function schemaFilesOfTheDaemon(): string[] {
  const declaring = sourceFiles(DAEMON_SRC).filter((file) => file !== join(DAEMON_SRC, 'core', 'state-store.ts') && /\bdeclareDocument\(/.test(readFileSync(file, 'utf8')));
  const others = ['files/upload-store.ts', 'conversation/cards-store.ts', 'sessions/agent/transcript.ts', 'core/audit.ts', 'core/audit-text.ts', 'locks/activity-log.ts'].map((file) => join(DAEMON_SRC, file));
  return [...new Set([...declaring, ...others])].sort();
}

/** `export const|function|class NAME` of packages/protocol/src: name -> the modules that define it. */
function definitionsOfTheProtocol(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of sourceFiles(PROTOCOL_SRC)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/^export (?:const|function|class|let) ([A-Za-z_$][\w$]*)/gm)) out.set(match[1] as string, [...(out.get(match[1] as string) ?? []), file]);
  }
  return out;
}

/** A name a schema is built from: another schema, or a constant (a limit, a pattern, a list of values). */
const isSchemaOrConstant = (name: string): boolean => /Schema$/.test(name) || /^[A-Z][A-Z0-9_]*$/.test(name);

interface Walk {
  /** Relative to packages/protocol/src, sorted. */
  readonly modules: string[];
  readonly problems: string[];
}

function walkTheProtocol(): Walk {
  const definitions = definitionsOfTheProtocol();
  const problems: string[] = [];
  const todo: string[] = [];
  for (const file of schemaFilesOfTheDaemon()) {
    for (const imported of runtimeImports(readFileSync(file, 'utf8'))) {
      if (imported.from !== '@smurg/protocol' && !imported.from.startsWith('@smurg/protocol/')) continue;
      for (const name of imported.names.filter(isSchemaOrConstant)) {
        const where = definitions.get(name);
        if (where === undefined) problems.push(`${relative(DAEMON_SRC, file)} imports ${name} from ${imported.from}, and no module of packages/protocol/src defines it with \`export const|function|class\``);
        else todo.push(...where);
      }
    }
  }
  // Every schema of the protocol that IS part of a persisted schema (the same object, or one built from it), however
  // it got there.
  const persisted = new Set<unknown>();
  for (const kind of persistedKinds()) {
    const which = kind.schema('999.0.0');
    if (which && which.described !== true) nodesOf(which.schema, persisted);
  }
  for (const document of documentsOfThisSmurg()) for (const step of document.steps ?? []) nodesOf(step.shape, persisted);
  for (const [name, value] of Object.entries(protocol)) {
    if (typeof value !== 'object' || value === null || !('_zod' in value) || !persisted.has(value)) continue;
    const where = definitions.get(name);
    if (where === undefined) problems.push(`@smurg/protocol exports the schema ${name}, a persisted schema holds it, and no module of packages/protocol/src defines it with \`export const\``);
    else todo.push(...where);
  }
  const seen = new Set<string>();
  while (todo.length > 0) {
    const file = todo.pop() as string;
    const rel = relative(PROTOCOL_SRC, file);
    if (seen.has(rel) || rel in WALK_STOPS) continue;
    seen.add(rel);
    for (const imported of runtimeImports(readFileSync(file, 'utf8'))) {
      if (!imported.from.startsWith('.')) continue;
      const target = normalize(join(dirname(file), imported.from));
      if (!existsSync(target)) problems.push(`${rel} imports ${imported.from}, which is not a file`);
      else todo.push(target);
    }
  }
  return { modules: [...seen].sort(), problems };
}

describe('the pin of everything smurg persists', () => {
  it(`was taken at shapes ${PINNED_AT_SHAPES}: the number and the pins move together`, () => {
    expect(WORKSPACE_SHAPES, 'WORKSPACE_SHAPES was raised: take the pins again (PINNED_AT_SHAPES, the hashes, test/upgrade/shapes/) in the same change, or raise neither').toBe(PINNED_AT_SHAPES);
  });

  describe('1. frozen: what an earlier published smurg accepted is literal and never changes', () => {
    const dir = join(DAEMON_SRC, 'frozen');
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts')).sort();

    it('a frozen file imports nothing but zod (no edit of today\'s code can move what it accepts)', () => {
      expect(files.length).toBeGreaterThanOrEqual(1);
      for (const name of files) {
        const source = readFileSync(join(dir, name), 'utf8');
        const imports = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
        expect(imports, `src/frozen/${name}`).toEqual(['zod']);
      }
    });

    it('a frozen file is byte for byte what it was when the step that reads it was published', () => {
      const now = Object.fromEntries(files.map((name) => [name, sha256(readFileSync(join(dir, name)))]));
      expect(now, 'A FROZEN SHAPE IS WHAT A PUBLISHED SMURG ACCEPTED. It is never edited: files that smurg really wrote would stop matching it, or files it never wrote would start to. (A new file under src/frozen/ is pinned here when its step is added.)').toEqual(FROZEN);
    });

    it('every step reads a frozen shape, the one of the version it is named after; none is derived from today\'s schema', async () => {
      const steps = documentsOfThisSmurg().flatMap((document) => (document.steps ?? []).map((step) => ({ document: document.name, step })));
      expect(steps.map((entry) => `${entry.document} from ${entry.step.from}`)).toEqual(['state from 0.4.0', 'suggestions from 0.4.0']);
      for (const { document, step } of steps) {
        expect(files, `the step of ${document} from ${step.from}`).toContain(`v${step.from}.ts`);
        const frozen = (await import(join(dir, `v${step.from}.ts`))) as Record<string, unknown>;
        expect(Object.values(frozen).includes(step.shape), `the shape of the step of ${document} from ${step.from} is an export of src/frozen/v${step.from}.ts`).toBe(true);
        // And nothing of today's schema is inside it (not even a shared scalar rule).
        const today = nodesOf(documentsOfThisSmurg().find((candidate) => candidate.name === document)?.schema);
        expect([...nodesOf(step.shape)].filter((node) => today.has(node)).length, `${document}: parts shared between the frozen shape and today's schema`).toBe(0);
      }
    });
  });

  describe('2. sources: every module of packages/protocol a persisted schema is built from', () => {
    const walk = walkTheProtocol();

    it('the walk finds its way: every schema and constant the daemon\'s schema files import is defined somewhere it can read', () => {
      expect(walk.problems).toEqual([]);
      // The ones the design names are in it, whatever else the walk finds.
      expect(walk.modules).toEqual(expect.arrayContaining(['schema/paths.ts', 'normalize.ts', 'schema/primitives.ts', 'schema/limits.ts', 'schema/entities.ts', 'schema/message-ref.ts', 'i18n/define.ts']));
      for (const stop of Object.keys(WALK_STOPS)) expect(existsSync(join(PROTOCOL_SRC, stop)), `${stop} (a stop of the walk) exists`).toBe(true);
    });

    it('none of them changed, came or went', () => {
      const now = Object.fromEntries(walk.modules.map((module) => [module, sha256(readFileSync(join(PROTOCOL_SRC, module)))]));
      expect(now, `packages/protocol/src: ${QUESTION}`).toEqual(PROTOCOL_SOURCES);
    });
  });

  describe('3. shapes: what zod can say about every persisted schema, from the composed schema', () => {
    const pinned = new Map<string, string>();
    for (const kind of persistedKinds()) {
      const which = kind.schema('999.0.0'); // today's schema of every kind
      if (kind.pin === undefined || which === null || which.described === true) continue;
      pinned.set(kind.pin, shapeOf(which.schema));
    }

    it('every kind with a schema has a pinned shape, and no pinned shape is left over', () => {
      expect([...pinned.keys()].sort()).toEqual([
        'activity.line',
        'agent-sessions.json',
        'audit.line',
        'cards.json',
        'claude-trust.json',
        'conflicts.json',
        'host-rules.json',
        'inbox.json',
        'reports.json',
        'sessions.json',
        'state.json',
        'suggestions.json',
        'topics.json',
        'transcripts.cards.json',
        'transcripts.events.line',
        'uploads.manifest.json',
        'worktrees.json',
      ]);
      if (WRITE) {
        mkdirSync(SHAPES_DIR, { recursive: true });
        for (const [name, text] of pinned) writeFileSync(join(SHAPES_DIR, `${name}.txt`), text);
      }
      expect(readdirSync(SHAPES_DIR).sort()).toEqual([...pinned.keys()].map((name) => `${name}.txt`).sort());
    });

    it.each([...pinned.keys()].sort())('%s accepts what it accepted', (name) => {
      const path = join(SHAPES_DIR, `${name}.txt`);
      const was = existsSync(path) ? readFileSync(path, 'utf8') : '(no pinned shape: test/upgrade/shapes/ has no such file)\n';
      expect(pinned.get(name), `${name}: ${QUESTION} (The pinned shape is rewritten with SMURG_PIN_WRITE=1.)`).toBe(was);
    });

    it('a pinned shape is plain ASCII and names no value of a file', () => {
      // eslint-disable-next-line no-control-regex
      for (const [name, text] of pinned) expect(/^[\x09\x0a\x20-\x7e]*$/.test(text), name).toBe(true);
    });
  });

  describe('4. formats that are no schema', () => {
    it.each(FORMAT_LINES)('$what ($file)', ({ file, line }) => {
      const lines = readFileSync(join(DAEMON_SRC, file), 'utf8').split('\n');
      expect(lines.filter((candidate) => candidate === line).length, `src/${file} no longer has the line\n${line}\n${QUESTION}`).toBe(1);
    });
  });
});

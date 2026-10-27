// THE PIN of everything smurg persists (DESIGN E-tests; ARCHITECTURE §7.1).
//
// 0.5.0 changed what state.json accepts without anyone deciding it: three settings were added to a schema of the WIRE
// (packages/protocol/src/schema/entities.ts), which the document's schema imports, and the file's own source did not
// change by a line. Every 0.4.0 workspace was refused. Nothing in the tree could have said "this is a stored shape".
// This test says it. It fails when one of the places that decide what a stored file accepts changes (the four pins
// below are those places; "WHAT THE PIN SEES" says what it cannot see), and asks one question:
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
//   2. SOURCES. The rules written as code (a path with too many combining marks, a blank name, a `.refine` on a list)
//      are in no description of a schema: only the source says them. So the SOURCE is pinned, by hash, of
//        a. every file of the daemon that defines a persisted schema: each one that declares a document, and those
//           of the persisted things that are no document (uploads, per-session cards, transcripts, the three logs);
//        b. every module of packages/protocol that ANY run-time name those files import leads to (not only names
//           that look like a schema or a constant: a schema may call a function), and everything those modules
//           import in turn. A name whose defining module cannot be found fails the test: nothing is skipped silently.
//      And c.: the other files of the DAEMON those schema files import at run time are named one by one, each with
//      the reason why no stored value passes through it; a new one fails until it is pinned or reasoned.
//   3. SHAPES. What zod itself can say about every persisted schema, taken from the COMPOSED schema (the way the bug
//      happened), as text under test/upgrade/shapes/: every key, type, limit, pattern and branch. A reviewer reads
//      the change of a stored shape as a diff. The stamp `written-by.json` is one of them.
//   4. FORMATS that are no schema: the line of an upload's journal, of a transcript and of the audit texts, the names
//      of the stamp and of a kept copy, and the number `shapes` itself.
//
// WHAT THE PIN SEES, exactly. It fails when the text of a pinned file changes, when a pinned shape's description
// changes, or when a pinned line is gone. It does NOT know whether a change matters: a comment in a pinned file fails
// it as surely as a tightened rule, and the answer to the question is a person's. It does NOT see: a rule in a file
// of the daemon that is not a schema file (2c names every such file a schema file can reach, and why none of them
// decides what a stored value may be); what a dependency (zod) does with the same description after an upgrade (the
// fixtures see that: the files the published versions wrote must still open); and a rule that is tightened by
// changing a value the schema reads at run time from outside these files.
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

/**
 * The number the pins below were taken at. Raised together with WORKSPACE_SHAPES, or not at all. 2 since 0.6.0 (the
 * question was answered: YES, it changes what stored files accept: state.json version 2 and agent-sessions.json, each
 * with a step from 0.5.0 that reads src/frozen/v0.5.0.ts; optional keys in topics.json and worktrees.json; wider enums
 * in reports.json, cards.json, transcripts and the audit; DESIGN 0.6.0 D6). 3 since 0.7.0 (answered again: YES:
 * state.json version 3 with the setting `merging` and the notice `auto-merge`, by a step from 0.6.0 that reads
 * src/frozen/v0.6.0.ts; optional keys in topics.json, reports.json and worktrees.json; wider enums in the audit, the
 * transcripts and the inbox's derived kinds; inbox.json unchanged through its own column target; DESIGN 0.7.0 D4).
 */
const PINNED_AT_SHAPES = 3;

/** src/frozen/<file>: what a published smurg accepted. NEVER changes; a new file is added with the step that reads it. */
const FROZEN: Readonly<Record<string, string>> = {
  'v0.4.0.ts': '4084b3352d4938af13ec617ab2ab09570004f3cb65611125034453d590612f3c',
  'v0.5.0.ts': 'cb5ecec470ec5187ce040f5f6d7bec09dbdf4ff2109ada562c76e9a67271f474',
  'v0.6.0.ts': '5fb735a380f2c1b404d8f9b4279887710277775c6ce175568f44ed100a934e70',
};

/**
 * packages/daemon/src/<file>: every file of the daemon that defines a persisted schema (the walk's roots: each one
 * that declares a document, and the six of the persisted things that are no document).
 */
const DAEMON_SOURCES: Readonly<Record<string, string>> = {
  'conversation/cards-store.ts': 'dd4d4571457ea824abcad95178254af2a33ad38e91806947b222ed5121261cb2',
  'core/audit-text.ts': '0b2e0d943504846ef14182f96517ee0bdf9211c954e9d702265043ae955089fd',
  'core/audit.ts': '9bd9267c2855afaea489e9b4f52e8688e02faccc829b70f4fe9af604e510227c',
  'core/workspace-state.ts': '5b5663c5dca308b62d30739f3056c5e9578bbf3b37d69530bdc6c2e7a204f158',
  'docs/conflicts.ts': 'dd9624cf4cc4f3f39f33efba03f02d94fdf61fdb853c02b2f8b9f1d98fa4e42d',
  'files/upload-store.ts': '65fa65d9bf0cbee656df6297dc1e473bb85228084fed32826ea1cb497bb574d2',
  'inbox/store.ts': '287e6ecc3e5604139847832d1bcb5ad803cef72812e91c1b79fa6ae97514b2f1',
  'locks/activity-log.ts': '85817194e1a6430fc4671a5e2a6361cf1d51f0e90a777314fffad6ed6ac2fd46',
  'sessions/agent/host-rules.ts': '8589139325f1f56eb73898d6b456ab36f85850e37e427b12a0ef1369eaee034e',
  'sessions/agent/project-settings.ts': 'f78365de979f27c4f678a6f4bc0df7544b3225c530a12acbad2b9f713c38b0af',
  'sessions/agent/store.ts': '1f84217f697b7d5c73e60cc7165c987228b39f65277d679e4aa447826ffd7949',
  'sessions/agent/transcript.ts': '1f648c75612cde4a7888c9a87f5ae79eec137c1a8440eabaf5dbf8b3bd8c59d6',
  'sessions/session-manager.ts': '8a2bbeb0680450666c80d80926e2366fbb8c50686835e1adb4334e9170786d6f',
  'suggest/store.ts': '5a2bef034e1917fb44d0752b4e04c0a3dbebe627b922a1edfea07c3f94304ba2',
  'topics/store.ts': '04ed46353379e52b828b1fa91c7da974118b4f131886814a9b424327ef0ab6c5',
  'worktree/store.ts': '8b34200008b0ae9280e70b950240a4c172dd4c413bb8ccbd4fcdbef82ddbe615',
};

/**
 * packages/protocol/src/<module>: every module that a run-time name imported by one of the files above leads to, and
 * everything those modules import (the walk below finds them). Taken for 0.5.1: all but two are byte for byte the
 * files of tag v0.5.0; codec.ts (what decodeClientHello RETURNS for another protocol version) and node/key-file.ts
 * (assertPrivateDirectory, which creates nothing) changed in 0.5.1, and neither changes what a stored file accepts.
 * Taken again for 0.6.0 (protocol 5, DESIGN D6): YES, what stored files accept changed (the four permission modes and
 * the workspace's in state.json's settings, the topic's agent settings, wider enums, smurg's own history), with the
 * steps from 0.5.0 and the points of NOT_PUBLISHED_YET; tools.ts left the walk (no schema file imports from it now).
 * Taken again for 0.7.0 (protocol 6, DESIGN 0.7.0 D4): YES, what stored files accept changed (the setting `merging` and
 * the notice `auto-merge` in state.json, by the step from 0.6.0; optional keys of topics.json, reports.json and
 * worktrees.json, with refines over those keys only; wider enums of the audit and of smurg's purposes; inbox.json kept
 * 0.6.0's shape through its own column target), with the points of NOT_PUBLISHED_YET. constants.ts and routing.ts
 * changed with no stored rule in them (PROTOCOL_VERSION; decisionRecipients).
 */
const PROTOCOL_SOURCES: Readonly<Record<string, string>> = {
  'agent-text.ts': 'fcfc79b5fe3180bb8724d2800cb057a8b271299917d8a69319ccb49bd7064b75',
  'bytes.ts': '7fc163368b2d2a82d5ce3d834922c96611f20331e61bff91b5ad22276391fa1c',
  'channel/identity-binding.ts': '57e7cbac993b088e66a8193dfca6054b5d6a8cfb5d95175c9eaf4d42c786e6dd',
  'codec.ts': '377cf872871c2185149f8b9cead0cf36bb19d0e7e3cf966c2b92988e5a25422a',
  'constants.ts': '25b8b52967ac2697e7736f45240755f370d0d57690f663ac98b27abbf57d8eff',
  'errors.ts': '0f2a058bb5226b4aad03f32560712ba9ca35838eb999e73ea2bd8e9611fddbf4',
  'i18n/define.ts': 'e6d7dd5a5ea9a26cbdf32dc3e2b118d8d8e13998360301089d4d17e81f4f4188',
  'mask.ts': '3bd5168fc9d394dbb72b0cc76d1e44e8867f16b07ee2fa139eb50abd57fbf48e',
  'node/key-file.ts': '8ef9a66fb06797fba933c28723068eac3d3329d71ad478f4967e859ed6d1a5eb',
  'normalize.ts': '5149ee3a744186ab39f5e27c77b26c14a54710d082d63d12811c79a5cc5b2378',
  'relay/binary.ts': 'ef4fc2b7c0166e9e5be18b3d5bc100ed1175cc1cd831a51b730d08a6cb401d4b',
  'relay/close-codes.ts': '9902b5aa33153f93751c4f8ebe9100b25bb5aec0f247812328a4e0f49a903ac1',
  'relay/frames.ts': '6cc87c1c2bf9aeec18facc53d8b78ed8c75dd2c2698f0ae73e0bb5babe136901',
  'relay/routes.ts': '223fb92a4cf5f0456e6f4e27f8860db2fddfe23ff06c5b133cc51fa5feb26ec5',
  'roles.ts': 'aefbcc4c97c5d783c99a6a3c5b1e9cb15668796446f5b3927c0655bcd23b6da2',
  'routing.ts': '8b327b339a75a19f0db5add172286f4cf6debfca080b75fd43fd408d898adafc',
  'schema/awareness.ts': '15f7202e552ced9496fb7ff62ccb1702eb4d1a808be278acf09e78999cdc768a',
  'schema/conversation.ts': '46239fc902c8df5659ab091009d163692a1bb85dece38e928a91df649c2963c4',
  'schema/entities.ts': '99f96cd2853c9d650afcbdc32f09085c99c70742e91ff71aad52c3e2cdd84231',
  'schema/error-details.ts': 'ecaa2ffc236f4a9a5ff9842ae681ba57c28487a4b7c1b43763be212586fdea97',
  'schema/handshake.ts': '31915fe6680b6a0c7c593eb4e338c7e8e571cda0aeef84b45d280f9aa255ab68',
  'schema/inbox.ts': '70daff0b7104b78d44957e645af70f731a63e8530b905a3b1300f3113e6d83df',
  'schema/index.ts': 'df8271d00f6e162c550c0a42e99d02e489f3c526342bff8208b3a99d10419f88',
  'schema/limits.ts': 'de9db30e6472cb5adad1bebeebc80f07a51f34b63fe93e8b350342231031dcac',
  'schema/message-ref.ts': 'ee4c2d08adecc61772f0da565141c2af9adf9fc32a7eb157ac8f9bf37d3a3019',
  'schema/messages/admin.ts': '100c58a4a888c409c34cef41786480d2dbf078b27d270422a96cf61ff9899dbb',
  'schema/messages/channel.ts': '5652ac0034cf595cb6148c863713352672eb4e669630a269048eff1e07e1275c',
  'schema/messages/conversation.ts': 'a1bbf190335ec77d332c544f61cd9786bc92878fdcb8399a576433fa5f8df7c9',
  'schema/messages/docs.ts': '39780943cf092425ba44b52352fe1a72b375405a6a00903ca54a668ac558946e',
  'schema/messages/files.ts': '80131236ef63575912af25e0e66300e82c253f2197fa57235e480b0f70dacd96',
  'schema/messages/inbox.ts': 'ca34d41770beb621beb629b4290cb7a6d934fde52229b368f4059c0c6c1b174f',
  'schema/messages/presence.ts': 'b072fa7f56d76819acf58811ff698efb3cf8c2dd87c80fee42a5f8938ec11c10',
  'schema/messages/sessions.ts': '2b5ff7a0bd5e1665a44d62389510e10f00e9750736d30f786db0f2399b88ae58',
  'schema/messages/suggestions.ts': 'db0a00d60c70ae8b4c92a228a7f1ef48e3b484bdb20b692e6056d9428a2cfd3c',
  'schema/messages/topics.ts': '0c632901b79d7ba908232ef23c800eed86f8026f043ff960dc973a654e444003',
  'schema/messages/transfer.ts': '8e0ccfcd4ddc2c2858895fa9ea35e1f3931b0280dbaab046a2da54c1cb6147f7',
  'schema/messages/worktrees.ts': 'eaa11a57ec6ac2071cde8f50c96be484d6ce7be7f4554789556ba4d1350faac8',
  'schema/paths.ts': '0ee840e274f57501b9c49baa8e4f16150ce0a3a543ee17bf49e2730777a6f6ca',
  'schema/primitives.ts': '97784d0308afe035d50582cbcc8296adcf9891816597351377ed885d854f2733',
  'schema/redact.ts': 'ba90ab8105d459f1f363c1bd162c6f84e49ecf2801bcbf58e797c6388ace7b92',
  'schema/registry.ts': '33e909dac94820a8cd8a8a1d7990791f0047a63f08fe9d3085271fbc905be3ca',
  'schema/topics.ts': '1abc4b0afa49ab233ae98364d9653963a8545a6ffbca3beff4a6a535ae0abf0c',
  'wire-text.ts': '0c93a045203d15779396e7c0e073e7f7e4c0996f8a64b8c627faf2615b5a36e5',
};

/**
 * The OTHER files of the daemon that a schema file imports at run time, and why no stored value passes through a
 * rule of theirs. A schema file that starts to import another file of the daemon fails here: pin that file (make it
 * one of DAEMON_SOURCES) when a persisted schema uses what it takes from it, or say here why it does not.
 */
const DAEMON_FILES_NO_STORED_VALUE_PASSES: Readonly<Record<string, string>> = {
  'core/state-store.ts': 'how a document is declared, read and written (declareDocument, defineStep, readPrivateJson, writePrivateFileAtomic, syncDirectory). Its formats are pinned line by line (4.) and the stamp by its shape (3.); it holds no rule of a document\'s values.',
  'core/config.ts': 'defaultMaxLiveAgents: the value the step from 0.4.0 GIVES `maxLiveAgents` on this machine (the function a new workspace uses, by design). It decides what an upgraded file holds, not what a stored file may hold.',
  'core/errors.ts': 'AuthorizationError: an error class.',
  'core/permissions.ts': 'SYSTEM_ACTOR and principalCan: who may do what at run time.',
  'core/stubs.ts': 'isStubService: whether a service slot is filled.',
  'core/lifecycle.ts': 'DisposableStack, newId, toDisposable: lifetimes and new ids.',
  'core/interfaces.ts': 'AUDIT_FULL_TEXT_HEAD_CHARS: how many characters of a text a NEW audit entry keeps. A stored entry is read with the wire\'s auditEntrySchema (pinned), whatever this number is.',
  'core/private-file.ts': 'openPrivateFile: owner, mode and kind of a file before it is read. Not its content.',
  'core/state-file-error.ts': 'StateFileError: the refusal itself.',
  'core/shell-scan.ts': 'scanShell and its helpers: which scripts a project\'s Claude Code settings RUN, to compute the key a trust decision is stored under. A change there makes stored decisions no longer apply (the closed side: the host is asked again); it refuses no file.',
  'local/local-channel.ts': 'LOCAL_CHANNEL_VIA: a text an audit entry carries for the control socket.',
  'sessions/agent/prompts.ts': 'freeRolePrompt: the text an agent session is started with.',
  'sessions/host-env.ts': 'buildHostEnv: the environment of a terminal.',
  'sessions/kill-tree.ts': 'killTree and its helpers: ending the processes of a session.',
  'sessions/process-run.ts': 'runProcess: running a helper process and reading what it prints.',
  'sessions/pty-session.ts': 'PtySession: the terminal a session runs in.',
  'workspace/fs-util.ts': 'errnoCode: the code of a system error.',
};

/**
 * Where the walk stops, and why that is right. Everything else a walked module imports is walked too.
 */
const WALK_STOPS: Readonly<Record<string, string>> = {
  'i18n/index.ts':
    'the text catalogs and how a reference is rendered (`msg`, `renderEnglish`; reached through errors.ts too, for the English text of an error). No schema reads them: a stored message reference is bounded by schema/message-ref.ts and i18n/define.ts, which are pinned, and whether its id exists is decided when it is rendered, never when a file is read.',
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

/** `export [async] const|function|class|let|enum NAME` of packages/protocol/src: name -> the modules that define it. */
function definitionsOfTheProtocol(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of sourceFiles(PROTOCOL_SRC)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/^export (?:async )?(?:const|function\*?|class|let|enum) ([A-Za-z_$][\w$]*)/gm)) out.set(match[1] as string, [...(out.get(match[1] as string) ?? []), file]);
  }
  return out;
}

interface Walk {
  /** Relative to packages/protocol/src, sorted. */
  readonly modules: string[];
  /** The files of the daemon (relative to its src) that a schema file imports at run time and that are no schema file and no frozen shape. */
  readonly daemonFiles: string[];
  readonly problems: string[];
}

function walkTheProtocol(): Walk {
  const definitions = definitionsOfTheProtocol();
  const problems: string[] = [];
  const todo: string[] = [];
  const roots = schemaFilesOfTheDaemon();
  const daemonFiles = new Set<string>();
  for (const file of roots) {
    for (const imported of runtimeImports(readFileSync(file, 'utf8'))) {
      if (imported.from.startsWith('.')) {
        // Another file of the daemon: a root itself, a frozen shape (pinned byte for byte), or one that is named with its reason.
        const target = normalize(join(dirname(file), imported.from));
        if (!existsSync(target)) problems.push(`${relative(DAEMON_SRC, file)} imports ${imported.from}, which is not a file`);
        else if (!roots.includes(target) && !relative(DAEMON_SRC, target).startsWith('frozen/')) daemonFiles.add(relative(DAEMON_SRC, target));
        continue;
      }
      if (imported.from !== '@smurg/protocol' && !imported.from.startsWith('@smurg/protocol/')) continue;
      // EVERY run-time name: a schema may call a function (`.refine((value) => encodedSize(value) < …)`), and a rule
      // taken from a function is a rule of the stored file. A name that cannot be followed fails the test.
      for (const name of imported.names) {
        const where = name === '*' ? undefined : definitions.get(name);
        if (where === undefined) problems.push(`${relative(DAEMON_SRC, file)} imports ${name === '*' ? 'everything (a namespace or a default import)' : name} from ${imported.from}: it cannot be followed to the module of packages/protocol/src that defines it (\`export const|function|class|let|enum\`). Import the name itself, from the package, so that its source is pinned.`);
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
  return { modules: [...seen].sort(), daemonFiles: [...daemonFiles].sort(), problems };
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
      expect(steps.map((entry) => `${entry.document} from ${entry.step.from}`)).toEqual(['state from 0.4.0', 'state from 0.5.0', 'state from 0.6.0', 'agent-sessions from 0.5.0', 'suggestions from 0.4.0']);
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

  describe('2. sources: the daemon\'s own schema files, and every module of packages/protocol they lead to', () => {
    const walk = walkTheProtocol();
    const roots = schemaFilesOfTheDaemon().map((file) => relative(DAEMON_SRC, file));

    it('the roots are every file of the daemon that declares a document, and the six of the persisted things that are no document', () => {
      expect(roots).toEqual([
        'conversation/cards-store.ts',
        'core/audit-text.ts',
        'core/audit.ts',
        'core/workspace-state.ts',
        'docs/conflicts.ts',
        'files/upload-store.ts',
        'inbox/store.ts',
        'locks/activity-log.ts',
        'sessions/agent/host-rules.ts',
        'sessions/agent/project-settings.ts',
        'sessions/agent/store.ts',
        'sessions/agent/transcript.ts',
        'sessions/session-manager.ts',
        'suggest/store.ts',
        'topics/store.ts',
        'worktree/store.ts',
      ]);
      // Every declared document's schema is defined in one of them (a document declared elsewhere would not be pinned).
      const declaring = roots.filter((file) => /\bdeclareDocument\(/.test(readFileSync(join(DAEMON_SRC, file), 'utf8')));
      const declared = declaring.flatMap((file) => [...readFileSync(join(DAEMON_SRC, file), 'utf8').matchAll(/\bdeclareDocument\(/g)].map(() => file));
      expect(declared.length).toBe(documentsOfThisSmurg().length);
    });

    it('the walk finds its way: EVERY run-time name a schema file imports from the protocol package is followed to the module that defines it', () => {
      expect(walk.problems).toEqual([]);
      // The ones the design names are in it, whatever else the walk finds; and the one a rule taken from a FUNCTION lives in.
      expect(walk.modules).toEqual(expect.arrayContaining(['schema/paths.ts', 'normalize.ts', 'schema/primitives.ts', 'schema/limits.ts', 'schema/entities.ts', 'schema/message-ref.ts', 'i18n/define.ts', 'codec.ts']));
      for (const stop of Object.keys(WALK_STOPS)) expect(existsSync(join(PROTOCOL_SRC, stop)), `${stop} (a stop of the walk) exists`).toBe(true);
    });

    it('a. the daemon\'s own schema files: none of them changed, came or went', () => {
      const now = Object.fromEntries(roots.map((file) => [file, sha256(readFileSync(join(DAEMON_SRC, file)))]));
      expect(now, `packages/daemon/src: ${QUESTION}`).toEqual(DAEMON_SOURCES);
    });

    it('b. the modules of packages/protocol they lead to: none of them changed, came or went', () => {
      const now = Object.fromEntries(walk.modules.map((module) => [module, sha256(readFileSync(join(PROTOCOL_SRC, module)))]));
      expect(now, `packages/protocol/src: ${QUESTION}`).toEqual(PROTOCOL_SOURCES);
    });

    it('c. every OTHER file of the daemon a schema file imports at run time is named, with the reason why no stored value passes through it', () => {
      expect(walk.daemonFiles, 'A SCHEMA FILE IMPORTS ANOTHER FILE OF THE DAEMON (or no longer does). Does a persisted schema use what it takes from it? Then that file decides what a stored file accepts: make it one of the pinned files. If not: name it in DAEMON_FILES_NO_STORED_VALUE_PASSES with the reason.').toEqual(Object.keys(DAEMON_FILES_NO_STORED_VALUE_PASSES).sort());
      for (const [file, reason] of Object.entries(DAEMON_FILES_NO_STORED_VALUE_PASSES)) expect(reason.trim(), file).not.toBe('');
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
        'written-by.json',
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

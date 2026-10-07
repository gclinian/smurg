// What a text costs the daemon that reads it (review, last round, N1).
//
// The daemon has one thread. Every function here is handed text a member or an agent wrote: PLAN.md, SPEC.md and a
// result report (2 MiB each), a shell command and the commands of a project's settings, the output and the input of a
// tool, the command lines of the machine's processes, names, paths. Each is walked through the hostile texts of
// `@smurg/protocol/testing` at one size and at sixteen times that size; sixteen times the text may cost about sixteen
// times as much. What grows faster than any power (a wildcard read as an expression, a command line read once for
// every directory it may be in) is measured by its own cases further down. The lists at the end say which source
// files hold a regular expression, a `normalize`, a collation or a sort: a new one is looked at (and its function
// added to LOOKS when it is handed such text) before a number changes.
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARK_RUN_MAX } from '@smurg/protocol';
import { AT_MOST_TIMES, LARGE_CHARS, NOISE_MS, costOf, countInSources, cpuMs, disproportionate, isSourceName, type Look } from '@smurg/protocol/testing';
import { describe, expect, it } from 'vitest';
import { deniedByPerson } from '../src/conversation/agent-sentences.ts';
import { applyEdit, changeDiff, replacementsDiff } from '../src/conversation/change-diff.ts';
import { clipExcerpt, mentionExcerpt } from '../src/conversation/mentions.ts';
import { namesClaudeConfig, shownInput, shownReason, shownText, shownToolName, shownUrl } from '../src/conversation/permission-card.ts';
import { cleanPersonText } from '../src/conversation/session-facts.ts';
import { sanitizeAuditDetail } from '../src/core/audit.ts';
import { quoteForLog } from '../src/core/logger.ts';
import { scanShell } from '../src/core/shell-scan.ts';
import { classifyText, encodeText } from '../src/docs/text-codec.ts';
import { planBatch, planFolders } from '../src/files/upload.ts';
import { looseKey } from '../src/files/util.ts';
import { bashPlaces, judgePlaces, type BashReading, type ResolvedPlace } from '../src/hooks/bash-guard.ts';
import { daemonUnreachableReason, gateDenyReason, pathDeniedReason } from '../src/hooks/deny-text.ts';
import { fileChangedMatcher } from '../src/hooks/settings-writer.ts';
import { patternLeavesRoot, toolInList } from '../src/hooks/tool-gate.ts';
import { projectHookInput, sniffHookEventName } from '../src/hooks/wire.ts';
import { excerptOf } from '../src/inbox/derive.ts';
import { lockKeyOf } from '../src/locks/keys.ts';
import { clipText, safeDisplayName, safeToolName, shownPath, summary } from '../src/locks/text.ts';
import { questionPartsOf, streamableLength } from '../src/sessions/agent/agent-runner.ts';
import { hostRulesOf } from '../src/sessions/agent/host-rules.ts';
import { checkLaunchArgs, fileRule } from '../src/sessions/agent/profiles.ts';
import { cannotFollow, effectsOf, headerEffectsOf, isGuardable, namesAPath, scriptCandidates } from '../src/sessions/agent/project-settings.ts';
import { buildToolResult, buildToolView, diffFromPatch, editOf, headTail, safeId, stripAnsi, suggestedRuleOf, toolName } from '../src/sessions/agent/tool-view.ts';
import { envEntryPidsFromPs, parseProcessTable } from '../src/sessions/kill-tree.ts';
import { PLAN_MARKER_END, PLAN_MARKER_START, parsePlan } from '../src/topics/plan-format.ts';
import { countOpenQuestions } from '../src/topics/plan-service.ts';
import { peopleList } from '../src/topics/prompts.ts';
import { REPORT_SECTIONS, REPORT_TITLE_PREFIX, parseReport, reportMarker } from '../src/topics/report-format.ts';
import { checkProposal } from '../src/topics/split.ts';
import { wireLarge, wireLine, wireMultiline } from '../src/topics/text.ts';
import { unaddressableNames } from '../src/workspace/fs-util.ts';
import { decodeGitPath, diffText, parseNameOnly, parseStatusPaths } from '../src/worktree/git-parse.ts';
import { checkpointMessage } from '../src/worktree/main-repo.ts';
import { excludePattern, gitIdentity, ownerSlug, worktreeBranch } from '../src/worktree/names.ts';

// ---- the files and commands a text stands in

const plan = (body: string): string => `# Plan\n\n${PLAN_MARKER_START}\n### 1. Cart API\n- id: cart-api\n- size: m\n\n${body}\n${PLAN_MARKER_END}\n`;
const report = (body: string): string =>
  `${REPORT_TITLE_PREFIX} Cart API\n${reportMarker('cart-api')}\n- outcome: complete\n\n## ${REPORT_SECTIONS[0]}\n${body}\n## ${REPORT_SECTIONS[1]}\n${body}\n## ${REPORT_SECTIONS[2]}\n- [x] the tests pass\n${body}\n## ${REPORT_SECTIONS[3]}\nNothing.\n`;
const PS_LINE = '  101   1   101   501 S    Mon Sep 28 13:50:05 2026 ';
const PS_COMMAND = '  101   501 Mon Sep 28 13:50:05 2026 ';

/** The recorded scripts of a root: an ordinary one, and one whose name is as long as a name can be. */
const RECORDED: ReadonlySet<string> = new Set(['scripts/lint.sh', `scripts/${'a'.repeat(250)}.sh`, 'tools/hooks/check.mjs']);
const CWD = '/work/shop';

/** The gate's whole look at one command, with the places taken as they are written (no links to resolve). */
function gate(command: string, recorded: ReadonlySet<string> = RECORDED): { reading: BashReading; verdict: string } {
  const reading = bashPlaces(command, CWD, '/home/host');
  const places: ResolvedPlace[] = reading.places.map((place) => ({
    rel: place.path === CWD ? '' : place.path.startsWith(`${CWD}/`) ? place.path.slice(CWD.length + 1) : null,
    kind: place.kind,
    ...(place.open === undefined ? {} : { open: place.open }),
  }));
  return { reading, verdict: judgePlaces({ unsure: reading.unsure, places }, recorded) };
}

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');
/** The larger size for the readers that do the most per character (several passes over a command and its words): a quarter of the usual one. */
const HEAVY_CHARS = LARGE_CHARS / 4;
/** What a shell reads differently when it stands in front: a quote, a substitution, a here-document, an assignment. */
const SHELL_SYNTAX: readonly string[] = ['echo "', "echo '", 'x $(', 'x `', 'x ${', 'x <(', 'cat <<A\n', 'X='];
/** Commands the gates read differently: one that changes files, a wildcard, a change of directory, another shell, a wrapper. */
const SHELL_COMMANDS: readonly string[] = ['rm ', 'rm scripts/*', 'cd /a; touch ', 'sh -c "', 'node -e "', 'find . -delete ', 'env ', 'eval '];

/** Every function of src/ that is handed text a member or an agent wrote, outside what is measured by its own case below. */
const LOOKS: Readonly<Record<string, Look>> = {
  // ---- a topic's files
  'parsePlan (PLAN.md, at every change of the file)': {
    run: (text) => void [parsePlan(plan(text)), parsePlan(text), parsePlan(`${PLAN_MARKER_START}\n${text}\n${PLAN_MARKER_END}`)],
    fronts: ['- a', '- id', '- depends on: ', '- touches: ', '### 1. ', '### 2. a\n- id: b\n- depends on: ', '#', '   ## ', '```\n', PLAN_MARKER_START],
  },
  'parseReport (a result report)': {
    run: (text) => void [parseReport(report(text), 'cart-api'), parseReport(text, 'cart-api')],
    fronts: ['## ', '## a', '## What was done', '- [ ] ', '- [ ] a:', '- [ ] a: not verified', '- [x] ', '- outcome', '# ', '```\n', REPORT_TITLE_PREFIX],
  },
  'countOpenQuestions (SPEC.md before "Generate plan")': { run: (text) => void [countOpenQuestions(text), countOpenQuestions(`## Open questions\n${text}`)], fronts: ['## Open questions', '- ', '1', '1. none', '#'] },
  'wireLine, wireMultiline and wireLarge (what a file holds, as the wire carries it)': { run: (text) => void [wireLine(text, 120), wireMultiline(text, 2_000), wireLarge(text, 65_536)] },
  'checkProposal and peopleList (the names of a split)': {
    run: (text) => void [checkProposal(new Set(['a']), [{ userId: 'dev:amy', name: text, joinedAt: 1 }], [{ id: 'a', person: text }]), peopleList([{ userId: 'dev:amy', displayName: text }])],
  },
  // ---- shell commands: the tool gate and the trust gate
  'scanShell (a command read as a shell splits it)': { run: (text) => void scanShell(text, { variables: { HOME: '/home/host' }, home: '/home/host' }), fronts: SHELL_SYNTAX },
  // The hook forwards a command of at most 32 KiB.
  'bashPlaces and judgePlaces (the tool gate reads every shell command)': { run: (text) => void gate(text), fronts: [...SHELL_SYNTAX, ...SHELL_COMMANDS], chars: 32_768 },
  'cannotFollow (a command of a project\u2019s settings)': { run: (text) => void [cannotFollow([text]), cannotFollow(['sh', '-c', text])], fronts: SHELL_COMMANDS, chars: HEAVY_CHARS },
  'scriptCandidates, namesAPath and isGuardable (the scripts a project\u2019s settings run)': {
    run: (text) => void [scriptCandidates([[text], ['sh', '-c', text]], { CLAUDE_PROJECT_DIR: '/work/shop', PWD: '.' }, '/home/host'), namesAPath(text), isGuardable(text)],
    fronts: SHELL_COMMANDS,
    chars: HEAVY_CHARS,
  },
  'effectsOf (a project\u2019s settings file)': {
    run: (text) =>
      void [
        effectsOf('.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: text, hooks: [{ type: 'command', command: text }] }] }, permissions: { allow: [text, `Bash(${text})`] }, env: { PATH: text } })),
        effectsOf('.mcp.json', JSON.stringify({ mcpServers: { a: { command: text, args: [text], env: { NODE_OPTIONS: text } } } })),
        effectsOf('.claude/settings.json', text),
      ],
    fronts: ['{"hooks":', 'Bash(', 'sh -c "'],
    chars: HEAVY_CHARS,
  },
  'headerEffectsOf (the header of an agent, a skill or a command)': {
    run: (text) => void [headerEffectsOf('.claude/agents/a.md', `---\n${text}\n---\nBody.\n`), headerEffectsOf('.claude/agents/a.md', `---\nhooks:\n${text}\n---\n`), headerEffectsOf('.claude/agents/a.md', text)],
    fronts: ['hooks:', '  - command: ', '  command', 'allowed-tools: ', 'allowed-tools:\n  ', 'permissionMode: "', 'a', '---\n'],
  },
  'fileRule, checkLaunchArgs and fileChangedMatcher (what a session is started with)': { run: (text) => void [fileRule('Edit', '/work/shop', text), checkLaunchArgs(['--settings', text]), fileChangedMatcher([text, text])], throws: true },
  // ---- tools: what an agent runs and what comes back
  'stripAnsi and headTail (the output of a command)': { run: (text) => void headTail(stripAnsi(text), 65_536, 16_384), fronts: ['\u001b[', '\u001b[1', '\u001b]', '\u001b]0;a', '\u001b'], chars: 262_144 },
  'buildToolView, editOf and suggestedRuleOf (the input of a tool)': {
    run: (text) =>
      void [
        buildToolView('Bash', { command: text, description: text }, { kind: 'none' }),
        buildToolView('WebFetch', { url: text, prompt: text }, { kind: 'none' }),
        buildToolView('Grep', { pattern: text, path: text }, { kind: 'outside' }),
        buildToolView(text, { file_path: text }, { kind: 'in', file: { root: { kind: 'main' }, path: 'src/a.ts' } }),
        editOf('Edit', { file_path: 'a', old_string: text, new_string: text }),
        suggestedRuleOf([{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: text }] }]),
        toolName(text),
        safeId(text, 'tool'),
      ],
  },
  'buildToolResult and diffFromPatch (the result of a tool)': {
    run: (text) => {
      const result = (name: string, structured: unknown): unknown =>
        buildToolResult({ view: buildToolView(name, { command: 'ls', file_path: '/work/shop/src/a.ts' }, name === 'Bash' ? { kind: 'none' } : { kind: 'in', file: { root: { kind: 'main' }, path: 'src/a.ts' } }), ok: true, text, structured, relativePath: (absolute) => absolute });
      void [
        result('Bash', { stdout: text, stderr: text }),
        result('Bash', null),
        result('Edit', { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: text.split('\n').map((line) => `+${line}`) }] }),
        result('Write', { type: 'create', content: text }),
        result('Glob', { filenames: [text, text], numFiles: 2 }),
        result('TodoWrite', { newTodos: [{ content: text, status: 'pending' }] }),
        result('WebFetch', null),
        diffFromPatch([{ lines: [text] }]),
      ];
    },
    fronts: ['Exit code 1', '\u001b[', 'token='],
    chars: HEAVY_CHARS * 2,
  },
  'questionPartsOf and streamableLength (a question an agent asks, a text it streams)': {
    run: (text) => void [questionPartsOf({ questions: [{ question: text, header: text, options: [{ label: text, description: text }, { label: 'b' }] }] }), streamableLength(text)],
  },
  'shownToolName, shownReason, shownInput, shownText and shownUrl (a permission card)': {
    run: (text) => void [shownToolName(text), shownReason(text), shownInput({ command: text, nested: { text } }), shownText(text), shownUrl(text, LARGE_CHARS), shownUrl(`https://${text}`, LARGE_CHARS)],
  },
  'namesClaudeConfig (a command that names Claude Code\u2019s configuration)': { run: (text) => void namesClaudeConfig(text), fronts: ['.claude', ' .git', 'cat .mcp.json', '.'] },
  'applyEdit and replacementsDiff (what an edit would change)': {
    run: (text) => {
      const edit = { kind: 'replace' as const, replacements: [{ oldText: 'a', newText: text.slice(0, 64), all: true }, { oldText: text.slice(0, 1_024), newText: 'b', all: false }] };
      void [applyEdit(text, edit), replacementsDiff('src/a.ts', edit, false), replacementsDiff('src/a.ts', { kind: 'write', text }, true)];
    },
  },
  'hostRulesOf (the host\u2019s own allow rules)': { run: (text) => void hostRulesOf({ state: { rules: [{ behavior: 'allow', source: 'userSettings', rule: text }, { behavior: 'allow', source: 'localSettings', rule: `Bash(${text})` }] } }) },
  'gateDenyReason, pathDeniedReason and daemonUnreachableReason (what an agent is told)': { run: (text) => void [gateDenyReason('G2', { tool: text, slug: text }), pathDeniedReason(text), daemonUnreachableReason(text)] },
  'patternLeavesRoot and toolInList (a search pattern, a tool name)': { run: (text) => void [patternLeavesRoot(text), toolInList([text, 'Bash'], text)], fronts: ['../', 'a/../', 'mcp__'] },
  'sniffHookEventName and projectHookInput (what a hook sends)': {
    run: (text) => void [sniffHookEventName(text), projectHookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: text, tool_input: { command: text, file_path: text, path: text, pattern: text } }, { command: true })],
    fronts: ['"hook_event_name"', '"hook_event_name" : "'],
  },
  // ---- conversations, the inbox, activity
  'cleanPersonText and deniedByPerson (a message, a denial\u2019s line)': { run: (text) => void [cleanPersonText(text, LARGE_CHARS * 2), deniedByPerson({ userId: 'dev:amy', displayName: text, role: 'agent' }, text)], throws: true },
  'clipExcerpt, mentionExcerpt and excerptOf (an inbox item)': { run: (text) => void [clipExcerpt(text), mentionExcerpt(text, 'Ian'), mentionExcerpt(`${text}@Ian ${text}`, 'Ian'), excerptOf(text)], fronts: ['@Ian'] },
  'summary, shownPath, clipText, safeDisplayName and safeToolName (an activity line)': { run: (text) => void [summary(text), shownPath(text), clipText(text, 200), safeDisplayName(text, 'member'), safeToolName(text)] },
  'sanitizeAuditDetail and quoteForLog (the audit log, the daemon\u2019s log)': { run: (text) => void [sanitizeAuditDetail({ text, nested: { text }, list: [text] }, ['text']), quoteForLog(text)] },
  // ---- processes, files, git
  'parseProcessTable and envEntryPidsFromPs (the command lines of the machine\u2019s processes)': {
    run: (text) => void [parseProcessTable(`${PS_LINE}${text}\n${PS_LINE}node a.js`), parseProcessTable(text), envEntryPidsFromPs(`${PS_COMMAND}${text}`, `${PS_COMMAND}${text} SMURG_SESSION=1`, 'SMURG_SESSION=1', 501)],
    fronts: [PS_LINE, `${PS_LINE}sleep `, '  101   1   101   501 S ', '101 1 101 501 '],
  },
  'classifyText and encodeText (a file opened as a document)': { run: (text) => void [classifyText(bytes(text)), encodeText(text, { eol: 'CRLF', bom: true })] },
  'lockKeyOf, looseKey and unaddressableNames (a name as a key)': { run: (text) => void [lockKeyOf({ root: { kind: 'main' }, path: text }), looseKey({ kind: 'main' }, text), unaddressableNames([text, `${text}a`])] },
  'decodeGitPath, parseNameOnly, parseStatusPaths and diffText (what git prints)': {
    run: (text) => void [decodeGitPath(bytes(text)), parseNameOnly(bytes(`${text}\0${text}\0`)), parseStatusPaths(bytes(` M ${text}\0?? ${text}\0`)), diffText(bytes(text))],
    throws: true,
  },
  'ownerSlug, gitIdentity, worktreeBranch, excludePattern and checkpointMessage (names git is given)': {
    run: (text) => void [ownerSlug(text), gitIdentity(text, text), excludePattern(text), checkpointMessage(text, [text, `Co-authored-by: ${text}`]), worktreeBranch(text, 'wt_000000000000000000000000')],
    fronts: ['a', '.'],
    throws: true,
  },
};

describe('what a text costs the daemon that reads it: packages/daemon', () => {
  it.each(Object.entries(LOOKS))('sixteen times the text costs about sixteen times as much: %s', (_name, look) => {
    expect(disproportionate(look)).toEqual([]);
  }, 300_000);
});

// ---- the regular expressions that were not in proportion: each is pinned by what it cost

describe('lines that held the daemon for seconds (N1, the sweep)', () => {
  /** Processor time of one call, in milliseconds. */
  const took = (run: () => void): number => costOf(run, 0, 1);

  it('PLAN.md: a field line that is a name and a run of blanks without a colon (the square of the run)', () => {
    const line = `- depends on${' '.repeat(60_000)}x`;
    expect(took(() => void parsePlan(plan(line)))).toBeLessThan(150);
    // And what the parser said before, it says now.
    const parsed = parsePlan(`${PLAN_MARKER_START}\n### 1. A\n-  ID\t :\tcart-api \n- Depends  On : none\n- size: L\n- touches: src/**, test/a.ts ,\n\nDone when green.\n### 2. B\n- id: b\n- depends on: cart-api\n${PLAN_MARKER_END}`);
    expect(parsed).toMatchObject({ ok: true, items: [{ id: 'cart-api', size: 'l', touches: ['src/**', 'test/a.ts'], summary: 'Done when green.' }, { id: 'b', dependsOn: ['cart-api'] }] });
    for (const bad of ['- id cart-api', '- id:cart-api', '- 1d: x', '-id: x', '- id : x : y', '- depends on\t']) {
      const refused = parsePlan(`${PLAN_MARKER_START}\n### 1. A\n- id: a\n${bad}\n${PLAN_MARKER_END}`);
      expect(refused.ok === false || refused.items[0]?.id === 'a', bad).toBe(true);
    }
    expect(parsePlan(`${PLAN_MARKER_START}\n### 1. A\n- id: a\n- id : x : y\n${PLAN_MARKER_END}`)).toMatchObject({ ok: false, errors: [{ kind: 'field', line: 4 }] });
    expect(parsePlan(`${PLAN_MARKER_START}\n### 1. A\n- id:a\n${PLAN_MARKER_END}`)).toMatchObject({ ok: false, errors: [{ kind: 'missing-id' }] });
  });

  it('PLAN.md: a work item that depends on every one of tens of thousands of others is refused at the cost of the file', () => {
    // 1.5 MiB (a topic's file may be 2 MiB): each dependency was looked for among the ones before it.
    const ids = Array.from({ length: 50_000 }, (_, index) => `i${index}`);
    const text = `${PLAN_MARKER_START}\n${ids.map((id) => `### 1. ${id}\n- id: ${id}\n`).join('')}### 1. last\n- id: last\n- depends on: ${ids.join(', ')}\n${PLAN_MARKER_END}`;
    expect(took(() => void parsePlan(text))).toBeLessThan(1_500);
    const refused = parsePlan(text);
    expect(refused.ok === false && refused.errors.map((error) => error.kind)).toEqual(['too-many']);
    // A dependency named twice is one dependency, in the order of the line.
    expect(parsePlan(`${PLAN_MARKER_START}\n### 1. A\n- id: a\n### 2. B\n- id: b\n### 3. C\n- id: c\n- depends on: b, a, b ,a\n${PLAN_MARKER_END}`)).toMatchObject({ ok: true, items: [{ id: 'a' }, { id: 'b' }, { id: 'c', dependsOn: ['b', 'a'] }] });
  });

  it('a report: a heading and a run of blanks before a letter (the cube of the run)', () => {
    const line = `## What was done${' '.repeat(20_000)}x`;
    expect(took(() => void parseReport(report(line), 'cart-api'))).toBeLessThan(150);
    // A heading is read as before: closing hashes and blanks around it are not part of its name.
    const text = `${REPORT_TITLE_PREFIX} A\n${reportMarker('a')}\n- outcome: partial\n## ${REPORT_SECTIONS[0]} ##\nDone.\n##\t${REPORT_SECTIONS[1]}\t \nBecause.\n## ${REPORT_SECTIONS[2]}  ##  \n- [x] ran\n- [ ] deploy: not verified: no access\n## ${REPORT_SECTIONS[3]}#\nNothing.\n`;
    expect(parseReport(text, 'a')).toMatchObject({ ok: true, report: { outcome: 'partial', sections: { done: 'Done.', why: 'Because.', watchOut: 'Nothing.' }, checks: { passed: 1, notVerified: 1 } } });
    expect(parseReport(text.replace(`## ${REPORT_SECTIONS[0]} ##`, `## ${REPORT_SECTIONS[0]} # x`), 'a')).toMatchObject({ ok: false, errors: [{ kind: 'heading', line: 4 }, { kind: 'section-missing' }] });
    expect(parseReport(text.replace(`## ${REPORT_SECTIONS[0]} ##`, '## #'), 'a')).toMatchObject({ ok: false });
  });

  it('a line that holds a character `.` does not match: a heading, an outcome, a check and a header key with a run of blanks before it (the square of the run)', () => {
    // A line is cut at line feeds; U+2028, U+2029 and a lone CR stay in it. `(.*)$` failed there and tried the blanks again from every blank.
    for (const stop of ['\u2028', '\u2029']) {
      const tail = `${' '.repeat(128_000)}x${stop}y`;
      expect(took(() => void parsePlan(plan(`### 2.${tail}`))), 'plan heading').toBeLessThan(150);
      expect(took(() => void parseReport(report(`- outcome:${tail}`), 'cart-api')), 'report outcome').toBeLessThan(150);
      expect(took(() => void parseReport(report(`- [x]${tail}`), 'cart-api')), 'report check').toBeLessThan(150);
      expect(took(() => void parseReport(report(`- [ ] deploy: not verified:${tail}`), 'cart-api')), 'report not verified').toBeLessThan(150);
    }
    for (const stop of ['\u2028', '\u2029', '\r']) {
      const header = `---\nname:${' '.repeat(128_000)}x${stop}y\nhooks:\n  - command:${' '.repeat(128_000)}x${stop}y\n---\nbody\n`;
      expect(took(() => void headerEffectsOf('.claude/agents/a.md', header)), 'header').toBeLessThan(150);
    }
    // Such a line was no heading before and is none now; a heading without one reads as before.
    expect(parsePlan(`${PLAN_MARKER_START}\n### 1. A\u2028B\n- id: a\n${PLAN_MARKER_END}`)).toMatchObject({ ok: false });
    expect(parsePlan(`${PLAN_MARKER_START}\n### 1. A B\n- id: a\n${PLAN_MARKER_END}`)).toMatchObject({ ok: true, items: [{ id: 'a', title: 'A B' }] });
  });

  it('a settings command of thirty wrappers in front of one very long word is not read once for every wrapper (the square of the word)', () => {
    for (const size of [64_000, 256_000]) {
      const line = `${'env '.repeat(30)}${'a'.repeat(size)}`;
      expect(took(() => void cannotFollow([line])), String(size)).toBeLessThan(400);
    }
    // What people write is followed as before, long arguments included.
    expect(cannotFollow([`env CI=1 nice node scripts/build.mjs --banner=${'x'.repeat(4_000)}`])).toBe(false);
    expect(cannotFollow([`sudo -u build env sh ${'$'}SCRIPT`])).toBe(true);
  });

  it('the output of a command: an escape sequence of exclamation marks (the square of the run)', () => {
    const output = `\u001b[${'!'.repeat(60_000)}\n`;
    expect(took(() => void stripAnsi(output))).toBeLessThan(100);
    expect(stripAnsi('a\u001b[31mb\u001b[0m \u001b[?25l\u001b[1;2Hc\u001b]0;title\u0007d\u001b]8;;http://a\u001b\\e\u001bMf\u001b[!pg\u001b[ qh\u001b[!1 !/pi\u001b[1!pj')).toBe('ab cdefghij');
    // A sequence without its final byte is no sequence: only the two-character escape goes.
    expect(stripAnsi('\u001b[!!!x and \u001b[1;;; \n and \u001b[!!! \n')).toBe(' and 1;;; \n and !!! \n');
  });

  it('a process whose command line is a run of blanks before a letter is read at once, and one with a line separator in it is seen', () => {
    const table = `${PS_LINE}sleep 100${' '.repeat(100_000)}x\n${PS_LINE}node a.js  \n  7 1 7 501 Z\n  8 1 8 501 S    Mon Sep 28 13:50:05 2026\n  9 1 9 501 S nonsense\n`;
    expect(took(() => void parseProcessTable(table))).toBeLessThan(100);
    expect(parseProcessTable(table).map((row) => [row.pid, row.zombie, row.start, row.command?.length])).toEqual([
      [101, false, 'Mon Sep 28 13:50:05 2026', 100_010],
      [101, false, 'Mon Sep 28 13:50:05 2026', 9],
      [7, true, undefined, undefined],
      [8, false, 'Mon Sep 28 13:50:05 2026', 0],
    ]);
    // U+2028 inside an argument: the expression's `.` stopped there and the line was no process at all.
    expect(parseProcessTable(`${PS_LINE}node a.js "x\u2028y"`)).toMatchObject([{ pid: 101, command: 'node a.js "x\u2028y"' }]);
    const plain = `${PS_COMMAND}sleep 100${' '.repeat(100_000)}x`;
    expect(took(() => void envEntryPidsFromPs(plain, `${plain} SMURG_SESSION=1 B=2`, 'SMURG_SESSION=1', 501))).toBeLessThan(100);
    expect([...envEntryPidsFromPs(`${PS_COMMAND}node a.js`, `${PS_COMMAND}node a.js A=1 SMURG_SESSION=1`, 'SMURG_SESSION=1', 501).keys()]).toEqual([101]);
    expect([...envEntryPidsFromPs(`${PS_COMMAND}echo SMURG_SESSION=1`, `${PS_COMMAND}echo SMURG_SESSION=1 A=1`, 'SMURG_SESSION=1', 501).keys()]).toEqual([]);
  });
});

describe('what grew faster than any power (N1, the sweep)', () => {
  it('a command of a project\u2019s settings that is one wrapper after another is not followed, at once (each one doubled the work)', () => {
    const started = cpuMs();
    for (const wrapper of ['env', 'sudo', 'nice', 'command', 'exec', 'nohup']) {
      expect(cannotFollow([`${`${wrapper} `.repeat(48)}sh ./scripts/lint.sh`]), wrapper).toBe(true);
      expect(cannotFollow([`${`${wrapper} `.repeat(20_000)}true`]), wrapper).toBe(true);
    }
    expect(cannotFollow([`${'env eval x '.repeat(8_000)}true`])).toBe(true);
    expect(cannotFollow([`${'eval '.repeat(30_000)}true`])).toBe(true);
    expect(cpuMs() - started).toBeLessThan(1_500);
    // What people write is followed as before.
    for (const line of ['sudo -u build env CI=1 nice -n 5 timeout 30 node scripts/build.mjs', 'env A=1 B=2 sh scripts/lint.sh', 'exec command time sh -c "cd scripts && ./lint.sh"', 'find . -name "*.sh" -exec sh {} ;', 'eval "sh scripts/lint.sh"']) {
      expect(cannotFollow([line]), line).toBe(line.startsWith('find'));
    }
    expect(cannotFollow(['sudo -u build env sh $SCRIPT'])).toBe(true);
    expect(cannotFollow(['env env env sh "$1"'])).toBe(true);
  });

  it('a wildcard of many stars is matched against a script\u2019s name at the cost of the two (as an expression it took minutes)', () => {
    const recorded = new Set([`scripts/${'a'.repeat(60)}.sh`]);
    const started = cpuMs();
    expect(gate(`rm scripts/${'*a'.repeat(30)}*b`, recorded).verdict).toBe('clear');
    expect(gate(`rm scripts/${'*a'.repeat(30)}*h`, recorded).verdict).toBe('writes');
    expect(gate(`rm scripts/${'a*'.repeat(8_000)}`, recorded).verdict).toBe('clear');
    expect(gate(`rm scripts/${'?'.repeat(61)}*${'?'.repeat(3)}`, recorded).verdict).toBe('clear');
    // One star and a run of the name's own letter that the name does not end with: not decided within the steps the
    // two are worth, so it "can match" and a person is asked.
    expect(gate(`rm scripts/*${'a'.repeat(28)}b`, recorded).verdict).toBe('writes');
    expect(cpuMs() - started).toBeLessThan(500);
    // Read as before: a wildcard names what it can match, in any case, and a class is any one character.
    const lint = new Set(['scripts/lint.sh']);
    for (const [command, verdict] of [
      ['rm scripts/*.sh', 'writes'],
      ['rm scripts/l?nt.sh', 'writes'],
      ['rm scripts/LINT.*', 'writes'],
      ['rm scripts/[kl]int.sh', 'writes'],
      ['rm scripts/*.md', 'clear'],
      ['rm scripts/l?t.sh', 'clear'],
      ['rm scripts/lint.sh?', 'clear'],
      ['rm scripts/*int*sh*', 'writes'],
      ['rm s*/lint.sh', 'writes'],
      ['rm t*/lint.sh', 'clear'],
      ['cat scripts/*.sh', 'clear'],
      ['wc scripts/*.md', 'clear'],
      ['node scripts/*.sh', 'unsure'],
      ['rm scripts/{lint,x}.sh', 'writes'],
      ['rm scripts/**', 'writes'],
    ] as const) {
      expect(gate(command, lint).verdict, command).toBe(verdict);
    }
  });

  it('a command line for another shell is read once, whatever number of directories the line may be in (it was read eight times at every depth)', () => {
    // Each level changes directory three times (eight directories it may be in) and hands the rest to another shell.
    const nested = (depth: number): string => {
      let line = 'rm lint.sh';
      for (let level = 0; level < depth; level += 1) line = `cd scripts; cd b; cd c; sh -c ${JSON.stringify(line)}`;
      return line;
    };
    const started = cpuMs();
    for (const depth of [1, 2, 3]) expect(gate(nested(depth)).verdict, `depth ${depth}`).toBe('writes');
    // Deeper, the line names more places than are looked at, and a shell more than four deep is not read: a person is asked.
    for (const depth of [4, 5, 6, 9, 12]) expect(gate(nested(depth)).verdict, `depth ${depth}`).toBe('unsure');
    expect(gate(`sh -c ${JSON.stringify(`sh -c ${JSON.stringify(`sh -c ${JSON.stringify(`sh -c ${JSON.stringify('rm scripts/lint.sh')}`)}`)}`)}`).verdict).toBe('writes');
    expect(gate(`sh -c ${JSON.stringify(`sh -c ${JSON.stringify(`sh -c ${JSON.stringify(`sh -c ${JSON.stringify(`sh -c ${JSON.stringify('rm scripts/lint.sh')}`)}`)}`)}`)}`).verdict).toBe('unsure');
    expect(cpuMs() - started).toBeLessThan(500);
    // One level is read as before: from every directory the line may be in.
    expect(gate('cd scripts; sh -c "rm lint.sh"').verdict).toBe('writes');
    expect(gate('cd docs; sh -c "rm lint.sh"').verdict).toBe('clear');
    expect(gate('sh -c "cd scripts && rm lint.sh"').verdict).toBe('writes');
    expect(gate('cd scripts; bash -c "sh -c \\"rm lint.sh\\""').verdict).toBe('writes');
    // A directory nobody knows in front of it: what the inner line writes by a relative name is not known either.
    expect(gate('cd "$X"; sh -c "rm lint.sh"').verdict).toBe('unsure');
    expect(gate('cd "$X"; sh -c "rm /work/shop/scripts/lint.sh"').verdict).toBe('writes');
    expect(gate('cd "$X"; sh -c "cat lint.sh"').verdict).toBe('clear');
  });

  it('a line of thousands of words after a change to a long directory costs what its length costs', () => {
    const line = `cd /${'d'.repeat(12_000)}; touch ${'a '.repeat(9_000)}`;
    const started = cpuMs();
    expect(gate(line).reading).toEqual({ unsure: true, places: [] });
    expect(gate(`${'cd a; '.repeat(5_000)}touch lint.sh`).verdict).toBe('unsure');
    expect(gate(`cd /${'d'.repeat(5_000)}; ${'cd .; '.repeat(4_000)}touch lint.sh`).verdict).toBe('unsure');
    expect(gate(`cd /${'d/'.repeat(6_000)}; rm ${'a '.repeat(9_000)}`).verdict).toBe('unsure');
    expect(gate(`node -e "${'a b '.repeat(7_000)}"`).verdict).toBe('unsure');
    expect(cpuMs() - started).toBeLessThan(300);
    // A substitution with more commands in it than a call can be handed is read like any other.
    expect(scanShell(`echo $(${'a;'.repeat(120_000)})`).commands).toHaveLength(120_001);
    expect(scanShell(`echo \`${'a;'.repeat(120_000)}\``).commands).toHaveLength(120_001);
  });

  it('an edit of thousands of replacements in a large file is shown replacement by replacement, at once (each one read the whole file again)', () => {
    const file = 'line of text number x\n'.repeat(47_662);
    const swaps = (count: number, all: boolean) => Array.from({ length: count }, (_, index) => ({ oldText: index % 2 === 0 ? 'x' : 'y', newText: index % 2 === 0 ? 'y' : 'x', all }));
    const started = cpuMs();
    // 2,000 replacements of every occurrence in a megabyte: 15 s. 4,000 of the first one: 0.9 s.
    expect(applyEdit(file, { kind: 'replace', replacements: swaps(2_000, true) })).toBeNull();
    expect(applyEdit(file, { kind: 'replace', replacements: swaps(4_000, false) })).toBeNull();
    const shown = changeDiff({ label: 'a.txt', current: file, exists: true, edit: { kind: 'replace', replacements: swaps(2_000, true) } });
    expect(cpuMs() - started).toBeLessThan(400);
    expect(shown.startsWith('--- a/a.txt\n+++ b/a.txt\n@@ replacement 1 of 2000 (every occurrence) @@\n-x\n+y\n')).toBe(true);
    // Within the bound an edit is applied as before: sixty replacements in the megabyte (four of every occurrence),
    // six thousand in a small file.
    expect(applyEdit(file, { kind: 'replace', replacements: swaps(60, false) })).toBe(file);
    expect(applyEdit(file, { kind: 'replace', replacements: swaps(3, true) })).toBe(file.replaceAll('x', 'y'));
    expect(applyEdit(file, { kind: 'replace', replacements: swaps(5, true) })).toBeNull();
    expect(applyEdit('a x b x\n'.repeat(100), { kind: 'replace', replacements: swaps(6_001, false) })).toBe(`a y b x\n${'a x b x\n'.repeat(99)}`);
    expect(applyEdit('cost: $1 and $&', { kind: 'replace', replacements: [{ oldText: '$', newText: '$$', all: true }, { oldText: 'cost', newText: "$'", all: false }] })).toBe("$': $$1 and $$&");
    expect(applyEdit('abc', { kind: 'replace', replacements: [{ oldText: 'x', newText: 'y', all: true }] })).toBeNull();
  });

  it('an upload plan of a thousand files in one deep folder costs what the plan holds (every file walked and folded every folder above it again)', () => {
    const plan = (files: number, depth: number) => Array.from({ length: files }, (_, index) => ({ path: `${'Dir/'.repeat(depth)}f${index}.txt`, kind: 'file' as const, size: 1 }));
    const whole = (entries: ReturnType<typeof plan>) => (): void => {
      const batch = planBatch(entries, true);
      if (batch !== null) planFolders([...batch.seen.values()]);
    };
    // Sixteen times the text: the same thousand files, sixteen times as deep.
    const one = costOf(whole(plan(1_000, 25)), 0, 3);
    const many = costOf(whole(plan(1_000, 400)), 0, 3);
    expect(many).toBeLessThan(Math.max(NOISE_MS, one * AT_MOST_TIMES));
    // The folders are the ones of the plan, parents first, each once; names are compared as the file system compares them.
    const batch = planBatch([{ path: 'A/b/one.txt', kind: 'file', size: 1 }, { path: 'a/B/two.txt', kind: 'file', size: 2 }, { path: 'a/c', kind: 'dir' }, { path: 'A/C', kind: 'dir' }, { path: 'a/b/ONE.txt', kind: 'file', size: 3 }, { path: 'a/b', kind: 'file', size: 4 }], true);
    expect(batch?.problems).toEqual([{ path: 'a/b/ONE.txt', reason: 'duplicate' }, { path: 'a/b', reason: 'file-and-directory' }]);
    expect([...(batch?.seen.keys() ?? [])]).toEqual(['a/b/one.txt', 'a/b/two.txt', 'a/c', 'a/b']);
    expect(planBatch([{ path: 'A/x', kind: 'file' }, { path: 'a/x', kind: 'file' }], false)?.problems).toEqual([]);
    expect(planFolders([{ path: 'a/b/c/f.txt', kind: 'file', size: 1 }, { path: 'a/z', kind: 'dir', size: 0 }, { path: 'top.txt', kind: 'file', size: 1 }, { path: 'a/b/g.txt', kind: 'file', size: 1 }])).toEqual(['a', 'a/b', 'a/z', 'a/b/c']);
    // More folders than a plan may have entries: no plan.
    const wide = Array.from({ length: 60 }, (_, index) => ({ path: `many${index}/${'d/'.repeat(199)}f.txt`, kind: 'file' as const, size: 1 }));
    expect(planBatch(wide, true)).toBeNull();
    expect(planBatch(wide.slice(0, 50), true)?.seen.size).toBe(50);
    expect(planFolders(wide.map((entry) => ({ ...entry })))).toBeNull();
    expect(planFolders(wide.slice(0, 50).map((entry) => ({ ...entry })))).toHaveLength(10_000);
  });

  it('a name of marks is one key at the cost of its length', () => {
    const marks = '\u0301\u0316'.repeat(30_000);
    const started = cpuMs();
    lockKeyOf({ root: { kind: 'main' }, path: `docs/a${marks}.md` });
    looseKey({ kind: 'main' }, `docs/a${marks}.md`);
    checkProposal(new Set(['a']), [{ userId: 'dev:amy', name: `Amy${marks}`, joinedAt: 1 }], [{ id: 'a', person: `amy${marks}` }]);
    expect(cpuMs() - started).toBeLessThan(200);
    expect(checkProposal(new Set(['a']), [{ userId: 'dev:amy', name: `Am\u00e9lie${'\u0301'.repeat(MARK_RUN_MAX)}`, joinedAt: 1 }], [{ id: 'a', person: `AME\u0301LIE${'\u0301'.repeat(MARK_RUN_MAX)}` }]).kept.get('a')).toBe('dev:amy');
  });
});

// ---- what the sources hold

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter(isSourceName)
    .map((name) => [name.split(sep).join('/'), readFileSync(join(SRC, name), 'utf8')]),
);

/**
 * How many regular expressions each source file holds. Every one of them was looked at for this test: it is anchored
 * and tried once, or it is a class of single characters, or every repetition in it is bounded, or its text is the
 * program's own (an id, a version, the output of a program the daemon starts with arguments of its own), or the walk
 * above measures it. A NEW expression changes a number here: before changing the number, make sure the expression
 * cannot be tried again from every character of a long run of text someone else wrote (`x+$`, `\s*:` behind a lazy
 * group, two neighbours that match the same characters), and add its function to LOOKS above when it is handed such
 * text.
 */
const EXPRESSIONS: Readonly<Record<string, number>> = {
  'conversation/change-diff.ts': 1,
  'conversation/mentions.ts': 3,
  'conversation/permission-card.ts': 5,
  'core/audit-text.ts': 1,
  'core/audit.ts': 1,
  'core/config.ts': 2,
  'core/fakes/worktrees.ts': 1,
  'core/hub.ts': 1,
  'core/lifecycle.ts': 1,
  'core/logger.ts': 3,
  'core/shell-scan.ts': 8,
  'core/sockets.ts': 1,
  'core/state-store.ts': 1,
  'core/workspace-state.ts': 1,
  'daemon.ts': 1,
  'docs/conflict-panel.ts': 1,
  'docs/text-codec.ts': 3,
  'files/upload-store.ts': 4,
  'files/watcher.ts': 2,
  'hooks/bash-guard.ts': 6,
  'hooks/deny-text.ts': 3,
  'hooks/schemas.ts': 1,
  'hooks/settings-writer.ts': 2,
  'hooks/tool-gate.ts': 1,
  'hooks/wire.ts': 2,
  'inbox/derive.ts': 4,
  'locks/colors.ts': 1,
  'locks/lock-manager.ts': 1,
  'locks/text.ts': 2,
  'net/identity.ts': 2,
  'sessions/agent/agent-runner.ts': 7,
  'sessions/agent/host-rules.ts': 1,
  'sessions/agent/profiles.ts': 4,
  'sessions/agent/project-settings.ts': 23,
  'sessions/agent/tool-view.ts': 5,
  'sessions/agent/transcript.ts': 1,
  'sessions/host-env.ts': 1,
  'sessions/kill-tree.ts': 4,
  'sessions/session-manager.ts': 2,
  'testing/fake-claude.mjs': 10,
  'testing/run-registry.ts': 2,
  'testing/temp.ts': 1,
  'topics/plan-format.ts': 10,
  'topics/plan-service.ts': 6,
  'topics/prompts.ts': 1,
  'topics/report-format.ts': 8,
  'topics/store.ts': 1,
  'topics/text.ts': 7,
  'workspace/fs-util.ts': 2,
  'workspace/power.ts': 4,
  'workspace/share-lock.ts': 1,
  'workspace/share.ts': 1,
  'worktree/fs-ops.ts': 1,
  'worktree/git-parse.ts': 4,
  'worktree/git.ts': 5,
  'worktree/main-repo.ts': 4,
  'worktree/names.ts': 11,
  'worktree/review.ts': 2,
  'worktree/stage-commit.ts': 3,
  'worktree/store.ts': 3,
};

/**
 * A sort, a collation, a `normalize`: where each is. Every one of these is a sort: by a number or a time, or of names
 * compared unit by unit (never by `localeCompare` or a collator, which put runs of marks in order first). None is a
 * `normalize`: the daemon normalises through `normalized` of @smurg/protocol (normalize.ts), which cuts a run of marks
 * before it does. A sort whose comparison reads the two texts again each time (splits a path, folds a name) is the
 * square of nothing, but work a list of thousands of long paths multiplies: give it what it compares by, computed once.
 */
const ORDERINGS: Readonly<Record<string, number>> = {
  'conversation/cards-store.ts': 1,
  'conversation/questions.ts': 1,
  'core/config.ts': 1,
  'core/fakes/conversation.ts': 1,
  'core/fakes/sessions.ts': 1,
  'docs/merge.ts': 1,
  'files/file-service.ts': 1,
  'files/upload.ts': 1,
  'files/zip.ts': 1,
  'hooks/settings-writer.ts': 2,
  'inbox/derive.ts': 2,
  'inbox/inbox-service.ts': 2,
  'locks/colors.ts': 1,
  'locks/lock-manager.ts': 1,
  'sessions/agent/agent-sessions.ts': 4,
  'sessions/agent/host-rules.ts': 2,
  'sessions/agent/project-settings.ts': 6,
  'sessions/agent/transcript.ts': 2,
  'sessions/session-manager.ts': 2,
  'suggest/suggestion-service.ts': 3,
  'topics/core.ts': 3,
  'topics/plan-format.ts': 2,
  'topics/plan-service.ts': 3,
  'topics/report-format.ts': 1,
  'topics/scheduler.ts': 3,
  'topics/split.ts': 4,
  'worktree/stage-commit.ts': 2,
  'worktree/worktree-manager.ts': 2,
};

describe('the regular expressions, normalisations and sorts of packages/daemon', () => {
  it('are the ones that were looked at: a new one is looked at before these lists change', () => {
    const found = countInSources(SOURCES);
    expect(found.expressions).toEqual(EXPRESSIONS);
    expect(found.orderings).toEqual(ORDERINGS);
    expect(Object.keys(SOURCES).filter((name) => (SOURCES[name] as string).includes('.normalize('))).toEqual([]);
  });
});

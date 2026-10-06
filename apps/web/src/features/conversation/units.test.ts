// The pure helpers of the conversation feature: text, people and mentions, drafts, diffs.
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, MENTIONS_PER_TEXT_MAX } from '@smurg/protocol';
import type { ConnectionState } from '../../lib/connection/types.ts';
import { MemoryStorage } from '../../testing/services.tsx';
import { diffStat, parseDiff } from './diff.ts';
import { DRAFTS_MAX, EMPTY_DRAFT, createDraftsStore, draftsOf, forgetDrafts } from './drafts.ts';
import { applyMention, matchPeople, mentionQueryAt, mentionsIn, personOf, whoDiscuss, withAgentAccess, type Person } from './people.ts';
import { cardDomId, commandHead, commonDir, lineRange, quoteSelection, showControls } from './text.ts';

const person = (displayName: string, role: Person['role'], userId = `dev:${displayName.toLowerCase().replace(/\s+/g, '-')}`): Person => ({ userId, displayName, role, color: '#000000', online: true });
const PEOPLE: Person[] = [person('Ian', 'host'), person('Mei', 'agent'), person('Mei Lin', 'editor'), person('Amy', 'editor'), person('Leo', 'viewer')];
const code = (...points: number[]): string => String.fromCharCode(...points);

describe('text', () => {
  it('makes characters a reader cannot see visible, and leaves tabs and line feeds', () => {
    expect(showControls('a\tb\nc')).toBe('a\tb\nc');
    expect(showControls(`rm ${code(0x1b)}[2K${code(0x7f)}`)).toBe(`rm ${code(0x241b)}[2K${code(0x2421)}`);
    expect(showControls(`safe${code(0x202e)}txt.exe`)).toBe(`safe${code(0x27e6)}U+202E${code(0x27e7)}txt.exe`);
    expect(showControls(`a${code(0x200b)}b${code(0xfeff)}`)).toBe(`a${code(0x27e6)}U+200B${code(0x27e7)}b${code(0x27e6)}U+FEFF${code(0x27e7)}`);
    // A NUL arrives as its control picture already (the daemon's rule) and stays one.
    expect(showControls(code(0x2400))).toBe(code(0x2400));
  });

  it('finds the folder paths share, and names a command by its first words', () => {
    expect(commonDir(['src/cart/a.ts', 'src/cart/b.ts', 'src/cart/sub/c.ts'])).toBe('src/cart');
    expect(commonDir(['src/a.ts', 'docs/b.md'])).toBeNull();
    expect(commonDir(['README.md'])).toBeNull();
    expect(commonDir([])).toBeNull();
    expect(commandHead('  pnpm   add left-pad ', 2)).toBe('pnpm add');
    expect(commandHead('node build.js', 1)).toBe('node');
    expect(lineRange(3, 3)).toBe('3');
    expect(lineRange(3, 5)).toBe(`3${code(0x2013)}5`);
    expect(cardDomId('q_1')).toBe('conv-card-q_1');
    expect(cardDomId('q:1 x')).toBe('conv-card-q_1_x');
  });

  it('quotes a selection with where it is from, in a fence the code cannot close', () => {
    expect(quoteSelection({ file: { root: MAIN_ROOT, path: 'src/a.ts' }, startLine: 3, endLine: 4, text: 'const a = 1;\r\nconst b = 2;\n' })).toBe('src/a.ts:3-4\n```\nconst a = 1;\nconst b = 2;\n```');
    expect(quoteSelection({ file: { root: MAIN_ROOT, path: 'README.md' }, startLine: 7, endLine: 7, text: '```ts\nx\n```' })).toBe('README.md:7\n````\n```ts\nx\n```\n````');
    // A selection from a worktree says so: the agent's own folder may be another one.
    expect(quoteSelection({ file: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'src/a.ts' }, startLine: 1, endLine: 1, text: 'x' })).toBe('src/a.ts:1 (worktree wt_1)\n```\nx\n```');
  });
});

describe('people and mentions', () => {
  it('knows who has agent access and who discusses', () => {
    expect(withAgentAccess(PEOPLE).map((one) => one.displayName)).toEqual(['Ian', 'Mei']);
    expect(whoDiscuss(PEOPLE).map((one) => one.displayName)).toEqual(['Ian', 'Mei', 'Mei Lin', 'Amy']);
    expect(personOf(PEOPLE, 'dev:amy')?.displayName).toBe('Amy');
    expect(personOf(PEOPLE, null)).toBeUndefined();
  });

  it('finds the members a text names, the longest name first, and never more than the wire allows', () => {
    expect(mentionsIn('no one here', PEOPLE)).toEqual([]);
    expect(mentionsIn('@Mei Lin and @Amy', PEOPLE)).toEqual(['dev:mei-lin', 'dev:amy']);
    expect(mentionsIn('@Mei and @Mei Lin', PEOPLE)).toEqual(['dev:mei-lin', 'dev:mei']);
    expect(mentionsIn('mail amy@example.com', PEOPLE)).toEqual([]);
    const crowd = Array.from({ length: MENTIONS_PER_TEXT_MAX + 3 }, (_, index) => person(`P${String(index).padStart(2, '0')}`, 'editor'));
    expect(mentionsIn(crowd.map((one) => `@${one.displayName}`).join(' '), crowd)).toHaveLength(MENTIONS_PER_TEXT_MAX);
  });

  it('reads the mention being typed at the caret and replaces it with the chosen name', () => {
    expect(mentionQueryAt('hello @me', 9)).toEqual({ start: 6, query: 'me' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('a@b', 3)).toBeNull();
    expect(mentionQueryAt('@a b c', 6)).toBeNull();
    expect(mentionQueryAt('@a\nb', 4)).toBeNull();
    expect(mentionQueryAt('no at sign', 5)).toBeNull();

    expect(matchPeople(PEOPLE, 'me', 'dev:ian').map((one) => one.displayName)).toEqual(['Mei', 'Mei Lin']);
    expect(matchPeople(PEOPLE, 'i', 'dev:mei').map((one) => one.displayName)).toEqual(['Ian', 'Mei Lin']);
    expect(matchPeople(PEOPLE, '', 'dev:ian').map((one) => one.displayName)).toEqual(['Mei', 'Mei Lin', 'Amy', 'Leo']);

    expect(applyMention('hello @me there', { start: 6, query: 'me' }, 9, 'Mei Lin')).toEqual({ text: 'hello @Mei Lin there', caret: 15 });
    expect(applyMention('@', { start: 0, query: '' }, 1, 'Amy')).toEqual({ text: '@Amy ', caret: 5 });
  });
});

describe('drafts', () => {
  it('keeps unsent text per session, tells its readers, and survives a reload of the page', () => {
    const storage = new MemoryStorage();
    const drafts = createDraftsStore('ws_1', storage);
    let changes = 0;
    drafts.subscribe(() => changes++);
    expect(drafts.get('s1')).toBe(EMPTY_DRAFT);
    drafts.setText('s1', 'Half a thought');
    drafts.setText('s1', 'Half a thought');
    expect(changes).toBe(1);
    drafts.setSource('s1', { file: { root: MAIN_ROOT, path: 'src/a.ts' }, startLine: 2, endLine: 3 });
    drafts.setText('s2', 'Another');

    const again = createDraftsStore('ws_1', storage);
    expect(again.get('s1')).toEqual({ text: 'Half a thought', source: { file: { root: MAIN_ROOT, path: 'src/a.ts' }, startLine: 2, endLine: 3 }, focusToken: 0 });
    expect(again.get('s2').text).toBe('Another');
    // Another workspace has its own.
    expect(createDraftsStore('ws_2', storage).get('s1')).toBe(EMPTY_DRAFT);

    again.clear('s1');
    expect(createDraftsStore('ws_1', storage).get('s1')).toBe(EMPTY_DRAFT);
  });

  it('a quote from outside goes under what is there and asks for the focus; corrupt storage is ignored', () => {
    const storage = new MemoryStorage();
    const drafts = createDraftsStore('ws_1', storage);
    drafts.setText('s1', 'Look at this:  ');
    drafts.append('s1', 'src/a.ts:3\n```\nx\n```\n', { file: { root: MAIN_ROOT, path: 'src/a.ts' }, startLine: 3, endLine: 3 });
    expect(drafts.get('s1').text).toBe('Look at this:\n\nsrc/a.ts:3\n```\nx\n```\n');
    expect(drafts.get('s1').focusToken).toBe(1);
    drafts.append('s2', 'quote', null);
    expect(drafts.get('s2')).toMatchObject({ text: 'quote', source: null, focusToken: 1 });

    storage.setItem('smurg.drafts.ws_9', '{"not":"a list"}');
    expect(createDraftsStore('ws_9', storage).getState().size).toBe(0);
    storage.setItem('smurg.drafts.ws_8', JSON.stringify([['s1', { text: 'ok', source: { file: 'nope', startLine: 0, endLine: 0 } }], ['s2', { text: 5 }], 'junk']));
    expect([...createDraftsStore('ws_8', storage).getState()]).toEqual([['s1', { text: 'ok', source: null, focusToken: 0 }]]);

    const many = createDraftsStore('ws_7', storage);
    for (let index = 0; index < DRAFTS_MAX + 5; index++) many.setText(`s${index}`, 'x');
    expect(createDraftsStore('ws_7', storage).getState().size).toBe(DRAFTS_MAX);
    // Without a workspace nothing is kept.
    const loose = createDraftsStore(null, storage);
    loose.setText('s1', 'x');
    expect(loose.get('s1').text).toBe('x');
  });

  it('a member who is removed, whose device is revoked or whose browser belongs to another account now leaves no draft in this browser', () => {
    const KEY = 'smurg.drafts.ws_1';
    /** A workspace session as drafts see it: its connection's state, which a test moves by hand. */
    const workspace = () => {
      let state: ConnectionState = { kind: 'connecting', attempt: 1, retryAt: null, cause: null };
      const listeners = new Set<(state: ConnectionState) => void>();
      return {
        connection: {
          getState: () => state,
          subscribe: (listener: (state: ConnectionState) => void) => (listeners.add(listener), () => listeners.delete(listener)),
        },
        becomes(next: ConnectionState): void {
          state = next;
          for (const listener of [...listeners]) listener(next);
        },
        get listeners() {
          return listeners.size;
        },
      };
    };
    const ended: ConnectionState[] = [
      { kind: 'closed', reason: 'kicked', daemonReason: 'kicked' },
      { kind: 'closed', reason: 'revoked', daemonReason: 'revoked' },
      { kind: 'rejected', reason: 'kicked' },
      { kind: 'rejected', reason: 'device-revoked' },
      { kind: 'rejected', reason: 'device-other-account' },
    ];
    for (const state of ended) {
      const session = workspace();
      const drafts = draftsOf(session, 'ws_1');
      expect(draftsOf(session, 'ws_1')).toBe(drafts);
      drafts.append('s1', 'src/secret.ts:1\n```\nconst key = 1;\n```\n', { file: { root: MAIN_ROOT, path: 'src/secret.ts' }, startLine: 1, endLine: 1 });
      expect(window.localStorage.getItem(KEY)).toContain('const key = 1;');
      session.becomes(state);
      expect(window.localStorage.getItem(KEY), JSON.stringify(state)).toBeNull();
      expect(drafts.getState().size).toBe(0);
      expect(session.listeners).toBe(0);
      // Nothing typed afterwards (the page still shows for a moment) is kept either.
      drafts.setText('s1', 'typed after the end');
      expect(window.localStorage.getItem(KEY)).toBeNull();
    }

    // What does not end the member's access keeps the drafts: the host is away, the page is closed, an old client.
    const kept: ConnectionState[] = [
      { kind: 'host-offline', reason: 'relay', since: 1 },
      { kind: 'closed', reason: 'local' },
      { kind: 'closed', reason: 'login-required' },
      { kind: 'rejected', reason: 'version' },
    ];
    for (const state of kept) {
      const session = workspace();
      draftsOf(session, 'ws_1').setText('s1', 'Half a thought');
      session.becomes(state);
      expect(window.localStorage.getItem(KEY), JSON.stringify(state)).toContain('Half a thought');
    }

    // A workspace that is opened when the access has already ended: what an earlier visit left goes at once.
    const late = workspace();
    late.becomes({ kind: 'rejected', reason: 'kicked' });
    expect(draftsOf(late, 'ws_1').getState().size).toBe(0);
    expect(window.localStorage.getItem(KEY)).toBeNull();

    // For the places that end a member's access themselves (logging out, leaving).
    const storage = new MemoryStorage();
    createDraftsStore('ws_2', storage).setText('s1', 'x');
    createDraftsStore('ws_3', storage).setText('s1', 'y');
    forgetDrafts('ws_2', storage);
    expect(storage.getItem('smurg.drafts.ws_2')).toBeNull();
    expect(storage.getItem('smurg.drafts.ws_3')).not.toBeNull();
  });
});

describe('diff', () => {
  it('numbers the lines from the hunk headers, and from 1 without them', () => {
    const lines = parseDiff('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -41,3 +41,4 @@ function a()\n context\n-old\n+new\n+more\n\\ No newline at end of file\n');
    expect(lines.map((line) => [line.kind, line.number])).toEqual([
      ['meta', null],
      ['meta', null],
      ['hunk', null],
      ['context', 41],
      ['del', 42],
      ['add', 42],
      ['add', 43],
      ['meta', null],
    ]);
    expect(lines[3]?.text).toBe('context');
    expect(diffStat(lines)).toEqual({ additions: 2, deletions: 1 });
    expect(parseDiff('+first\n+second').map((line) => line.number)).toEqual([1, 2]);
    expect(parseDiff('')).toEqual([]);
    // A replacement the daemon could not number has a heading and no line numbers.
    expect(parseDiff('@@ replacement 1 of 2 @@\n-a\n+b').map((line) => [line.kind, line.number])).toEqual([['hunk', null], ['del', null], ['add', null]]);
  });

  it('a removed line "-- x" and an added line "++n" are a removal and an addition with their numbers, never a file heading', () => {
    // What the daemon sends for an edit that removes the SQL comment "-- old" and adds the line "++n, evil();".
    const lines = parseDiff('--- a/src/a.js\n+++ b/src/a.js\n@@ -7,3 +7,3 @@\n before\n--- old\n+++n, evil();\n after\n');
    expect(lines.map((line) => [line.kind, line.number, line.text])).toEqual([
      ['meta', null, '--- a/src/a.js'],
      ['meta', null, '+++ b/src/a.js'],
      ['hunk', null, '@@ -7,3 +7,3 @@'],
      ['context', 7, 'before'],
      ['del', 8, '-- old'],
      ['add', 8, '++n, evil();'],
      ['context', 9, 'after'],
    ]);
    expect(diffStat(lines)).toEqual({ additions: 1, deletions: 1 });
    // The diff of a tool's result has no file heading: its first lines are changes whatever they start with.
    expect(parseDiff('@@ -1,1 +1,1 @@\n--- a\n+++ b').map((line) => [line.kind, line.number, line.text])).toEqual([
      ['hunk', null, '@@ -1,1 +1,1 @@'],
      ['del', 1, '-- a'],
      ['add', 1, '++ b'],
    ]);
    // A new file whose first line starts with "++" (no heading at all), and a lone "--- " line with no "+++ " under it.
    expect(parseDiff('+++ b/x\n+second').map((line) => [line.kind, line.number, line.text])).toEqual([['add', 1, '++ b/x'], ['add', 2, 'second']]);
    expect(parseDiff('--- a/x\n-gone').map((line) => line.kind)).toEqual(['del', 'del']);
    // The replacements the daemon could not diff keep the file heading above their own headings.
    expect(parseDiff('--- /dev/null\n+++ b/new.sql\n@@ replacement 1 of 1 @@\n--- x\n+++ y').map((line) => line.kind)).toEqual(['meta', 'meta', 'hunk', 'del', 'add']);
  });
});

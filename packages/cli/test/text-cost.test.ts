// What a text costs the CLI that reads it (review, last round, N1).
//
// `smurg attach` writes another person's session into this person's terminal and lists sessions by names and titles
// other members and agents chose. Each function that is handed such text is walked through the hostile texts of
// `@smurg/protocol/testing` at one size and at sixteen times that size; sixteen times the text may cost about sixteen
// times as much. The lists at the end say which source files hold a regular expression, a `normalize`, a collation or
// a sort: a new one is looked at (and its function added to LOOKS when it is handed such text) before a number changes.
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LARGE_CHARS, buildAgentSession, buildTerminalSession, countInSources, disproportionate, isSourceName, type Look } from '@smurg/protocol/testing';
import { describe, expect, it } from 'vitest';
import { readOnlyNotice, sessionTitle } from '../src/attach/attach-session.ts';
import { OutputFilter } from '../src/attach/output-filter.ts';
import { clipColumn, displayWidth, padColumn } from '../src/cli/columns.ts';
import { deviceName, formatSessionList } from '../src/commands/attach.ts';
import { m, renderText, wireError } from '../src/i18n/index.ts';
import { parseVersion } from '../src/update/versions.ts';

const user = (displayName: string) => ({ userId: 'dev:amy', displayName });

/** Every function of src/ that is handed text a member, an agent or a program in a session wrote. */
const LOOKS: Readonly<Record<string, Look>> = {
  'OutputFilter (what a session prints, on its way to this terminal)': {
    run: (text) => {
      const bytes = new Uint8Array(Buffer.from(text, 'utf8'));
      void new OutputFilter({ utf8: false }).push(bytes);
      // In pieces: a sequence may be cut anywhere.
      const filter = new OutputFilter();
      for (let at = 0; at < bytes.length; at += 4_093) filter.push(bytes.subarray(at, at + 4_093));
    },
    fronts: ['\u001b[', '\u001b]0;', '\u001b]8;;http://a', '\u001bP', '\u009b'],
  },
  // (Names and titles are a few hundred characters: measured at a quarter of the usual size.)
  'displayWidth, padColumn and clipColumn (a column of the session list)': { run: (text) => void [displayWidth(text), padColumn(text, 24), clipColumn(text, 24)], chars: LARGE_CHARS / 4 },
  'formatSessionList, sessionTitle and readOnlyNotice (names and titles other people chose)': {
    run: (text) => {
      const sessions = [buildTerminalSession({ title: text, openedBy: user(text) }), buildAgentSession({ title: text, topicName: text, openedBy: user(text) })];
      for (const lang of ['en', 'zh-TW'] as const) void [formatSessionList(sessions, 'dev:ian', lang), renderText(lang, sessionTitle(sessions[0] as never)), renderText(lang, readOnlyNotice(sessions[0] as never))];
    },
    chars: LARGE_CHARS / 4,
  },
  'a name inside a sentence of the CLI, and an error the host sent': {
    run: (text) => {
      for (const lang of ['en', 'zh-TW'] as const) void [renderText(lang, m('attach.attaching.other', { title: text, owner: text })), renderText(lang, wireError({ code: 'conflict', message: text }))];
    },
  },
  'deviceName and parseVersion (a host name, a version a download names)': { run: (text) => void [deviceName(text), parseVersion(text), parseVersion(`1.2.3-${text}`)], fronts: ['1.2.3', '1.2.3-'] },
};

describe('what a text costs the CLI that reads it: packages/cli', () => {
  it.each(Object.entries(LOOKS))('sixteen times the text costs about sixteen times as much: %s', (_name, look) => {
    expect(disproportionate(look)).toEqual([]);
  }, 300_000);
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
 * program's own or this person's own (an argument, a version, a file of the release, the answer to a question the CLI
 * asked), or the walk above measures it. A NEW expression changes a number here: before changing the number, make
 * sure the expression cannot be tried again from every character of a long run of text someone else wrote (`x+$`,
 * `\s*:` behind a lazy group, two neighbours that match the same characters), and add its function to LOOKS above
 * when it is handed such text.
 */
const EXPRESSIONS: Readonly<Record<string, number>> = {
  'attach/attach-session.ts': 3,
  'attach/output-filter.ts': 7,
  'channel/discover.ts': 1,
  'cli/args.ts': 2,
  'cli/io.ts': 1,
  'commands/attach.ts': 3,
  'commands/host.ts': 1,
  'commands/stop.ts': 1,
  'commands/uninstall.ts': 2,
  'commands/update.ts': 3,
  'licenses/notices.ts': 5,
  'relay/login.ts': 1,
  'sea/native.ts': 2,
  'state/credentials.ts': 1,
  'update/downloads.ts': 4,
  'update/versions.ts': 3,
};

/** A sort, a collation, a `normalize`: where each is. All are sorts of a few names or versions; none is a `normalize` (packages/protocol/src/normalize.ts has the only one). */
const ORDERINGS: Readonly<Record<string, number>> = {
  'commands/attach.ts': 1,
  'commands/uninstall.ts': 3,
  'commands/update.ts': 1,
};

describe('the regular expressions, normalisations and sorts of packages/cli', () => {
  it('are the ones that were looked at: a new one is looked at before these lists change', () => {
    const found = countInSources(SOURCES);
    expect(found.expressions).toEqual(EXPRESSIONS);
    expect(found.orderings).toEqual(ORDERINGS);
    expect(Object.keys(SOURCES).filter((name) => (SOURCES[name] as string).includes('.normalize('))).toEqual([]);
  });
});

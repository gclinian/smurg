// What a text costs the process that reads it: the functions of this package (review, last round, N1).
//
// Every function here is handed text a member or an agent wrote, in the daemon (one thread for everybody), in the
// CLI and in every member's browser. Each is walked through the hostile texts of src/testing/text-cost.ts at one size
// and at sixteen times that size; sixteen times the text may cost about sixteen times as much. The lists at the end
// say which source files hold a regular expression, a `normalize`, a collation or a sort: a new one is looked at (and
// its function added to LOOKS when it is handed such text) before a number changes.
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultErrorRef, isMessageId, msg, render, renderEnglish, roleRef } from '../src/i18n/index.ts';
import {
  MARK_RUN_MAX,
  agentSafeName,
  agentText,
  agentTextWithin,
  checkRelPath,
  checkRememberableRule,
  composeRevise,
  entryPathSchema,
  fileRefKey,
  foldPathName,
  foldRelPath,
  folderHoldsPath,
  hasInvisibleCharacters,
  hasLongMarkRun,
  hasMaskable,
  isClaudeConfigPath,
  isHiddenTempName,
  isHostOnlyPath,
  isHostPrivatePath,
  isInTopicDir,
  largeTextSchema,
  lineTextSchema,
  mask,
  multilineTextSchema,
  normalized,
  offerAlwaysRule,
  parseInviteUrl,
  parseRuleString,
  pathSegmentSchema,
  personHeader,
  quoteForAgent,
  relPathSchema,
  ruleCoversRequest,
  shownAgentText,
  slugFromName,
  suggestionHeader,
  titleFromFirstMessage,
  topicFileKind,
  truncateToUtf8Bytes,
  visibleText,
  wireText,
  withFewMarks,
} from '../src/index.ts';
import { localeFromAcceptLanguage, matchLanguageTag, parseAppleLanguages } from '../src/locale/index.ts';
import { normalizeDeviceUserCode } from '../src/relay/device-login.ts';
import { relayDisplayNameSchema, sanitizeRelayDisplayName } from '../src/relay/frames.ts';
import { LARGE_CHARS, costOf, countInSources, cpuMs, disproportionate, isSourceName, type Look } from '../src/testing/index.ts';

const person = (displayName: string) => ({ userId: 'github:1', displayName, role: 'editor' as const });

/** Every function of src/ that is handed text a member or an agent wrote. */
const LOOKS: Readonly<Record<string, Look>> = {
  'agentText (a message, a suggestion, a comment, an answer, a note)': { run: (text) => void agentText(text), fronts: ['[', '[smurg', ' [a'] },
  'agentTextWithin and hasInvisibleCharacters (SPEC.md and PLAN.md before a Start)': { run: (text) => void [agentTextWithin(text, LARGE_CHARS), hasInvisibleCharacters(text)] },
  'agentText of what agentText gave (a text is cleaned again where it is composed and sent)': { run: (text) => void agentText(agentText(text).text) },
  'shownAgentText (what an agent wrote)': { run: (text) => void shownAgentText(text) },
  'visibleText (a command on a card, the commands of a project\u2019s settings)': { run: (text) => void [visibleText(text), visibleText(text, true)] },
  'agentSafeName, personHeader and suggestionHeader (a display name in a header)': { run: (text) => void [agentSafeName(text, text), personHeader(person(text)), suggestionHeader(person(text), person(text))] },
  quoteForAgent: { run: (text) => void quoteForAgent('text', text) },
  // (Four cleanings of each text and a quotation: measured at a quarter of the usual size.)
  'composeRevise ("Ask the agent to revise")': { run: (text) => void composeRevise({ target: 'spec', text, quote: { heading: text, text } }, LARGE_CHARS * 4), chars: LARGE_CHARS / 4 },
  'mask and hasMaskable (everything an agent or a tool wrote)': {
    run: (text) => void [mask(text), hasMaskable(text)],
    fronts: ['-----BEGIN PRIVATE KEY-----', '-----BEGIN A ', 'authorization', 'authorization: bearer ', 'token', 'token="', 'sk-', 'a.token'],
  },
  titleFromFirstMessage: { run: (text) => void titleFromFirstMessage(text) },
  'slugFromName (a topic\u2019s name)': { run: (text) => void slugFromName(text, ['topic-1']) },
  'a name inside a sentence of the host, in both languages': {
    run: (text) => {
      const ref = msg('session.title.item', { number: 1, title: text });
      void [wireText(ref), renderEnglish(ref), render('zh-TW', ref)];
    },
  },
  'defaultErrorRef, roleRef and isMessageId (the code of a refusal, a role, an id the other side names)': { run: (text) => void [defaultErrorRef(text), roleRef(text), isMessageId(text), render('zh-TW', { id: text })], fronts: ['bad', 'error.'] },
  'checkRelPath and the path schemas (every path of every request)': {
    run: (text) => void [checkRelPath(text), relPathSchema.safeParse(text), entryPathSchema.safeParse(text), pathSegmentSchema.safeParse(text)],
    fronts: ['a/'],
    // The schemas refuse a longer string before they look at it.
    chars: 16_384,
  },
  'foldPathName and foldRelPath (a name as a case-insensitive file system compares it)': { run: (text) => void [foldPathName(text), foldRelPath(text)], fronts: ['.claude/'] },
  'isHostOnlyPath, isHostPrivatePath and isClaudeConfigPath': { run: (text) => void [isHostOnlyPath(text), isHostPrivatePath(text), isClaudeConfigPath(text)], fronts: ['.git/'] },
  'topicFileKind, isInTopicDir and folderHoldsPath': { run: (text) => void [topicFileKind(text, 'cart'), isInTopicDir(text, 'cart'), folderHoldsPath(text, `${text}/a`)], fronts: ['specs/cart/'] },
  isHiddenTempName: { run: (text) => void isHiddenTempName(text), fronts: ['.', '.a.tmp.1'] },
  fileRefKey: { run: (text) => void fileRefKey({ root: { kind: 'main' }, path: text }) },
  'checkRememberableRule, ruleCoversRequest and offerAlwaysRule (a rule a member asks to remember)': {
    run: (text) =>
      void [
        checkRememberableRule('Bash', text),
        checkRememberableRule('WebFetch', `domain:${text}`),
        ruleCoversRequest({ tool: 'Bash', pattern: `${text}:*` }, { tool: 'Bash', target: text }),
        ruleCoversRequest({ tool: 'WebFetch', pattern: 'domain:example.com' }, { tool: 'WebFetch', target: `https://${text}/` }),
        offerAlwaysRule({ tool: 'Bash', pattern: `${text} *` }, false),
      ],
    fronts: ['npm run ', 'a.'],
  },
  parseRuleString: { run: (text) => void parseRuleString(text), fronts: ['Bash(', 'Bash'] },
  'sanitizeRelayDisplayName and the display name schema': { run: (text) => void [sanitizeRelayDisplayName(text, text), relayDisplayNameSchema.safeParse(text)] },
  normalizeDeviceUserCode: { run: (text) => void normalizeDeviceUserCode(text) },
  'the text schemas (single-line, multi-line, large)': { run: (text) => void [lineTextSchema(LARGE_CHARS).safeParse(text), multilineTextSchema(LARGE_CHARS).safeParse(text), largeTextSchema(LARGE_CHARS).safeParse(text)] },
  truncateToUtf8Bytes: { run: (text) => void truncateToUtf8Bytes(text, text.length) },
  'localeFromAcceptLanguage, matchLanguageTag and parseAppleLanguages': { run: (text) => void [localeFromAcceptLanguage(text), matchLanguageTag(text), parseAppleLanguages(text)], fronts: ['en;q', 'en;q=0.', '"'] },
  parseInviteUrl: { run: (text) => void parseInviteUrl(text), fronts: ['https://smurg.app/join/', 'https://smurg.app/join/AbCdEfGh_-012345#'], throws: true },
  'withFewMarks, hasLongMarkRun and normalized in the four forms': { run: (text) => void [withFewMarks(text), hasLongMarkRun(text), normalized(text, 'NFC'), normalized(text, 'NFD'), normalized(text, 'NFKC'), normalized(text, 'NFKD')] },
};

describe('what a text costs the process that reads it: packages/protocol', () => {
  it.each(Object.entries(LOOKS))('sixteen times the text costs about sixteen times as much: %s', (_name, look) => {
    expect(disproportionate(look)).toEqual([]);
  }, 300_000);

  it('one message of the largest size made of accents costs what its length costs (normalize took 1 to 2 s for it)', () => {
    // Marks of two combining classes in turn: putting one run of them in order costs the square of the run.
    const marks = `a${'\u0301\u0316'.repeat(32_768)}`;
    const took = costOf(() => void agentText(marks), 0, 1);
    expect(took).toBeLessThan(100);
    // The first thirty marks are kept, in the canonical order, and the letter takes the accent it can.
    expect(agentText(marks)).toEqual({ text: `\u00e1${'\u0316'.repeat(15)}${'\u0301'.repeat(14)}`, cleaned: true });
    // The same marks kept apart by characters agentText itself removes, and by the joiner it keeps between marks.
    for (const between of ['\u200b', '\u2060', '\u200d']) {
      const apart = `a${`\u0301${between}\u0316${between}`.repeat(16_384)}`;
      const started = cpuMs();
      const once = agentText(apart);
      const twice = agentText(once.text);
      expect(cpuMs() - started).toBeLessThan(200);
      expect(twice).toEqual({ text: once.text, cleaned: false });
    }
  });
});

describe('a run of combining marks (N1)', () => {
  const word = (marks: number): string => `e${'\u0301'.repeat(marks)}`;

  it('is cut to its first thirty before a text is normalised, and the text says something was removed', () => {
    expect(withFewMarks(`a${'\u0316'.repeat(MARK_RUN_MAX)}b`)).toBe(`a${'\u0316'.repeat(MARK_RUN_MAX)}b`);
    expect(withFewMarks(`a${'\u0316'.repeat(MARK_RUN_MAX + 1)}b${'\u0301'.repeat(40)}`)).toBe(`a${'\u0316'.repeat(MARK_RUN_MAX)}b${'\u0301'.repeat(MARK_RUN_MAX)}`);
    expect(hasLongMarkRun(word(MARK_RUN_MAX))).toBe(false);
    expect(hasLongMarkRun(word(MARK_RUN_MAX + 1))).toBe(true);
    // Marks outside the Basic Multilingual Plane are one mark each, and the half-width sound marks count.
    expect(withFewMarks(`a${'\u{1d165}'.repeat(40)}`)).toBe(`a${'\u{1d165}'.repeat(MARK_RUN_MAX)}`);
    expect(withFewMarks(`\u30ab${'\uff9e'.repeat(40)}`)).toBe(`\u30ab${'\uff9e'.repeat(MARK_RUN_MAX)}`);
    // An ordinary text is the same string, not a copy.
    const plain = 'Cafe\u0301 \u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35 \u05e9\u05b8\u05c1\u05dc\u05d5\u05b9\u05dd \u{1F469}\u200d\u{1F4BB}';
    expect(withFewMarks(plain)).toBe(plain);
    expect(agentText(`Zalgo ${word(64)} text`)).toEqual({ text: `Zalgo \u00e9${'\u0301'.repeat(MARK_RUN_MAX - 1)} text`, cleaned: true });
    expect(agentText(`${word(MARK_RUN_MAX)} is kept`)).toEqual({ text: `\u00e9${'\u0301'.repeat(MARK_RUN_MAX - 1)} is kept`, cleaned: false });
    expect(hasInvisibleCharacters(word(31))).toBe(true);
  });

  it('agentText gives a text it leaves alone: marks around a removed character are put in order once, a mark that splits in two is counted after it split', () => {
    const texts = [
      'e\u0301\u200b\u0316',
      `a${'\u0301\u200b\u0316'.repeat(40)}`,
      `a${'\u0344'.repeat(MARK_RUN_MAX)}`,
      `a${'\u0301'.repeat(MARK_RUN_MAX)}\ufe0f`,
      `a${'\u0316\u0301'.repeat(15)}\u200d${'\u0301\u0316'.repeat(20)}b`,
      `\u1100\u200b\u1161${'\u0f71\u0f72'.repeat(40)}`,
    ];
    for (const raw of texts) {
      const once = agentText(raw);
      expect(agentText(once.text), JSON.stringify(raw)).toEqual({ text: once.text, cleaned: false });
      expect(once.text.normalize('NFC'), JSON.stringify(raw)).toBe(once.text);
      expect(hasLongMarkRun(once.text), JSON.stringify(raw)).toBe(false);
    }
    expect(agentText('e\u0301\u200b\u0316').text).toBe('\u00e9\u0316'.normalize('NFC'));
  });

  it('a name with such a run is no path: it is refused, not cut to the name of another file', () => {
    const name = (marks: number): string => `a${'\u0301\u0316'.repeat(marks / 2)}.md`;
    expect(checkRelPath(`docs/${name(MARK_RUN_MAX)}`).ok).toBe(true);
    expect(checkRelPath(`docs/${name(MARK_RUN_MAX + 2)}`)).toEqual({ ok: false, problem: 'mark-run' });
    expect(relPathSchema.safeParse(name(64)).success).toBe(false);
    // Neither with the characters between the marks that a file system leaves out when it compares names …
    expect(checkRelPath(`a${'\u0301\u200d'.repeat(MARK_RUN_MAX + 1)}`)).toEqual({ ok: false, problem: 'mark-run' });
    // … nor when the run is only that long once it is normalised (U+0344 is two marks in every normal form).
    expect(checkRelPath(`a${'\u0344'.repeat(MARK_RUN_MAX)}`)).toEqual({ ok: false, problem: 'mark-run' });
    // So a path that passed has one key, whatever is folded: two names never share one.
    const kept = checkRelPath(`A${'\u0301\u0316'.repeat(15)}\u200d\u00e9/B.md`);
    expect(kept.ok && foldRelPath(kept.path) === foldRelPath(`${kept.path}`)).toBe(true);
    expect(foldPathName(`a${'\u0301'.repeat(MARK_RUN_MAX)}`)).not.toBe(foldPathName(`a${'\u0301'.repeat(MARK_RUN_MAX - 1)}`));
    // What is no path at all still folds at the cost of its length: every name beyond the thirtieth mark is one name.
    expect(foldPathName(`.CLAUDE${'\u0301'.repeat(200)}`)).toBe(foldPathName(`.claude${'\u0301'.repeat(100)}`));
  });

  it('every code point that normalize moves, in any form, is one the cut counts', () => {
    // A code point has no place of its own in the canonical order when U+0345 (the highest class) in front of it is
    // moved behind it. Whatever a code point becomes in a normal form: once every such run is cut, what is left of it
    // holds no run that the form could not have been handed in an ordinary word.
    const moved = (text: string): boolean => {
      for (const char of text) if (char !== '\u0345' && `\u0345${char}`.normalize('NFD') === `\u0345${char}`) return false;
      return text.length > 0;
    };
    const uncounted: string[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const char = String.fromCodePoint(point);
      if (withFewMarks(char.repeat(MARK_RUN_MAX + 1)).length < char.length * (MARK_RUN_MAX + 1)) continue;
      for (const form of ['NFD', 'NFKD'] as const) {
        const parts = char.normalize(form);
        if (moved(parts) || (parts !== char && moved(String.fromCodePoint(parts.codePointAt(0) as number)))) uncounted.push(`U+${point.toString(16)} in ${form}`);
      }
    }
    expect(uncounted).toEqual([]);
  }, 120_000);

  it('normalising gives no character that agentText removes, so a text is cleaned before it is normalised', () => {
    const made: string[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const char = String.fromCodePoint(point);
      const normal = char.normalize('NFC');
      if (normal !== char && !agentText(`a${char}b`).cleaned && agentText(`a${normal}b`).cleaned) made.push(`U+${point.toString(16)}`);
    }
    expect(made).toEqual([]);
  }, 120_000);
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
 * program's own (an id, a route, a catalogue string), or the walk above measures it. A NEW expression changes a
 * number here: before changing the number, make sure the expression cannot be tried again from every character of a
 * long run of text someone else wrote (`x+$`, `\s*:` behind a lazy group, two neighbours that match the same
 * characters), and add its function to LOOKS above when it is handed such text.
 */
const EXPRESSIONS: Readonly<Record<string, number>> = {
  'agent-text.ts': 14,
  'bytes.ts': 2,
  'client/relay-api.ts': 3,
  'i18n/define.ts': 2,
  'i18n/index.ts': 1,
  'invite.ts': 3,
  'locale/index.ts': 3,
  'mask.ts': 14,
  'names.ts': 5,
  'noise/patterns.ts': 2,
  'noise/testing/vectors.ts': 2,
  'normalize.ts': 1,
  'relay/device-login.ts': 5,
  'relay/frames.ts': 4,
  'relay/routes.ts': 2,
  'rules.ts': 8,
  'schema/entities.ts': 8,
  'schema/inbox.ts': 1,
  'schema/messages/admin.ts': 1,
  'schema/paths.ts': 7,
  'schema/primitives.ts': 10,
  'testing/text-cost.ts': 3,
  'wire-text.ts': 1,
};

/**
 * `normalize`, `localeCompare`, a collator, a sort: where each is. normalize.ts holds THE `normalize` (no run of marks
 * longer than MARK_RUN_MAX reaches it); relay/device-login.ts holds one more, of a text of at most 64 characters (the
 * relay's entry may import nothing of this package but constants.ts). The two others are sorts: of the entries of an
 * Accept-Language header (at most a few), and of the source file names in the helper of this test.
 */
const ORDERINGS: Readonly<Record<string, number>> = {
  'locale/index.ts': 1,
  'normalize.ts': 1,
  'relay/device-login.ts': 1,
  'testing/text-cost.ts': 1,
};

describe('the regular expressions, normalisations and sorts of packages/protocol', () => {
  it('are the ones that were looked at: a new one is looked at before these lists change', () => {
    const found = countInSources(SOURCES);
    expect(found.expressions).toEqual(EXPRESSIONS);
    expect(found.orderings).toEqual(ORDERINGS);
    expect(Object.keys(SOURCES).filter((name) => (SOURCES[name] as string).includes('.normalize(')).sort()).toEqual(['normalize.ts', 'relay/device-login.ts']);
  });
});

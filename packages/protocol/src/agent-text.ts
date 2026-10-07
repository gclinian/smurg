// Everything that goes to a model passes ONE of the three functions here (ARCHITECTURE §5.9 "Text for agents"): the
// sessions, conversation, suggestion and topics modules, the hook texts and the MCP answers all use the same ones, so
// what a member with agent access sees on a card is exactly the characters the agent gets.
//
//  - agentText(raw)                 every string a PERSON wrote (messages, suggestions, notes, "Other" answers,
//                                   comments, a denial's line): invisible characters removed, header-like lines quoted
//  - shownAgentText(raw)            the other direction: text an AGENT wrote, before it is stored and shown to people
//  - agentSafeName(name, userId)    a display name as a model reads it (headers, notes, sentences, commit trailers)
//  - frameMessage(header, body)     the header line in front of a body
//
// Pure, no imports beyond the limits: browser, Worker and Node safe.
import type { Role } from './roles.ts';
import { AGENT_SAFE_NAME_MAX } from './schema/limits.ts';

// ---------------------------------------------------------------------------------------------------------------
// agentText
// ---------------------------------------------------------------------------------------------------------------

const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const TAB = 0x09;
const LF = 0x0a;

/** C0 and C1 controls and DEL. Tab and LF are kept by the caller. */
function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

/**
 * Code points a reader cannot see: Unicode's default-ignorable set (the tag block, zero-width characters, word
 * joiners, variation selectors, invisible operators, fillers) and every bidirectional control. ZWJ and VS16 are in
 * here too; `agentText` keeps them where an emoji needs them.
 */
function isInvisible(cp: number): boolean {
  return (
    cp === 0x00ad || // soft hyphen
    cp === 0x034f || // combining grapheme joiner
    cp === 0x061c || // Arabic letter mark
    cp === 0x115f ||
    cp === 0x1160 || // Hangul fillers
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    (cp >= 0x180b && cp <= 0x180f) || // Mongolian variation selectors and vowel separator
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space / non-joiner / joiner, LRM, RLM
    (cp >= 0x202a && cp <= 0x202e) || // bidi embeddings and overrides
    (cp >= 0x2060 && cp <= 0x206f) || // word joiner, invisible operators, bidi isolates, deprecated format characters
    cp === 0x3164 || // Hangul filler
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    cp === 0xfeff || // zero-width no-break space (BOM)
    cp === 0xffa0 ||
    (cp >= 0xfff0 && cp <= 0xfff8) ||
    (cp >= 0x1bca0 && cp <= 0x1bca3) || // shorthand format controls
    (cp >= 0x1d173 && cp <= 0x1d17a) || // musical format controls
    (cp >= 0xe0000 && cp <= 0xe0fff) // the tag block and the variation selector supplement
  );
}

const WHITESPACE = /^\s$/u;

/** A character a person sees (not a control, not invisible, not white space). */
function isVisible(cp: number | undefined): boolean {
  if (cp === undefined) return false;
  return !isControl(cp) && !isInvisible(cp) && !WHITESPACE.test(String.fromCodePoint(cp));
}

/**
 * A line that looks like a header: `[…]` alone on its line, whatever blank characters stand around it (every Unicode
 * white space, and the braille blank, which is none but renders as one); or a line that STARTS like smurg's own
 * header, with text behind it on the same line (the role prompts say: a line that starts with `[smurg <tag>]` is the
 * workspace software itself). A line that merely starts with a bracket (`[x] done`, a link) is left alone.
 */
const HEADER_LIKE_LINE = /^[\s\u2800]*\[(?:.*\][\s\u2800]*$|\s*smurg(?![\p{L}\p{N}_]))/iu;
const QUOTE_PREFIX = '> ';
/** What ends a line: CRLF, CR, and Unicode's line and paragraph separators (each becomes LF). */
const LINE_ENDS = /\r\n?|[\u2028\u2029]/g;

export interface AgentText {
  /** What is stored, what the card shows and what is sent. */
  readonly text: string;
  /** Something a reader could not see was removed ("Hidden characters were removed"). */
  readonly cleaned: boolean;
}

/**
 * Cleans a string a person wrote before it is stored, shown and sent to an agent:
 *  - NFC; CRLF, lone CR and Unicode's line and paragraph separators become LF; lone surrogates are dropped;
 *  - C0 / C1 controls are removed, except tab and newline;
 *  - invisible code points are removed (see isInvisible); the emoji joiner U+200D is kept only between two visible
 *    characters, the emoji presentation selector U+FE0F only directly after a visible character;
 *  - a line that looks like a header (HEADER_LIKE_LINE) gets `> ` in front, so no body line can pass for the header
 *    of a person or of smurg itself.
 * `cleaned` is true when a control or an invisible character was removed (not for line endings, NFC or the quoting).
 * Idempotent: `agentText(agentText(x).text)` changes nothing.
 */
export function agentText(raw: string): AgentText {
  const { text: joined, cleaned } = withoutUnseen(raw.normalize('NFC').replace(LINE_ENDS, '\n'));
  const lines = joined.split('\n');
  const text = lines.map((line) => (HEADER_LIKE_LINE.test(line) ? QUOTE_PREFIX + line : line)).join('\n');
  return { text, cleaned };
}

/**
 * Text an AGENT wrote, as it is stored and shown to everyone (text blocks of a conversation): the characters a reader
 * cannot see are removed exactly as from a person's text (controls except tab and newline, every bidirectional
 * control, the invisible code points; an emoji's joiner and presentation selector stay). So what people read, in the
 * order they read it, is what is there: a command an agent quotes cannot show in another order than it copies.
 * No line is quoted (this text is not sent to an agent) and nothing is normalised.
 */
export function shownAgentText(raw: string): string {
  return withoutUnseen(raw.replace(/\r\n/g, '\n')).text;
}

/** `source` without lone surrogates, controls (tab and LF stay) and invisible code points; ZWJ and VS16 where an emoji needs them. */
function withoutUnseen(source: string): AgentText {
  const points: number[] = [];
  let cleaned = false;
  for (const char of source) {
    const cp = char.codePointAt(0) as number;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      cleaned = true; // a lone surrogate (a pair iterates as one code point above U+FFFF)
      continue;
    }
    points.push(cp);
  }
  const kept: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const cp = points[i] as number;
    if (cp === TAB || cp === LF) {
      kept.push(cp);
      continue;
    }
    if (isControl(cp)) {
      cleaned = true;
      continue;
    }
    if (!isInvisible(cp)) {
      kept.push(cp);
      continue;
    }
    const previous = kept[kept.length - 1];
    const keep =
      (cp === ZWJ && isVisible(previous) && isVisible(points[i + 1])) || (cp === VS16 && isVisible(previous));
    if (keep) kept.push(cp);
    else cleaned = true;
  }
  let text = '';
  for (const cp of kept) text += String.fromCodePoint(cp);
  return { text, cleaned };
}

/** Whether `text` holds a character people cannot see (the Start dialog's warning about the spec and plan files). */
export function hasInvisibleCharacters(text: string): boolean {
  return agentText(text).cleaned;
}

export type AgentTextWithin =
  | { readonly ok: true; readonly text: string; readonly cleaned: boolean }
  | { readonly ok: false; readonly reason: 'blank' | 'too-long' };

/**
 * `agentText` plus the two checks every handler needs afterwards: the cleaned text is not blank, and (quoting may add
 * characters) still fits `maxChars` UTF-16 units.
 */
export function agentTextWithin(raw: string, maxChars: number): AgentTextWithin {
  const { text, cleaned } = agentText(raw);
  if (!/\S/u.test(text)) return { ok: false, reason: 'blank' };
  if (text.length > maxChars) return { ok: false, reason: 'too-long' };
  return { ok: true, text, cleaned };
}

// ---------------------------------------------------------------------------------------------------------------
// agentSafeName
// ---------------------------------------------------------------------------------------------------------------

const SAFE_NAME_CHAR = /[\p{L}\p{M}\p{N} ._-]/u;
const USER_ID_PROVIDER = /^[a-z]+:/;

/**
 * A display name as a model reads it. Display names are free text from an identity provider (up to 256 characters);
 * for a model they become at most AGENT_SAFE_NAME_MAX code points of letters, marks and digits of any script, space,
 * `.`, `_` and `-` (white space collapsed, trimmed). A name with nothing left is `member <the first 4 safe characters
 * of the user id's own part>` (`github:12345` → `member 1234`). The interface keeps showing the real display name.
 */
export function agentSafeName(displayName: string, userId: string): string {
  const safe = keepSafe(displayName.normalize('NFC'), AGENT_SAFE_NAME_MAX);
  if (safe !== '') return safe;
  const idPart = keepSafe(userId.replace(USER_ID_PROVIDER, ''), 4).replaceAll(' ', '');
  return idPart === '' ? 'member' : `member ${idPart}`;
}

function keepSafe(text: string, max: number): string {
  let out = '';
  let count = 0;
  let pendingSpace = false;
  for (const char of text) {
    if (count >= max) break;
    if (/\s/u.test(char)) {
      pendingSpace = out !== '';
      continue;
    }
    if (!SAFE_NAME_CHAR.test(char)) continue;
    if (pendingSpace) {
      if (count + 1 >= max) break;
      out += ' ';
      count += 1;
      pendingSpace = false;
    }
    out += char;
    count += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------------------------------------------

/** Role names in headers: fixed English, whatever language anyone reads. */
export const AGENT_ROLE_NAMES: Readonly<Record<Role, string>> = Object.freeze({
  host: 'Host',
  agent: 'Agent access',
  editor: 'Editor',
  viewer: 'Viewer',
});

/** smurg's own tag in a session: four characters drawn at random per session, announced in the role prompt. */
export const SMURG_TAG_PATTERN = /^[a-z0-9]{4}$/;
export const SMURG_TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface HeaderPerson {
  readonly userId: string;
  readonly displayName: string;
  readonly role: Role;
}

/** `[Ian · Host]`: the first line of every text a person sends to an agent. */
export function personHeader(person: HeaderPerson): string {
  return `[${agentSafeName(person.displayName, person.userId)} · ${AGENT_ROLE_NAMES[person.role]}]`;
}

/** `[Amy · Editor, suggestion accepted by Ian]`. */
export function suggestionHeader(author: HeaderPerson, acceptedBy: { readonly userId: string; readonly displayName: string }): string {
  return `[${agentSafeName(author.displayName, author.userId)} · ${AGENT_ROLE_NAMES[author.role]}, suggestion accepted by ${agentSafeName(acceptedBy.displayName, acceptedBy.userId)}]`;
}

/** `[smurg k7f2]`: the first line of every message smurg writes itself. Throws on a tag that is not one. */
export function smurgHeader(tag: string): string {
  if (!SMURG_TAG_PATTERN.test(tag)) throw new TypeError('not a smurg tag');
  return `[smurg ${tag}]`;
}

/**
 * The header line and a newline in front of the body. Because of it no message starts with `/`, so Claude Code runs
 * none of them as a slash command.
 */
export function frameMessage(header: string, body: string): string {
  return `${header}\n${body}`;
}

/**
 * A fenced quotation for text an agent must see as information, not as instructions (the decisions of a lost
 * discussion): a fence longer than any run of backticks inside, labelled, the body through `agentText`.
 */
export function quoteForAgent(label: string, body: string): string {
  const text = agentText(body).text;
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${label}\n${text}\n${fence}`;
}

/**
 * The text of "Ask the agent to revise" (`topic.revise`) as it is stored, shown and sent, composed BEFORE a message is
 * sent or a suggestion is created (so a card shows exactly what an accept sends):
 *
 *   About SPEC.md, section "Cart rules":        a fixed English line naming the file; the heading JSON-quoted
 *   ```text                                     the quoted section as a fenced quotation (`quoteForAgent`)
 *   …
 *   ```
 *   <the person's own text>
 *
 * Without a quote the first line is `About SPEC.md:`; a quote without a heading says `About SPEC.md, this part:`.
 * Every part goes through `agentText`; `cleaned` says something a reader cannot see was removed from any of them.
 * Refused like `agentTextWithin`: `blank` (the person's own text is), `too-long` (the composed text exceeds `maxChars`).
 */
export function composeRevise(
  input: { readonly target: 'spec' | 'plan'; readonly text: string; readonly quote?: { readonly heading?: string; readonly text: string } },
  maxChars: number,
): AgentTextWithin {
  const own = agentText(input.text);
  if (!/\S/u.test(own.text)) return { ok: false, reason: 'blank' };
  const file = input.target === 'spec' ? 'SPEC.md' : 'PLAN.md';
  let cleaned = own.cleaned;
  let head = `About ${file}:`;
  let quoted = '';
  if (input.quote !== undefined) {
    const heading = agentText(input.quote.heading ?? '');
    const body = agentText(input.quote.text);
    cleaned ||= heading.cleaned || body.cleaned;
    const title = heading.text.replace(/\s+/gu, ' ').trim();
    head = title === '' ? `About ${file}, this part:` : `About ${file}, section ${JSON.stringify(title)}:`;
    quoted = `${quoteForAgent('text', body.text)}\n`;
  }
  const text = agentText(`${head}\n${quoted}${own.text}`).text;
  if (text.length > maxChars) return { ok: false, reason: 'too-long' };
  return { ok: true, text, cleaned };
}

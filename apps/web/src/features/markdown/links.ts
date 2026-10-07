import { authorityOf, HOST_MAX_CHARS, PORT_MAX_CHARS } from '../../lib/web-address.ts';

// Which addresses a link of agent or member text may lead to (DESIGN §5.5): http, https and mailto, nothing else.
// A relative address, a fragment, `javascript:`, `data:`, `file:`, `vscode:` … is not a link: its text is shown.
export const LINK_PROTOCOLS: readonly string[] = Object.freeze(['http:', 'https:', 'mailto:']);

/** The address as the browser will open it, or null when it must not become a link. */
export function safeHref(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // A scheme hidden behind white space or control characters is refused, not repaired.
  if (raw === '' || /[\u0000- \u007f]/.test(raw)) return null;
  // The browser's parser is handed nothing but a web address with a host of a host's length, or a mail address: it
  // reads a host through Unicode's normalisation, which costs the square of a long run of combining marks (seconds
  // for one address of a message's size, in the render, where nothing has a budget; review R4-03, fourth round).
  // `https:example.com` and `http:///x` would parse, but they are not what was written for a person to follow.
  if (!/^mailto:/i.test(raw)) {
    const authority = authorityOf(raw);
    if (authority === null || authority.length > HOST_MAX_CHARS + PORT_MAX_CHARS) return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!LINK_PROTOCOLS.includes(url.protocol)) return null;
  // An address that carries a name and a password shows one host and opens another's account.
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}

// ---- a link's text that is itself an address
//
// Everything below runs while a text is being rendered, on text anyone may have written, a link's words being as
// long as a paragraph may be (lex.ts). So it is written as single passes over the characters: no regular expression
// looks at the text here, because the obvious ones (a mail address, "punctuation at the end") are tried again from
// every character of a long run and cost the square of its length (review R4-03: seconds per message, at every mount).

/** What an address-looking word names: a host, a mail address, or an address that cannot be taken at its word. */
type Place = { readonly kind: 'web'; readonly host: string } | { readonly kind: 'mail'; readonly address: string } | { readonly kind: 'unclear' };

const UNCLEAR: Place = Object.freeze({ kind: 'unclear' });
/** `host` in lower case. A leading `www.` is not a difference between two places. */
const web = (host: string): Place => ({ kind: 'web', host: host.startsWith('www.') ? host.slice(4) : host });
const mail = (address: string): Place => ({ kind: 'mail', address });

/**
 * The endings under which a bare word (no `https://`, no `www.`, nothing after it) is read as a host: where the places
 * people know by name live. A bare word under any other ending is a file or a name from code far more often than a
 * place (`README.md`, `Node.js`, `event.target`, `user.name` are all real endings of host names too), and no spelling
 * tells the two apart. With a path behind it (`smurg.sh/install`) a word under ANY ending is a host.
 */
const HOST_ENDINGS: ReadonlySet<string> = new Set([
  ...['com', 'org', 'net', 'io', 'dev', 'app', 'ai', 'co', 'edu', 'gov', 'info', 'me', 'xyz', 'shop', 'tech', 'cloud', 'blog', 'biz', 'club', 'wiki', 'gg', 'tv', 'ly'],
  ...['tw', 'uk', 'us', 'de', 'jp', 'cn', 'fr', 'ca', 'au', 'eu', 'nl', 'ru', 'br', 'es', 'ch', 'se', 'kr', 'nz', 'mx', 'sg', 'hk', 'dk', 'fi', 'cz', 'pt', 'ie'],
]);

const code = (char: string): number => char.charCodeAt(0);
const isDigit = (unit: number): boolean => unit >= code('0') && unit <= code('9');
const isLetter = (unit: number): boolean => unit >= code('a') && unit <= code('z');
/** A character of a host name's label, as people write host names (lower case here). */
const isLabelChar = (unit: number): boolean => isLetter(unit) || isDigit(unit) || unit === code('-') || unit === code('_');
/** What ends the host of an address: the path, the port, the query, the fragment. */
const ENDS_HOST = '/\\:?#';

/** Whether `text[from, to)` is only digits (an empty stretch is). */
function onlyDigits(text: string, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) if (!isDigit(text.charCodeAt(index))) return false;
  return true;
}

/** What follows a host inside an address: nothing, a path / query / fragment, or a port of digits and then one of those. */
function portIsSound(word: string, from: number): boolean {
  if (from >= word.length || word[from] !== ':') return true;
  let end = from + 1;
  while (end < word.length && !'/\\?#'.includes(word[end] as string)) end += 1;
  return onlyDigits(word, from + 1, end);
}

/** The place `rest` (what follows `http://` or `https://`, in lower case) names. */
function placeOfAddress(rest: string): Place {
  let end = 0;
  while (end < rest.length && !'/\\?#'.includes(rest[end] as string)) end += 1;
  const authority = rest.slice(0, end);
  // A name and a password in front of the host show one place and open another's.
  if (authority === '' || authority.includes('@')) return UNCLEAR;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1 || !portIsSound(authority, close + 1) || (close + 1 < authority.length && authority[close + 1] !== ':')) return UNCLEAR;
    return web(authority.slice(0, close + 1));
  }
  const colon = authority.indexOf(':');
  const host = colon === -1 ? authority : authority.slice(0, colon);
  // Longer than a host name can be: nothing a browser reaches, and nothing to take at its word.
  if (host === '' || host.length > HOST_MAX_CHARS || !portIsSound(authority, host.length)) return UNCLEAR;
  // Anything a browser would first have to decode or rewrite (`%6d`, a character outside a host name) is not taken
  // at its word: it is compared as "another place", which shows the reader where the link really leads.
  for (let index = 0; index < host.length; index += 1) {
    const unit = host.charCodeAt(index);
    if (!isLabelChar(unit) && unit !== code('.')) return UNCLEAR;
  }
  return web(host);
}

/** Whether `word` (no white space in it) reads as a mail address: one "@", no "/" or ":", a dot inside what follows the "@". */
function isMailAddress(word: string): boolean {
  const at = word.indexOf('@');
  if (at <= 0 || word.indexOf('@', at + 1) !== -1 || word.includes('/') || word.includes(':')) return false;
  const dot = word.indexOf('.', at + 2);
  return dot !== -1 && dot < word.length - 1;
}

/**
 * The place a bare word (lower case, no scheme) names, or null when it is not an address: `github.com`,
 * `www.example.org/x`, `smurg.sh/install`, `192.168.1.1:8080`. Not `README.md`, `cart.ts:42`, `v1.2.3`, `src/app.ts`.
 */
function placeOfBareWord(word: string): Place | null {
  // The host: labels of letters, digits and hyphens with single dots between them, up to what ends a host.
  let end = 0;
  let labels = 0;
  let labelStart = 0;
  let numeric = true;
  let lastIsWord = false;
  for (; end <= word.length; end += 1) {
    const unit = end < word.length ? word.charCodeAt(end) : -1;
    if (unit !== -1 && (isLetter(unit) || isDigit(unit) || unit === code('-'))) continue;
    if (unit !== -1 && unit !== code('.') && !ENDS_HOST.includes(word[end] as string)) return null;
    // A label ends here.
    const length = end - labelStart;
    if (length === 0) return null;
    labels += 1;
    const digits = onlyDigits(word, labelStart, end);
    // A number address has four numbers below 256, none written with a leading zero (a browser reads that as octal).
    if (!digits || length > 3 || Number(word.slice(labelStart, end)) > 255 || (length > 1 && word[labelStart] === '0')) numeric = false;
    lastIsWord = length >= 2 && !digits && onlyLetters(word, labelStart, end);
    if (unit !== code('.')) break;
    labelStart = end + 1;
  }
  const host = word.slice(0, end);
  // A dotted word longer than a host name can be is not the name of a place.
  if (host.length > HOST_MAX_CHARS) return null;
  if (labels === 4 && numeric) return portIsSound(word, end) ? web(host) : UNCLEAR;
  if (labels < 2 || !lastIsWord) return null;
  const ending = word.slice(labelStart, end);
  const hasPath = end < word.length && (word[end] === '/' || word[end] === '\\');
  if (!word.startsWith('www.') && !HOST_ENDINGS.has(ending) && !hasPath) return null;
  // `cart.com:12` could be a port; `github.com:x` is nothing a browser opens as written.
  return portIsSound(word, end) ? web(host) : UNCLEAR;
}

function onlyLetters(text: string, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) if (!isLetter(text.charCodeAt(index))) return false;
  return true;
}

function placeOf(written: string): Place | null {
  const word = written.toLowerCase();
  if (word.startsWith('http://')) return placeOfAddress(word.slice('http://'.length));
  if (word.startsWith('https://')) return placeOfAddress(word.slice('https://'.length));
  if (word.startsWith('mailto:')) {
    const query = word.indexOf('?');
    return mail(word.slice('mailto:'.length, query === -1 ? word.length : query));
  }
  if (isMailAddress(word)) return mail(word);
  return placeOfBareWord(word);
}

// ---- names that only look like an address
//
// `github.c\u043em` with a Cyrillic "o" reads as github.com and is another name; so does a name written entirely in
// look-alike letters, and so does `github\u3002com` with a Chinese full stop for the dot (a browser takes that full stop
// for a dot too). No list of look-alike letters is complete, so the rule does not try: a dotted name with ANY letter
// from outside ASCII is never taken at its word (review R4-05, third round). What a browser opens for such a name is
// its ASCII form (`xn--…`), so even a link that leads to the very name it shows gets its destination written out.
//
// Chinese, Japanese and Korean are written without spaces, so their characters around a Latin name are the sentence
// the name stands in, not part of the name (`\u8acb\u5230github.com\u767b\u5165`): a label ends where the writing changes
// between those scripts and everything else. And their full stop is a full stop wherever one of their characters
// stands beside it.
//
// What a reader CANNOT SEE is not part of what the words read as: a zero width joiner or space, a word joiner, a soft
// hyphen, a variation selector, a tag (Unicode's own list: the characters a display leaves out when it has no
// picture for them). `github<U+200D>.com` reads "github.com" and was two words that name nothing to the rules above
// (review R4-05, fourth round). They are taken out before the words are read; and words that had one beside the dot
// of a name are never taken at their word, wherever the link leads: nobody puts one there for the reader.
//
// One exception to "any letter from outside ASCII": words that are the NAME OF THE FILE the link leads to (the last
// part of its path, decoded) are an ordinary link, as `README.md` on a link to a README.md always was. Only where no
// dot of the name is followed by what a host ends in (HOST_ENDINGS) or by other letters: whoever owns a destination
// writes its path, so `github.c\u043em` on a link to `https://evil.example/github.c\u043em` is still a name that looks
// like a place.

/** What a label of a name can be made of, in any script: letters, marks, digits. */
const NAME_CHAR = /[\p{L}\p{M}\p{N}]/u;
/** The scripts written without spaces between words. */
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
const IDEOGRAPHIC_FULL_STOP = '\u3002';

/** 0: not part of a label; 1: an ASCII label character; 2: a letter from outside ASCII; 3: a character of a script written without spaces. */
type LabelKind = 0 | 1 | 2 | 3;

function labelKind(char: string): LabelKind {
  if (char.length === 1 && char.charCodeAt(0) < 0x80) {
    const unit = char.toLowerCase().charCodeAt(0);
    return isLabelChar(unit) ? 1 : 0;
  }
  if (SPACELESS.test(char)) return 3;
  return NAME_CHAR.test(char) ? 2 : 0;
}

/** The character (one or two UTF-16 units) that ends just before `index`, or '' at the start. */
function charBefore(text: string, index: number): string {
  if (index <= 0) return '';
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text[index - 1] as string;
}

/** The character that starts at `index`, or '' at the end. */
function charAt(text: string, index: number): string {
  if (index >= text.length) return '';
  return String.fromCodePoint(text.codePointAt(index) as number);
}

/** Labels of the two writings never run into each other: 1 and 2 are one writing, 3 is the other. */
const sameWriting = (a: LabelKind, b: LabelKind): boolean => a !== 0 && b !== 0 && (a === 3) === (b === 3);

/**
 * `text` with every Chinese full stop that stands between two label characters of other scripts turned into the dot
 * it is read as there (`github\u3002com`). Beside a Chinese, Japanese or Korean character it ends a sentence and stays.
 */
function foldFullStops(text: string): string {
  let at = text.indexOf(IDEOGRAPHIC_FULL_STOP);
  if (at === -1) return text;
  const pieces: string[] = [];
  let from = 0;
  while (at !== -1) {
    const before = labelKind(charBefore(text, at));
    const after = labelKind(charAt(text, at + 1));
    if ((before === 1 || before === 2) && (after === 1 || after === 2)) {
      pieces.push(text.slice(from, at), '.');
      from = at + 1;
    }
    at = text.indexOf(IDEOGRAPHIC_FULL_STOP, at + 1);
  }
  if (from === 0) return text;
  pieces.push(text.slice(from));
  return pieces.join('');
}

/**
 * Whether `text` holds a dotted name with a letter from outside ASCII in one of the two labels at a dot: a name that
 * cannot be taken at its word. One pass: each dot looks at the label on either side of it, and a label ends at the
 * next dot. A label longer than a whole host name can be is not part of a name.
 *
 * `ofFile`: the text is the name of the file the link leads to. Then a dot counts only where what follows it is
 * what a host ends in (one of HOST_ENDINGS) or is itself written in other letters: `r\u00e9sum\u00e9.pdf` is a file,
 * `\u0430\u0440\u0440\u04cf\u0435.com` and `\u0430\u0440\u0440\u04cf\u0435.com login.md` read as a place whatever a path repeats.
 */
function holdsForeignName(text: string, ofFile: boolean): boolean {
  let dot = text.indexOf('.');
  while (dot !== -1) {
    let foreign = false;
    // The label before the dot.
    let start = dot;
    let first: LabelKind = 0;
    while (dot - start <= HOST_MAX_CHARS) {
      const char = charBefore(text, start);
      const kind = char === '' ? 0 : labelKind(char);
      if (first === 0) first = kind;
      if (!sameWriting(first, kind)) break;
      if (kind !== 1) foreign = true;
      start -= char.length;
    }
    if (start < dot && dot - start <= HOST_MAX_CHARS) {
      // The label after it.
      let end = dot + 1;
      let plain = true;
      first = 0;
      while (end - dot - 1 <= HOST_MAX_CHARS) {
        const char = charAt(text, end);
        const kind = char === '' ? 0 : labelKind(char);
        if (first === 0) first = kind;
        if (!sameWriting(first, kind)) break;
        if (kind !== 1) plain = false;
        end += char.length;
      }
      if (!plain) foreign = true;
      if (end > dot + 1 && end - dot - 1 <= HOST_MAX_CHARS && foreign) {
        if (!ofFile || !plain || HOST_ENDINGS.has(text.slice(dot + 1, end).toLowerCase())) return true;
      }
    }
    dot = text.indexOf('.', dot + 1);
  }
  return false;
}

/** What a reader cannot see: the characters a display leaves out by default (zero width, soft hyphen, selectors, tags). */
const UNSEEN = /\p{Default_Ignorable_Code_Point}/u;

/** Whether the character at `at` is a dot between the two labels of a name (for a Chinese full stop: as foldFullStops reads it). */
function isNameDot(text: string, at: number): boolean {
  const char = text[at];
  if (char !== '.' && char !== IDEOGRAPHIC_FULL_STOP) return false;
  const before = labelKind(charBefore(text, at));
  const after = labelKind(charAt(text, at + 1));
  if (char === '.') return before !== 0 && after !== 0;
  return (before === 1 || before === 2) && (after === 1 || after === 2);
}

/**
 * `text` as a reader reads it: every character in the form it looks like (full-width letters, a one-dot leader: the
 * compatibility form, NFKC) and without the characters that cannot be seen. `atDot`: one of those stood beside the
 * dot of a name.
 *
 * Each character is normalised BY ITSELF, one or two UTF-16 units at a time. `normalize` on a whole text puts every
 * run of combining marks in order by comparing them with each other, at the cost of the square of the run, and a
 * text can be made of characters that only BECOME marks when normalised (U+FF9E): 84 ms for one link of 15,800
 * such characters, in the render, at every mount (review R4-03, fourth round). No call of `normalize` in the web
 * app runs on text whose length someone else chose (test/text-cost.test.tsx keeps it so). Nothing is lost here:
 * whether words name a place does not depend on the order of their accents, or on a letter and its accent being
 * one character or two (either way it is a letter from outside ASCII).
 */
function asRead(text: string): { readonly text: string; readonly atDot: boolean } {
  const pieces: string[] = [];
  /** Where unseen characters were left out: the length of the result at that point. */
  const gaps: number[] = [];
  let length = 0;
  let from = 0;
  const keep = (to: number): void => {
    if (to <= from) return;
    pieces.push(text.slice(from, to));
    length += to - from;
  };
  let index = 0;
  while (index < text.length) {
    if (text.charCodeAt(index) < 0x80) {
      index += 1;
      continue;
    }
    const char = charAt(text, index);
    const next = index + char.length;
    if (UNSEEN.test(char)) {
      keep(index);
      if (gaps.at(-1) !== length) gaps.push(length);
      from = next;
    } else {
      const normal = char.normalize('NFKC');
      if (normal !== char) {
        keep(index);
        pieces.push(normal);
        length += normal.length;
        from = next;
      }
    }
    index = next;
  }
  if (from === 0) return { text, atDot: false };
  keep(text.length);
  const read = pieces.join('');
  return { text: read, atDot: gaps.some((gap) => (gap > 0 && isNameDot(read, gap - 1)) || isNameDot(read, gap)) };
}

/** Whether `text` has a character from outside ASCII at all (most links' words have none: nothing above runs for them). */
function hasNonAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) > 0x7f) return true;
  return false;
}

/**
 * Whether `text` is the name of the file `url` leads to: the last part of its path, decoded, character for character.
 * A name has no slash in it (an address can hide one in its last part as `%2F`).
 */
function isNameOfFile(text: string, url: URL): boolean {
  if (url.protocol === 'mailto:' || text.includes('/') || text.includes('\\')) return false;
  const path = url.pathname;
  const name = path.slice(path.lastIndexOf('/') + 1);
  // One UTF-16 unit of the words is at most nine characters of an address ("%E8%A8%AD").
  if (name === '' || name.length > text.length * 9) return false;
  try {
    return decodeURIComponent(name) === text;
  } catch {
    return false;
  }
}

/**
 * The longest words of a link that are read, in UTF-16 units: a few sentences. Longer words are written out with
 * their destination unread (the safe side), so what a link costs the render is bounded by a constant.
 */
export const LABEL_MAX_CHARS = 1_024;

/** What may stand in front of an address in a sentence, and after it. */
const OPENS = '("\'<[';
const CLOSES = ')"\'>].,;:!?';
/** A character of a word: printable ASCII. A host glued to words of another script is still found. */
const isWordUnit = (unit: number): boolean => unit >= 0x21 && unit <= 0x7e;

/**
 * Whether `text` (the words of a link, or of an image) names a place other than the one the link leads to:
 * `[https://github.com/…](https://evil.example/login)`, `[Sign in at github.com](https://evil.example)`,
 * `[amy@example.com](mailto:eve@evil.example)`, `![github.com/logo.png](https://evil.example/x.png)`.
 * `href` is an address safeHref() accepted. `www.` in front of a host is not a difference. Characters that only look
 * like ASCII (full-width letters, a one-dot leader or a Chinese full stop for the dot) are read as what they look
 * like, characters that cannot be seen are not read, and a dotted name with a letter from outside ASCII is always
 * "another place" unless it is the name of the file the link leads to (see above). Words longer than
 * LABEL_MAX_CHARS are "another place" unread.
 *
 * Linear in the length of the text, and bounded: see the note at the top of this part.
 */
export function namesAnotherPlace(text: string, href: string): boolean {
  if (text.length > LABEL_MAX_CHARS) return true;
  const url = new URL(href);
  let destination: Place;
  try {
    destination = url.protocol === 'mailto:' ? mail(decodeURIComponent(url.pathname).toLowerCase()) : web(url.hostname.toLowerCase());
  } catch {
    // A mail address that does not decode names nothing a text could agree with.
    destination = UNCLEAR;
  }
  // Pure ASCII is what it is. Anything else is read as what it looks like.
  let read = text;
  if (hasNonAscii(text)) {
    const seen = asRead(text);
    if (seen.atDot) return true;
    read = seen.text;
    if (hasNonAscii(read)) {
      read = foldFullStops(read);
      if (holdsForeignName(read, isNameOfFile(text, url))) return true;
    }
  }
  let index = 0;
  while (index < read.length) {
    if (!isWordUnit(read.charCodeAt(index))) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < read.length && isWordUnit(read.charCodeAt(end))) end += 1;
    let from = index;
    let to = end;
    while (from < to && OPENS.includes(read[from] as string)) from += 1;
    while (to > from && CLOSES.includes(read[to - 1] as string)) to -= 1;
    index = end;
    if (from === to) continue;
    const place = placeOf(read.slice(from, to));
    if (place === null) continue;
    if (place.kind !== destination.kind) return true;
    if (place.kind === 'web' && destination.kind === 'web' && place.host !== destination.host) return true;
    if (place.kind === 'mail' && destination.kind === 'mail' && place.address !== destination.address) return true;
  }
  return false;
}

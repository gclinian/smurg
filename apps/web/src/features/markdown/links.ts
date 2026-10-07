// Which addresses a link of agent or member text may lead to (DESIGN §5.5): http, https and mailto, nothing else.
// A relative address, a fragment, `javascript:`, `data:`, `file:`, `vscode:` … is not a link: its text is shown.
export const LINK_PROTOCOLS: readonly string[] = Object.freeze(['http:', 'https:', 'mailto:']);

/** The address as the browser will open it, or null when it must not become a link. */
export function safeHref(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // A scheme hidden behind white space or control characters is refused, not repaired.
  if (raw === '' || /[\u0000- \u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!LINK_PROTOCOLS.includes(url.protocol)) return null;
  // `https:example.com` and `http:///x` parse, but they are not what was written for a person to follow.
  if (url.protocol !== 'mailto:' && !/^https?:\/\/[^/]/i.test(raw)) return null;
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
  if (host === '' || !portIsSound(authority, host.length)) return UNCLEAR;
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
 * like ASCII (full-width letters, a one-dot leader for the dot) are read as what they look like.
 *
 * Linear in the length of the text: see the note at the top of this part.
 */
export function namesAnotherPlace(text: string, href: string): boolean {
  const url = new URL(href);
  let destination: Place;
  try {
    destination = url.protocol === 'mailto:' ? mail(decodeURIComponent(url.pathname).toLowerCase()) : web(url.hostname.toLowerCase());
  } catch {
    // A mail address that does not decode names nothing a text could agree with.
    destination = UNCLEAR;
  }
  const read = text.normalize('NFKC');
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

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

/** What an address-looking word names: a host, a mail address, or an address that cannot be taken at its word. */
type Place = { readonly kind: 'web'; readonly host: string } | { readonly kind: 'mail'; readonly address: string } | { readonly kind: 'unclear' };

const UNCLEAR: Place = Object.freeze({ kind: 'unclear' });
const web = (hostname: string): Place => ({ kind: 'web', host: hostname.toLowerCase().replace(/^www\./, '') });
const mail = (address: string): Place => ({ kind: 'mail', address: address.toLowerCase() });

/**
 * The endings under which a bare word (no `https://`, no `www.`) is read as a host: where the places people know by
 * name live. Without such a list every `Node.js`, `README.md` and `cart.ts` in a link's text would count as one.
 */
const HOST_ENDINGS: ReadonlySet<string> = new Set(['com', 'org', 'net', 'io', 'dev', 'app', 'ai', 'co', 'edu', 'gov', 'info', 'me', 'tw', 'uk', 'us', 'de', 'jp', 'cn', 'fr', 'ca', 'au']);
const BARE_HOST = /^(?:[a-z0-9-]+\.)+([a-z]{2,})(?:[/:?#]\S*)?$/i;
const MAIL_ADDRESS = /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/;

function placeOf(word: string): Place | null {
  if (/^https?:\/\//i.test(word)) {
    try {
      const url = new URL(word);
      return url.username !== '' || url.password !== '' ? UNCLEAR : web(url.hostname);
    } catch {
      return UNCLEAR;
    }
  }
  if (/^mailto:/i.test(word)) return mail(word.slice('mailto:'.length).split('?')[0] ?? '');
  if (MAIL_ADDRESS.test(word)) return mail(word);
  const bare = BARE_HOST.exec(word);
  if (bare === null || !(/^www\./i.test(word) || HOST_ENDINGS.has((bare[1] as string).toLowerCase()))) return null;
  try {
    return web(new URL(`http://${word}`).hostname);
  } catch {
    return UNCLEAR;
  }
}

/**
 * Whether the text of a link names a place other than the one the link leads to:
 * `[https://github.com/…](https://evil.example/login)`, `[Sign in at github.com](https://evil.example)`,
 * `[amy@example.com](mailto:eve@evil.example)`. `href` is an address safeHref() accepted. Words are the runs of ASCII
 * in the text (a host glued to words of another script is still found); `www.` in front of a host is not a difference.
 */
export function namesAnotherPlace(text: string, href: string): boolean {
  const url = new URL(href);
  let destination: Place;
  try {
    destination = url.protocol === 'mailto:' ? mail(decodeURIComponent(url.pathname)) : web(url.hostname);
  } catch {
    // A mail address that does not decode names nothing a text could agree with.
    destination = UNCLEAR;
  }
  for (const run of text.match(/[!-~]+/g) ?? []) {
    const place = placeOf(run.replace(/^[("'<[]+/, '').replace(/[)"'>\].,;:!?]+$/, ''));
    if (place === null) continue;
    if (place.kind !== destination.kind) return true;
    if (place.kind === 'web' && destination.kind === 'web' && place.host !== destination.host) return true;
    if (place.kind === 'mail' && destination.kind === 'mail' && place.address !== destination.address) return true;
  }
  return false;
}

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

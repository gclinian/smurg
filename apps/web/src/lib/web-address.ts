// What of an address is looked at BEFORE the browser's own parser is. `new URL()` reads the host of a web address
// through Unicode's normalisation (IDNA), which puts every run of combining marks in order at the cost of the square
// of the run: an address of a message's size with such a host took seconds, in a render or on a click, where nothing
// has a budget (review R4-03). A host name is at most 253 characters, so whatever is longer is not handed over.

/** The longest name a host can have (RFC 1035), in UTF-16 units as it is written. */
export const HOST_MAX_CHARS = 253;
/** What may stand behind a host: a colon and a port. */
export const PORT_MAX_CHARS = 6;

/**
 * What stands between `http://` or `https://` and the path, the query or the fragment of `raw`: the host with its
 * port (and a name with a password, where one was written). Null when `raw` is not an address written that way.
 * One look at the start and one pass over that part.
 */
export function authorityOf(raw: string): string | null {
  const scheme = /^https?:\/\//i.exec(raw);
  if (scheme === null) return null;
  const from = scheme[0].length;
  let end = from;
  // A browser takes a backslash for a slash here.
  while (end < raw.length && !'/\\?#'.includes(raw[end] as string)) end += 1;
  return end === from ? null : raw.slice(from, end);
}

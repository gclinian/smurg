// Who has to update when a member's command is refused with `version` (0.5.1, DESIGN B3).
//
// The refusal carries nothing but that word: the verdict of the handshake is `{ ok: false, reason }` in a strict
// schema of every published version, so the host's number never reaches the member, and 0.5.0 guessed ("update
// smurg", also to a member who already ran the newest one against a host that had not updated). The member's command
// can find out ONE thing without the wire: whether a newer smurg than itself is published. It asks what `smurg update`
// asks (<downloads>/latest/VERSION, ./downloads.ts) and says:
//   - a newer smurg is published      -> update this one (`smurg update`), then connect again;
//   - this one is the newest          -> the host's smurg is the older one: the host stops sharing, runs `smurg update`
//                                        and shares again;
//   - it cannot ask                   -> both sentences, the member's own step first, and no claim about who is older.
// It cannot ask when the lookup fails or times out, with SMURG_NO_UPDATE_CHECK set (the person said no to that
// request), and when smurg runs from source (there `smurg update` could not do what the first sentence says). Never
// rejects, and takes at most VERSION_ADVICE_TIMEOUT_MS.
import { flagOn, type CliIo } from '../cli/io.ts';
import { m, type Text } from '../i18n/index.ts';
import { seaExecutable } from '../sea/native.ts';
import { CLI_VERSION } from '../version.ts';
import { downloadsBase, latestVersion } from './downloads.ts';
import type { UpdateNoticeDeps } from './notice.ts';
import { compareVersions, parseVersion } from './versions.ts';

/** How long a refused member waits for latest/VERSION before the text that names both sides is shown. */
export const VERSION_ADVICE_TIMEOUT_MS = 3_000;

/** What the downloads site says about this executable's version. */
export type OwnVersion =
  | { readonly kind: 'newer-published'; readonly current: string; readonly latest: string }
  | { readonly kind: 'newest'; readonly current: string }
  | { readonly kind: 'unknown' };

/** `smurg update`'s own lookup (the newest published version against this one), without its words. */
export async function lookUpOwnVersion(io: CliIo, deps: UpdateNoticeDeps = {}): Promise<OwnVersion> {
  const unknown: OwnVersion = { kind: 'unknown' };
  if (flagOn(io.env['SMURG_NO_UPDATE_CHECK'])) return unknown;
  if ((deps.executable === undefined ? seaExecutable() : deps.executable) === null) return unknown;
  const current = deps.version ?? CLI_VERSION;
  const have = parseVersion(current);
  if (have === null) return unknown;
  // The time limit holds whatever the request does (also one that does not end when it is aborted).
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<OwnVersion>((resolve) => {
    timer = setTimeout(() => {
      stop.abort(new DOMException('no answer in time', 'TimeoutError'));
      resolve(unknown);
    }, deps.timeoutMs ?? VERSION_ADVICE_TIMEOUT_MS);
  });
  const ask = async (): Promise<OwnVersion> => {
    try {
      const latest = await latestVersion(downloadsBase(io.env), { signal: stop.signal, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      const published = parseVersion(latest);
      if (published === null) return unknown;
      return compareVersions(published, have) > 0 ? { kind: 'newer-published', current, latest } : { kind: 'newest', current };
    } catch {
      return unknown;
    }
  };
  try {
    return await Promise.race([ask(), gaveUp]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What a member reads after a `version` refusal. */
export function versionRefusalText(own: OwnVersion): Text {
  switch (own.kind) {
    case 'newer-published':
      return m('channel.rejected.version.updateHere', { current: own.current, latest: own.latest });
    case 'newest':
      return m('channel.rejected.version.hostOlder', { current: own.current });
    case 'unknown':
      return m('channel.rejected.version');
  }
}

/** The lookup and its words in one step (never rejects). */
export async function versionRefusalAdvice(io: CliIo, deps: UpdateNoticeDeps = {}): Promise<Text> {
  return versionRefusalText(await lookUpOwnVersion(io, deps));
}

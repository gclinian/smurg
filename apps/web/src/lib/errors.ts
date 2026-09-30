// One zh-TW sentence for any error the UI may show. Daemon errors (SmurgError) carry zh-TW messages or at least a code
// with a zh-TW default; local SDK failures (ClientRequestError) are zh-TW already; relay HTTP errors get a message of
// our own. Nothing here ever shows a stack trace, a path of the host or a payload.
import { defaultErrorMessage, isSmurgError } from '@smurg/protocol';
import { isRelayApiError } from '@smurg/protocol/client';
import { tApp } from '../strings/app.ts';

const HAS_CJK = new RegExp('[\\u3400-\\u9fff\\uf900-\\ufaff]', 'u');

/** The daemon composes a stub for a feature module that is not built yet (ARCHITECTURE §7.2). */
export function isNotImplemented(error: unknown): boolean {
  return isSmurgError(error) && error.detail?.['reason'] === 'not-implemented';
}

export function describeError(error: unknown): string {
  if (isNotImplemented(error)) return tApp('error.notImplemented');
  if (isSmurgError(error)) {
    // A daemon message written for people is zh-TW; anything else (e.g. "not implemented: …") is not shown as is.
    return HAS_CJK.test(error.message) ? error.message : defaultErrorMessage(error.code);
  }
  if (isRelayApiError(error)) {
    if (error.status === 401) return tApp('error.unauthorized');
    if (error.status === 0) return tApp('error.relay');
    return tApp('error.relayStatus', { status: error.status });
  }
  return tApp('error.generic');
}

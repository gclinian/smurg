// One sentence, in the viewer's language, for any error the UI may show.
//
// A daemon error (SmurgError) and a local SDK failure (ClientRequestError) carry a message reference (`text`: an id
// of the wire catalogue + parameters) next to `message`, its English rendering. The rule:
//   1. the reference, rendered in the viewer's language;
//   2. a reference this build cannot render (an id from a newer host): `message`, the English sentence it came with;
//   3. no reference at all (a plain string from the SDK or a wrapped internal: not written for people): the default
//      sentence of the error's code, in the viewer's language.
// Relay HTTP errors get a message of our own. Nothing here ever shows a stack trace, a path of the host or a payload.
import { isSmurgError, type MessageRef } from '@smurg/protocol';
import { isRelayApiError } from '@smurg/protocol/client';
import { defaultErrorRef, render } from '@smurg/protocol/i18n';
import { tApp } from '../strings/app.ts';
import { getLocale } from './locale.ts';

/** The daemon composes a stub for a feature module that is not built yet (ARCHITECTURE §7.2). */
export function isNotImplemented(error: unknown): boolean {
  return isSmurgError(error) && error.detail?.['reason'] === 'not-implemented';
}

/**
 * A text the host (or the SDK) wrote, in the viewer's language: the message reference when this build can render
 * it, the English `fallback` otherwise. The one rule for errors, activity sentences and system notifications.
 */
export function renderWireText(text: MessageRef | null | undefined, fallback: string): string {
  return render(getLocale(), text) ?? fallback;
}

export function describeError(error: unknown): string {
  if (isNotImplemented(error)) return tApp('error.notImplemented');
  if (isSmurgError(error)) {
    return error.text === undefined ? renderWireText(defaultErrorRef(error.code), error.message) : renderWireText(error.text, error.message);
  }
  if (isRelayApiError(error)) {
    if (error.status === 401) return tApp('error.unauthorized');
    if (error.status === 0) return tApp('error.relay');
    return tApp('error.relayStatus', { status: error.status });
  }
  return tApp('error.generic');
}

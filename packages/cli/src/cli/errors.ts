// A failure the CLI reports to the person: a message (and an optional hint) plus the exit code. Commands throw it; the
// dispatcher prints it on stderr as `smurg: <message>` in the terminal's language and exits with `exitCode`. The
// message is a Text (../i18n/index.ts): no language is needed where it is thrown. Anything else that escapes a command
// is an internal error: the person gets a generic line, never a stack trace or a host path from deep inside a library.
import { m, renderText, type Locale, type Text } from '../i18n/index.ts';
import { EXIT, type ExitCode } from './exit-codes.ts';

export class CliError extends Error {
  readonly exitCode: ExitCode;
  /** What the person reads; `message` (Error's) is its English rendering, for logs and debugging only. */
  readonly text: Text;
  readonly hint: Text | undefined;

  constructor(text: Text, options: { readonly exitCode?: ExitCode; readonly hint?: Text; readonly cause?: unknown } = {}) {
    super(renderText('en', text), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.text = text;
    this.exitCode = options.exitCode ?? EXIT.failure;
    this.hint = options.hint;
  }
}

export function usageError(text: Text, hint?: Text): CliError {
  return new CliError(text, { exitCode: EXIT.usage, ...(hint === undefined ? {} : { hint }) });
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}

/**
 * What a failed request to the daemon says, as a Text: a CliError's own text; an error that carries a reference into
 * the wire catalog (SmurgError, ClientRequestError: `.text`, `.code`) rendered in this terminal's language with its
 * English message as the fallback; any other Error's message; else `otherwise`.
 */
export function errorText(err: unknown, otherwise: Text): Text {
  if (isCliError(err)) return err.text;
  if (err instanceof Error) {
    const wire = err as Error & { readonly text?: unknown; readonly code?: unknown };
    const ref = typeof wire.text === 'object' && wire.text !== null && typeof (wire.text as { id?: unknown }).id === 'string' ? (wire.text as { id: string }) : undefined;
    if (ref !== undefined || typeof wire.code === 'string') {
      return { wire: ref, ...(typeof wire.code === 'string' ? { code: wire.code } : {}), fallback: err.message };
    }
    if (err.message !== '') return err.message;
  }
  return otherwise;
}

/** The lines printed for an error that escaped a command. */
export function formatFailure(err: unknown, lang: Locale): { readonly text: string; readonly exitCode: ExitCode } {
  if (isCliError(err)) {
    return { text: renderText(lang, m('failure.line', { message: err.text, ...(err.hint === undefined ? {} : { hint: err.hint }) })), exitCode: err.exitCode };
  }
  const name = err instanceof Error ? err.name : 'unknown';
  return { text: renderText(lang, m('failure.unexpected', { name })), exitCode: EXIT.failure };
}

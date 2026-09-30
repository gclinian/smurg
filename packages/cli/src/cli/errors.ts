// A failure the CLI reports to the person: a zh-TW message (and an optional hint) plus the exit code. Commands throw
// it; the dispatcher prints it on stderr as 「smurg：<message>」 and exits with `exitCode`. Anything else that escapes
// a command is an internal error: the person gets a generic zh-TW line, never a stack trace or a host path from deep
// inside a library.
import { EXIT, type ExitCode } from './exit-codes.ts';

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(message: string, options: { readonly exitCode?: ExitCode; readonly hint?: string; readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? EXIT.failure;
    this.hint = options.hint;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, { exitCode: EXIT.usage, ...(hint === undefined ? {} : { hint }) });
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}

/** The lines printed for an error that escaped a command. */
export function formatFailure(err: unknown): { readonly text: string; readonly exitCode: ExitCode } {
  if (isCliError(err)) {
    return { text: `smurg：${err.message}\n${err.hint ? `  ${err.hint}\n` : ''}`, exitCode: err.exitCode };
  }
  const name = err instanceof Error ? err.name : 'unknown';
  return { text: `smurg：發生未預期的錯誤（${name}）。\n  若問題持續發生，請回報並附上 ~/.smurg/logs 裡的紀錄。\n`, exitCode: EXIT.failure };
}

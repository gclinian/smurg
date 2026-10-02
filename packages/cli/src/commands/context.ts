// What every command receives: the injected io, the state paths derived from it, and the language of this run.
import type { CliIo } from '../cli/io.ts';
import { renderText, resolveLang, type Locale, type Text } from '../i18n/index.ts';
import { statePaths, type StatePaths } from '../state/paths.ts';

export interface CommandContext {
  readonly io: CliIo;
  readonly paths: StatePaths;
  /** The language of everything this command prints (decided once per run: ../cli/run.ts). */
  readonly lang: Locale;
}

/** `lang` absent: from io's environment (and its system-language reader, which only the real process has). */
export function commandContext(io: CliIo, lang: Locale = resolveLang(io.env, io.systemLanguages)): CommandContext {
  return { io, paths: statePaths(io.env), lang };
}

/** `text` in this command's language. */
export function tr(ctx: Pick<CommandContext, 'lang'>, text: Text): string {
  return renderText(ctx.lang, text);
}

/** Writes one line (or several) to stdout. */
export function say(ctx: CommandContext, text: Text): void {
  const line = tr(ctx, text);
  ctx.io.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

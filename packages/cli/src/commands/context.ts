// What every command receives: the injected io and the state paths derived from it.
import type { CliIo } from '../cli/io.ts';
import { statePaths, type StatePaths } from '../state/paths.ts';

export interface CommandContext {
  readonly io: CliIo;
  readonly paths: StatePaths;
}

export function commandContext(io: CliIo): CommandContext {
  return { io, paths: statePaths(io.env) };
}

/** Writes one line (or several) to stdout. */
export function say(ctx: CommandContext, text: string): void {
  ctx.io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

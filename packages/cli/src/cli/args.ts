// A small, strict argument parser: `--name value`, `--name=value`, boolean `--flag` / `--no-flag`, `-h`, and `--` to
// end options. Unknown options, missing values, a string
// option given twice, a boolean together with its negation and surplus positionals are usage errors with a zh-TW
// message (the CLI never guesses what was meant).
import { usageError } from './errors.ts';

export interface OptionSpec {
  readonly kind: 'string' | 'boolean';
  /** A one-letter alias (`-h`). */
  readonly short?: string;
}

export interface ArgsSpec {
  readonly options: Readonly<Record<string, OptionSpec>>;
  /** Names of the positionals, in order (for messages); `max` defaults to their count. */
  readonly positionals?: readonly string[];
  readonly minPositionals?: number;
  readonly maxPositionals?: number;
}

export interface ParsedArgs {
  readonly options: Readonly<Record<string, string | boolean | undefined>>;
  readonly positionals: readonly string[];
}

export function parseArgs(argv: readonly string[], spec: ArgsSpec): ParsedArgs {
  const options: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  const shortNames = new Map<string, string>();
  for (const [name, option] of Object.entries(spec.options)) if (option.short) shortNames.set(option.short, name);
  let onlyPositionals = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (onlyPositionals || arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositionals = true;
      continue;
    }
    let name: string;
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    } else {
      const long = arg.length === 2 ? shortNames.get(arg.slice(1)) : undefined;
      if (long === undefined) throw usageError(`不認得的選項 ${arg}`);
      name = long;
    }
    const given = name;
    let option: OptionSpec | undefined = spec.options[name];
    let negated = false;
    if (option === undefined && name.startsWith('no-') && spec.options[name.slice(3)]?.kind === 'boolean') {
      option = spec.options[name.slice(3)];
      name = name.slice(3);
      negated = true;
    }
    if (option === undefined) throw usageError(`不認得的選項 --${given}`);
    if (option.kind === 'boolean') {
      if (inline !== undefined) throw usageError(`選項 --${given} 不接受值`);
      // `--flag --no-flag`: the CLI does not guess which one was meant (a repeat of the same form is harmless).
      if (options[name] !== undefined && options[name] !== !negated) throw usageError(`選項 --${name} 和 --no-${name} 不能同時指定`);
      options[name] = !negated;
      continue;
    }
    if (negated) throw usageError(`不認得的選項 --no-${name}`);
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) throw usageError(`選項 --${name} 需要一個值`);
      value = next;
      i += 1;
    }
    if (options[name] !== undefined) throw usageError(`選項 --${name} 只能指定一次`);
    options[name] = value;
  }
  const names = spec.positionals ?? [];
  const min = spec.minPositionals ?? 0;
  const max = spec.maxPositionals ?? names.length;
  if (options['help'] !== true) {
    if (positionals.length < min) throw usageError(`缺少參數 <${names[positionals.length] ?? '參數'}>`);
    if (positionals.length > max) throw usageError(`多了不認得的參數「${positionals[max]}」`);
  }
  return { options, positionals };
}

export function stringOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  return typeof value === 'string' ? value : undefined;
}

export function booleanOption(args: ParsedArgs, name: string): boolean | undefined {
  const value = args.options[name];
  return typeof value === 'boolean' ? value : undefined;
}

const DURATION = /^(\d{1,6})(s|m|h|d|w)$/;
const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

/** `30m`, `12h`, `7d`, `2w` → seconds. */
export function parseDuration(text: string, what: string): number {
  const match = DURATION.exec(text.trim());
  if (!match) throw usageError(`${what}「${text}」看不懂`, '請用數字加單位，例如 30m、12h、7d、2w（s 秒、m 分、h 小時、d 天、w 週）。');
  return Number(match[1]) * (UNIT_SECONDS[match[2] as string] as number);
}

/** A positive integer within [min, max]. */
export function parseCount(text: string, what: string, min: number, max: number): number {
  if (!/^\d{1,9}$/.test(text)) throw usageError(`${what}必須是正整數（目前是「${text}」）`);
  const value = Number(text);
  if (value < min || value > max) throw usageError(`${what}必須在 ${min} 到 ${max} 之間`);
  return value;
}

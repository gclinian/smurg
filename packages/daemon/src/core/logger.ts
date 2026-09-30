// The daemon's diagnostic log. It is for the host's own debugging and never a place for content: callers pass
// message types, ids, codes and sizes, never payloads, tokens, keys or file contents (use redactForLog from
// @smurg/protocol when a payload shape is needed). The audit log (core/audit.ts) is the record of who did what.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line (e.g. `{ module: 'hub' }`). */
  child(fields: LogFields): Logger;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LineLoggerOptions {
  readonly level?: LogLevel;
  /** Where a formatted line goes; default: process.stderr. */
  readonly write?: (line: string) => void;
  readonly now?: () => number;
}

function formatValue(value: string | number | boolean | null): string {
  if (typeof value !== 'string') return String(value);
  // Quote anything that could be confused with the key=value structure or smuggle a fake line.
  return /^[\w.:/@+-]*$/.test(value) && value.length > 0 ? value : JSON.stringify(value);
}

/** One `time level message key=value …` line per call. */
export function createLineLogger(options: LineLoggerOptions = {}, base: LogFields = {}): Logger {
  const threshold = LEVEL_RANK[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => Date.now());
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < threshold) return;
    const merged = { ...base, ...fields };
    let line = `${new Date(now()).toISOString()} ${level} ${JSON.stringify(message)}`;
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) continue;
      line += ` ${key}=${formatValue(value)}`;
    }
    try {
      write(line);
    } catch {
      // A broken stderr must never take the daemon down.
    }
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLineLogger(options, { ...base, ...fields }),
  };
}

/** Drops everything; the default in tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** Keeps lines in memory (tests that assert on diagnostics). */
export function createMemoryLogger(): Logger & { readonly lines: { level: LogLevel; message: string; fields: LogFields }[] } {
  const lines: { level: LogLevel; message: string; fields: LogFields }[] = [];
  const make = (base: LogFields): Logger => ({
    debug: (message, fields) => lines.push({ level: 'debug', message, fields: { ...base, ...fields } }),
    info: (message, fields) => lines.push({ level: 'info', message, fields: { ...base, ...fields } }),
    warn: (message, fields) => lines.push({ level: 'warn', message, fields: { ...base, ...fields } }),
    error: (message, fields) => lines.push({ level: 'error', message, fields: { ...base, ...fields } }),
    child: (fields) => make({ ...base, ...fields }),
  });
  return Object.assign(make({}), { lines });
}

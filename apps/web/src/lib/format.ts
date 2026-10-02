// Formatting of times, durations, numbers, sizes, lists and people in the viewer's language, shared by every feature.
// Everything goes through `Intl` with the tag of the current locale (`en` / `zh-Hant-TW`); the formatters are built
// lazily, once per locale, so a language switch needs no reload and no module holds a formatter of the old language.
import type { Actor, Role } from '@smurg/protocol';
import { joinList, roleLabel } from '@smurg/protocol/i18n';
import { intlTag, type Locale } from '@smurg/protocol/locale';
import { tApp } from '../strings/app.ts';
import { getLocale } from './locale.ts';

interface Formatters {
  readonly dateTime: Intl.DateTimeFormat;
  readonly exactTime: Intl.DateTimeFormat;
  readonly time: Intl.DateTimeFormat;
  readonly integer: Intl.NumberFormat;
  readonly oneDecimal: Intl.NumberFormat;
  readonly relative: Intl.RelativeTimeFormat;
  readonly seconds: Intl.NumberFormat;
  readonly minutes: Intl.NumberFormat;
  readonly hours: Intl.NumberFormat;
  readonly collator: Intl.Collator;
}

const cache = new Map<Locale, Formatters>();

/** The `Intl` formatters of `locale` (default: the current one), memoised per locale. */
export function formatters(locale: Locale = getLocale()): Formatters {
  let made = cache.get(locale);
  if (made === undefined) {
    const tag = intlTag(locale);
    const unit = (name: 'second' | 'minute' | 'hour'): Intl.NumberFormat =>
      new Intl.NumberFormat(tag, { style: 'unit', unit: name, unitDisplay: 'long', maximumFractionDigits: 0 });
    made = {
      // English spells the month ("May 29, 2026, 04:26"): 5/29/26 reads as two different days around the world.
      dateTime: new Intl.DateTimeFormat(tag, { dateStyle: locale === 'en' ? 'medium' : 'short', timeStyle: 'short', hour12: false }),
      exactTime: new Intl.DateTimeFormat(tag, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
      time: new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
      integer: new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }),
      oneDecimal: new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }),
      relative: new Intl.RelativeTimeFormat(tag, { numeric: 'always', style: 'long' }),
      seconds: unit('second'),
      minutes: unit('minute'),
      hours: unit('hour'),
      collator: new Intl.Collator(tag, { numeric: true, sensitivity: 'base' }),
    };
    cache.set(locale, made);
  }
  return made;
}

/** "just now", "3 minutes ago", ..., then an absolute date after a week. */
export function formatRelativeTime(at: number, now: number = Date.now()): string {
  const { relative, dateTime } = formatters();
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 10) return tApp('common.justNow');
  if (seconds < 60) return relative.format(-seconds, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return relative.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relative.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return relative.format(-days, 'day');
  return dateTime.format(at);
}

/** Date and time to the minute. */
export function formatDateTime(at: number): string {
  return formatters().dateTime.format(at);
}

/** Date and time to the second with every field in two digits (logs, audit rows). */
export function formatExactTime(at: number): string {
  return formatters().exactTime.format(at);
}

/** Time of day to the second. */
export function formatTime(at: number): string {
  return formatters().time.format(at);
}

/** A whole number with the language's grouping ("12,345"). */
export function formatNumber(value: number): string {
  return formatters().integer.format(value);
}

/**
 * A length of time in its largest whole unit: "45 seconds", "3 minutes", "2 hours" (never negative; a fraction is
 * rounded up, so a countdown never shows "0 seconds" while time is left).
 */
export function formatDuration(seconds: number): string {
  const f = formatters();
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0;
  if (whole < 60) return f.seconds.format(whole);
  const minutes = Math.ceil(whole / 60);
  if (minutes < 60) return f.minutes.format(minutes);
  return f.hours.format(Math.ceil(minutes / 60));
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Binary units, as the host's disk check reports them (5 GB = 5 × 2^30 bytes). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return tApp('common.unknown');
  const { integer, oneDecimal } = formatters();
  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${sign}${unit === 0 ? integer.format(value) : oneDecimal.format(value)} ${UNITS[unit]}`;
}

/** Names, paths and other items in one line, joined the way the language does (the wire catalogue's rule). */
export function formatList(items: readonly string[]): string {
  return joinList(getLocale(), items);
}

/** Order of two names as the viewer's language sorts them; digits compare as numbers ("file2" before "file10"). */
export function compareText(a: string, b: string): number {
  return formatters().collator.compare(a, b);
}

/** The role's label ("Agent access"): one wording for the web app, the CLI and the docs (the wire catalogue). */
export function formatRole(role: Role): string {
  return roleLabel(getLocale(), role);
}

/** The name to show for whoever did something (agents are already named "Claude (Ian)" by the daemon). */
export function formatActor(actor: Actor): string {
  return actor.kind === 'system' ? 'smurg' : actor.displayName;
}

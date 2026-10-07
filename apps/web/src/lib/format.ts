// Formatting of times, durations, numbers, sizes, lists and people in the viewer's language, shared by every feature.
// Everything goes through `Intl` with the tag of the current locale (`en` / `zh-Hant-TW`); the formatters are built
// lazily, once per locale, so a language switch needs no reload and no module holds a formatter of the old language.
import { withFewMarks, type Actor, type Role } from '@smurg/protocol';
import { joinList, roleLabel } from '@smurg/protocol/i18n';
import { intlTag, type Locale } from '@smurg/protocol/locale';
import { tApp } from '../strings/app.ts';
import { secondsShown } from './clock.ts';
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
  readonly shortSeconds: Intl.NumberFormat;
  readonly shortMinutes: Intl.NumberFormat;
  readonly shortHours: Intl.NumberFormat;
  readonly shortDays: Intl.NumberFormat;
  readonly conjunction: Intl.ListFormat;
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
    const short = (name: 'second' | 'minute' | 'hour' | 'day'): Intl.NumberFormat =>
      new Intl.NumberFormat(tag, { style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: 0 });
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
      shortSeconds: short('second'),
      shortMinutes: short('minute'),
      shortHours: short('hour'),
      shortDays: short('day'),
      conjunction: new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' }),
      collator: new Intl.Collator(tag, { numeric: true, sensitivity: 'base' }),
    };
    cache.set(locale, made);
  }
  return made;
}

/**
 * Whether a text made from this many elapsed seconds will read differently within a second or so: under a minute it
 * is printed to the second. A time far in the future (a clock that is wrong) is not: it would keep the clock ticking
 * each second for nothing.
 */
const changesWithinSeconds = (elapsed: number): boolean => elapsed < 60 && elapsed > -60;

/**
 * "just now", "3 minutes ago", ..., then an absolute date after a week. Under a minute the text changes within seconds:
 * the clock is told (lib/clock.ts), so whoever shows it is redrawn in time.
 *
 * `finest: 'minute'` is for a text that is redrawn once a minute or less often (a label of the file tree): it says
 * "just now" for the whole first minute instead of seconds it would not follow, and asks the clock for nothing.
 */
export function formatRelativeTime(at: number, now: number = Date.now(), finest: 'second' | 'minute' = 'second'): string {
  const { relative, dateTime } = formatters();
  const seconds = Math.floor((now - at) / 1000);
  if (finest === 'minute') {
    if (seconds < 60) return tApp('common.justNow');
  } else {
    if (changesWithinSeconds(seconds)) secondsShown();
    if (seconds < 10) return tApp('common.justNow');
    if (seconds < 60) return relative.format(-seconds, 'second');
  }
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

/**
 * How long ago, in the least room: "40 sec", "6 min", "2 hr", "3 days" (an inbox row, a waiting line). Never
 * negative; whole units, rounded down, so "6 min" means at least six minutes. Under a minute the age is printed to the
 * second: the clock is told (lib/clock.ts) and redraws every age on screen each second for as long as that lasts.
 */
export function formatAge(at: number, now: number = Date.now()): string {
  const f = formatters();
  const elapsed = Math.floor((now - at) / 1000);
  if (changesWithinSeconds(elapsed)) secondsShown();
  const seconds = Math.max(0, elapsed);
  if (seconds < 60) return f.shortSeconds.format(seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return f.shortMinutes.format(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return f.shortHours.format(hours);
  return f.shortDays.format(Math.floor(hours / 24));
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

// Chinese, Japanese and Korean letters, their punctuation and the full-width forms: text that carries its own spacing.
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const WIDE_WORD = /^\p{Script=Han}+$/u;
const WIDE_PUNCTUATION = /[\u3000-\u303f\uff00-\uffef]/u;

/**
 * A few things that all apply, as a sentence says them: "5 and 6", "4, 5, and 6" (work item numbers, names). Where
 * the language's word for "and" is a Chinese character, a space sets it apart from Latin text and digits beside it
 * (the house style: "Ian" + "Mei" reads with a space on both sides of the word), and not from Chinese text.
 */
export function formatAnd(items: readonly string[]): string {
  const parts = formatters().conjunction.formatToParts(items);
  return parts
    .map((part, index) => {
      if (part.type !== 'literal' || !WIDE_WORD.test(part.value)) return part.value;
      const before = parts[index - 1]?.value.at(-1);
      const after = parts[index + 1]?.value[0];
      return `${before !== undefined && !WIDE.test(before) ? ' ' : ''}${part.value}${after !== undefined && !WIDE.test(after) ? ' ' : ''}`;
    })
    .join('');
}

/**
 * The gap between a sentence and what follows it in the same line (another sentence, a link, a button): a space,
 * except after Chinese or full-width punctuation, which carries its own gap (a full-width full stop followed by a
 * space reads as a hole). Nothing after nothing.
 */
export function gapAfter(sentence: string | null | undefined): '' | ' ' {
  if (sentence === null || sentence === undefined || sentence === '') return '';
  return WIDE_PUNCTUATION.test(sentence.at(-1) as string) ? '' : ' ';
}

/** Sentences one after the other in one line, each set apart from the next by gapAfter(). */
export function joinSentences(sentences: readonly (string | null | undefined)[]): string {
  let text = '';
  for (const sentence of sentences) {
    if (sentence === null || sentence === undefined || sentence === '') continue;
    text += `${gapAfter(text)}${sentence}`;
  }
  return text;
}

/**
 * Order of two names as the viewer's language sorts them; digits compare as numbers ("file2" before "file10").
 * A collator puts every run of combining marks in order first, at the cost of the square of the run (half a second
 * for two names of 32,000 marks): no run longer than a word can have reaches it (the protocol's withFewMarks).
 */
export function compareText(a: string, b: string): number {
  return formatters().collator.compare(withFewMarks(a), withFewMarks(b));
}

/**
 * Order of two ids or keys of the product's own making, by their UTF-16 units: for the last key of a sort, which only
 * has to be the same on every page. Not `localeCompare`: nothing in the web app hands a text to a collator except
 * compareText above (test/text-cost.test.tsx keeps it so).
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The role's label ("Agent access"): one wording for the web app, the CLI and the docs (the wire catalogue). */
export function formatRole(role: Role): string {
  return roleLabel(getLocale(), role);
}

/** The name to show for whoever did something (agents are already named "Claude (Ian)" by the daemon). */
export function formatActor(actor: Actor): string {
  return actor.kind === 'system' ? 'smurg' : actor.displayName;
}

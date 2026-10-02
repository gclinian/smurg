// The language of the web app: `en` (default) or `zh-TW`. It is the viewer's own choice and never leaves the browser
// except as the cookie the relay's HTML pages (/device, login errors) read to follow it.
//
// Detection, first hit wins (one rule for every surface: @smurg/protocol/locale):
//   1. the stored choice, localStorage['smurg.lang'];
//   2. the cookie `smurg_lang` (set by this app or by the language link of a relay page);
//   3. the first entry of navigator.languages that is English or Traditional Chinese;
//   4. English.
//
// One module-level controller, because the string catalogue and the Intl formatters read the language at call time
// (`t('key')` has no locale argument). `setLocale()` records the person's choice; nothing is reloaded: the app
// re-mounts its route tree with the locale as React key (app/App.tsx). Known and accepted: a toast already on screen
// and error sentences already kept in a store stay in the previous language.
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_STORAGE_KEY,
  intlTag,
  localeFromLanguages,
  parseLocale,
  type Locale,
} from '@smurg/protocol/locale';
import { getCatalogLocale, setCatalogLocale } from '../strings/catalog.ts';
import type { ReadableStore } from './store.ts';

export type { Locale } from '@smurg/protocol/locale';

/**
 * The two languages as the language menu lists them: each in its own language, never translated. (The label of
 * Traditional Chinese is the one piece of Chinese text outside the zh-TW tables.)
 */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = Object.freeze({ en: 'English', 'zh-TW': '繁體中文' });

/** One year: the cookie only has to outlive the visits between two device logins. */
const COOKIE_MAX_AGE_S = 31_536_000;

/** What detection reads. Everything is optional: a blocked storage or a missing navigator is "nothing stored". */
export interface LocaleSources {
  /** `localStorage['smurg.lang']`. */
  readonly stored?: string | null | undefined;
  /** The whole `document.cookie` string. */
  readonly cookie?: string | null | undefined;
  /** `navigator.languages`. */
  readonly languages?: readonly string[] | null | undefined;
}

/** The value of the `smurg_lang` cookie in a `document.cookie` string (undefined when absent). */
export function localeCookieValue(cookie: string | null | undefined): string | undefined {
  if (typeof cookie !== 'string') return undefined;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === LOCALE_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The rule above, pure. */
export function detectLocale(sources: LocaleSources): Locale {
  return parseLocale(sources.stored) ?? parseLocale(localeCookieValue(sources.cookie)) ?? localeFromLanguages(sources.languages ?? []);
}

function readStored(): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null; // blocked storage: nothing stored
  }
}

function readCookie(): string | null {
  try {
    return typeof document === 'undefined' ? null : document.cookie;
  } catch {
    return null;
  }
}

function browserSources(): LocaleSources {
  const languages = typeof navigator === 'undefined' ? [] : (navigator.languages ?? (navigator.language ? [navigator.language] : []));
  return { stored: readStored(), cookie: readCookie(), languages };
}

const listeners = new Set<() => void>();

/** The language everything renders in right now. */
export function getLocale(): Locale {
  return getCatalogLocale();
}

/** The BCP 47 tag of the current language for `Intl.*` and `<html lang>` (`en` / `zh-Hant-TW`). */
export function currentIntlTag(): 'en' | 'zh-Hant-TW' {
  return intlTag(getLocale());
}

/** Called after every change of the language. Returns the unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The language as a store, for `useStore(localeStore)`. */
export const localeStore: ReadableStore<Locale> = { getState: getLocale, subscribe };

/**
 * Makes `locale` the language of the catalogue, the formatters and `<html lang>` WITHOUT recording a choice (boot
 * after detection; tests). Notifies subscribers when it changed.
 */
export function applyLocale(locale: Locale): void {
  const next: Locale = locale === 'zh-TW' ? 'zh-TW' : DEFAULT_LOCALE;
  const changed = next !== getCatalogLocale();
  setCatalogLocale(next);
  if (typeof document !== 'undefined') document.documentElement.lang = intlTag(next);
  if (!changed) return;
  for (const listener of [...listeners]) listener();
}

/**
 * The person chose a language: remembered in localStorage, mirrored into the cookie `smurg_lang` (so the relay's
 * pages follow), applied at once. A browser that refuses storage or cookies still switches for this page.
 */
export function setLocale(locale: Locale): void {
  const next: Locale = locale === 'zh-TW' ? 'zh-TW' : DEFAULT_LOCALE;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // blocked or full storage: the choice lasts as long as the cookie, or this page
  }
  try {
    // Not HttpOnly on purpose (the relay's own switch writes the same cookie and this app reads it). `Secure` only
    // on https: a plain-http development origin would drop the cookie otherwise.
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; SameSite=Lax${secure}`;
  } catch {
    // cookies disabled: the relay's pages fall back to Accept-Language
  }
  applyLocale(next);
}

/** Boot (src/boot/locale.ts): detects the language from this browser and applies it. Returns it. */
export function initLocale(sources: LocaleSources = browserSources()): Locale {
  const locale = detectLocale(sources);
  applyLocale(locale);
  return locale;
}

// The language of the relay's own HTML pages, and the visible switch.
//
// The language is the viewer's: the `smurg_lang` cookie (set by the switch below or by the web app's language menu),
// then the first supported entry of Accept-Language, then English (`@smurg/protocol/locale` holds the rule). The JSON
// API never picks a language.
//
// The switch: `GET <page>?lang=en|zh-TW` stores the choice in the cookie and answers 303 to the same path without
// `lang` (every other query parameter kept). Only GET pages have it; `lang` on a POST is ignored, and so is any other
// value of `lang`.
import { LOCALES, LOCALE_COOKIE, localeFromAcceptLanguage, parseLocale, type Locale } from '@smurg/protocol/locale';
import { readCookie } from './cookies.ts';
import type { LanguageLinks, PageView } from './html.ts';
import { PAGE_VARY, redirectResponse } from './http.ts';

/** The part of a RequestContext this module reads (structural, so the Node tests can import the module without the Worker's `Env`). */
export type PageRequest = { readonly req: Request; readonly url: URL; readonly config: { readonly secureCookies: boolean } };

export const LANGUAGE_PARAM = 'lang';
/** One year: the choice is a preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 31_536_000;

export function pageLocale(req: Request): Locale {
  return parseLocale(readCookie(req.headers.get('cookie'), LOCALE_COOKIE)) ?? localeFromAcceptLanguage(req.headers.get('accept-language'));
}

/**
 * The language cookie. Not HttpOnly: the web app (same origin) reads and writes the same cookie. `Secure` whenever the
 * relay is on https (always, except local development over plain http).
 */
export function localeCookie(locale: Locale, secure: boolean): string {
  const attrs = [`${LOCALE_COOKIE}=${locale}`, 'Path=/', `Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}`, 'SameSite=Lax'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function pathWithQuery(url: URL, params: URLSearchParams): string {
  const query = params.toString();
  return query === '' ? url.pathname : `${url.pathname}?${query}`;
}

/**
 * The switch links of the page at `url`. `keepQuery: false` for a page that takes nothing from its URL (/device): its
 * links then carry only `lang`, so nothing a link put into the URL is echoed into the page.
 */
export function languageLinks(url: URL, options: { keepQuery: boolean }): LanguageLinks {
  const link = (locale: Locale): string => {
    const params = new URLSearchParams(options.keepQuery ? url.searchParams : undefined);
    params.set(LANGUAGE_PARAM, locale);
    return pathWithQuery(url, params);
  };
  return Object.fromEntries(LOCALES.map((locale) => [locale, link(locale)])) as Record<Locale, string>;
}

/** A page that answers a GET: the viewer's language and the switch. */
export function getPageView(ctx: PageRequest, options: { keepQuery: boolean }): PageView {
  return { locale: pageLocale(ctx.req), languageLinks: languageLinks(ctx.url, options) };
}

/** A page that answers a POST (or whose URL must not be requested again): the viewer's language, no switch. */
export function plainPageView(ctx: PageRequest): PageView {
  return { locale: pageLocale(ctx.req) };
}

/**
 * `GET <page>?lang=<locale>`: the 303 that stores the choice, or null when this request is not a language switch.
 * The target is the request's own path (never a URL from the request), so this cannot redirect anywhere else.
 */
export function languageSwitchRedirect(ctx: PageRequest): Response | null {
  if (ctx.req.method !== 'GET') return null;
  const locale = parseLocale(ctx.url.searchParams.get(LANGUAGE_PARAM));
  if (locale === undefined) return null;
  const params = new URLSearchParams(ctx.url.searchParams);
  params.delete(LANGUAGE_PARAM);
  const response = redirectResponse(pathWithQuery(ctx.url, params), [localeCookie(locale, ctx.config.secureCookies)], 303);
  response.headers.set('vary', PAGE_VARY);
  return response;
}

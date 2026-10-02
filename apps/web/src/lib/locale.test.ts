// The language of the web app: detection (stored choice > cookie > navigator.languages > English, the shared rule of
// @smurg/protocol/locale), the controller (setLocale / applyLocale / subscribe) and what a choice leaves behind.
import { LOCALE_COOKIE, LOCALE_STORAGE_KEY } from '@smurg/protocol/locale';
import { LANGUAGE_LIST_CASES, NOT_ZH_TW_TAGS, ZH_TW_TAGS } from '@smurg/protocol/locale/test-table';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../strings/catalog.ts';
import { formatRelativeTime } from './format.ts';
import { LOCALE_NAMES, applyLocale, currentIntlTag, detectLocale, getLocale, initLocale, localeCookieValue, localeStore, setLocale, subscribe } from './locale.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detectLocale', () => {
  it('follows navigator.languages by the shared table: the FIRST supported entry wins', () => {
    for (const [languages, expected] of LANGUAGE_LIST_CASES) expect(detectLocale({ languages }), JSON.stringify(languages)).toBe(expected);
    for (const tag of ZH_TW_TAGS) expect(detectLocale({ languages: [tag] }), tag).toBe('zh-TW');
    for (const tag of NOT_ZH_TW_TAGS) expect(detectLocale({ languages: [tag] }), tag).toBe('en');
    expect(detectLocale({})).toBe('en');
    expect(detectLocale({ languages: null, stored: null, cookie: null })).toBe('en');
  });

  it('the stored choice beats the cookie, and the cookie beats the browser languages', () => {
    expect(detectLocale({ stored: 'en', cookie: 'smurg_lang=zh-TW', languages: ['zh-TW'] })).toBe('en');
    expect(detectLocale({ stored: 'zh-TW', cookie: 'smurg_lang=en', languages: ['en-US'] })).toBe('zh-TW');
    expect(detectLocale({ stored: null, cookie: 'a=1; smurg_lang=zh-TW; b=2', languages: ['en-US'] })).toBe('zh-TW');
    expect(detectLocale({ stored: null, cookie: 'smurg_lang=en', languages: ['zh-TW'] })).toBe('en');
  });

  it('a stored value or a cookie that is not exactly a locale is ignored (a choice is not a language tag)', () => {
    expect(detectLocale({ stored: 'zh-Hant', languages: ['en'] })).toBe('en');
    expect(detectLocale({ stored: 'fr', cookie: 'smurg_lang=ja', languages: ['zh-HK'] })).toBe('zh-TW');
    expect(detectLocale({ stored: '', cookie: 'other_smurg_lang=zh-TW', languages: [] })).toBe('en');
    // Case and underscore are tolerated in an explicit choice.
    expect(detectLocale({ stored: 'ZH_tw', languages: ['en'] })).toBe('zh-TW');
  });

  it('reads the cookie by its exact name', () => {
    expect(localeCookieValue('smurg_lang=zh-TW')).toBe('zh-TW');
    expect(localeCookieValue('x=1;  smurg_lang=en ;y=2')).toBe('en');
    expect(localeCookieValue('xsmurg_lang=zh-TW')).toBeUndefined();
    expect(localeCookieValue('')).toBeUndefined();
    expect(localeCookieValue(null)).toBeUndefined();
  });
});

describe('the locale controller', () => {
  it('tests start in English: the setup file pins it', () => {
    expect(getLocale()).toBe('en');
    expect(localeStore.getState()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(currentIntlTag()).toBe('en');
  });

  it('setLocale switches the catalogue, the formatters and <html lang> at once, and remembers the choice', () => {
    const seen: string[] = [];
    const off = subscribe(() => seen.push(getLocale()));
    setLocale('zh-TW');
    expect(getLocale()).toBe('zh-TW');
    expect(t('app.common.cancel')).toBe('取消');
    expect(formatRelativeTime(0, 3 * 60_000)).toBe('3 分鐘前');
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(currentIntlTag()).toBe('zh-Hant-TW');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-TW');
    expect(localeCookieValue(document.cookie)).toBe('zh-TW');
    // The same language again: nothing to announce.
    setLocale('zh-TW');
    setLocale('en');
    expect(t('app.common.cancel')).toBe('Cancel');
    expect(document.documentElement.lang).toBe('en');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(localeCookieValue(document.cookie)).toBe('en');
    off();
    setLocale('zh-TW');
    expect(seen).toEqual(['zh-TW', 'en']);
  });

  it('the cookie is the one the relay pages read: Path=/, one year, SameSite=Lax, Secure only on https', () => {
    const written: string[] = [];
    vi.spyOn(document, 'cookie', 'set').mockImplementation((value: string) => {
      written.push(value);
    });
    setLocale('zh-TW');
    expect(written).toEqual([`${LOCALE_COOKIE}=zh-TW; Path=/; Max-Age=31536000; SameSite=Lax`]);
    expect(window.location.protocol).toBe('http:');
  });

  it('applyLocale changes the language without recording a choice (boot after detection, tests)', () => {
    applyLocale('zh-TW');
    expect(getLocale()).toBe('zh-TW');
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
    expect(localeCookieValue(document.cookie)).toBeUndefined();
  });

  it('anything that is not zh-TW is English', () => {
    applyLocale('fr' as 'en');
    expect(getLocale()).toBe('en');
    setLocale('zh-CN' as 'en');
    expect(getLocale()).toBe('en');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('a browser that refuses storage and cookies still switches for this page', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(document, 'cookie', 'set').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => setLocale('zh-TW')).not.toThrow();
    expect(getLocale()).toBe('zh-TW');
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
  });

  it('initLocale: detects from this browser and applies; a later visit starts in the chosen language', () => {
    expect(initLocale({ languages: ['zh-HK', 'en'] })).toBe('zh-TW');
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(initLocale({ languages: ['zh-CN', 'ja'] })).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    // The real sources of this (jsdom) browser: a choice made earlier is found again.
    setLocale('zh-TW');
    applyLocale('en');
    expect(initLocale()).toBe('zh-TW');
    // Only the cookie left (the relay's language link set it, or storage was cleared): still found.
    window.localStorage.clear();
    applyLocale('en');
    expect(initLocale()).toBe('zh-TW');
  });

  it('names each language in itself', () => {
    expect(LOCALE_NAMES).toEqual({ en: 'English', 'zh-TW': '繁體中文' });
  });
});

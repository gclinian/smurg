// The five places that hold text people read, loaded for the lint tests: the wire catalog (@smurg/protocol/i18n), the
// CLI catalog, the web catalogue, the relay's page strings and the site's chrome. Each is imported from its source
// file by path (this folder is not a workspace package); the web catalogue is imported at run time only, because its
// modules are written for Vite (import.meta.glob) and type-check with the web app's own tsconfig.
import { join } from 'node:path';
import { STRINGS as RELAY_STRINGS, type PageStrings } from '../../apps/relay/src/lib/strings.ts';
import { CATALOGS as CLI_CATALOGS, m, renderText, type MessageId as CliMessageId } from '../../packages/cli/src/i18n/index.ts';
import { MESSAGE_IDS, msg, render, type MessageId as WireMessageId, type ParamsArg } from '../../packages/protocol/src/i18n/index.ts';
import { LOCALES, type Locale } from '../../packages/protocol/src/locale/index.ts';
import { REPO_ROOT } from './tree.ts';

export { CLI_CATALOGS, LOCALES, MESSAGE_IDS, RELAY_STRINGS, type CliMessageId, type Locale, type PageStrings, type WireMessageId };

/** A wire message (what the daemon sends as a reference) in `locale`. */
export function wire<I extends WireMessageId>(locale: Locale, id: I, ...params: ParamsArg<I>): string {
  const text = render(locale, msg(id, ...params));
  if (text === undefined) throw new Error(`the wire catalog does not render ${id}`);
  return text;
}

/** A CLI message in `locale`. The parameters are checked by the catalog's own types where it is called from the CLI. */
export function cli(locale: Locale, id: CliMessageId, params?: Readonly<Record<string, unknown>>): string {
  const build = m as (id: CliMessageId, params?: unknown) => Parameters<typeof renderText>[1];
  return renderText(locale, build(id, params));
}

type WebValue = string | { readonly one: string; readonly other: string };

export interface WebCatalogue {
  /** Every full key (`namespace.key`), in definition order. */
  readonly keys: readonly string[];
  table(locale: Locale): ReadonlyMap<string, WebValue>;
  /** The template of `key` in `locale` with `{placeholders}` filled from `vars` (a plural key: the form for `count`). */
  text(locale: Locale, key: string, vars?: Readonly<Record<string, string | number>>): string;
}

let web: Promise<WebCatalogue> | undefined;

/** The web app's whole catalogue (the six app-wide namespaces and every feature's). */
export function webCatalogue(): Promise<WebCatalogue> {
  web ??= (async () => {
    // Paths in variables: these modules belong to the web app's program, not to this folder's.
    const indexPath = join(REPO_ROOT, 'apps/web/src/strings/index.ts');
    const catalogPath = join(REPO_ROOT, 'apps/web/src/strings/catalog.ts');
    await import(/* @vite-ignore */ indexPath);
    const catalog = (await import(/* @vite-ignore */ catalogPath)) as {
      catalogueTable(locale: Locale): ReadonlyMap<string, WebValue>;
      interpolate(template: string, vars?: Readonly<Record<string, string | number>>): string;
      selectForm(value: WebValue, vars: Readonly<Record<string, string | number>> | undefined, locale: Locale): string;
    };
    const tables: Record<Locale, ReadonlyMap<string, WebValue>> = { en: catalog.catalogueTable('en'), 'zh-TW': catalog.catalogueTable('zh-TW') };
    return {
      keys: [...tables.en.keys()],
      table: (locale) => tables[locale],
      text: (locale, key, vars) => {
        const value = tables[locale].get(key);
        if (value === undefined) throw new Error(`the web catalogue has no key ${key}`);
        return catalog.interpolate(catalog.selectForm(value, vars, locale), vars);
      },
    };
  })();
  return web;
}

export interface SiteChrome {
  readonly [key: string]: unknown;
}

/** The site's own words (`CHROME` in apps/site/scripts/site.ts), per locale. */
export async function siteChrome(): Promise<Readonly<Record<Locale, SiteChrome>>> {
  const sitePath = join(REPO_ROOT, 'apps/site/scripts/site.ts');
  const site = (await import(/* @vite-ignore */ sitePath)) as { CHROME: Readonly<Record<Locale, SiteChrome>> };
  return site.CHROME;
}

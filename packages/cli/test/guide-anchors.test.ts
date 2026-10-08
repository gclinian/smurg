// Every address of a guide that the command prints WITH an anchor leads to a heading that is there, in the guide of
// that language (0.5.1, sceptic V3-5).
//
// The one-line notices of `smurg host` sent the host to the top of section 9 of the hosting guide: what the upgrade
// line is about stood 50 lines further down, the way back to a folder set aside 170. They now name the part they are
// about (9.2 and 9.4), by the id the site gives that heading (GitHub's: apps/site/scripts/markdown.ts). A heading that
// is reworded changes its id, and the address in the terminal would then open the top of the page without a word:
// this test fails first, and says which address of which catalog has no heading.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../../apps/site/scripts/markdown.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

type Lang = 'en' | 'zh-TW';
const CATALOG: Readonly<Record<Lang, string>> = { en: 'packages/cli/src/i18n/en.ts', 'zh-TW': 'packages/cli/src/i18n/zh-TW.ts' };
/** The guides the site serves under /docs/<page>/ and /zh-TW/docs/<page>/ (apps/site/scripts/site.ts). */
const GUIDE: Readonly<Record<string, Readonly<Record<Lang, string>>>> = {
  hosting: { en: 'docs/HOSTING.md', 'zh-TW': 'docs/zh-TW/HOSTING.md' },
  joining: { en: 'docs/JOINING.md', 'zh-TW': 'docs/zh-TW/JOINING.md' },
};

interface Address {
  readonly url: string;
  readonly lang: Lang;
  readonly page: string;
  readonly anchor: string;
}

/** The addresses with an anchor in a catalog's source (they are written out there: constants and the --help texts). */
function addressesOf(catalog: Lang): Address[] {
  const found: Address[] = [];
  for (const match of read(CATALOG[catalog]).matchAll(/https:\/\/smurg\.ai\/(zh-TW\/)?docs\/([a-z-]+)\/#([^\s'"`]+)/g)) {
    found.push({ url: match[0], lang: match[1] === undefined ? 'en' : 'zh-TW', page: match[2] as string, anchor: match[3] as string });
  }
  return found;
}

const headingIds = new Map<string, readonly string[]>();
/** The ids of a guide's headings, as the site makes them. */
function idsOf(guide: string): readonly string[] {
  let ids = headingIds.get(guide);
  if (ids === undefined) {
    ids = renderMarkdown(read(guide), { resolveLink: (href) => ({ href }), tableLabel: () => 'Table', reservedIds: ['main'] }).headings.map((heading) => heading.id);
    headingIds.set(guide, ids);
  }
  return ids;
}

describe('the guide addresses the command prints lead to a heading that is there', () => {
  it.each(['en', 'zh-TW'] as const)('%s: every address with an anchor is of this language\'s guide and names one of its headings', (catalog) => {
    const addresses = addressesOf(catalog);
    // The --help texts of host, status, attach, update and uninstall, and the one-line notices of smurg host.
    expect(addresses.length).toBeGreaterThanOrEqual(8);
    const problems: string[] = [];
    for (const address of addresses) {
      const guide = GUIDE[address.page]?.[address.lang];
      if (address.lang !== catalog) problems.push(`${address.url}: the ${catalog} catalog sends the reader to the guide in another language`);
      else if (guide === undefined) problems.push(`${address.url}: no guide is known for /docs/${address.page}/ (add it to GUIDE in this test)`);
      else if (!idsOf(guide).includes(address.anchor)) problems.push(`${address.url}: ${guide} has no heading with the id "${address.anchor}"`);
    }
    expect(problems).toEqual([]);
  });

  it('the one-line notices of smurg host name the part they are about: what an update keeps (9.2), the way back to a folder set aside (9.4)', () => {
    const want: Readonly<Record<Lang, readonly [string, string]>> = {
      en: ['92-after-an-update-what-your-workspace-keeps', '94-if-you-moved-the-state-folder-away-because-smurg-050-told-you-to'],
      'zh-TW': ['92-更新之後工作區保留了什麼', '94-如果你照-smurg-050-的指示把狀態資料夾移走了'],
    };
    for (const lang of ['en', 'zh-TW'] as const) {
      const anchors = addressesOf(lang).map((address) => address.anchor);
      for (const anchor of want[lang]) {
        expect(anchors, lang).toContain(anchor);
        expect(idsOf(GUIDE['hosting']?.[lang] as string), lang).toContain(anchor);
      }
    }
  });

  it('the rule itself: an address whose heading is gone is found', () => {
    expect(idsOf('docs/HOSTING.md')).toContain('9-updating-and-removing');
    expect(idsOf('docs/HOSTING.md')).not.toContain('92-after-an-update');
    expect(idsOf('docs/zh-TW/HOSTING.md')).toContain('9-更新與移除');
  });
});

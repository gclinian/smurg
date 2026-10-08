// What the documents say about an update is what was built (0.5.1, the last fixes).
//
// docs-quotes.test.ts holds single sentences to the catalogs. A document can quote every sentence right and still
// send its reader the wrong way. Five sceptics followed the documents to the letter with the real executables and
// found where:
//   - HOSTING §9.4 said that whoever holds the key of the time in between is "asked" about a changed key. They are
//     not: their page says "Security warning: connection refused", only a link gets them on, the host's own browser
//     is one of them, and a member whose role is not the link's is refused AFTER confirming the key (V3-1, V3-2);
//     and nothing told the host to go through the members and roles that came back (V3-4);
//   - §9.3 answered a damaged file of read marks with the last resort. Which ONE file a host can set aside is the
//     daemon's decision, document by document, and the guide's table must be that list (V5-1);
//   - RELEASING §4.5 step 5 printed a command that failed as printed, and said that a skipped run says so on stderr
//     when it did not (V2-1, V5-3, V5-4);
//   - CONTRIBUTING said that the pin sees more than it saw (V5-2).
// So this lint reads SECTIONS of the documents against what decides: the catalogs, the daemon's declarations, the
// head of the opt-in test and its rules, the pin's own lists. English and zh-TW alike.
import { describe, expect, it } from 'vitest';
import { SET_ASIDE_DOCUMENTS } from '../../packages/cli/src/i18n/en.ts';
import { UPGRADE_SKIPPED, upgradePlan } from '../../packages/cli/test/sea-binaries.ts';
import { cli, webCatalogue, wire, type Locale } from './catalogs.ts';
import { GUIDES, flat, section, tableRows } from './guides.ts';
import { read, repoFiles } from './tree.ts';

const LOCALES: readonly Locale[] = ['en', 'zh-TW'];
const HOSTING = GUIDES.HOSTING;
const JOINING = GUIDES.JOINING;

/** A part of a CLI message as a guide quotes it; the part must be in the catalog's rendering. */
function cliPart(locale: Locale, id: Parameters<typeof cli>[1], params: Readonly<Record<string, unknown>> | undefined, part: Readonly<Record<Locale, string>>): string {
  const quoted = flat(part[locale]);
  expect(flat(cli(locale, id, params)), `the quoted part of ${id} is no longer what the catalog renders`).toContain(quoted);
  return quoted;
}

// ------------------------------------------------------------------------------------- going back (HOSTING §9.4)

describe('going back to a state folder that was moved away: what people read, and the way on (HOSTING §9.4, §8; JOINING §1)', () => {
  it.each(LOCALES)('%s: §9.4 names the screen of whoever holds the key of the time in between, the sentence of smurg attach, the question a link asks, and the link the host opens', async (locale) => {
    const web = await webCatalogue();
    const text = flat(section(HOSTING[locale], '9.4'));
    const must: readonly (readonly [string, string])[] = [
      ['the page of whoever recorded the key of the time in between', flat(web.text(locale, 'conn.keyMismatch.title'))],
      [
        'what smurg attach says to them',
        cliPart(locale, 'channel.keyMismatch.device', undefined, {
          en: "the key of the host's computer differs from the one this computer recorded last time",
          'zh-TW': '主人電腦的金鑰和這台電腦上次記錄的不同',
        }),
      ],
      ['the question a link then asks', flat(web.text(locale, 'join.keyChange.title'))],
      [
        "the host's own link, for the host's own browser",
        cliPart(locale, 'host.summary', { name: 'my-app', hostUrl: 'https://…', inviteHeading: '', inviteUrl: 'https://…' }, { en: 'Your link', 'zh-TW': '你的連結' }),
      ],
    ];
    for (const [what, quoted] of must) expect(text.includes(quoted), `${HOSTING[locale]} §9.4 does not name ${what}: ${quoted}`).toBe(true);
  });

  it.each(LOCALES)("%s: §9.4 says what a member whose role is not the link's reads after confirming the key, by the names of the roles", async (locale) => {
    const web = await webCatalogue();
    const text = flat(section(HOSTING[locale], '9.4'));
    expect(text.includes(flat(web.text(locale, 'conn.rejected.invite-invalid.title'))), `${HOSTING[locale]} §9.4 does not name the screen "${web.text(locale, 'conn.rejected.invite-invalid.title')}"`).toBe(true);
    for (const role of ['role.viewer', 'role.agent', 'role.editor'] as const) expect(text.includes(wire(locale, role)), `${HOSTING[locale]} §9.4 does not name the role ${wire(locale, role)}`).toBe(true);
  });

  it.each(LOCALES)('%s: §9.4 sends the host through the members, the roles and the invite links after going back', (locale) => {
    const text = flat(section(HOSTING[locale], '9.4'));
    const sentence = locale === 'en' ? /go through the members, the roles and the invite links in the host console/i : /到主人控制台把成員、角色和邀請連結看過一遍/;
    expect(sentence.test(text), `${HOSTING[locale]} §9.4 does not tell the host to go through the members, the roles and the invite links`).toBe(true);
  });

  it.each(LOCALES)('%s: the troubleshooting table has a row for the screen, and the row leads to §9.4', async (locale) => {
    const web = await webCatalogue();
    const title = flat(web.text(locale, 'conn.keyMismatch.title'));
    const rows = tableRows(section(HOSTING[locale], '8')).filter((cells) => flat(cells[0] ?? '').includes(title));
    expect(rows.length, `${HOSTING[locale]} §8 has no row for "${title}"`).toBe(1);
    expect(rows[0]?.[1] ?? '').toContain('§9.4');
  });

  it.each(LOCALES)("%s: the teammates' guide says in its row for the refused link that the key was accepted all the same", async (locale) => {
    const web = await webCatalogue();
    const title = flat(web.text(locale, 'conn.rejected.invite-invalid.title'));
    const rows = tableRows(section(JOINING[locale], '1')).filter((cells) => flat(cells[0] ?? '').includes(title));
    expect(rows.length, `${JOINING[locale]} §1 has no row for "${title}"`).toBe(1);
    const cell = flat(rows[0]?.[1] ?? '');
    // The case is the one after the key question; the row names it by the question's own title.
    expect(cell.includes(flat(web.text(locale, 'join.keyChange.title'))), `${JOINING[locale]}: the row for "${title}" does not name the key question`).toBe(true);
  });
});

// ------------------------------------------------------------------------------- one file set aside (HOSTING §9.3)

interface Declared {
  readonly name: string;
  readonly canSetAside: boolean;
  readonly file: string;
}

/**
 * Every document the daemon declares, read from its source as text (this folder loads no daemon): each
 * `declareDocument({ name: …, … })` with its name (a literal, or a constant of the same file) and whether the
 * declaration says `canSetAside: true`. A declaration this cannot read fails: the guide's table must follow it.
 */
function declaredDocuments(): Declared[] {
  const out: Declared[] = [];
  for (const file of repoFiles().filter((path) => /^packages\/daemon\/src\/.*\.ts$/.test(path) && !path.endsWith('.test.ts'))) {
    const source = read(file);
    for (const match of source.matchAll(/declareDocument\(\{([\s\S]*?)\}\);/g)) {
      const body = match[1] as string;
      const named = /^\s*name: (?:'([a-z-]+)'|([A-Z][A-Z_]*))\s*,/.exec(body);
      if (named === null) throw new Error(`${file}: a declareDocument whose name this lint cannot read: ${body.slice(0, 80)}`);
      const literal = named[1] ?? new RegExp(`const ${named[2] as string} = '([a-z-]+)';`).exec(source)?.[1];
      if (literal === undefined) throw new Error(`${file}: the constant ${named[2] as string} of a declareDocument is not a text of this file`);
      out.push({ name: literal, canSetAside: /\bcanSetAside: true\b/.test(body), file });
    }
  }
  return out;
}

describe('one file of a workspace folder set aside alone (HOSTING §9.3)', () => {
  const declared = declaredDocuments();
  const can = declared.filter((document) => document.canSetAside).map((document) => `${document.name}.json`);
  const cannot = declared.filter((document) => !document.canSetAside).map((document) => `${document.name}.json`);

  it('the daemon declares its documents where this lint reads them, and the command has a sentence for exactly those it lets a host set aside', () => {
    expect(new Set(declared.map((document) => document.name)).size).toBe(declared.length);
    expect(declared.length).toBeGreaterThanOrEqual(12);
    expect(cannot).toContain('state.json');
    expect(declared.filter((document) => document.canSetAside).map((document) => document.name).sort()).toEqual([...SET_ASIDE_DOCUMENTS].sort());
  });

  it.each(LOCALES)('%s: the table names exactly the files the daemon lets a host set aside, each with what it holds and what is lost', (locale) => {
    const rows = tableRows(section(HOSTING[locale], '9.3')).filter((cells) => /^`[a-z-]+\.json`$/.test(cells[0] ?? ''));
    expect(rows.map((cells) => (cells[0] as string).replaceAll('`', '')).sort()).toEqual([...can].sort());
    for (const cells of rows) {
      expect(cells.length, cells[0]).toBe(3);
      for (const cell of cells) expect(cell.length, cells[0]).toBeGreaterThan(5);
    }
  });

  it.each(LOCALES)('%s: every other document, and the key, is named as a file that cannot be set aside', (locale) => {
    const outside = section(HOSTING[locale], '9.3')
      .split('\n')
      .filter((line) => !/^\| `[a-z-]+\.json` \|/.test(line))
      .join('\n');
    for (const name of [...cannot, 'identity.key']) expect(outside.includes(`\`${name}\``), `${HOSTING[locale]} §9.3 does not say that ${name} cannot be set aside`).toBe(true);
  });

  it.each(LOCALES)("%s: \"this one file can be set aside\" comes before the last resort, in the terminal's own words, with the name the file is moved to", (locale) => {
    const markdown = section(HOSTING[locale], '9.3');
    const text = flat(markdown);
    const aside = text.indexOf(cliPart(locale, 'host.setAside', { document: 'inbox' }, { en: 'This one file can be set aside without losing the workspace', 'zh-TW': '這一個檔案可以單獨移到旁邊，工作區不會因此不見' }));
    const lastResort = text.indexOf(cliPart(locale, 'host.unreadable.lastResort', undefined, { en: 'The last resort is a new workspace.', 'zh-TW': '最後的辦法是建立新的工作區。' }));
    expect(aside, `${HOSTING[locale]} §9.3 does not quote the sentence about setting one file aside`).toBeGreaterThan(-1);
    expect(lastResort).toBeGreaterThan(aside);
    expect(markdown).toContain('.set-aside-');
  });

  it.each(LOCALES)('%s: the guide shows what an entry of workspaces.json holds, by the fields the terminal lists', (locale) => {
    const fields = [...cli('en', 'host.entryUnread.next', { workspacesDir: '~/.smurg/workspaces' }).matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1] as string);
    expect(fields).toEqual(['folder', 'relay', 'workspaceId', 'createdAt']);
    const markdown = section(HOSTING[locale], '9.3');
    for (const field of fields) expect(markdown.includes(`"${field}":`), `${HOSTING[locale]} §9.3 shows no entry with "${field}"`).toBe(true);
  });
});

// ----------------------------------------------------------------------- the release dry run (RELEASING §4.5 step 5)

/** The lines of every ```sh block of `markdown`, trimmed, per block. */
function shBlocks(markdown: string): string[][] {
  return [...markdown.matchAll(/```sh\n([\s\S]*?)```/g)].map((block) =>
    (block[1] as string)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
}

describe('the upgrade test with the published executables, as the release guide prints it (docs/RELEASING.md §4.5)', () => {
  const dryRun = section('docs/RELEASING.md', '4.5');

  it('the command is the one at the head of the test file, which is held to work as printed from the repository\'s root', () => {
    const head = read('packages/cli/test/sea-upgrade.test.ts').split('\nimport ')[0] as string;
    const command = head
      .split('\n')
      .map((line) => line.replace(/^\/\/\s*/, '').trim())
      .filter((line) => /^SMURG_PREVIOUS_BINARIES=\S+ \\$|^SMURG_SEA_BINARY=\S+ \\$|^pnpm --filter @smurg\/cli exec vitest run test\/sea-upgrade\.test\.ts$/.test(line));
    expect(command).toHaveLength(3);
    const printed = shBlocks(dryRun).filter((lines) => lines.some((line) => line.endsWith('vitest run test/sea-upgrade.test.ts')));
    expect(printed).toEqual([command]);
    // The rules that make it work as printed are tested where they live.
    expect(repoFiles()).toContain('packages/cli/test/sea-upgrade-asked.test.ts');
  });

  it('says what a run that did not test prints, in the test\'s own words, and how its last lines read', () => {
    const text = flat(dryRun);
    const skipped = flat(UPGRADE_SKIPPED.slice(0, UPGRADE_SKIPPED.indexOf(' It needs ')));
    expect(skipped).toBe('[sea-upgrade] SKIPPED: the upgrade from the published executables was NOT tested.');
    expect(text.includes(skipped), `docs/RELEASING.md §4.5 does not quote: ${skipped}`).toBe(true);
    expect(text).toContain('Tests 1 skipped (1)');
    expect(text).toContain('Tests 2 passed (2)');
  });

  it("says that a release's gate fails without the two variables, and prints the gate with them", () => {
    const gate = upgradePlan({ SMURG_RELEASE_GATE: '1' });
    expect(gate.kind).toBe('failed');
    const lines = shBlocks(dryRun).flat();
    const withBoth = lines.join(' ').replaceAll('\\ ', '');
    expect(/SMURG_PREVIOUS_BINARIES=\S+ +SMURG_SEA_BINARY=\S+ +SMURG_RELEASE_GATE=1 pnpm check/.test(withBoth), 'docs/RELEASING.md §4.5 prints no gate command with both variables').toBe(true);
    // §4 step 1 (the checklist of a release) names them too: a gate run without them is red since 0.5.1.
    const cutting = flat(section('docs/RELEASING.md', '4'));
    expect(cutting.slice(0, cutting.indexOf('4.1 '))).toContain('SMURG_PREVIOUS_BINARIES');
  });
});

// ------------------------------------------------------------------------------- what the pin sees (CONTRIBUTING.md)

describe('CONTRIBUTING says what the pin sees (packages/daemon/test/upgrade/pin.test.ts)', () => {
  const pin = read('packages/daemon/test/upgrade/pin.test.ts');
  const contributing = read('CONTRIBUTING.md');
  const start = contributing.indexOf('### When you change something smurg stores');
  const chapter = contributing.slice(start, contributing.indexOf('\n## ', start));

  it('names every list of pinned values the test has: a new pin is described, and one that is gone is not promised', () => {
    expect(start).toBeGreaterThan(-1);
    const from = pin.indexOf('// The pinned values');
    const to = pin.indexOf('// The walk:');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const lists = [...pin.slice(from, to).matchAll(/^const ([A-Z][A-Z_]+): (?:Readonly<Record<string, string>>|readonly \{)/gm)].map((match) => match[1] as string);
    expect(lists.length).toBeGreaterThanOrEqual(5);
    for (const name of lists) expect(chapter.includes(`\`${name}\``), `CONTRIBUTING.md does not say what the pin's ${name} is`).toBe(true);
    // And the other way round: a list CONTRIBUTING names as the pin's is one the test has.
    const named = [...chapter.matchAll(/`([A-Z][A-Z_]{3,})`/g)].map((match) => match[1] as string).filter((name) => !['WORKSPACE_SHAPES', 'NOT_PUBLISHED_YET', 'SMURG_PIN_WRITE'].includes(name));
    for (const name of named) expect(pin.includes(`const ${name}`), `CONTRIBUTING.md names ${name}, which pin.test.ts does not have`).toBe(true);
  });

  it('says what the pin does not see, as the head of the test does', () => {
    expect(pin).toContain('It does NOT see:');
    expect(flat(chapter)).toMatch(/does not see/i);
    // The sentence the sceptic found untrue: the pin was said to hash the protocol package only.
    expect(flat(chapter)).not.toContain('It holds a hash of every source file of packages/protocol that a stored schema is built from, the shape');
  });
});

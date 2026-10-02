// The catalogs of the packages agree with each other (DESIGN A.3, A.11 item 2). Each catalog has a parity test of its
// own next to it (keys, parameters, plural forms, unused ids); this test is the view across packages:
//   1. every catalog exists in exactly the two locales with the same keys, English without CJK;
//   2. words that two packages show for the same thing are the same words (language names, role labels, the offline
//      label and the key-change title the CLI quotes from the web app, the login button of the relay and the web app);
//   3. the glossary's terms hold in every catalog (docs/GLOSSARY.md): one translation per term, "log in" not "sign in".
import { describe, expect, it } from 'vitest';
import { CLI_CATALOGS, LOCALES, MESSAGE_IDS, RELAY_STRINGS, cli, siteChrome, webCatalogue, wire, type Locale } from './catalogs.ts';
import { CJK, read } from './tree.ts';

/** Every leaf of a nested table as `path -> text` (functions are called with placeholder arguments). */
function leaves(table: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') out.set(path, value);
    else if (typeof value === 'function') {
      let text: unknown;
      try {
        text = (value as (...args: unknown[]) => unknown)(...Array.from({ length: value.length }, (_, i) => `x${i}`));
      } catch {
        text = undefined; // a function of structured parameters: its own package's test renders it
      }
      out.set(path, typeof text === 'string' ? text : '');
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`));
    else if (typeof value === 'object' && value !== null) for (const [key, item] of Object.entries(value)) visit(item, path === '' ? key : `${path}.${key}`);
    else out.set(path, String(value));
  };
  visit(table, prefix);
  return out;
}

interface InstallerMessage {
  readonly line: number;
  readonly en: string;
  readonly zh: string;
}

/** Every `msg 'english' '中文' …` / `failf …` of the installer. */
function installerMessages(): InstallerMessage[] {
  const out: InstallerMessage[] = [];
  read('scripts/install.sh')
    .split('\n')
    .forEach((line, index) => {
      if (/^\s*(?:#|msg\(\)|failf\(\))/.test(line)) return;
      for (const call of line.matchAll(/(?:^|[\s;|&(])(?:msg|failf) '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'/g)) {
        out.push({ line: index + 1, en: call[1] as string, zh: call[2] as string });
      }
    });
  return out;
}

const SIGN_IN = /\bsign(?:ed|ing|s)?[ -](?:in|out)\b|\bsign-?(?:in|out)s?\b/i;

describe('every catalog has the two locales, key for key', () => {
  it('the locales are en and zh-TW', () => {
    expect([...LOCALES]).toEqual(['en', 'zh-TW']);
  });

  it('the CLI catalog', () => {
    expect(Object.keys(CLI_CATALOGS).sort()).toEqual(['en', 'zh-TW']);
    expect(Object.keys(CLI_CATALOGS['zh-TW']).sort()).toEqual(Object.keys(CLI_CATALOGS.en).sort());
    expect(Object.keys(CLI_CATALOGS.en).length).toBeGreaterThan(250);
  });

  it('the relay pages', () => {
    expect(Object.keys(RELAY_STRINGS).sort()).toEqual(['en', 'zh-TW']);
    expect(Object.keys(RELAY_STRINGS['zh-TW']).sort()).toEqual(Object.keys(RELAY_STRINGS.en).sort());
    const english = leaves(RELAY_STRINGS.en);
    for (const [key, text] of english) expect(text, key).not.toMatch(CJK);
  });

  it('the web catalogue', async () => {
    const web = await webCatalogue();
    expect([...web.table('zh-TW').keys()].sort()).toEqual([...web.keys].sort());
    expect(web.keys.length).toBeGreaterThan(1000);
    for (const key of web.keys) {
      const value = web.table('en').get(key);
      for (const form of typeof value === 'string' ? [value] : [value?.one ?? '', value?.other ?? '']) expect(form, key).not.toMatch(CJK);
    }
  });

  it('the site chrome', async () => {
    const chrome = await siteChrome();
    expect(Object.keys(chrome).sort()).toEqual(['en', 'zh-TW']);
    const english = leaves(chrome.en);
    const chinese = leaves(chrome['zh-TW']);
    expect([...chinese.keys()].sort()).toEqual([...english.keys()].sort());
    expect(english.size).toBeGreaterThan(20);
    for (const [key, text] of english) expect(text, key).not.toMatch(CJK);
  });

  it('the wire catalog renders every parameterless message in both locales', () => {
    expect(MESSAGE_IDS.length).toBeGreaterThan(150);
    let rendered = 0;
    for (const id of MESSAGE_IDS) {
      let english: string;
      try {
        english = (wire as (locale: Locale, id: string) => string)('en', id);
      } catch {
        continue; // a message with required parameters: packages/protocol/src/i18n/catalog.test.ts renders those
      }
      rendered += 1;
      expect(english, id).not.toMatch(CJK);
      expect((wire as (locale: Locale, id: string) => string)('zh-TW', id), id).not.toBe('');
    }
    expect(rendered).toBeGreaterThan(40);
  });

  it('the installer: every message has both languages, the same %s count, English in ASCII', () => {
    const messages = installerMessages();
    expect(messages.length).toBeGreaterThan(35);
    for (const message of messages) {
      const at = `scripts/install.sh:${message.line}`;
      expect((message.zh.match(/%s/g) ?? []).length, at).toBe((message.en.match(/%s/g) ?? []).length);
      // eslint-disable-next-line no-control-regex
      expect(message.en, at).toMatch(/^[\x00-\x7f]*$/);
      // A line that is only a command or an address is the same in both languages; anything else is translated.
      if (/[A-Za-z]{3,} [a-z]{3,}/.test(message.en.replace(/https?:\/\/\S+|smurg [a-z-]+( --?[a-z-]+| <[^>]+>| ~?\S*\/\S*)*/g, ''))) expect(message.zh, at).toMatch(CJK);
    }
  });
});

describe('one wording for one thing, across packages', () => {
  it('each language is named in its own language, everywhere the same', async () => {
    const chrome = await siteChrome();
    expect(read('apps/web/src/lib/locale.ts')).toContain("LOCALE_NAMES: Readonly<Record<Locale, string>> = Object.freeze({ en: 'English', 'zh-TW': '繁體中文' })");
    expect(read('apps/relay/src/lib/strings.ts')).toContain("LANGUAGE_NAMES: Readonly<Record<Locale, string>> = { en: 'English', 'zh-TW': '繁體中文' }");
    expect([chrome.en['name'], chrome['zh-TW']['name']]).toEqual(['English', '繁體中文']);
  });

  it('role labels are the glossary’s, from the wire catalog only: the CLI and the web app keep no copy', async () => {
    const glossary = read('docs/GLOSSARY.md');
    const roles = [
      ['role.host', 'Host', '主人'],
      ['role.agent', 'Agent access', '可使用 agent'],
      ['role.editor', 'Editor', '可編輯'],
      ['role.viewer', 'Viewer', '旁觀'],
    ] as const;
    for (const [id, english, chinese] of roles) {
      expect(wire('en', id)).toBe(english);
      expect(wire('zh-TW', id)).toBe(chinese);
      expect(glossary).toMatch(new RegExp(`\\| \\*\\*${english}\\*\\*[^|]*\\| ${chinese} \\| \`${id.slice(5)}\` \\|`));
    }
    expect(Object.keys(CLI_CATALOGS.en).filter((id) => /^role\./.test(id))).toEqual([]);
    const web = await webCatalogue();
    // "Host" also names the person and "Editor" the code editor; the other names are a role's and nothing else's.
    const labels = new Set(['Agent access', 'Viewer', '可使用 agent', '可編輯', '旁觀']);
    const copies = web.keys.filter((key) => LOCALES.some((locale) => typeof web.table(locale).get(key) === 'string' && labels.has(web.table(locale).get(key) as string)));
    expect(copies).toEqual([]);
  });

  it('what the CLI quotes from the web app is what the web app shows: the offline label and the key-change title', async () => {
    const web = await webCatalogue();
    for (const locale of LOCALES) {
      const offline = web.text(locale, 'conn.pill.hostOffline');
      expect(cli(locale, 'host.keepAwake.notice', { state: 'x' })).toContain(offline);
      expect(cli(locale, 'host.keepAwake.lost', { state: 'x' })).toContain(offline);
      const keyChange = web.text(locale, 'join.keyChange.title');
      expect(cli(locale, 'attach.keyChange', { known: 'aa', offered: 'bb' })).toContain(keyChange);
      expect(cli(locale, 'usage.attach')).toContain(keyChange.replace(/^The /, ''));
    }
    expect(web.text('en', 'conn.pill.hostOffline')).toBe('Host offline');
  });

  it('the login button reads the same on the relay’s /device page and in the web app', async () => {
    const web = await webCatalogue();
    for (const locale of LOCALES) {
      expect(web.text(locale, 'app.login.google')).toBe(RELAY_STRINGS[locale].loginWith('Google'));
      expect(web.text(locale, 'app.login.github')).toBe(RELAY_STRINGS[locale].loginWith('GitHub'));
      expect(web.text(locale, 'app.login.dev.submit')).toBe(RELAY_STRINGS[locale].devLoginButton);
    }
  });

  it('the default name of a session nobody named comes from the wire catalog, with the agent’s language-neutral name', () => {
    expect(wire('en', 'session.title.agent', { owner: 'Ian' })).toBe('Claude (Ian)');
    expect(wire('zh-TW', 'session.title.agent', { owner: 'Ian' })).toBe('Claude (Ian)');
    expect(wire('en', 'session.title.terminal', { owner: 'Ian' })).toBe('Terminal (Ian)');
  });
});

describe('the glossary’s terms in every catalog', () => {
  /** English text -> its zh-TW counterpart, for every catalog that pairs them by key. */
  async function pairs(): Promise<{ at: string; en: string; zh: string }[]> {
    const out: { at: string; en: string; zh: string }[] = [];
    const web = await webCatalogue();
    const flat = (value: unknown): string => (typeof value === 'string' ? value : `${(value as { one: string }).one} ${(value as { other: string }).other}`);
    for (const key of web.keys) out.push({ at: `web ${key}`, en: flat(web.table('en').get(key)), zh: flat(web.table('zh-TW').get(key)) });
    const relayEn = leaves(RELAY_STRINGS.en);
    const relayZh = leaves(RELAY_STRINGS['zh-TW']);
    for (const [key, text] of relayEn) out.push({ at: `relay ${key}`, en: text, zh: relayZh.get(key) ?? '' });
    const cliEn = leaves(CLI_CATALOGS.en);
    const cliZh = leaves(CLI_CATALOGS['zh-TW']);
    for (const [key, text] of cliEn) out.push({ at: `cli ${key}`, en: text, zh: cliZh.get(key) ?? '' });
    const chrome = await siteChrome();
    const siteEn = leaves(chrome.en);
    const siteZh = leaves(chrome['zh-TW']);
    for (const [key, text] of siteEn) out.push({ at: `site ${key}`, en: text, zh: siteZh.get(key) ?? '' });
    for (const message of installerMessages()) out.push({ at: `scripts/install.sh:${message.line}`, en: message.en, zh: message.zh });
    return out;
  }

  it('English says "log in" / "log out", never "sign in" / "sign out"', async () => {
    const hits = (await pairs()).filter((pair) => SIGN_IN.test(pair.en)).map((pair) => `${pair.at}: ${pair.en}`);
    for (const file of ['activity', 'client', 'errors', 'files', 'notify', 'roles', 'sessions', 'worktrees']) {
      if (SIGN_IN.test(read(`packages/protocol/src/i18n/messages/${file}.ts`))) hits.push(`packages/protocol/src/i18n/messages/${file}.ts`);
    }
    expect(hits).toEqual([]);
  });

  it('a term has one translation: agent access, Host offline', async () => {
    const TERMS: readonly (readonly [RegExp, RegExp])[] = [
      [/\bagent access\b/i, /使用 agent/],
      [/\bHost offline\b/, /主人已離線/],
    ];
    const hits: string[] = [];
    for (const pair of await pairs()) {
      for (const [english, chinese] of TERMS) if (english.test(pair.en) && pair.zh !== '' && !chinese.test(pair.zh)) hits.push(`${pair.at}: "${pair.en}" / "${pair.zh}" (expected ${chinese.source})`);
    }
    expect(hits).toEqual([]);
  });

  it('the agent’s name is written Claude (X) with ASCII brackets in both languages', async () => {
    const hits = (await pairs()).filter((pair) => /Claude（/.test(pair.zh) && !/開的/.test(pair.zh)).map((pair) => `${pair.at}: ${pair.zh}`);
    expect(hits).toEqual([]);
  });
});

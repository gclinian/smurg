// The guides and the product page quote what smurg prints and shows (DESIGN B.5). A quote that drifts from the
// catalogs sends a reader looking for a button that is not there, so both directions are checked, per language:
//
//   forward: a list of messages (catalog id + sample parameters) that the guides must quote as the catalogs render
//            them: the samples of `smurg login` and `smurg host`, the troubleshooting tables, role names, main buttons;
//   reverse: every quoted text of a guide ("…" in English, 「…」 in zh-TW, and the lines of its sample blocks) and every
//            label of the product page's picture of the app is found in the catalogs of its language, except the
//            quotes listed below that are not UI text (prose, other products' words, composed samples).
//
// English guide <-> English catalogs, zh-TW guide <-> zh-TW catalogs: a guide never quotes the other language.
import { describe, expect, it } from 'vitest';
import { agentHeldReason, humanHeldReason } from '../../packages/daemon/src/hooks/deny-text.ts';
import { RELAY_STRINGS, cli, webCatalogue, wire, type CliMessageId, type Locale, type WebCatalogue } from './catalogs.ts';
import { CJK, read, repoFiles } from './tree.ts';

type Guide = 'HOSTING' | 'JOINING';
const GUIDES: Readonly<Record<Guide, Readonly<Record<Locale, string>>>> = {
  HOSTING: { en: 'docs/HOSTING.md', 'zh-TW': 'docs/zh-TW/HOSTING.md' },
  JOINING: { en: 'docs/JOINING.md', 'zh-TW': 'docs/zh-TW/JOINING.md' },
};
const LANDING: Readonly<Record<Locale, string>> = { en: 'apps/site/public/index.html', 'zh-TW': 'apps/site/public/zh-TW/index.html' };

/** One line of text: Markdown emphasis and code marks dropped, whitespace collapsed (zh-TW: none between Han characters). */
function flat(text: string): string {
  const joined = text
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const han = '[\\u2E80-\\u9FFF\\uFF00-\\uFFEF\\u3000-\\u303F]'.replace(/\\u([0-9A-F]{4})/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
  return joined.replace(new RegExp(`(${han}) (?=${han})`, 'g'), '$1');
}

const guideText = new Map<string, string>();
function guide(path: string): string {
  let text = guideText.get(path);
  if (text === undefined) {
    text = flat(read(path));
    guideText.set(path, text);
  }
  return text;
}

interface Quote {
  /** What it is, for the failure message. */
  readonly what: string;
  readonly guides: readonly Guide[];
  /** The catalog's rendering in `locale`. */
  render(locale: Locale, web: WebCatalogue): string;
  /**
   * The part of the rendering a guide quotes, per language, when it does not quote all of it (a sentence that goes
   * on with an address or a name). The part must be in the rendering and in the guide.
   */
  readonly part?: Readonly<Record<Locale, string>>;
}

const cliQuote = (id: CliMessageId, params: Readonly<Record<string, unknown>> | undefined, guides: readonly Guide[], part?: Readonly<Record<Locale, string>>): Quote => ({
  what: `CLI ${id}`,
  guides,
  render: (locale) => cli(locale, id, params),
  ...(part === undefined ? {} : { part }),
});
const webQuote = (key: string, guides: readonly Guide[], vars?: Readonly<Record<string, string | number>>): Quote => ({
  what: `web ${key}`,
  guides,
  render: (locale, web) => web.text(locale, key, vars),
});

const INVITE_URL = 'https://app.smurg.ai/join/ws_…#k=…&s=…';

const QUOTES: readonly Quote[] = [
  // ---- smurg login (HOSTING §2)
  cliQuote('login.open', { page: 'https://app.smurg.ai/device', code: 'WDJB-MJHT', minutes: 10 }, ['HOSTING']),
  cliQuote('login.done', { origin: 'https://app.smurg.ai', name: 'Ian', userId: 'google:1' }, ['HOSTING'], { en: 'Logged in to', 'zh-TW': '已登入' }),
  { what: 'relay next', guides: ['HOSTING'], render: (locale) => RELAY_STRINGS[locale].next },
  { what: 'relay allow', guides: ['HOSTING', 'JOINING'], render: (locale) => RELAY_STRINGS[locale].allow },
  { what: 'relay deny', guides: ['HOSTING'], render: (locale) => RELAY_STRINGS[locale].deny },
  // ---- smurg host (HOSTING §3, §6, §9)
  {
    what: 'CLI host.summary with host.invite.heading',
    guides: ['HOSTING'],
    render: (locale) =>
      cli(locale, 'host.summary', {
        name: 'my-app',
        hostUrl: INVITE_URL,
        inviteHeading: cli(locale, 'host.invite.heading', { amount: 7, unit: 'day' }),
        inviteUrl: INVITE_URL,
      }),
  },
  cliQuote('host.update.notice', { latest: '0.4.1', current: '0.4.0' }, ['HOSTING']),
  {
    what: 'CLI host.keepAwake.notice with power.off.refused',
    guides: ['HOSTING'],
    render: (locale) => cli(locale, 'host.keepAwake.notice', { state: cli(locale, 'power.off.refused') }),
    part: { en: 'Warning: keep-awake: off (the system (polkit) does not allow blocking sleep,', 'zh-TW': '防止睡眠：未啟用（系統（polkit）不允許防止睡眠' },
  },
  // ---- the troubleshooting table (HOSTING §8)
  cliQuote('relay.unreachable', { origin: 'https://app.smurg.ai', action: 'claim' }, ['HOSTING'], { en: 'Cannot reach the relay', 'zh-TW': '無法連線到 relay' }),
  cliQuote('relay.refused', { origin: 'https://app.smurg.ai', action: 'claim', status: 500, code: 'internal' }, ['HOSTING'], { en: 'the relay refused the request', 'zh-TW': 'relay 拒絕了請求' }),
  cliQuote('host.locked.shared', undefined, ['HOSTING'], { en: 'This folder is already being shared', 'zh-TW': '這個資料夾已經在分享中' }),
  cliQuote('host.locked.ancestor', undefined, ['HOSTING']),
  cliQuote('host.relay.authRejected', { origin: 'https://app.smurg.ai' }, ['HOSTING'], { en: "the relay refused this computer's login", 'zh-TW': 'relay 拒絕了這台電腦的登入' }),
  cliQuote('login.expired', undefined, ['HOSTING']),
  cliQuote('login.unsupported', { origin: 'https://relay.example' }, ['HOSTING'], { en: 'This relay does not support logging in with a code yet', 'zh-TW': '這個 relay 還不支援用代碼登入' }),
  cliQuote('host.state.unsaved', undefined, ['HOSTING'], { en: "smurg's state file could not be written", 'zh-TW': '無法寫入 smurg 的狀態檔' }),
  cliQuote('host.stateFile', undefined, ['HOSTING']),
  cliQuote('state.socketPathTooLong', { path: '/x' }, ['HOSTING'], { en: "The path of smurg's state folder is too long for a Unix socket", 'zh-TW': 'smurg 的狀態目錄路徑太長' }),
  cliQuote('uninstall.question', undefined, ['HOSTING'], { en: 'Remove these? [y/N]', 'zh-TW': '確定要移除嗎？ [y/N]' }),
  // ---- one title for the key change, in the web app and in `smurg attach`
  webQuote('join.keyChange.title', ['HOSTING', 'JOINING']),
  cliQuote('attach.keyChange', { known: 'aa', offered: 'bb' }, ['JOINING'], { en: "The host computer's key has changed", 'zh-TW': '主人的電腦金鑰和之前不同' }),
  cliQuote('attach.readOnly', { owner: 'Amy' }, ['JOINING'], { en: 'Read-only:', 'zh-TW': '唯讀模式' }),
  // ---- roles (the wire catalog: one wording for the web app and the CLI)
  { what: 'wire role.agent', guides: ['HOSTING', 'JOINING'], render: (locale) => wire(locale, 'role.agent') },
  { what: 'wire role.editor', guides: ['HOSTING', 'JOINING'], render: (locale) => wire(locale, 'role.editor') },
  { what: 'wire role.viewer', guides: ['HOSTING', 'JOINING'], render: (locale) => wire(locale, 'role.viewer') },
  // ---- the web app (JOINING)
  webQuote('app.login.google', ['JOINING']),
  webQuote('join.confirm.join', ['JOINING']),
  webQuote('join.keyChange.confirm', ['JOINING']),
  webQuote('conn.keyMismatch.title', ['JOINING']),
  webQuote('conn.pill.hostOffline', ['HOSTING', 'JOINING']),
  webQuote('conn.pill.relayUnreachable', ['HOSTING', 'JOINING']),
  webQuote('conn.pill.roleChanged', ['JOINING']),
  webQuote('editor.lock.release', ['JOINING']),
  webQuote('agents.terminal.watchOnly', ['JOINING']),
  webQuote('suggest.queue.accept', ['JOINING']),
  webQuote('suggest.queue.editAccept', ['JOINING']),
  webQuote('suggest.queue.reject', ['JOINING']),
  webQuote('activity.actor.system', ['JOINING']),
  // ---- the activity feed's sentences (the wire catalog)
  { what: 'wire activity.agentBashChange', guides: ['HOSTING'], render: (locale) => wire(locale, 'activity.agentBashChange', { agent: 'Claude (Amy)', path: 'src/app.ts', change: 'change' }) },
];

/** The sentences of the activity feed in the product page's picture of the app. */
const PICTURE_QUOTES: readonly { what: string; render(locale: Locale, web: WebCatalogue): string }[] = [
  { what: 'wire activity.agentEdit', render: (locale) => wire(locale, 'activity.agentEdit', { agent: 'Claude (Amy)', path: 'tests/login.test.ts', tool: 'Edit' }) },
  { what: 'wire activity.fileUpload', render: (locale) => wire(locale, 'activity.fileUpload', { path: 'data/fixtures.json' }) },
  { what: 'wire activity.agentBashChange', render: (locale) => wire(locale, 'activity.agentBashChange', { agent: 'Claude (Ian)', path: 'package.json', change: 'change' }) },
  { what: 'web activity.via.shell', render: (locale, web) => web.text(locale, 'activity.via.shell') },
  { what: 'web worktree.switcherLabel', render: (locale, web) => web.text(locale, 'worktree.switcherLabel') },
  { what: 'web agents.action.new', render: (locale, web) => web.text(locale, 'agents.action.new') },
  { what: 'web workbench.topbar.console', render: (locale, web) => web.text(locale, 'workbench.topbar.console') },
  { what: 'web conn.pill.online', render: (locale, web) => web.text(locale, 'conn.pill.online') },
  { what: 'wire role.host', render: (locale) => wire(locale, 'role.host') },
];

/**
 * What an agent reads when a file is locked is fixed English (packages/daemon/src/hooks/deny-text.ts): both guides
 * quote the same English sentence and say so.
 */
const AGENT_READS: Readonly<Record<Locale, readonly string[]>> = {
  en: [humanHeldReason(['<your name>']), agentHeldReason('Claude (Amy)')],
  'zh-TW': [humanHeldReason(['<你的名字>']), agentHeldReason('Claude (Amy)')],
};

describe('the guides quote the catalogs: listed messages (forward)', () => {
  it.each(QUOTES.flatMap((quote) => quote.guides.flatMap((name) => (['en', 'zh-TW'] as const).map((locale) => [quote.what, GUIDES[name][locale], locale, quote] as const))))(
    '%s is quoted in %s as the %s catalog renders it',
    async (_what, path, locale, quote) => {
      const rendering = flat(quote.render(locale, await webCatalogue()));
      expect(rendering).not.toBe('');
      const quoted = quote.part === undefined ? rendering : flat(quote.part[locale]);
      expect(rendering, 'the quoted part is no longer what the catalog renders').toContain(quoted);
      expect(guide(path).includes(quoted), `${path} does not quote: ${quoted}`).toBe(true);
    },
  );

  it.each(PICTURE_QUOTES.flatMap((quote) => (['en', 'zh-TW'] as const).map((locale) => [quote.what, LANDING[locale], locale, quote] as const)))(
    '%s is in the picture of the app on %s as the %s catalog renders it',
    async (_what, path, locale, quote) => {
      const rendering = flat(quote.render(locale, await webCatalogue()));
      const page = flat(
        read(path)
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'"),
      );
      expect(page.includes(rendering), `${path} does not show: ${rendering}`).toBe(true);
    },
  );

  it('the text an agent reads is quoted in English in both languages of the guide for teammates', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      const text = guide(GUIDES.JOINING[locale]);
      expect(AGENT_READS[locale].filter((sentence) => text.includes(flat(sentence))).length, GUIDES.JOINING[locale]).toBeGreaterThanOrEqual(1);
    }
  });

  it('the English guides never quote zh-TW text, and no guide spells the agent name with full-width brackets', () => {
    for (const name of ['HOSTING', 'JOINING'] as const) {
      expect(CJK.test(read(GUIDES[name].en).replaceAll('繁體中文', ''))).toBe(false);
      for (const locale of ['en', 'zh-TW'] as const) expect(read(GUIDES[name][locale])).not.toMatch(/Claude（(?:Amy|Ian|Ben)）/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------- reverse

/** The text of every catalog of one language, as written in the source (templates with their placeholders). */
function corpus(locale: Locale): string {
  const files = repoFiles();
  const web = files.filter((path) => /^apps\/web\/src\/(?:strings\/[a-z]+|features\/[a-z]+\/strings)(\.zh-TW)?\.ts$/.test(path));
  const picked =
    locale === 'en'
      ? [...web.filter((path) => !path.includes('.zh-TW.')), 'packages/cli/src/i18n/en.ts']
      : [...web.filter((path) => path.includes('.zh-TW.')), 'packages/cli/src/i18n/zh-TW.ts'];
  const both = ['apps/relay/src/lib/strings.ts', ...files.filter((path) => /^packages\/protocol\/src\/i18n\/messages\/[a-z]+\.ts$/.test(path)), 'packages/daemon/src/hooks/deny-text.ts'];
  return flat([...picked, ...both].map((path) => read(path).replaceAll("\\'", "'")).join('\n'));
}

/** Sample values the guides put where a catalog has a placeholder: a quote is compared piece by piece around them. */
const SAMPLE_VALUES =
  /Claude \((?:Amy|Ian)\)|<your name>|<你的名字>|Amy, Ben|Amy、Ben|\bAmy\b|\bBen\b|\bIan\b|src\/app\.ts|tests\/login\.test\.ts|package\.json|data\/fixtures\.json|my-app|0\.4\.[01]|WDJB-MJHT|https:\/\/\S+|ws_…#k=…&s=…|…|\.\.\./g;

function pieces(quote: string, minLength: number): string[] {
  return quote
    .split(SAMPLE_VALUES)
    .map((piece) => piece.replace(/^[\s,.:;!?()，。：；、！？（）]+|[\s,.:;!?()，。：；、！？（）]+$/g, ''))
    .filter((piece) => piece.length >= minLength);
}

/** `undefined`: nothing to check (too short, or only sample values). */
function inCatalogs(quote: string, text: string, minLength: number): boolean | undefined {
  const parts = pieces(flat(quote), minLength);
  if (parts.length === 0) return undefined;
  return parts.every((part) => text.includes(part));
}

/** The quoted texts of a guide: "…" (English) or 「…」 (zh-TW) outside `sh` blocks, and the lines of its sample blocks. */
function quotedTexts(path: string, locale: Locale): string[] {
  const text = read(path).replace(/```sh[\s\S]*?```/g, '');
  const out: string[] = [];
  const outsideBlocks = text.replace(/```[\s\S]*?```/g, '');
  if (locale === 'en') for (const match of outsideBlocks.matchAll(/"([^"\n]{3,}?)"/g)) out.push(match[1] as string);
  else for (const match of outsideBlocks.matchAll(/「([^」]+)」/g)) out.push(match[1] as string);
  for (const block of text.matchAll(/```(?:text)?\n([\s\S]*?)```/g)) {
    for (const line of (block[1] as string).split('\n')) if (line.trim() !== '' && !line.includes('https://')) out.push(line);
  }
  return [...new Set(out.map((quote) => quote.replace(/\s*\n\s*/g, locale === 'en' ? ' ' : '')))];
}

/** The labels of the product page's picture of the app (`.m-app`), without its file names, code and terminal lines. */
function pictureLabels(path: string): string[] {
  const html = read(path);
  const picture = /<div class="m-app">([\s\S]*?)<figcaption>/.exec(html)?.[1] ?? '';
  const labels = picture
    .replace(/<pre class="m-(?:code|term)">[\s\S]*?<\/pre>/g, '')
    .replace(/<ul class="m-tree">[\s\S]*?<\/ul>/g, (tree) => [...tree.matchAll(/<span class="m-tag[^"]*">([^<]*)<\/span>/g)].map((tag) => tag[1]).join('|'))
    .replace(/<i class="(?:av|m-count)[^"]*">[\s\S]*?<\/i>/g, '|')
    .split(/<[^>]+>|\|/)
    .map((label) => label.replace(/^[+＋]\s*/, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim())
    .filter((label) => label.length > 1 && !['smurg', 'login.ts', 'app.ts', 'TypeScript', 'my-app', 'IA', 'AM', 'BE'].includes(label) && !label.startsWith('app.smurg.ai'));
  return [...new Set(labels)];
}

/**
 * Quotes that are not smurg's UI text. Each entry is the reason it is here; a quote that stops appearing in its
 * guide must be removed from this list too (checked below), so the list cannot grow stale.
 */
const NOT_UI_TEXT: Readonly<Record<string, readonly string[]>> = {
  'docs/HOSTING.md': [
    'it can see', // prose: a phrase under discussion
    'is the host still there', // prose: what the keep-alive asks
    'After taking it back', // the name of a step of this guide
    ' do not matter) and press ', // not a quote: the text between two quotes on one line
    'Warning: keep-awake: off (the system (polkit) does not allow blocking sleep, …)', // two messages put together: in the forward list
    'Link for your teammates (send it to them privately; valid for 7 days):', // rendered with a duration: in the forward list
  ],
  'docs/JOINING.md': [
    'Should you check the key fingerprint?', // a heading of this guide
    ' under the session and can ', // between two quotes
    ' (see §7), and choose ', // between two quotes
    ' and lets you choose ', // between two quotes
  ],
  'docs/zh-TW/HOSTING.md': [
    '主人還在嗎', // prose
    '收回之後', // the name of a step of this guide
    '只有一個 agent 正在執行 shell 指令', // prose: the condition under discussion
    '給組員的連結（用私訊傳給他們，7 天內有效）：', // rendered with a duration: in the forward list
    '⚠ 防止睡眠：未啟用（系統（polkit）不允許防止睡眠…）', // two messages put together: in the forward list
    'Claude (Amy) 透過 shell 指令修改了 src/app.ts', // rendered with a verb: in the forward list
  ],
  'docs/zh-TW/JOINING.md': [
    'Not logged in', // Claude Code's own words
    '要不要核對金鑰指紋', // a heading of this guide
  ],
  'apps/site/public/index.html': [
    'Viewing: Main workspace', // a label and the chosen option of the switcher, joined by the picture
    '3 minutes ago', // written by Intl.RelativeTimeFormat, not by a catalog
  ],
  'apps/site/public/zh-TW/index.html': [
    '檢視的工作區：主工作區', // a label and the chosen option of the switcher, joined by the picture
    '3 分鐘前', // written by Intl.RelativeTimeFormat, not by a catalog
    'Claude (Ian) 透過 shell 指令修改了 package.json', // rendered with a verb: in the forward list
  ],
};

describe('what the guides and the product page quote is in the catalogs (reverse)', () => {
  const cases: (readonly [string, Locale, number, () => string[]])[] = [
    [GUIDES.HOSTING.en, 'en', 6, () => quotedTexts(GUIDES.HOSTING.en, 'en')],
    [GUIDES.JOINING.en, 'en', 6, () => quotedTexts(GUIDES.JOINING.en, 'en')],
    [LANDING.en, 'en', 4, () => pictureLabels(LANDING.en)],
    [GUIDES.HOSTING['zh-TW'], 'zh-TW', 3, () => quotedTexts(GUIDES.HOSTING['zh-TW'], 'zh-TW')],
    [GUIDES.JOINING['zh-TW'], 'zh-TW', 3, () => quotedTexts(GUIDES.JOINING['zh-TW'], 'zh-TW')],
    [LANDING['zh-TW'], 'zh-TW', 2, () => pictureLabels(LANDING['zh-TW'])],
  ];

  it.each(cases)('%s (%s): every quoted text is catalog text', (path, locale, minLength, quotes) => {
    const text = corpus(locale);
    const all = quotes();
    const allowed = new Set(NOT_UI_TEXT[path] ?? []);
    const missing = all.filter((quote) => !allowed.has(quote) && inCatalogs(quote, text, minLength) === false);
    expect(missing).toEqual([]);
    expect(all.filter((quote) => inCatalogs(quote, text, minLength) === true).length).toBeGreaterThanOrEqual(15);
    // The exceptions are still in the document, and still not catalog text.
    for (const quote of allowed) {
      expect(all, `${path}: remove the exception "${quote}" (no longer quoted)`).toContain(quote);
      expect(inCatalogs(quote, text, minLength), `${path}: remove the exception "${quote}" (it is catalog text now)`).not.toBe(true);
    }
  });
});

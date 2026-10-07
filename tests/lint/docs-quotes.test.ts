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
  cliQuote('host.update.notice', { latest: '0.5.1', current: '0.5.0' }, ['HOSTING']),
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
  webQuote('conversation.sug.accept', ['JOINING']),
  webQuote('conversation.sug.editAccept', ['JOINING']),
  webQuote('conversation.sug.reject', ['JOINING']),
  webQuote('conversation.sug.reaches', ['JOINING']),
  webQuote('activity.actor.system', ['JOINING']),
  // ---- the topics flow (0.5.0): the sessions view, the cards, the plan and the report (JOINING)
  webQuote('workbench.mode.sessions', ['JOINING']),
  webQuote('workbench.mode.code', ['JOINING']),
  webQuote('sidebar.inbox.group.waiting', ['JOINING']),
  webQuote('sidebar.inbox.group.look', ['JOINING']),
  webQuote('sidebar.inbox.empty.viewer', ['JOINING']),
  webQuote('columns.refused', ['JOINING']),
  webQuote('conversation.q.title', ['JOINING']),
  webQuote('conversation.q.comment.note', ['JOINING']),
  webQuote('conversation.q.tie', ['JOINING']),
  webQuote('conversation.q.remind', ['JOINING']),
  webQuote('conversation.perm.title.command', ['JOINING']),
  webQuote('conversation.perm.allow', ['HOSTING', 'JOINING']),
  webQuote('conversation.perm.always', ['HOSTING', 'JOINING']),
  webQuote('conversation.perm.scope.session', ['HOSTING', 'JOINING']),
  webQuote('conversation.perm.scope.topic', ['HOSTING', 'JOINING']),
  webQuote('conversation.perm.hostOnly', ['HOSTING', 'JOINING']),
  webQuote('conversation.mode.fixed', ['HOSTING', 'JOINING']),
  webQuote('conversation.status.fresh', ['HOSTING', 'JOINING']),
  webQuote('conversation.status.spec', ['JOINING']),
  webQuote('topics.new.submit', ['JOINING']),
  webQuote('topics.revise.open', ['JOINING']),
  webQuote('topics.plan.generate', ['JOINING']),
  webQuote('topics.assign.mode.everyone', ['JOINING']),
  webQuote('topics.followUp.label', ['JOINING']),
  webQuote('topics.review.action', ['JOINING']),
  webQuote('topics.item.resolve', ['JOINING']),
  webQuote('topics.review.request', ['JOINING']),
  webQuote('topics.report.closed', ['JOINING']),
  webQuote('worktree.active.requestMerge', ['JOINING']),
  webQuote('conversation.q.settled.show', ['JOINING']),
  webQuote('conversation.status.idle', ['JOINING']),
  webQuote('sidebar.restart.continue', ['HOSTING', 'JOINING']),
  { what: 'wire permissionMode.askCommands', guides: ['HOSTING', 'JOINING'], render: (locale) => wire(locale, 'permissionMode.askCommands') },
  { what: 'wire attention.itemStalled', guides: ['HOSTING', 'JOINING'], render: (locale) => wire(locale, 'attention.itemStalled') },
  // ---- what a host must be told (HOSTING §4, §5, §7, §8): whose Claude account, the host's own rules, project settings
  // Owner decision Q6: the host guide says plainly that a personal subscription is for the host's own use, in the
  // words of the console's security note, and quotes the one-time notice.
  webQuote('console.security.account', ['HOSTING']),
  webQuote('topics.new.info.subscription', ['HOSTING']),
  { what: 'wire notice.personalSubscription', guides: ['HOSTING'], render: (locale) => wire(locale, 'notice.personalSubscription') },
  // The one review of a folder's Claude Code project settings (the console's; also inside the New topic dialog).
  webQuote('console.claudeConfig.choice.title', ['HOSTING']),
  webQuote('console.claudeConfig.choice.ignore', ['HOSTING']),
  webQuote('console.claudeConfig.trust', ['HOSTING']),
  webQuote('console.claudeConfig.loaded.title', ['HOSTING']),
  webQuote('console.claudeConfig.ack.incomplete', ['HOSTING']),
  webQuote('console.claudeConfig.group.other', ['HOSTING']),
  // What the review says about a path where no file is yet, and about commands whose files it cannot follow.
  webQuote('console.claudeConfig.script.absent', ['HOSTING']),
  webQuote('console.claudeConfig.unfollowed', ['HOSTING'], { count: 2 }),
  // smurg's own two sentences on a permission card its tool gate asked for (the web's words in the reader's language).
  webQuote('conversation.perm.gate.writes-settings-script', ['HOSTING']),
  webQuote('conversation.perm.gate.may-reach-settings-script', ['HOSTING']),
  // What a person must have read before allowing, and what a teammate is told about a folder only the host may move.
  webQuote('conversation.perm.readFirst', ['HOSTING', 'JOINING']),
  { what: 'wire path.hostOnly', guides: ['HOSTING', 'JOINING'], render: (locale) => wire(locale, 'path.hostOnly') },
  // The rows of the troubleshooting table and of §10 that the review fixes added.
  { what: 'wire report.changes.failed', guides: ['HOSTING'], render: (locale) => wire(locale, 'report.changes.failed') },
  { what: 'wire session.folderNotNameable', guides: ['HOSTING'], render: (locale) => wire(locale, 'session.folderNotNameable') },
  webQuote('topics.badge.stalled.error', ['HOSTING']),
  webQuote('topics.badge.reviewedWaitsMerge', ['HOSTING']),
  webQuote('topics.review.merge', ['HOSTING']),
  webQuote('conversation.message.delivery.queued', ['JOINING']),
  // What a teammate is told about a text that is shown as written, removed characters and an upload that is too large.
  webQuote('markdown.plain.note', ['JOINING']),
  webQuote('conversation.message.cleaned', ['JOINING']),
  { what: 'wire upload.tooManyFolders', guides: ['JOINING'], render: (locale) => wire(locale, 'upload.tooManyFolders', { max: 10_000 }), part: { en: 'Upload it in parts.', 'zh-TW': '請分批上傳' } },
  { what: 'wire conversation.interrupted.restart', guides: ['HOSTING'], render: (locale) => wire(locale, 'conversation.interrupted.restart') },
  { what: 'wire conversation.owner.handover.kicked', guides: ['HOSTING'], render: (locale) => wire(locale, 'conversation.owner.handover.kicked', { name: 'Amy' }) },
  webQuote('console.hostRules.title', ['HOSTING']),
  cliQuote('status.hostRules', { count: 0 }, ['HOSTING']),
  webQuote('console.audit.action.agent.command', ['HOSTING']),
  webQuote('console.settings.maxLiveAgents', ['HOSTING']),
  webQuote('topics.badge.planChanged', ['HOSTING']),
  { what: 'wire attention.hostRules', guides: ['HOSTING'], render: (locale) => wire(locale, 'attention.hostRules') },
  {
    what: 'wire hostRules.found',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'hostRules.found', { count: 3 }),
    part: { en: 'Agents here run them without asking too.', 'zh-TW': '這裡的 agent 也會直接執行' },
  },
  { what: 'wire attention.projectSettings', guides: ['HOSTING'], render: (locale) => wire(locale, 'attention.projectSettings') },
  { what: 'wire session.projectSettings.untrusted', guides: ['HOSTING'], render: (locale) => wire(locale, 'session.projectSettings.untrusted') },
  { what: 'wire session.projectSettings.changed', guides: ['HOSTING'], render: (locale) => wire(locale, 'session.projectSettings.changed') },
  { what: 'wire session.claude.notLoggedIn', guides: ['HOSTING'], render: (locale) => wire(locale, 'session.claude.notLoggedIn') },
  { what: 'wire notice.rateLimit', guides: ['HOSTING'], render: (locale) => wire(locale, 'notice.rateLimit') },
  { what: 'wire plan.start.noGit', guides: ['HOSTING'], render: (locale) => wire(locale, 'plan.start.noGit') },
  { what: 'wire notice.unattended', guides: ['HOSTING'], render: (locale) => wire(locale, 'notice.unattended') },
  // The other sentences of a conversation that the host guide quotes whole (their zh-TW forms end in a full stop or do not, as the catalog has them).
  { what: 'wire notice.authRejected', guides: ['HOSTING'], render: (locale) => wire(locale, 'notice.authRejected') },
  { what: 'wire notice.compacted', guides: ['HOSTING'], render: (locale) => wire(locale, 'notice.compacted') },
  { what: 'wire notice.transcriptTrimmed', guides: ['HOSTING'], render: (locale) => wire(locale, 'notice.transcriptTrimmed') },
  { what: 'wire session.claude.initTimeout', guides: ['HOSTING'], render: (locale) => wire(locale, 'session.claude.initTimeout') },
  { what: 'wire session.resume.lost', guides: ['HOSTING'], render: (locale) => wire(locale, 'session.resume.lost') },
  { what: 'wire conversation.redacted', guides: ['HOSTING'], render: (locale) => wire(locale, 'conversation.redacted') },
  { what: 'wire conversation.owner.handover', guides: ['HOSTING'], render: (locale) => wire(locale, 'conversation.owner.handover', { name: 'Amy' }) },
  cliQuote('host.agentsPaused', { count: 3 }, ['HOSTING']),
  cliQuote('status.claude.notChecked', undefined, ['HOSTING']),
  cliQuote('attach.agents.heading', undefined, ['JOINING']),
  // ---- the activity feed's sentences (the wire catalog)
  { what: 'wire activity.agentBashChange', guides: ['HOSTING'], render: (locale) => wire(locale, 'activity.agentBashChange', { agent: 'Claude (Amy)', path: 'src/app.ts', change: 'change' }) },
];

/** The sentences of the activity feed in the product page's picture of the app. */
const PICTURE_QUOTES: readonly { what: string; render(locale: Locale, web: WebCatalogue): string }[] = [
  { what: 'web workbench.topbar.console', render: (locale, web) => web.text(locale, 'workbench.topbar.console') },
  { what: 'web workbench.mode.sessions', render: (locale, web) => web.text(locale, 'workbench.mode.sessions') },
  { what: 'web workbench.mode.code', render: (locale, web) => web.text(locale, 'workbench.mode.code') },
  { what: 'web workbench.topbar.host', render: (locale, web) => web.text(locale, 'workbench.topbar.host', { name: 'Ian' }) },
  { what: 'web conn.pill.online', render: (locale, web) => web.text(locale, 'conn.pill.online') },
  { what: 'web sidebar.inbox.title', render: (locale, web) => web.text(locale, 'sidebar.inbox.title') },
  { what: 'web sidebar.inbox.group.waiting', render: (locale, web) => web.text(locale, 'sidebar.inbox.group.waiting') },
  { what: 'web sidebar.inbox.group.look', render: (locale, web) => web.text(locale, 'sidebar.inbox.group.look') },
  { what: 'web sidebar.group.free', render: (locale, web) => web.text(locale, 'sidebar.group.free') },
  { what: 'web sidebar.sessions.filter.waiting', render: (locale, web) => web.text(locale, 'sidebar.sessions.filter.waiting') },
  { what: 'wire session.title.discussion', render: (locale) => wire(locale, 'session.title.discussion') },
  { what: 'wire session.title.terminal', render: (locale) => wire(locale, 'session.title.terminal', { owner: 'Ian' }) },
  { what: 'wire role.editor', render: (locale) => wire(locale, 'role.editor') },
  { what: 'web stores.phase.executing', render: (locale, web) => web.text(locale, 'stores.phase.executing') },
  { what: 'web conversation.responsible.nobody', render: (locale, web) => web.text(locale, 'conversation.responsible.nobody') },
  { what: 'web conversation.mode.fixed', render: (locale, web) => web.text(locale, 'conversation.mode.fixed') },
  { what: 'web conversation.message.suggestion', render: (locale, web) => web.text(locale, 'conversation.message.suggestion', { name: 'Ian' }) },
  { what: 'web conversation.q.title', render: (locale, web) => web.text(locale, 'conversation.q.title') },
  { what: 'web conversation.q.leading', render: (locale, web) => web.text(locale, 'conversation.q.leading') },
  { what: 'web conversation.q.comment.note', render: (locale, web) => web.text(locale, 'conversation.q.comment.note') },
  { what: 'web conversation.q.decide.opener', render: (locale, web) => web.text(locale, 'conversation.q.decide.opener') },
  { what: 'web conversation.q.submit', render: (locale, web) => web.text(locale, 'conversation.q.submit', { count: 1 }) },
  { what: 'web topics.assign.heading', render: (locale, web) => web.text(locale, 'topics.assign.heading') },
  { what: 'web topics.assign.mode.assigned', render: (locale, web) => web.text(locale, 'topics.assign.mode.assigned') },
  { what: 'web topics.assign.mode.everyone', render: (locale, web) => web.text(locale, 'topics.assign.mode.everyone') },
  { what: 'web topics.rules.label', render: (locale, web) => web.text(locale, 'topics.rules.label') },
  { what: 'web topics.badge.report', render: (locale, web) => web.text(locale, 'topics.badge.report') },
  { what: 'web topics.badge.permission', render: (locale, web) => web.text(locale, 'topics.badge.permission') },
  { what: 'wire role.host', render: (locale) => wire(locale, 'role.host') },
  { what: 'web topics.summary.reviewed', render: (locale, web) => web.text(locale, 'topics.summary.reviewed', { reviewed: 0, total: 3 }) },
  { what: 'web topics.summary.toReview', render: (locale, web) => web.text(locale, 'topics.summary.toReview', { count: 1 }) },
  { what: 'web topics.summary.waitPerson', render: (locale, web) => web.text(locale, 'topics.summary.waitPerson', { count: 1 }) },
  { what: 'web topics.summary.notStarted', render: (locale, web) => web.text(locale, 'topics.summary.notStarted', { count: 1 }) },
  { what: 'web topics.report.section.done', render: (locale, web) => web.text(locale, 'topics.report.section.done') },
  { what: 'web topics.report.section.why', render: (locale, web) => web.text(locale, 'topics.report.section.why') },
  { what: 'web topics.report.section.verified', render: (locale, web) => web.text(locale, 'topics.report.section.verified') },
  { what: 'web topics.report.section.watchOut', render: (locale, web) => web.text(locale, 'topics.report.section.watchOut') },
  { what: 'web topics.report.section.changes', render: (locale, web) => web.text(locale, 'topics.report.section.changes') },
  { what: 'web topics.followUp.label', render: (locale, web) => web.text(locale, 'topics.followUp.label') },
  { what: 'web topics.review.action', render: (locale, web) => web.text(locale, 'topics.review.action') },
  { what: 'wire report.outcome.complete', render: (locale) => wire(locale, 'report.outcome.complete') },
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
  /Claude \((?:Amy|Ian)\)|<your name>|<你的名字>|Amy, Ben|Amy、Ben|\bAmy\b|\bBen\b|\bIan\b|src\/app\.ts|tests\/login\.test\.ts|package\.json|data\/fixtures\.json|my-app|0\.5\.[01]|WDJB-MJHT|https:\/\/\S+|ws_…#k=…&s=…|…|\.\.\./g;

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

/**
 * The labels of the product page's picture of the app (`.m-app`), without what a person or an agent wrote there (the
 * elements marked `m-said`: a topic's name, a question, a message, a report's sentences, file names) and without
 * commands (`pre.m-term`).
 */
function pictureLabels(path: string): string[] {
  const html = read(path);
  const picture = /<div class="m-app">([\s\S]*?)<figcaption>/.exec(html)?.[1] ?? '';
  const labels = picture
    .replace(/<pre class="m-term">[\s\S]*?<\/pre>/g, '|')
    .replace(/<(\w+) class="(?:[^"]* )?m-said(?: [^"]*)?">[^<]*<\/\1>/g, '|')
    .replace(/<i class="(?:av|m-count)[^"]*">[\s\S]*?<\/i>/g, '|')
    .split(/<[^>]+>|\|/)
    .map((label) => label.replace(/^[+＋]\s*/, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim())
    .filter((label) => label.length > 1 && !['smurg', 'my-app'].includes(label) && !label.startsWith('app.smurg.ai'));
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
    '要不要核對金鑰指紋', // a heading of this guide
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

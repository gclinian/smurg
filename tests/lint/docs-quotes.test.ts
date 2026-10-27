// The guides, the quick start, the two short pages (how it works, the security model) and the product page quote what
// smurg prints and shows (DESIGN B.5). A quote that drifts from the catalogs sends a reader looking for a button that
// is not there, so both directions are checked, per language:
//
//   forward: a list of messages (catalog id + sample parameters) that the guides must quote as the catalogs render
//            them: the samples of `smurg login` and `smurg host`, the troubleshooting tables, role names, main buttons;
//   reverse: every quoted text of a guide ("…" in English, 「…」 in zh-TW, and the lines of its sample blocks) and every
//            label of the product page's picture of the app is found in the catalogs of its language (their sources,
//            and what the forward list renders from them: a message built from parameters), except the quotes listed
//            below that are not UI text (prose, other products' words).
//
// English guide <-> English catalogs, zh-TW guide <-> zh-TW catalogs: a guide never quotes the other language.
import { describe, expect, it } from 'vitest';
import { agentHeldReason, humanHeldReason } from '../../packages/daemon/src/hooks/deny-text.ts';
import { RELAY_STRINGS, cli, webCatalogue, wire, type CliMessageId, type Locale, type WebCatalogue } from './catalogs.ts';
import { GUIDES, flat, type Guide } from './guides.ts';
import { CJK, read, repoFiles } from './tree.ts';

const LANDING: Readonly<Record<Locale, string>> = { en: 'apps/site/public/index.html', 'zh-TW': 'apps/site/public/zh-TW/index.html' };

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
/**
 * The oldest git the worktree mode accepts, as the daemon renders it in its refusals: read from the daemon's source
 * (this folder loads no daemon), so that the guide's "2.42.0" cannot stay behind when the daemon raises it.
 */
const GIT_MIN_VERSION = (/\bGIT_MIN_VERSION\b[^=]*= Object\.freeze\(\[(\d+), (\d+), (\d+)\]\)/.exec(read('packages/daemon/src/worktree/git.ts')) ?? []).slice(1).join('.');
/** A workspace's state folder and one of its files, as a refusal names them (the guides quote the words before the path). */
const STATE_DIR = '~/.smurg/workspaces/ws_…';
const STATE_FILE = `${STATE_DIR}/state.json`;

const QUOTES: readonly Quote[] = [
  // ---- smurg login (HOSTING §2)
  cliQuote('login.open', { page: 'https://app.smurg.ai/device', code: 'WDJB-MJHT', minutes: 10 }, ['HOSTING']),
  cliQuote('login.done', { origin: 'https://app.smurg.ai', name: 'Ian', userId: 'google:1' }, ['HOSTING'], { en: 'Logged in to', 'zh-TW': '已登入' }),
  { what: 'relay next', guides: ['HOSTING', 'QUICKSTART'], render: (locale) => RELAY_STRINGS[locale].next },
  { what: 'relay allow', guides: ['HOSTING', 'JOINING', 'QUICKSTART'], render: (locale) => RELAY_STRINGS[locale].allow },
  { what: 'relay deny', guides: ['HOSTING'], render: (locale) => RELAY_STRINGS[locale].deny },
  // ---- smurg host (HOSTING §3, §6, §9)
  {
    what: 'CLI host.summary with host.invite.heading',
    guides: ['HOSTING', 'QUICKSTART'],
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
  // ---- a workspace's state after an update (HOSTING §8, §9.2, §9.4): the one line of a start, and the lines for a
  // teammate of another protocol version
  cliQuote('host.upgraded', { from: '0.4.0' }, ['HOSTING']),
  cliQuote('host.putBack.state', { names: ['state.json'] }, ['HOSTING'], { en: 'was put back into this workspace and upgraded again', 'zh-TW': '被放回這個工作區，並且重新升級了' }),
  cliQuote('host.oldFolder', { path: `${STATE_DIR}.old`, more: 0 }, ['HOSTING'], {
    en: 'An earlier state folder of this workspace lies beside the one in use',
    'zh-TW': '這個工作區之前的狀態資料夾還放在旁邊',
  }),
  cliQuote('host.peer.newer', undefined, ['HOSTING'], {
    en: "Warning: a teammate's page or smurg is newer than this smurg and was turned away. Stop sharing, run smurg update, then share again.",
    'zh-TW': '有組員的網頁或 smurg 比這個 smurg 新，連線被拒絕了。請停止分享，執行 smurg update，再重新分享。',
  }),
  cliQuote('host.peer.older', undefined, ['HOSTING']),
  // ---- after going back to a folder that was moved away (HOSTING §8, §9.4; JOINING §1, §10): what the people who
  // hold the key of the time in between read, and what a member whose role is not the link's reads after confirming
  cliQuote('channel.keyMismatch.device', undefined, ['HOSTING'], {
    en: "the key of the host's computer differs from the one this computer recorded last time",
    'zh-TW': '主人電腦的金鑰和這台電腦上次記錄的不同',
  }),
  webQuote('conn.rejected.invite-invalid.title', ['HOSTING', 'JOINING']),
  cliQuote('channel.rejected.inviteInvalid', undefined, ['JOINING']),
  cliQuote('status.otherVersion', { current: '0.5.1', why: 'no-answer', socket: '/x', workspaceId: 'ws_…', folder: '/p' }, ['HOSTING'], {
    en: 'A smurg host of another version is sharing it',
    'zh-TW': '正由另一個版本的 smurg host 分享',
  }),
  // ---- a refused workspace state (HOSTING §8, §9.3): one text per cause; each names the file and says that nothing was changed
  cliQuote('host.unchanged', undefined, ['HOSTING']),
  cliQuote('host.newer', { path: STATE_DIR, current: '0.5.1' }, ['HOSTING'], {
    en: 'This workspace was last shared with a newer smurg than this one (this is 0.5.1), and this smurg cannot read what it wrote',
    'zh-TW': '這個工作區上次是用比這個 smurg（0.5.1）更新的版本分享的，這個 smurg 讀不了它寫的東西',
  }),
  cliQuote('host.insecure.mode', { path: STATE_FILE, mode: '644', count: 1 }, ['HOSTING'], {
    en: "A file of this workspace's state is open to other users of this computer (mode 644)",
    'zh-TW': '這個工作區有一個狀態檔，這台電腦的其他使用者也能存取（權限 644）',
  }),
  cliQuote('host.insecure.owner', { path: STATE_FILE, count: 1 }, ['HOSTING'], {
    en: "A file of this workspace's state belongs to another user, not to you",
    'zh-TW': '這個工作區有一個狀態檔屬於其他使用者，不是你的',
  }),
  cliQuote('host.insecure.symlink', { path: STATE_FILE, count: 1 }, ['HOSTING'], {
    en: "A file of this workspace's state is a symbolic link, and smurg follows no link in its state folder",
    'zh-TW': '這個工作區有一個狀態檔是符號連結（symlink），smurg 不會跟著狀態資料夾裡的連結走',
  }),
  {
    what: 'CLI host.insecure.notFile with host.found.directory',
    guides: ['HOSTING'],
    render: (locale) => cli(locale, 'host.insecure.notFile', { path: STATE_FILE, count: 1, found: cli(locale, 'host.found.directory') }),
    part: { en: "Where a file of this workspace's state belongs there is a folder", 'zh-TW': '這個工作區的狀態檔該在的位置上，是一個資料夾' },
  },
  {
    what: 'CLI host.cannotOpen with host.cannotOpen.reason',
    guides: ['HOSTING'],
    render: (locale) => cli(locale, 'host.cannotOpen', { path: STATE_FILE, count: 1, reason: cli(locale, 'host.cannotOpen.reason', { code: 'EACCES' }) }),
    part: {
      en: "A file of this workspace's state could not be opened or written (permission denied, EACCES)",
      'zh-TW': '這個工作區有一個狀態檔無法開啟或寫入（沒有權限，EACCES）',
    },
  },
  cliQuote('host.otherWorkspace', { path: STATE_FILE, workspaceId: 'ws_…' }, ['HOSTING'], { en: 'names another workspace', 'zh-TW': '狀態檔寫的是另一個工作區' }),
  cliQuote('host.unreadable.missingState', { path: STATE_FILE }, ['HOSTING'], {
    en: 'The state file of this workspace is not there, although other files of the workspace are',
    'zh-TW': '這個工作區的狀態檔不見了，可是工作區的其他檔案還在',
  }),
  cliQuote('host.unreadable.missingKey', { path: `${STATE_DIR}/identity.key` }, ['HOSTING'], {
    en: "The daemon's key of this workspace is not there, although its state file is",
    'zh-TW': '這個工作區的 daemon 金鑰不見了，可是它的狀態檔還在',
  }),
  cliQuote('host.unreadable.notJson', { path: STATE_FILE }, ['HOSTING'], {
    en: "A file of this workspace's state is damaged: it is not valid JSON (it may be empty or cut off)",
    'zh-TW': '這個工作區有一個狀態檔已損毀：它不是有效的 JSON（可能是空的，或只寫了一半）',
  }),
  cliQuote('host.unreadable.shape', { path: STATE_FILE, current: '0.5.1' }, ['HOSTING'], {
    en: "A file of this workspace's state is not in a form that smurg 0.5.1 or an earlier published smurg wrote",
    'zh-TW': '這個工作區有一個狀態檔的格式，不是 smurg 0.5.1 或更早發佈的任何版本寫的',
  }),
  cliQuote('host.unreadable.carried', { path: STATE_FILE, current: '0.5.1' }, ['HOSTING'], {
    en: 'A state file that an earlier smurg wrote holds a value that smurg 0.5.1 does not accept',
    'zh-TW': '較早版本的 smurg 寫的狀態檔裡，有一個值是 smurg 0.5.1 不接受的',
  }),
  cliQuote('host.unreadable.maybeNewer', undefined, ['HOSTING']),
  // What follows the first line: the places that do not fit, and what a refusal says when the start was already
  // writing (or the system would not open the file) instead of the bare "Nothing was changed."
  cliQuote('host.unreadable.problems', { problems: ['…'], more: 0 }, ['HOSTING'], { en: 'What does not fit:', 'zh-TW': '不符合的地方：' }),
  cliQuote('host.cannotOpen.unchanged', undefined, ['HOSTING'], {
    en: 'smurg host did not start, and nothing in the workspace was changed or reset',
    'zh-TW': 'smurg host 沒有啟動，工作區裡的東西沒有被更動或重設',
  }),
  // Where a carried value can sit (the host console's own name of the setting), and what a page says of a card whose
  // file the host set aside.
  webQuote('console.settings.sharedDirs', ['HOSTING']),
  webQuote('conversation.card.gone', ['HOSTING']),
  // ONE file that can be set aside alone, named before the last resort (which is then not printed).
  cliQuote('host.setAside', { document: 'inbox' }, ['HOSTING'], {
    en: 'This one file can be set aside without losing the workspace',
    'zh-TW': '這一個檔案可以單獨移到旁邊，工作區不會因此不見',
  }),
  cliQuote('host.unreadable.lastResort', undefined, ['HOSTING'], { en: 'The last resort is a new workspace.', 'zh-TW': '最後的辦法是建立新的工作區。' }),
  // The host's own two files (~/.smurg/workspaces.json, credentials.json): refused, never read as empty.
  cliQuote('state.newer', { subject: 'workspaces', path: '~/.smurg/workspaces.json', current: '0.5.1' }, ['HOSTING'], {
    en: 'The workspace list (workspaces.json) was written by a newer smurg than this one (this is 0.5.1)',
    'zh-TW': '工作區紀錄檔（workspaces.json）是較新版的 smurg 寫的（這個 smurg 是 0.5.1）',
  }),
  // The folder's own entry in workspaces.json that this smurg cannot read: `smurg host` stops, never a new workspace.
  cliQuote('host.entryUnread', { place: 3, path: '~/.smurg/workspaces.json', current: '0.5.1' }, ['HOSTING'], {
    en: "This folder's entry in the workspace list (workspaces.json) is not in a form this smurg can read (this is 0.5.1)",
    'zh-TW': '工作區紀錄檔（workspaces.json）裡，這個資料夾的那筆資料這個 smurg（0.5.1）讀不懂',
  }),
  // ---- a page or a command of another version than the host's smurg (HOSTING §8, §9.1; JOINING §8, §10)
  webQuote('conn.rejected.version.hostOlder.title', ['HOSTING', 'JOINING']),
  webQuote('conn.rejected.version.stale.title', ['JOINING']),
  webQuote('conn.rejected.version.title', ['JOINING']),
  webQuote('ui.chunk.gone.title', ['JOINING']),
  webQuote('ui.chunk.reload', ['JOINING']),
  webQuote('conn.closed.newer-key.title', ['JOINING']),
  cliQuote('channel.rejected.version', undefined, ['JOINING']),
  cliQuote('channel.rejected.version.updateHere', { current: '0.5.0', latest: '0.5.1' }, ['JOINING'], {
    en: 'a newer smurg (0.5.1) is published: update this one (smurg update), then connect again.',
    'zh-TW': '已經有更新的版本（0.5.1）：請更新這個 smurg（smurg update），再重新連線。',
  }),
  cliQuote('channel.rejected.version.hostOlder', { current: '0.5.1' }, ['JOINING'], {
    en: "The host's smurg is older than this one",
    'zh-TW': '請主人停止分享、執行 smurg update，再重新分享；然後你再重新連線。',
  }),
  cliQuote('state.socketPathTooLong', { path: '/x' }, ['HOSTING'], { en: "The path of smurg's state folder is too long for a Unix socket", 'zh-TW': 'smurg 的狀態目錄路徑太長' }),
  cliQuote('uninstall.question', undefined, ['HOSTING'], { en: 'Remove these? [y/N]', 'zh-TW': '確定要移除嗎？ [y/N]' }),
  // ---- one title for the key change, in the web app and in `smurg attach`
  webQuote('join.keyChange.title', ['HOSTING', 'JOINING']),
  cliQuote('attach.keyChange', { known: 'aa', offered: 'bb' }, ['JOINING'], { en: "The host computer's key has changed", 'zh-TW': '主人的電腦金鑰和之前不同' }),
  cliQuote('attach.readOnly', { owner: 'Amy' }, ['JOINING'], { en: 'Read-only:', 'zh-TW': '唯讀模式' }),
  // ---- roles (the wire catalog: one wording for the web app and the CLI)
  // (the two short pages say what each role can do and see: they name all three as the app does)
  { what: 'wire role.agent', guides: ['HOSTING', 'JOINING', 'QUICKSTART', 'HOW_IT_WORKS', 'SECURITY_MODEL'], render: (locale) => wire(locale, 'role.agent') },
  { what: 'wire role.editor', guides: ['HOSTING', 'JOINING', 'QUICKSTART', 'HOW_IT_WORKS', 'SECURITY_MODEL'], render: (locale) => wire(locale, 'role.editor') },
  { what: 'wire role.viewer', guides: ['HOSTING', 'JOINING', 'HOW_IT_WORKS', 'SECURITY_MODEL'], render: (locale) => wire(locale, 'role.viewer') },
  // ---- the web app (JOINING)
  webQuote('app.login.google', ['JOINING', 'QUICKSTART']),
  webQuote('join.confirm.join', ['JOINING', 'QUICKSTART']),
  webQuote('join.keyChange.confirm', ['JOINING']),
  webQuote('conn.keyMismatch.title', ['HOSTING', 'JOINING']),
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
  webQuote('conversation.q.title', ['JOINING', 'QUICKSTART']),
  webQuote('conversation.q.comment.note', ['JOINING']),
  webQuote('conversation.q.tie', ['JOINING']),
  webQuote('conversation.q.remind', ['JOINING']),
  webQuote('conversation.perm.title.command', ['JOINING', 'QUICKSTART']),
  webQuote('conversation.perm.allow', ['HOSTING', 'JOINING', 'QUICKSTART']),
  webQuote('conversation.perm.always', ['HOSTING', 'JOINING']),
  webQuote('conversation.perm.scope.session', ['HOSTING', 'JOINING']),
  webQuote('conversation.perm.scope.topic', ['HOSTING', 'JOINING']),
  webQuote('conversation.perm.hostOnly', ['HOSTING', 'JOINING']),
  webQuote('conversation.mode.fixed', ['HOSTING', 'JOINING']),
  webQuote('conversation.status.fresh', ['HOSTING', 'JOINING']),
  webQuote('conversation.status.spec', ['JOINING', 'QUICKSTART']),
  webQuote('topics.new.submit', ['JOINING', 'QUICKSTART']),
  webQuote('topics.revise.open', ['JOINING']),
  webQuote('topics.plan.generate', ['JOINING', 'QUICKSTART']),
  webQuote('topics.assign.mode.everyone', ['JOINING']),
  webQuote('topics.followUp.label', ['JOINING']),
  webQuote('topics.review.action', ['JOINING']),
  webQuote('topics.item.resolve', ['JOINING', 'HOSTING']),
  webQuote('topics.review.request', ['JOINING']),
  webQuote('topics.report.closed', ['JOINING']),
  webQuote('worktree.active.requestMerge', ['JOINING']),
  webQuote('conversation.q.settled.show', ['JOINING']),
  webQuote('conversation.status.idle', ['JOINING']),
  webQuote('sidebar.restart.continue', ['HOSTING', 'JOINING']),
  // The four permission modes (0.6.0, DESIGN D3, D20): both guides name them by their labels.
  { what: 'wire permissionMode.auto', guides: ['HOSTING', 'JOINING'], render: (locale) => wire(locale, 'permissionMode.auto') },
  { what: 'wire permissionMode.askCommands', guides: ['HOSTING', 'JOINING'], render: (locale) => wire(locale, 'permissionMode.askCommands') },
  { what: 'wire permissionMode.askAll', guides: ['HOSTING', 'JOINING'], render: (locale) => wire(locale, 'permissionMode.askAll') },
  { what: 'wire permissionMode.askNothing', guides: ['HOSTING', 'JOINING'], render: (locale) => wire(locale, 'permissionMode.askNothing') },
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
  // One row per reason git keeps Start from running (0.5.2): the row quotes what is wrong, its other cell says what to
  // do (with the oldest git the daemon accepts, and 2.39.5 for a git that is too old).
  {
    what: 'wire worktree.unavailable.notAGitRepo',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'worktree.unavailable.notAGitRepo'),
    part: { en: 'The shared folder is not a git repository, so worktrees cannot be used.', 'zh-TW': '分享的資料夾不是 git 儲存庫，無法使用 worktree。' },
  },
  {
    what: 'wire worktree.unavailable.noCommit',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'worktree.unavailable.noCommit'),
    part: { en: "The shared folder's git repository has no commit yet, so no worktree can be created.", 'zh-TW': '分享資料夾的 git 儲存庫還沒有任何提交，無法建立 worktree。' },
  },
  {
    what: 'wire worktree.unavailable.gitDirGone',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'worktree.unavailable.gitDirGone'),
    part: { en: "The shared folder's .git is gone, so worktrees cannot be used.", 'zh-TW': '分享資料夾的 .git 不見了，無法使用 worktree。' },
  },
  {
    what: 'wire worktree.unavailable.gitNotFound',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'worktree.unavailable.gitNotFound', { minVersion: GIT_MIN_VERSION }),
    part: { en: "git was not found on the host's computer, so worktrees cannot be used.", 'zh-TW': '主人的電腦上找不到 git，無法使用 worktree。' },
  },
  {
    what: 'wire worktree.unavailable.gitTooOld',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'worktree.unavailable.gitTooOld', { version: '2.39.5', minVersion: GIT_MIN_VERSION }),
    part: { en: `The host's git is version 2.39.5, and worktrees need ${GIT_MIN_VERSION} or later.`, 'zh-TW': `主人電腦上的 git 是 2.39.5 版，worktree 需要 ${GIT_MIN_VERSION} 以上。` },
  },
  {
    what: 'wire worktree.unavailable.gitCannotRun',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'worktree.unavailable.gitCannotRun'),
    part: { en: "git does not run on the host's computer, so worktrees cannot be used.", 'zh-TW': '主人電腦上的 git 無法執行，無法使用 worktree。' },
  },
  {
    what: 'wire worktree.unavailable.gitDirNotDirectory',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'worktree.unavailable.gitDirNotDirectory'),
    part: {
      en: "The shared folder's .git is not an ordinary folder (the folder is a git worktree or a submodule, for example), so worktrees cannot be used.",
      'zh-TW': '分享資料夾的 .git 不是一般的資料夾（例如這個資料夾本身是 git worktree 或 submodule），無法使用 worktree。',
    },
  },
  {
    what: 'wire worktree.unavailable.worktreesDirUnusable',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'worktree.unavailable.worktreesDirUnusable'),
    part: { en: '.smurg/worktrees in the shared folder is not an ordinary folder, so worktrees cannot be used.', 'zh-TW': '分享資料夾裡的 .smurg/worktrees 不是一般的資料夾，無法使用 worktree。' },
  },
  { what: 'wire worktree.unavailable.checkFailed', guides: ['HOSTING'], render: (locale) => wire(locale, 'worktree.unavailable.checkFailed') },
  cliQuote('host.smurgTracked', undefined, ['HOSTING']),
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
  // ---- 0.6.0 (DESIGN D20): the permission modes, the models, smurg's own history and work items without git
  // Where the mode is chosen, what auto mode costs, the warning before "Asks for nothing" and what every member then sees.
  webQuote('console.settings.permissionMode', ['HOSTING']),
  // The host guide quotes what the host reads ("your usage", 0.6.0's review); members read "the host's usage".
  webQuote('agents.cost.auto.host', ['HOSTING']),
  webQuote('console.settings.askNothing.confirm.title', ['HOSTING']),
  webQuote('console.settings.askNothing.confirm.body', ['HOSTING']),
  webQuote('console.settings.askNothing.confirm.go', ['HOSTING']),
  webQuote('workbench.workspace.asksNothing.badge', ['HOSTING']),
  cliQuote('host.asksNothing', undefined, ['HOSTING']),
  // The update to 0.6.0: the line of smurg host and the inbox row.
  cliQuote('host.agentsAuto', undefined, ['HOSTING']),
  { what: 'wire attention.agentsAuto', guides: ['HOSTING'], render: (locale) => wire(locale, 'attention.agentsAuto') },
  // What smurg's own gate says when it asks in auto mode (G11, G12), and the audit entry of a command the check stopped.
  webQuote('conversation.perm.gate.writes-host-only', ['HOSTING']),
  webQuote('conversation.perm.gate.writes-outside', ['HOSTING']),
  // A teammate's command smurg cannot read (GATE_ASKS_WHEN_UNSURE): its own label since 0.6.0's review.
  webQuote('conversation.perm.gate.writes-unknown', ['HOSTING']),
  webQuote('console.audit.action.agent.command.blocked', ['HOSTING']),
  { what: 'wire conversation.autoMode.blocked', guides: ['HOSTING'], render: (locale) => wire(locale, 'conversation.autoMode.blocked', { reason: '[Rule]' }), part: { en: "Claude Code's check stopped a command", 'zh-TW': 'Claude Code 的檢查擋下了一個指令' } },
  // A model that cannot be used, a mode that cannot run, a model choice that goes with its member.
  { what: 'wire notice.modelRefused', guides: ['HOSTING'], render: (locale) => wire(locale, 'notice.modelRefused', { model: 'Fable' }), part: { en: "on the host's account: it may not exist, or the account may not have access to it. Choose another model for this session.", 'zh-TW': '它可能不存在，或這個帳號不能使用它。請為這個 session 選擇其他模型。' } },
  webQuote('conversation.notice.action.choose-model', ['HOSTING']),
  { what: 'wire notice.autoUnavailable.model', guides: ['HOSTING'], render: (locale) => wire(locale, 'notice.autoUnavailable.model', { model: 'Haiku' }), part: { en: 'This session asks before commands until it runs on another model.', 'zh-TW': '在換成其他模型之前，這個 session 執行指令前會先問。' } },
  { what: 'wire notice.autoUnavailable.settings', guides: ['HOSTING'], render: (locale) => wire(locale, 'notice.autoUnavailable.settings') },
  { what: 'wire notice.asksNothingRefused', guides: ['HOSTING'], render: (locale) => wire(locale, 'notice.asksNothingRefused') },
  { what: 'wire conversation.model.reset', guides: ['HOSTING'], render: (locale) => wire(locale, 'conversation.model.reset', { name: 'Amy' }), part: { en: "The model is back to the host's default", 'zh-TW': '模型已恢復為主人的預設' } },
  // The strip's two dialogs (the guide for teammates) and the line under a model that may bill usage credits.
  webQuote('conversation.mode.dialog', ['JOINING']),
  webQuote('conversation.model.dialog', ['JOINING']),
  webQuote('conversation.model.change.note', ['JOINING']),
  webQuote('agents.model.credits', ['JOINING']),
  // How work items run (HOSTING §10.2, §8): smurg's own history, without git, an item whose history changed.
  webQuote('topics.start.smurgHistory', ['HOSTING']),
  webQuote('topics.start.direct.title', ['HOSTING']),
  webQuote('topics.start.direct.confirm', ['HOSTING']),
  webQuote('topics.start.direct.hostOnly', ['HOSTING']),
  webQuote('topics.plan.direct.foot', ['HOSTING']),
  { what: 'wire conversation.direct.waits', guides: ['HOSTING'], render: (locale) => wire(locale, 'conversation.direct.waits') },
  { what: 'wire plan.start.historyChanged', guides: ['HOSTING'], render: (locale) => wire(locale, 'plan.start.historyChanged') },
  {
    what: 'wire worktree.hidden.tooLarge',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'worktree.hidden.tooLarge', { size: '2 GB', files: '80,000', maxSize: '1 GB', maxFiles: '50,000', largest: 'node_modules (1.2 GB)' }),
    part: { en: 'more than smurg copies into a checkout for each work item (1 GB and 50,000 files at most)', 'zh-TW': '超過 smurg 會為每個工作項目複製一份的上限（最多 1 GB、50,000 個檔案）' },
  },
  {
    what: 'wire worktree.hidden.changed',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'worktree.hidden.changed'),
    part: { en: "smurg's own history of this folder (.smurg/git) was changed by something other than smurg, so worktrees cannot be used.", 'zh-TW': 'smurg 為這個資料夾保存的版本紀錄（.smurg/git）被 smurg 以外的程式改動了，所以無法使用 worktree。' },
  },
  { what: 'wire worktree.hidden.unknown', guides: ['HOSTING'], render: (locale) => wire(locale, 'worktree.hidden.unknown'), part: { en: 'The shared folder holds a .smurg/git that this workspace has no record of', 'zh-TW': '分享的資料夾裡有一個這個工作區沒有紀錄的 .smurg/git' } },
  {
    what: 'wire worktree.hidden.gone',
    guides: ['HOSTING'],
    render: (locale) => wire(locale, 'worktree.hidden.gone'),
    // 0.6.0's review: "reject them. The next Start makes a new history." was not true while their worktrees remain.
    part: { en: "smurg's own history of this folder (.smurg/git) is gone, so the work items and merge requests made from it cannot go on.", 'zh-TW': 'smurg 為這個資料夾保存的版本紀錄（.smurg/git）不見了，所以從它建立的工作項目和合併請求無法繼續。' },
  },
  { what: 'wire worktree.hidden.noSpace', guides: ['HOSTING'], render: (locale) => wire(locale, 'worktree.hidden.noSpace', { needed: '700 MB', free: '200 MB' }), part: { en: "There is not enough free disk space for another work item's worktree", 'zh-TW': '磁碟空間不夠再建立一個工作項目的 worktree' } },
  { what: 'wire worktree.unavailable.unchecked', guides: ['HOSTING'], render: (locale) => wire(locale, 'worktree.unavailable.unchecked'), part: { en: "smurg has not checked git on the host's computer yet.", 'zh-TW': 'smurg 還沒在主人的電腦上檢查 git。' } },
  // ---- the quick start (docs/QUICKSTART.md): every button and label its twelve steps name, in the order of the steps.
  // The ones the guides quote too carry 'QUICKSTART' in their own lines above (the sample of smurg host, "Next" and
  // "Allow", the two roles, the login and join buttons, the question card, the spec, the plan, the permission card,
  // the review and "Merge…"); these are the quick start's own.
  webQuote('conn.pill.online', ['QUICKSTART']),
  webQuote('workbench.empty.first.title', ['QUICKSTART']),
  webQuote('sidebar.sessions.new.topic', ['QUICKSTART']),
  // (the card's "Your vote" is only the name of its group of options for a screen reader: the quick start does not
  // send a reader looking for it; a card with several questions has the other word on its button)
  webQuote('conversation.q.submit', ['QUICKSTART']),
  webQuote('conversation.q.submitAll', ['QUICKSTART']),
  webQuote('conversation.next.spec.open', ['QUICKSTART']),
  // (the button under a plan counts the items that can start; the quick start's sample plan has three, as the product page's picture)
  webQuote('topics.foot.startAll', ['QUICKSTART'], { count: 3 }),
  webQuote('topics.start.go', ['QUICKSTART']),
  webQuote('conversation.perm.deny', ['QUICKSTART']),
  // (0.7.0, DESIGN D21: the quick start no longer walks through the review and the host's merge, which work items no
  // longer wait for; the host guide's "I merge each item myself" still does, and quotes them)
  {
    // The row of the host's inbox goes on with what is to merge (an item's title).
    what: 'web sidebar.title.merge.ready',
    guides: ['HOSTING'],
    render: (locale, web) => web.text(locale, 'sidebar.title.merge.ready', { what: 'Cart API' }),
    part: { en: 'Reviewed, ready to merge', 'zh-TW': '已看過，可以合併' },
  },
  webQuote('worktree.review.approve', ['HOSTING']),
  // ---- 0.7.0 (DESIGN D18-D21): work items that merge by themselves, decisions, ready to check, undo, the restart
  // The row every member's inbox has when a topic is ready to check, the button that completes it, and the host's undo
  // (the guides write the topic's name as a placeholder).
  {
    what: 'web sidebar.title.ready',
    guides: ['QUICKSTART', 'HOSTING', 'JOINING'],
    render: (locale, web) => web.text(locale, 'sidebar.title.ready', { topic: locale === 'en' ? '<topic>' : '<主題>' }),
  },
  webQuote('topics.result.check', ['QUICKSTART', 'HOSTING', 'JOINING']),
  webQuote('topics.undo.action', ['QUICKSTART', 'HOSTING', 'JOINING']),
  webQuote('topics.result.undoTopic', ['HOSTING']),
  // A decision's row (the guide for teammates names its parts as placeholders), and what its foot offers.
  {
    what: 'web sidebar.title.decision',
    guides: ['JOINING'],
    render: (locale, web) => web.text(locale, 'sidebar.title.decision', locale === 'en' ? { item: '<item>', reason: '<reason>' } : { item: '<項目>', reason: '<原因>' }),
  },
  webQuote('topics.decision.fix', ['HOSTING', 'JOINING']),
  webQuote('topics.decision.asIs', ['HOSTING', 'JOINING']),
  webQuote('topics.decision.leaveOut', ['HOSTING', 'JOINING']),
  webQuote('topics.decision.removePaths', ['HOSTING']),
  webQuote('topics.decision.accept', ['HOSTING']),
  // The host's setting, the Start's stricter choice and the line of a Start on a detached HEAD.
  webQuote('console.settings.merging', ['HOSTING']),
  webQuote('console.settings.merging.auto', ['HOSTING']),
  webQuote('console.settings.merging.host', ['HOSTING']),
  webQuote('topics.start.agent.merge', ['JOINING']),
  webQuote('topics.start.merge.option.host', ['HOSTING', 'JOINING']),
  webQuote('topics.start.merge.detached', ['HOSTING']),
  // What the plan says while an item is on its way into the main workspace.
  webQuote('topics.badge.resolving', ['HOSTING']),
  webQuote('topics.badge.verifying', ['HOSTING']),
  webQuote('topics.badge.waitsToMerge', ['HOSTING'], { name: 'Amy' }),
  webQuote('topics.badge.waitsToMerge.busy', ['HOSTING']),
  // Why an item was not merged (HOSTING §8 has a row for each reason a person decides), as the plan's badge says it.
  ...(['partial', 'blocked', 'report-invalid', 'check-failed', 'not-verified', 'conflict', 'stopped', 'stale-report', 'rejected', 'policy', 'local-changes', 'in-the-way', 'staged', 'branch', 'git-busy', 'undo-interrupted', 'history-changed', 'merge-failed'] as const).map(
    (reason): Quote => ({ what: `web topics.badge.held (${reason})`, guides: ['HOSTING'], render: (locale, web) => web.text(locale, 'topics.badge.held', { reason: web.text(locale, `stores.hold.${reason}`) }) }),
  ),
  {
    what: 'web topics.badge.held (conflict with a person)',
    guides: ['HOSTING'],
    render: (locale, web) => web.text(locale, 'topics.badge.held', { reason: web.text(locale, 'stores.hold.conflict.people', { names: 'Amy', path: 'src/app.ts' }) }),
  },
  {
    what: 'web topics.badge.held (conflict outside smurg)',
    guides: ['HOSTING'],
    render: (locale, web) => web.text(locale, 'topics.badge.held', { reason: web.text(locale, 'stores.hold.conflict.outside', { path: 'src/app.ts' }) }),
  },
  { what: 'wire merge.staged', guides: ['HOSTING'], render: (locale) => wire(locale, 'merge.staged') },
  // The update to 0.7.0: the line of smurg host, the inbox row and the console's banner's button.
  cliQuote('host.mergesAuto', undefined, ['HOSTING'], {
    en: 'Work items now merge by themselves: when a work item\'s report says complete, at least one check passed and none failed',
    'zh-TW': '工作項目現在會自動合併：報告寫著完成、至少一項驗證通過、沒有驗證失敗時',
  }),
  { what: 'wire attention.autoMerge', guides: ['HOSTING'], render: (locale) => wire(locale, 'attention.autoMerge') },
  webQuote('console.settings.agentsAuto.dismiss', ['HOSTING']),
  // While smurg host runs, when it stops and when it starts again (HOSTING §7, §10.3, §10.5), and smurg status.
  cliQuote('host.topicReady', { name: 'Checkout', merged: 3, total: 3 }, ['HOSTING']),
  {
    what: 'CLI host.plansContinue',
    guides: ['HOSTING'],
    render: (locale) => cli(locale, 'host.plansContinue', { topics: [{ name: 'Checkout', items: 2 }, { name: 'Search', items: 1 }] }),
  },
  cliQuote('host.stopping.goOn', { n: 2 }, ['HOSTING']),
  cliQuote('host.plansPaused', { names: ['Checkout'] }, ['HOSTING'], { en: 'Paused by a person, and still paused:', 'zh-TW': '有人暫停、仍在暫停中的主題：' }),
  cliQuote('status.topics', { total: 3, running: 1, decisions: 1, ready: 1, paused: 0 }, ['HOSTING']),
  // What a work item's conversation says when smurg continues it by itself (HOSTING §8, §10.5).
  { what: 'wire conversation.continued.restart', guides: ['HOSTING'], render: (locale) => wire(locale, 'conversation.continued.restart') },
  { what: 'wire conversation.continued.usageLimit', guides: ['HOSTING'], render: (locale) => wire(locale, 'conversation.continued.usageLimit') },
  { what: 'wire conversation.continued.crash', guides: ['HOSTING'], render: (locale) => wire(locale, 'conversation.continued.crash') },
  { what: 'wire conversation.continued.snapshot', guides: ['HOSTING'], render: (locale) => wire(locale, 'conversation.continued.snapshot') },
  // ---- the activity feed's sentences (the wire catalog)
  { what: 'wire activity.agentBashChange', guides: ['HOSTING'], render: (locale) => wire(locale, 'activity.agentBashChange', { agent: 'Claude (Amy)', path: 'src/app.ts', change: 'change' }) },
];

/**
 * The labels of the product page's picture of the app (the four scenes of its window: a question card, the plan, the
 * agents at work, one running the project's tests and the first item merged by itself, its result report marked as
 * reviewed), as the catalogs render them.
 */
const PICTURE_QUOTES: readonly {
  what: string;
  render(locale: Locale, web: WebCatalogue): string;
  /** The part of the rendering the picture shows, where it leaves the end out (the time of an answer). */
  part?: Readonly<Record<Locale, string>>;
}[] = [
  { what: 'web conn.pill.online', render: (locale, web) => web.text(locale, 'conn.pill.online') },
  // ---- 1: the question card, its votes and its answer
  { what: 'web conversation.q.title', render: (locale, web) => web.text(locale, 'conversation.q.title') },
  { what: 'web conversation.q.voted (1 of 3)', render: (locale, web) => web.text(locale, 'conversation.q.voted', { voted: 1, eligible: 3 }) },
  { what: 'web conversation.q.voted (2 of 3)', render: (locale, web) => web.text(locale, 'conversation.q.voted', { voted: 2, eligible: 3 }) },
  { what: 'web conversation.q.allVoted', render: (locale, web) => web.text(locale, 'conversation.q.allVoted', { count: 3 }) },
  { what: 'web conversation.q.leading', render: (locale, web) => web.text(locale, 'conversation.q.leading') },
  { what: 'web sidebar.fact.decides', render: (locale, web) => web.text(locale, 'sidebar.fact.decides', { name: 'Ian' }) },
  { what: 'web conversation.q.submit', render: (locale, web) => web.text(locale, 'conversation.q.submit', { count: 1 }) },
  { what: 'web conversation.q.settled.answered', render: (locale, web) => web.text(locale, 'conversation.q.settled.answered', { answer: locale === 'en' ? 'On the server' : '存在伺服器' }) },
  // ---- 2: the spec and the plan (two files, named as the columns that show them), and Start
  { what: 'web stores.column.spec', render: (locale, web) => web.text(locale, 'stores.column.spec') },
  { what: 'web stores.column.plan', render: (locale, web) => web.text(locale, 'stores.column.plan') },
  { what: 'web topics.plan.generating', render: (locale, web) => web.text(locale, 'topics.plan.generating') },
  { what: 'web topics.summary.items', render: (locale, web) => web.text(locale, 'topics.summary.items', { count: 3 }) },
  { what: 'web topics.badge.ready', render: (locale, web) => web.text(locale, 'topics.badge.ready') },
  { what: 'web topics.badge.running', render: (locale, web) => web.text(locale, 'topics.badge.running') },
  { what: 'web topics.foot.start', render: (locale, web) => web.text(locale, 'topics.foot.start') },
  { what: 'web topics.foot.startAll', render: (locale, web) => web.text(locale, 'topics.foot.startAll', { count: 3 }) },
  { what: 'web topics.start.done', render: (locale, web) => web.text(locale, 'topics.start.done', { count: 3 }) },
  // ---- 3: one agent per work item, one of which runs the project's tests
  { what: 'wire session.title.item', render: (locale) => wire(locale, 'session.title.item', { number: 2, title: locale === 'en' ? 'Payments' : '付款' }) },
  { what: 'web agents.where.worktree', render: (locale, web) => web.text(locale, 'agents.where.worktree', { branch: 'checkout-2' }) },
  { what: 'web conversation.tool.edit', render: (locale, web) => web.text(locale, 'conversation.tool.edit') },
  { what: 'web conversation.tool.read', render: (locale, web) => web.text(locale, 'conversation.tool.read') },
  { what: 'web conversation.tool.create', render: (locale, web) => web.text(locale, 'conversation.tool.create') },
  // (0.6.0, DESIGN D20: what auto mode runs without a request in a work item's own worktree; nobody is asked in the picture)
  { what: 'web conversation.tool.run', render: (locale, web) => web.text(locale, 'conversation.tool.run') },
  { what: 'web conversation.status.working', render: (locale, web) => web.text(locale, 'conversation.status.working') },
  // (0.7.0, DESIGN D21: the first item's report says complete and verified, and smurg merges it by itself)
  { what: 'web topics.badge.mergedAuto', render: (locale, web) => web.text(locale, 'topics.badge.mergedAuto') },
  // ---- 4: the result report of the item smurg merged, and the review that marks it
  { what: 'web stores.column.reportOf', render: (locale, web) => web.text(locale, 'stores.column.reportOf', { item: wire(locale, 'session.title.item', { number: 1, title: locale === 'en' ? 'Cart API' : '購物車 API' }) }) },
  { what: 'web topics.report.section.done', render: (locale, web) => web.text(locale, 'topics.report.section.done') },
  { what: 'web topics.report.section.verified', render: (locale, web) => web.text(locale, 'topics.report.section.verified') },
  { what: 'web topics.report.section.changes', render: (locale, web) => web.text(locale, 'topics.report.section.changes') },
  { what: 'web topics.review.action', render: (locale, web) => web.text(locale, 'topics.review.action') },
  { what: 'web topics.review.done', render: (locale, web) => web.text(locale, 'topics.review.done') },
  { what: 'web topics.badge.mergedReviewed', render: (locale, web) => web.text(locale, 'topics.badge.mergedReviewed') },
  { what: 'web topics.review.merged', render: (locale, web) => web.text(locale, 'topics.review.merged') },
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
      // (where the page's markup puts a tag between a full-width mark and a Latin word, as in 「worktree：checkout-2」,
      // the text read from it has a space there that the catalog's rendering has not: such a space does not count,
      // on either side; the reverse rule below reads every label as it is written)
      const tight = (text: string): string => flat(text).replace(/(?<=[　-〿＀-￯]) | (?=[　-〿＀-￯])/g, '');
      const rendering = tight(quote.render(locale, await webCatalogue()));
      expect(rendering).not.toBe('');
      const page = tight(
        read(path)
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'"),
      );
      const shown = quote.part === undefined ? rendering : tight(quote.part[locale]);
      expect(rendering, 'the shown part is no longer what the catalog renders').toContain(shown);
      expect(page.includes(shown), `${path} does not show: ${shown}`).toBe(true);
    },
  );

  it('the text an agent reads is quoted in English in both languages of the guide for teammates', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      const text = guide(GUIDES.JOINING[locale]);
      expect(AGENT_READS[locale].filter((sentence) => text.includes(flat(sentence))).length, GUIDES.JOINING[locale]).toBeGreaterThanOrEqual(1);
    }
  });

  it('the English guides never quote zh-TW text, and no guide spells the agent name with full-width brackets', () => {
    for (const name of ['QUICKSTART', 'HOSTING', 'JOINING', 'HOW_IT_WORKS', 'SECURITY_MODEL'] as const) {
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

/**
 * What the forward list renders, per language: catalog text too. A message that is built from parameters (a number of
 * days, a version, one message inside another) is in no source file as the guide quotes it; its rendering is.
 */
const renderings = new Map<Locale, Promise<string>>();
function forwardRenderings(locale: Locale): Promise<string> {
  let text = renderings.get(locale);
  if (text === undefined) {
    text = webCatalogue().then((web) => QUOTES.map((quote) => flat(quote.render(locale, web))).join('\n'));
    renderings.set(locale, text);
  }
  return text;
}

/** Sample values the guides put where a catalog has a placeholder: a quote is compared piece by piece around them. */
const SAMPLE_VALUES =
  /Claude \((?:Amy|Ian)\)|<your name>|<你的名字>|Amy, Ben|Amy、Ben|\bAmy\b|\bBen\b|\bIan\b|src\/app\.ts|tests\/login\.test\.ts|package\.json|data\/fixtures\.json|my-app|0\.5\.[0-2]|WDJB-MJHT|https:\/\/\S+|ws_…#k=…&s=…|…|\.\.\./g;

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
 * The labels of the product page's picture of the app (`.m-app`: the window with its four scenes), without what a
 * person or an agent wrote there (the elements marked `m-said`: a topic's name, a question, its options, an item's
 * title, a report's sentences, file and branch names), without commands (`pre.m-term`), and without avatars and
 * numbers (`i.av`, `i.m-count`).
 */
function pictureLabels(path: string): string[] {
  const html = read(path);
  const picture = /<div class="m-app"[^>]*>([\s\S]*?)<figcaption>/.exec(html)?.[1] ?? '';
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
  ],
  'docs/JOINING.md': [
    'Should you check the key fingerprint?', // a heading of this guide
  ],
  'docs/zh-TW/HOSTING.md': [
    '主人還在嗎', // prose
    '收回之後', // the name of a step of this guide
    '只有一個 agent 正在執行 shell 指令', // prose: the condition under discussion
  ],
  'docs/zh-TW/JOINING.md': [
    '要不要核對金鑰指紋', // a heading of this guide
  ],
};

describe('what the guides and the product page quote is in the catalogs (reverse)', () => {
  /**
   * A document, its language, the shortest piece of a quote that is compared, its quotes, and how many of them must
   * be found in the catalogs at least (a guide or the picture that quoted fewer would have lost its quotes, or this
   * lint its way of reading them). The two short pages quote little on purpose: in zh-TW the role names, which that
   * language writes as quotes (two of the three are long enough to compare); in English nothing, because English
   * writes a role name without quotation marks (the forward list above holds the names there). Whatever either
   * page comes to quote must be catalog text all the same.
   */
  const cases: (readonly [string, Locale, number, () => string[], number])[] = [
    [GUIDES.QUICKSTART.en, 'en', 6, () => quotedTexts(GUIDES.QUICKSTART.en, 'en'), 15],
    [GUIDES.HOSTING.en, 'en', 6, () => quotedTexts(GUIDES.HOSTING.en, 'en'), 15],
    [GUIDES.JOINING.en, 'en', 6, () => quotedTexts(GUIDES.JOINING.en, 'en'), 15],
    [GUIDES.HOW_IT_WORKS.en, 'en', 6, () => quotedTexts(GUIDES.HOW_IT_WORKS.en, 'en'), 0],
    [GUIDES.SECURITY_MODEL.en, 'en', 6, () => quotedTexts(GUIDES.SECURITY_MODEL.en, 'en'), 0],
    [LANDING.en, 'en', 4, () => pictureLabels(LANDING.en), 15],
    [GUIDES.QUICKSTART['zh-TW'], 'zh-TW', 3, () => quotedTexts(GUIDES.QUICKSTART['zh-TW'], 'zh-TW'), 15],
    [GUIDES.HOSTING['zh-TW'], 'zh-TW', 3, () => quotedTexts(GUIDES.HOSTING['zh-TW'], 'zh-TW'), 15],
    [GUIDES.JOINING['zh-TW'], 'zh-TW', 3, () => quotedTexts(GUIDES.JOINING['zh-TW'], 'zh-TW'), 15],
    [GUIDES.HOW_IT_WORKS['zh-TW'], 'zh-TW', 3, () => quotedTexts(GUIDES.HOW_IT_WORKS['zh-TW'], 'zh-TW'), 2],
    [GUIDES.SECURITY_MODEL['zh-TW'], 'zh-TW', 3, () => quotedTexts(GUIDES.SECURITY_MODEL['zh-TW'], 'zh-TW'), 2],
    [LANDING['zh-TW'], 'zh-TW', 2, () => pictureLabels(LANDING['zh-TW']), 15],
  ];

  it.each(cases)('%s (%s): every quoted text is catalog text', async (path, locale, minLength, quotes, atLeast) => {
    const text = `${corpus(locale)}\n${await forwardRenderings(locale)}`;
    const all = quotes();
    const allowed = new Set(NOT_UI_TEXT[path] ?? []);
    const missing = all.filter((quote) => !allowed.has(quote) && inCatalogs(quote, text, minLength) === false);
    expect(missing).toEqual([]);
    expect(all.filter((quote) => inCatalogs(quote, text, minLength) === true).length).toBeGreaterThanOrEqual(atLeast);
    // The exceptions are still in the document, and still not catalog text.
    for (const quote of allowed) {
      expect(all, `${path}: remove the exception "${quote}" (no longer quoted)`).toContain(quote);
      expect(inCatalogs(quote, text, minLength), `${path}: remove the exception "${quote}" (it is catalog text now)`).not.toBe(true);
    }
  });
});

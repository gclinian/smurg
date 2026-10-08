// The CLI's own messages in English: the source of truth for the ids and their parameters (zh-TW.ts must match, by
// type). ASCII only (`...`, `->`, `Warning:`), so every line is safe under LANG=C. One id per sentence; a parameter is
// a name, a path, a count or a whole other message, never a translated fragment (docs/GLOSSARY.md).
import { plural } from '@smurg/protocol/i18n';

/** What a relay request was for (relay/relay.ts relayProblem). */
export type RelayAction = 'claim' | 'login' | 'dev-login' | 'verify';
/** Where a relay or web URL came from (relay/relay.ts relayOriginOf). */
export type UrlSubject = 'flag' | 'web-origin' | 'env' | 'credentials' | 'built-in' | 'invite';
/** A private file or directory of the state dir (state/private-file.ts stateProblem). */
export type StateSubject = 'credentials' | 'workspaces' | 'logs' | 'daemon-key' | 'device-key';
/** A private file of the state dir that carries a `version` (state/private-file.ts versionedRecord). */
export type VersionedStateFile = 'credentials' | 'workspaces';
/**
 * Why a running smurg host could not be read by this command (channel/local-channel.ts): no answer came, the answer
 * is not one this command knows, the connection was closed before one came, or (after an attach) a message could not
 * be decoded. Each means a host of another smurg version.
 */
export type UnreadableHost = 'no-answer' | 'not-understood' | 'closed' | 'message';
export type DurationUnit = 'day' | 'hour' | 'minute' | 'second';
/** What the daemon found out about Claude Code on the host (`smurg status`; DaemonStatus.claude of @smurg/daemon). */
export type ClaudeVerdict = 'verified' | 'unverified' | 'too-old' | 'unknown';
export type ClaudeLogin = 'logged-in' | 'logged-out' | 'unknown';
/** The trust state of the shared folder's Claude Code project settings (`smurg status`). */
export type ProjectSettings = 'used' | 'ignored' | 'none';

const STATE_SUBJECT: Readonly<Record<StateSubject, string>> = {
  credentials: 'The login file (credentials.json)',
  workspaces: 'The workspace list (workspaces.json)',
  logs: 'The log folder',
  'daemon-key': "The daemon's key or state folder",
  'device-key': "This device's key (device.key)",
};

/** What to do with a state file that is not in its format, after "nothing was changed" (never: just delete it). */
const BAD_FORMAT_NEXT: Readonly<Record<VersionedStateFile, string>> = {
  credentials: 'Otherwise move the file away and log in again (smurg login).',
  workspaces:
    'Otherwise repair it or put a copy back: it links every shared folder to its workspace, and without it smurg host gives a folder a new workspace (new members, new invite links, a new daemon key).',
};

const UNREADABLE_HOST: Readonly<Record<UnreadableHost, string>> = {
  'no-answer': 'it did not answer',
  'not-understood': 'its answer is not one this smurg can read',
  closed: 'it closed the connection without an answer',
  message: 'it sent a message this smurg cannot read',
};

const URL_SUBJECT: Readonly<Record<UrlSubject, string>> = {
  flag: 'The --relay URL',
  'web-origin': 'The --web-origin URL',
  env: 'The SMURG_RELAY_URL URL',
  credentials: 'The relay URL in credentials.json',
  'built-in': "The URL of smurg's built-in public relay",
  invite: "The invite link's URL",
};

const RELAY_UNREACHABLE: Readonly<Record<RelayAction, string>> = {
  claim: 'the workspace was not created',
  login: 'the login did not complete',
  'dev-login': 'the development login did not complete',
  verify: 'the login could not be checked',
};

const RELAY_FAILED: Readonly<Record<RelayAction, string>> = {
  claim: 'Creating the workspace failed',
  login: 'The login failed',
  'dev-login': 'The development login failed',
  verify: 'Checking the login failed',
};

const CLAUDE_VERDICT: Readonly<Record<ClaudeVerdict, string>> = {
  verified: 'verified with this smurg',
  unverified: 'not verified with this smurg yet; agent sessions run with a warning',
  'too-old': 'too old for agent sessions; update Claude Code',
  unknown: 'smurg could not read its version',
};

const CLAUDE_LOGIN: Readonly<Record<ClaudeLogin, string>> = {
  'logged-in': 'logged in',
  'logged-out': 'not logged in (run claude in a terminal and log in)',
  unknown: 'login not checked yet',
};

const PROJECT_SETTINGS: Readonly<Record<ProjectSettings, string>> = {
  used: 'confirmed (agents use them)',
  ignored: 'not confirmed (agents run without them; confirm them in the web app)',
  none: 'none in this folder',
};

/**
 * Why the system would not open or write a file (a refused workspace state, `cannot-open`): the errno in words. A code
 * that is not here is shown as it is.
 */
const ERRNO_WORDS: Readonly<Record<string, string>> = {
  EACCES: 'permission denied',
  EPERM: 'the system does not permit it',
  EIO: 'read or write error; the disk may be failing',
  ENOSPC: 'no space left on the disk',
  EDQUOT: 'the disk quota is used up',
  EROFS: 'the file system is read-only',
  EISDIR: 'it is a folder',
  ENOTDIR: 'a part of its path is not a folder',
  EMFILE: 'too many open files',
  ENFILE: 'too many open files',
  EBUSY: 'the file is in use',
  ENOENT: 'it is not there',
  EEXIST: 'a file of that name is already there',
  ELOOP: 'too many symbolic links',
  ENAMETOOLONG: 'the path is too long',
};

/**
 * The documents of a workspace's folder that a host can set aside ALONE when smurg refuses one as unreadable: the
 * workspace keeps its members, invite links and key, and the next start makes a new, empty one. The daemon decides
 * which (DocumentDeclaration.canSetAside in @smurg/daemon, proven per document by its test/upgrade/set-aside.test.ts;
 * test/host-state-words.test.ts holds this list equal to the daemon's). `other`: a document the daemon vouches for
 * and this list does not know yet.
 */
export const SET_ASIDE_DOCUMENTS = ['inbox', 'suggestions', 'conflicts', 'worktrees', 'sessions', 'host-rules', 'claude-trust', 'cards'] as const;
export type SetAsideDocument = (typeof SET_ASIDE_DOCUMENTS)[number] | 'other';

/** What each such file holds, and that setting it aside loses only that: one sentence pair per document. */
const SET_ASIDE: Readonly<Record<SetAsideDocument, string>> = {
  inbox: 'It holds what each member has read or dismissed in their inbox and the mentions kept for them. Setting it aside loses only that: everything in every inbox is unread again.',
  suggestions: 'It holds the suggestions members made to agent sessions. Setting it aside loses only those: one that still waited has to be made again.',
  conflicts: "It holds the list of kept conflicts between a person's and an agent's edit of the same file. Setting it aside loses only that list: your files are not touched.",
  worktrees:
    "It holds smurg's record of the worktrees it made and of every merge request. Setting it aside loses only that: " +
    "the worktrees' folders stay on disk (in the shared folder's .smurg/worktrees), unknown to smurg, and merge requests that waited are gone.",
  sessions: 'It holds which terminal sessions were running. Setting it aside loses only that: processes they left running after a crash are not ended for you.',
  'host-rules': 'It holds what smurg last saw of your own Claude Code allow rules. Setting it aside loses only that: smurg tells you about them again.',
  'claude-trust':
    "It holds your decisions about projects' Claude Code settings. Setting it aside loses only those: agent sessions start without a project's settings until you confirm them again.",
  cards: 'It holds the list of conversations that have questions and permission requests. Setting it aside loses only that: the ones asked so far are no longer shown.',
  other: "It holds a part of the workspace's state that is neither its members nor its invite links nor its keys. Setting it aside loses only what this file holds.",
};

/**
 * Where the host guide says what a one-line notice of `smurg host` is about (docs/HOSTING.md; the anchors are the
 * headings' own, and test/guide-anchors.test.ts fails when a heading they name is gone): what an update carries over
 * and what putting a kept copy back undoes (9.2), and how to go back to a folder set aside (9.4).
 */
const GUIDE_KEPT = 'https://smurg.ai/docs/hosting/#92-after-an-update-what-your-workspace-keeps';
const GUIDE_GOING_BACK = 'https://smurg.ai/docs/hosting/#94-if-you-moved-the-state-folder-away-because-smurg-050-told-you-to';

/** "A file of this workspace's state is" / "3 files of this workspace's state are" (+ "; the first" before its details). */
const stateFiles = (count: number, one: string, many: string): string => (count === 1 ? `A file of this workspace's state ${one}` : `${count} files of this workspace's state ${many}`);

const duration = (amount: number, unit: DurationUnit): string => `${amount} ${plural(amount, unit, `${unit}s`)}`;

const UNCHANGED = 'smurg was not changed.';

export const en = {
  // ---- how a failure is printed
  'failure.line': (p: { message: string; hint?: string }) => `smurg: ${p.message}\n${p.hint ? `  ${p.hint}\n` : ''}`,
  'failure.unexpected': (p: { name: string }) => `smurg: an unexpected error occurred (${p.name}).\n  If it keeps happening, report it with the logs in ~/.smurg/logs.\n`,
  'failure.unexpectedEarly': (p: { name: string }) => `smurg: an unexpected error occurred (${p.name}).\n`,

  // ---- the dispatcher
  'usage.root': () => `smurg - a shared workspace for people and their AI agents

Usage: smurg <command> [options]

  host <folder>        Share a project folder on this computer and print the invite links (runs in the foreground)
  attach [session]     Attach a terminal session to this terminal (lists the sessions when none is given)
  stop                 Stop sharing (disconnects everyone, ends terminal sessions, pauses agent sessions)
  status               Show the workspaces being shared
  login                Log in to the relay (the public relay uses Google)
  logout               Log out of the relay
  update               Update smurg to the latest version (--check only checks)
  uninstall            Remove smurg from this computer
  licenses             Show the license and the third-party notices
  --version            Show the version

Every command takes --help. State and keys are kept in ~/.smurg (set SMURG_HOME to move them).
Language: English or Traditional Chinese, from your locale; set SMURG_LANG=en or SMURG_LANG=zh-TW to choose.
Docs: https://smurg.ai/docs/
`,
  'cli.unknownCommand': (p: { command: string }) => `Unknown command "${p.command}"`,
  'cli.unknownCommand.hint': () => 'Run smurg --help to see every command.',

  // ---- arguments
  'args.unknownOption': (p: { option: string }) => `Unknown option ${p.option}`,
  'args.takesNoValue': (p: { name: string }) => `Option --${p.name} does not take a value`,
  'args.conflict': (p: { name: string }) => `Options --${p.name} and --no-${p.name} cannot be used together`,
  'args.needsValue': (p: { name: string }) => `Option --${p.name} needs a value`,
  'args.once': (p: { name: string }) => `Option --${p.name} can be given only once`,
  'args.missing': (p: { name: string }) => `Missing argument <${p.name}>`,
  'args.surplus': (p: { value: string }) => `Unexpected argument "${p.value}"`,
  'arg.folder': () => 'folder',
  'arg.session': () => 'session',
  'arg.generic': () => 'argument',

  // ---- state dir
  'state.homeNotAbsolute': () => 'SMURG_HOME must be an absolute path',
  'state.insecureDirectory': (p: { subject: StateSubject; path: string }) => `${STATE_SUBJECT[p.subject]} is in a folder other users can access: ${p.path}`,
  'state.insecureDirectory.hint': (p: { path: string }) => `Run chmod 700 ${p.path}, or use a new SMURG_HOME.`,
  'state.insecurePermissions': (p: { subject: StateSubject; path: string }) => `${STATE_SUBJECT[p.subject]} can be read by other users: ${p.path}`,
  'state.insecurePermissions.hint': (p: { path: string }) => `Run chmod 600 ${p.path}.`,
  'state.notOwner': (p: { subject: StateSubject; path: string }) => `${STATE_SUBJECT[p.subject]} belongs to another user: ${p.path}`,
  'state.notRegularFile': (p: { subject: StateSubject; path: string }) => `${STATE_SUBJECT[p.subject]} is not a regular file (it may be a symlink): ${p.path}`,
  'state.damaged': (p: { subject: StateSubject; path: string }) => `${STATE_SUBJECT[p.subject]} is damaged: ${p.path}`,
  'state.unusable': (p: { subject: StateSubject; path: string }) => `${STATE_SUBJECT[p.subject]} cannot be used: ${p.path}`,
  'state.noAccess': (p: { subject: StateSubject; code: string }) => `${STATE_SUBJECT[p.subject]} cannot be accessed (${p.code})`,
  'state.tooLarge': (p: { subject: StateSubject; path: string }) => `${STATE_SUBJECT[p.subject]} is too large and may be damaged: ${p.path}`,
  'state.badFormat': (p: { subject: StateSubject; path: string }) => `${STATE_SUBJECT[p.subject]} is not in the expected format: ${p.path}`,
  'state.badFormat.hint': (p: { file: VersionedStateFile }) => `Nothing was changed. If a newer smurg was ever used on this computer, run smurg update. ${BAD_FORMAT_NEXT[p.file]}`,
  'state.newer': (p: { subject: VersionedStateFile; path: string; current: string }) => `${STATE_SUBJECT[p.subject]} was written by a newer smurg than this one (this is ${p.current}): ${p.path}`,
  'state.newer.hint': () => 'Run smurg update. Nothing was changed.',
  'state.entriesKept': (p: { subject: VersionedStateFile; path: string; count: number; current: string }) =>
    `Note: ${STATE_SUBJECT[p.subject]} holds ${p.count} ${plural(p.count, 'entry', 'entries')} this smurg cannot read (this is ${p.current}); ` +
    `${plural(p.count, 'it is', 'they are')} left exactly as ${plural(p.count, 'it is', 'they are')}, and this smurg does not use ${plural(p.count, 'it', 'them')}: ${p.path}\n` +
    '  If a newer smurg was ever used on this computer, run smurg update.',
  'state.workspaceId': (p: { id: string }) => `Not a workspace ID: ${p.id}`,
  'state.socketPathTooLong': (p: { path: string }) => `The path of smurg's state folder is too long for a Unix socket: ${p.path}`,
  'state.socketPathTooLong.hint': () => 'Set SMURG_HOME to a shorter path.',

  // ---- relay
  'relay.badUrl': (p: { subject: UrlSubject; url: string }) => `${URL_SUBJECT[p.subject]} is not valid: ${p.url}`,
  'relay.badUrl.hint': () => 'A relay URL must be the root of an https site (for local development: http://localhost:8787).',
  'relay.badWebOrigin.hint': () => 'The web URL must be the root of an https site (for local development: http://localhost:5173).',
  'relay.none': () => 'No relay was given',
  'relay.none.hint': () =>
    'Name the relay with --relay <URL> (or set SMURG_RELAY_URL); it is remembered after the first login. This smurg has no built-in public relay (docs: https://smurg.ai/docs/hosting/; local development: http://localhost:8787).',
  'relay.default.none': () => 'default: SMURG_RELAY_URL, or the relay of your last login; there is no built-in relay',
  'relay.default.builtIn': (p: { url: string }) => `default: SMURG_RELAY_URL, the relay of your last login, or the built-in public relay ${p.url}`,
  'relay.builtInNotice': (p: { origin: string }) => `Using smurg's built-in public relay: ${p.origin} (for another relay: --relay <URL> or SMURG_RELAY_URL)`,
  'relay.unreachable': (p: { origin: string; action: RelayAction }) => `Cannot reach the relay (${p.origin}); ${RELAY_UNREACHABLE[p.action]}`,
  'relay.unreachable.hint': () => 'Check your network connection and the relay URL.',
  'relay.loginInvalid': (p: { origin: string }) => `The relay login is no longer valid (${p.origin})`,
  'relay.loginInvalid.hint': () => 'Run smurg login to log in again.',
  'relay.refused': (p: { origin: string; status: number; code: string; action: RelayAction }) => `${RELAY_FAILED[p.action]}: the relay refused the request (${p.origin}, HTTP ${p.status}, ${p.code})`,
  'relay.failed': (p: { action: RelayAction; name: string }) => `${RELAY_FAILED[p.action]} (${p.name})`,

  // ---- login / logout
  'usage.login': (p: { relayDefault: string }) => `Usage: smurg login [--relay URL] [--dev-user NAME] [--no-browser]

  Log in to the relay: smurg prints a URL and a code. Open the URL in a browser on any device (a computer or a
  phone), log in to your account (the public relay uses Google), enter the code and approve the request.
  It works the same over SSH; nothing else needs to be set up.
  The login is saved in ~/.smurg/credentials.json (mode 0600).
  --relay URL         the relay's URL (${p.relayDefault})
  --dev-user NAME     local development only: use the relay's development login (the relay must be on localhost)
  --no-browser        do not open the URL in this computer's browser (it never opens over SSH or without a desktop)
`,
  'usage.logout': () => `Usage: smurg logout [--relay URL] [--all]

  Forget the relay login saved on this computer. --all forgets the logins of every relay.
`,
  'login.done': (p: { origin: string; name: string; userId: string }) => `Logged in to ${p.origin}: ${p.name} (${p.userId})`,
  'logout.allAndRelay': () => '--all and --relay cannot be used together',
  'logout.all': (p: { count: number }) => `Logged out of every relay (${p.count} ${plural(p.count, 'login', 'logins')}).`,
  'logout.allNone': () => 'There is no relay login on this computer.',
  'logout.done': (p: { origin: string }) => `Logged out of ${p.origin}.`,
  'logout.none': (p: { origin: string }) => `There is no login for ${p.origin}.`,
  'login.open': (p: { page: string; code: string; minutes: number }) =>
    `On any device (a computer or a phone), open:\n  ${p.page}\nEnter the code: ${p.code}   (valid for ${duration(p.minutes, 'minute')})\n`,
  'login.opened': () => '(The URL above was opened in this computer\'s browser.)\n',
  'login.waiting': () => 'Waiting for you to approve the request in your browser... (Ctrl-C cancels)\n',
  'login.tooMany': () => 'Too many logins were started from this network in the last 10 minutes',
  'login.tooMany.hint': () => 'Try again in a few minutes.',
  'login.unsupported': (p: { origin: string }) => `This relay does not support logging in with a code yet (${p.origin})`,
  'login.unsupported.hint': () => 'Ask whoever runs the relay to update it, or use the smurg version released with it.',
  'login.cancelled': () => 'Login cancelled',
  'login.expired': () => 'The code expired; the login did not complete',
  'login.expired.hint': () => 'Run the command again, then enter the code and approve the request in your browser within 10 minutes.',
  'login.denied': () => 'The login was denied in the browser',
  'login.denied.hint': () => 'If that was not you, someone else may have the code: run the command again and enter the code only in your own browser.',
  'login.retrying': (p: { origin: string }) => `(Cannot reach the relay (${p.origin}) right now; still trying)\n`,
  'login.devUserLocalOnly': () => '--dev-user works only with a relay on this computer (localhost, 127.0.0.1, [::1] or *.localhost)',
  'login.devUserLocalOnly.hint': (p: { origin: string }) => `The relay is ${p.origin}; use smurg login and log in in the browser the way this relay offers (the public relay: Google).`,
  'login.devUserName': () => 'The --dev-user name may contain only letters, digits, ".", "_" and "-", at most 64 characters',
  'login.devDisabled': (p: { origin: string }) => `This relay has no development login (${p.origin})`,
  'login.devDisabled.hint': () => 'The development login needs a relay started with DEV_LOGIN=1 (pnpm dev:relay).',
  'login.required': (p: { origin: string }) => `Not logged in to the relay (${p.origin})`,
  'login.required.hint': (p: { origin: string }) => `Run smurg login --relay ${p.origin} first.`,
  'login.expiringSoon': () => 'The relay login expires soon; logging in again first (if it expired while you share, your teammates could not connect).\n',
  'login.hasExpired': () => 'The relay login has expired; log in again.\n',
  'login.first': () => 'Not logged in to the relay yet; logging in first.\n',

  // ---- the connection to a workspace
  'channel.closed.stopped': () => 'The host stopped sharing (smurg stop).',
  'channel.closed.kicked': () => 'The host removed you from this workspace.',
  'channel.closed.revoked': () => "This device's key was revoked.",
  'channel.closed.roleChanged': () => 'Your role changed; connect again.',
  'channel.closed.protocolError': () => 'The connection was closed because of a protocol error.',
  'channel.closed.other': () => 'The connection was lost.',
  'channel.closed.local': () => 'The connection was closed.',
  'channel.keyMismatch.device': () =>
    "Warning: the key of the host's computer differs from the one this computer recorded last time; someone (the relay, for example) may be posing as the host. The connection was aborted and nothing was sent. " +
    'If the host says they set the workspace up again (with new keys), ask them for a new invite link, join with smurg attach --invite -, and confirm the daemon key fingerprint with the host through another channel.',
  'channel.keyMismatch.invite': () =>
    'Warning: the other side\'s key does not match the invite link (or the key recorded last time); someone (the relay, for example) may be posing as the host. The connection was aborted and nothing was sent. Confirm the daemon key fingerprint with the host through another channel.',
  'channel.rejected.inviteInvalid': () => 'The invite link is not valid, has expired or has been used up; ask the host for a new one.',
  'channel.rejected.deviceRevoked': () => "This device's key was revoked (you may have been removed from the workspace); ask the host for a new invite link.",
  'channel.rejected.deviceOtherAccount': () =>
    'This device joined this workspace with another account before, so it cannot connect with the account logged in now. Log in with the original account (smurg login), or use another SMURG_HOME.',
  'channel.rejected.identityInvalid': () => "The relay's identity token could not be verified; log in again and retry.",
  // A `version` refusal names no side. These three are chosen by what smurg update would find (update/version-advice.ts):
  // it could not ask (both steps, this computer's first) / a newer smurg is published / this one is the newest.
  'channel.rejected.version': () =>
    "This smurg and the host's smurg are different versions and cannot connect. First run smurg update here. If it says this is the latest version, the host's smurg is the older one: the host stops sharing, runs smurg update and shares again.",
  'channel.rejected.version.updateHere': (p: { current: string; latest: string }) =>
    `This smurg (${p.current}) and the host's smurg are different versions and cannot connect, and a newer smurg (${p.latest}) is published: update this one (smurg update), then connect again.`,
  'channel.rejected.version.hostOlder': (p: { current: string }) =>
    `The host's smurg is older than this one (${p.current}; no newer smurg is published): the host stops sharing, runs smurg update and shares again. Then connect again.`,
  'channel.rejected.aborted': () => 'The host does not know this invite link; check that the link is complete.',
  'channel.rejected.unknown': () => 'The host refused the connection.',
  'channel.closed.loginRequired': () => 'The relay login is no longer valid; run smurg login to log in again.',
  'channel.closed.relayRefused': () => 'The relay refused the connection.',
  'channel.closed.noTrust': () => "There is no invite link for this workspace and no recorded key of the host: give the invite link with --invite.",
  'channel.closed.storageError': () => "Cannot read or write this device's key or the recorded key of the host (the permissions of ~/.smurg?).",
  'channel.hostOffline': () => "The host is offline (smurg host is not running, or the host's computer is asleep).",
  'channel.relayUnreachable': () => 'Cannot reach the relay.',
  'channel.timeout': () => 'The connection timed out; could not join the workspace.',
  'ctl.notRunning': () => 'No smurg host is running for this workspace',
  'ctl.connectFailed': (p: { code: string }) => `Cannot connect to the control socket of smurg host (${p.code})`,
  'ctl.disconnected': () => 'The connection to smurg host was lost.',
  'ctl.attachRefused': (p: { reason: string }) => `smurg host refused the connection: ${p.reason}`,
  'ctl.noAnswer': (p: { type: string }) => `smurg host did not answer (${p.type})`,
  // A smurg host of another version: its control socket is alive and this command cannot read what it sends.
  'otherVersion.hint': () => 'Stop it (smurg stop, or Ctrl-C in the terminal that runs smurg host), then start it again with smurg host.',
  'attach.otherVersion': (p: { current: string; why: UnreadableHost }) => `Another version of smurg is sharing here (this smurg is ${p.current}): ${UNREADABLE_HOST[p.why]}`,
  'discover.notRunningFor': (p: { workspaceId: string }) => `No smurg host is running for workspace ${p.workspaceId}`,
  'discover.notRunning': () => 'No smurg host is running',
  'discover.several': () => 'Several workspaces are being shared; choose one with --workspace',
  'discover.several.hint': (p: { ids: readonly string[] }) => `Workspaces being shared: ${p.ids.join(', ')}`,

  // ---- attach
  'usage.attach': (p: { relayDefault: string }) => `Usage: smurg attach [session] [--workspace ID] [--invite -|LINK] [--relay URL] [--no-browser] [--accept-new-key]

  Attach a terminal session to this terminal. Without a session, list every session.
  A session is its number in the list, its session ID, or the start of its ID.
  Agent sessions are conversations: they are listed with their topic and status, and they open in the browser,
  not in a terminal.
  When this computer is sharing the workspace (smurg host), you attach directly as the host; otherwise you join
  through the relay with this computer's device key.
  --invite -          the first time you join someone's workspace: run the command, then paste the invite link the
                      host gave you (it is not shown on screen). You can also put the link in the environment variable
                      SMURG_INVITE. It is needed only the first time; after that --workspace is enough.
                      Writing the link on the command line (--invite LINK) works too, but the secret in the link stays
                      in your shell history and shows in the process list (ps) while the command runs.
  --workspace ID      the workspace (default: the one shared from the current folder, or the only one)
  --relay URL         the relay's URL (default: ${p.relayDefault})
  --no-browser        when a relay login is needed, do not open the browser; only print the URL (SMURG_NO_BROWSER=1
                      does the same)
  --accept-new-key    when the host's key in the invite link differs from the one this computer recorded ("The
                      host computer's key has changed"), use the invite link's key without asking. Use it only
                      after you confirmed the key fingerprint with the host through another channel.

  Once attached: press Ctrl-] to leave (the session keeps running). The host and members with agent access can type
  into any session; other roles are read-only.
  Guide for teammates: https://smurg.ai/docs/joining/#10-joining-from-a-terminal-cli-optional
`,
  'attach.relayDefault.none': () => "the invite link's URL, or the relay you used last",
  'attach.relayDefault.builtIn': (p: { url: string }) => `the invite link's URL, the relay you used last, or the built-in public relay ${p.url}`,
  'attach.status.exited': (p: { exitCode: number }) => `exited (${p.exitCode})`,
  'attach.status.starting': () => 'starting',
  'attach.status.running': () => 'running',
  'attach.kind.terminal': () => 'terminal',
  'attach.owner.you': (p: { name: string }) => `${p.name} (you)`,
  'attach.list.empty': () => 'This workspace has no sessions.',
  'attach.list.header': () => 'No.   Session ID                            Type      Owner         Status      Title',
  'attach.list.footer': () => 'Attach with smurg attach <number or session ID>.',
  'attach.list.noTerminals': () => 'This workspace has no terminal sessions.',
  'attach.agents.heading': () => 'Agent sessions (conversations):',
  'attach.agents.header': () => 'Session ID                            Status                    Topic                     Title',
  'attach.agents.noTopic': () => 'No topic',
  'attach.agents.browser': (p: { url?: string }) =>
    p.url === undefined ? "Agent conversations open in the browser, in this workspace's web app." : `Agent conversations open in the browser: ${p.url}`,
  'attach.agents.notTerminal': (p: { title: string }) => `Session "${p.title}" is an agent conversation, not a terminal`,
  'attach.agent.waitingAnswer': () => 'waiting for an answer',
  'attach.agent.waitingPermission': () => 'waiting for permission',
  'attach.agent.idle': () => 'idle',
  'attach.agent.stalled': () => 'stopped without a report',
  'attach.agent.done': () => 'done',
  'attach.agent.failed': () => 'failed',
  'attach.agent.ended': () => 'ended',
  'attach.list.workspace.local': (p: { name: string; workspaceId: string }) => `Workspace "${p.name}" (${p.workspaceId}, on this computer)`,
  'attach.list.workspace.relay': (p: { name: string; workspaceId: string; relay: string }) => `Workspace "${p.name}" (${p.workspaceId}, through the relay ${p.relay})`,
  'attach.pick.ambiguous': (p: { wanted: string }) => `"${p.wanted}" matches more than one session; type more of the ID`,
  'attach.pick.notFound': (p: { wanted: string }) => `No session "${p.wanted}"`,
  'attach.pick.notFound.hint': () => 'Run smurg attach without a session to list every session.',
  'attach.invite.bad': () => 'The invite link is not valid',
  'attach.invite.bad.hint': () => 'Copy the whole link the host gave you (including the part after #).',
  'attach.invite.otherWorkspace': () => '--workspace and the invite link name different workspaces',
  'attach.several': () => 'This computer is sharing several workspaces; choose one with --workspace',
  'attach.several.hint': (p: { ids: readonly string[] }) => `Being shared: ${p.ids.join(', ')}`,
  'attach.noTarget': () => 'Which workspace to attach to is not known',
  'attach.noTarget.hint': () => 'The first time, join with --invite - (run it, then paste the invite link); after that you can use --workspace <ID>.',
  'attach.loginOrigin': (p: { others: readonly string[]; origin: string; first: string }) =>
    [
      `Note: this computer is logged in to ${p.others.join(', ')}, but not to ${p.origin} (logins are kept per URL).`,
      `  If ${p.origin} is only the web page of the same relay (the web server of a local development setup, for example), press Ctrl-C and run the command again with --relay ${p.first};`,
      `  otherwise run  smurg login --relay ${p.origin}  first.`,
    ].join('\n'),
  'attach.keyChange': (p: { pinned: string; invited: string }) =>
    [
      '',
      "The host computer's key has changed",
      "  You joined this workspace before, and the key of the host's computer was not the one this invite link names.",
      '  Usually the host set the workspace up again (new keys after taking agent access back from someone, for example)',
      '  or reinstalled smurg; but someone may also be posing as the host.',
      `  Key fingerprint recorded last time: ${p.pinned}`,
      `  Key fingerprint in the invite link: ${p.invited}`,
      '  Continue only if you confirmed with the host through another channel (in person, by phone, or in the chat app',
      '  you normally use) that the host just gave you this new link, and that the "daemon key fingerprint" the host',
      '  sees in smurg status is the same as "Key fingerprint in the invite link" above.',
      '',
    ].join('\n'),
  'attach.keyChange.accepted': () => "--accept-new-key was given: using the invite link's key.\n",
  'attach.keyChange.question': () => 'Did you confirm it? Type y to join with the new link, anything else to cancel: ',
  'attach.keyChange.cancelled': () => "Cancelled; nothing was connected, and the host key this computer recorded is unchanged.",
  'attach.keyChange.cancelled.noTerminal': () => 'smurg cannot ask outside a terminal: after you confirmed the key fingerprint with the host, run the command again with --accept-new-key.',
  'attach.keyChange.cancelled.hint': () => 'Run the command again after you confirmed the key fingerprint with the host.',
  'attach.invite.prompt': () => 'Paste the invite link the host gave you (it is not shown on screen), then press Enter: ',
  'attach.invite.none': () => 'No invite link was received',
  'attach.invite.none.hint': () => 'Run the command again, paste the whole link (including the part after #) and press Enter.',
  'attach.invite.onCommandLine': () =>
    'Note: an invite link on the command line (with its secret) stays in your shell history and shows in the process list (ps) while the command runs. ' +
    'Next time use --invite - (run it, then paste the link) or the environment variable SMURG_INVITE; after you joined once, --workspace is enough.\n',
  'attach.needsTerminal': () => 'smurg attach must run in a terminal (standard input and output must both be a terminal)',
  'attach.sessionExited': (p: { title: string; exitCode: number }) => `Session "${p.title}" has already exited (exit code ${p.exitCode})`,
  'attach.attaching.own': (p: { title: string; owner: string }) => `Attaching to session "${p.title}" (${p.owner}, your session). Press Ctrl-] to leave.`,
  'attach.attaching.other': (p: { title: string; owner: string }) => `Attaching to session "${p.title}" (opened by ${p.owner}). Press Ctrl-] to leave.`,
  'attach.readOnly': (p: { owner: string }) =>
    `Read-only: ${p.owner} opened this terminal session, and your role cannot type into terminal sessions. Press Ctrl-] to leave.`,
  'attach.title': (p: { title: string }) => `smurg: ${p.title}`,
  'attach.title.readOnly': () => 'read-only',
  'attach.title.hostOffline': () => 'the host is offline, waiting to reconnect...',
  'attach.title.reconnecting': () => 'reconnecting...',
  'attach.title.enlarge': (p: { cols: number; rows: number }) => `the session window is ${p.cols}x${p.rows}; enlarge your terminal`,
  'attach.note': (p: { message: string }) => `[smurg] ${p.message}`,
  'attach.exited': (p: { exitCode: number }) => `The session has exited (exit code ${p.exitCode}).`,
  'attach.failed': () => 'Could not attach to the session',
  'attach.signal': (p: { signal: string }) => `Received ${p.signal}; left the session (it keeps running).`,
  'attach.rawModeFailed': () => 'Could not switch the terminal to raw mode.',
  'attach.detached': () => 'Left the session (it keeps running; attach again with smurg attach).',

  // ---- host
  'usage.host': (p: { relayDefault: string }) => `Usage: smurg host <folder> [options]

  Share a project folder on this computer and print two links: yours, and one for your teammates. smurg host keeps
  running in the foreground; press Ctrl-C, or run smurg stop in another terminal, to stop sharing. The key
  fingerprint, the settings and where the log is: smurg status.
  --relay URL         the relay's URL (${p.relayDefault})
  --role ROLE         the role of the teammates' link: agent (Agent access), editor (Editor, the default),
                      viewer (Viewer)
                      Sessions opened by a member with agent access run as you on this computer, with your Claude
                      login, and that member can message any agent, allow what agents ask to run and type into any
                      terminal: give it only to people you trust completely
  --expires TIME      how long the teammates' link stays valid, for example 30m, 12h, 7d (default 7d, at most 365d)
  --max-uses N        how many times the teammates' link can be used (default: no limit)
  --name NAME         the name the workspace is shown with (default: the folder's name)
  --web-origin URL    the web page the links point to (default: the relay itself; for local development:
                      http://localhost:5173)
  --no-keep-awake     do not keep the computer awake while sharing
  --no-browser        when a relay login is needed, do not open the browser; only print the URL (SMURG_NO_BROWSER=1
                      does the same)
  --no-bash-attribution
                      do not tell smurg when an agent runs a shell command (by default it is told)

  Read before you share: https://smurg.ai/docs/hosting/#4-before-you-share
  What agent access and --no-bash-attribution mean, and their risks: https://smurg.ai/docs/hosting/#5-agent-access-and-agents-shell-commands
`,
  'host.folder.notFound': (p: { folder: string }) => `Folder not found: ${p.folder}`,
  'host.folder.notDirectory': (p: { folder: string }) => `${p.folder} is not a folder`,
  'host.folder.root': () => 'The whole file system (/) cannot be shared; name a project folder',
  'host.folder.home': () => 'Your whole home folder cannot be shared; name a project folder',
  'host.folder.example': (p: { example: string }) => `For example: smurg host ${p.example}`,
  'host.folder.containsHome': () => 'A folder that contains a home folder cannot be shared',
  'host.folder.containsHome.hint': (p: { example?: string }) =>
    `A home folder holds private files such as SSH keys and logins, and your teammates would see all of them. Share the project folder itself${p.example === undefined ? '.' : `, for example: smurg host ${p.example}`}`,
  'host.folder.containsState': (p: { stateDir: string }) => `This folder cannot be shared: smurg's state folder (${p.stateDir}) is inside it`,
  'host.folder.containsState.hint': () => 'The state folder holds keys and logins that your teammates must not see. Share the project folder itself.',
  'host.folder.insideState': () => "A folder inside smurg's state folder cannot be shared",
  'host.share.notFound': () => 'The folder to share was not found',
  'host.share.notDirectory': () => 'What you want to share is not a folder',
  'host.share.root': () => 'The whole file system cannot be shared',
  'host.share.home': () => 'Your whole home folder cannot be shared',
  'host.share.stateInside': () => "smurg's state folder is inside the folder you want to share",
  'host.share.smurgNotDirectory': () => '.smurg in the folder is not a folder; move it away first',
  'host.share.containsHomes': () => "A folder that contains users' home folders cannot be shared",
  'host.share.other': (p: { reason: string }) => `This folder cannot be shared (${p.reason})`,
  'host.locked.ancestor': () => 'A folder above this one is already being shared',
  'host.locked.shared': () => "This folder is already being shared (perhaps through another relay or from another smurg state folder)",
  'host.locked.hint': () => 'One smurg host at a time can share a folder. Look with smurg status, or stop the other share first.',
  // ---- a workspace's state that smurg host does not open (0.5.1, DESIGN C; commands/host-state.ts). One text per kind
  // and cause of the daemon's refusal; each names the file and the reason itself and says that nothing was changed.
  // The hint is a list of sentences, one id each, joined by `host.lines`. Never "move the folder away", except as the
  // last resort of `unreadable`, after what that costs; and not even then for a file that can be set aside alone.
  'host.lines': (p: { lines: readonly string[] }) => p.lines.join('\n  '),
  'host.unchanged': () => 'Nothing was changed.',
  'host.refused.all': (p: { paths: readonly string[] }) => `All of them: ${p.paths.join(', ')}`,
  // newer: the folder's stamp, or a document's version, is from a later smurg
  'host.newer': (p: { path: string; current: string; writtenBy?: string }) =>
    `This workspace was last shared with ${p.writtenBy === undefined ? 'a newer smurg' : `smurg ${p.writtenBy}, a newer smurg`} than this one (this is ${p.current}), and this smurg cannot read what it wrote: ${p.path}`,
  'host.newer.update': (p: { latest: string }) => `Run smurg update (version ${p.latest} is available), then smurg host again.`,
  'host.newer.maybe': () =>
    'Run smurg update, then smurg host again. If smurg update says that this is the latest version, the folder was last written by a smurg this computer cannot get that way: share it with the smurg that wrote it.',
  'host.newer.newest': (p: { current: string }) =>
    `smurg update cannot help: ${p.current} is the latest published version. This folder was last written by a smurg this computer cannot get that way (a build that was never published, or a folder copied from another computer): share it with the smurg that wrote it.`,
  'host.newer.stamp': (p: { stamp: string; writtenBy?: string }) =>
    p.writtenBy === undefined ? `The folder has no usable stamp that names its writer (${p.stamp}).` : `The stamp that names its writer: ${p.stamp} (it says smurg ${p.writtenBy}).`,
  // insecure, by cause
  'host.insecure.mode': (p: { path: string; mode: string; count: number }) =>
    `${stateFiles(p.count, 'is', 'are')} open to other users of this computer${p.count === 1 ? '' : '; the first'} (mode ${p.mode}): ${p.path}`,
  'host.insecure.mode.hint': (p: { count: number; command: string }) =>
    `Until now, other users of this computer could read or change ${plural(p.count, 'it', 'them')} (a workspace's state holds the daemon's key and the keys of its invite links). ` +
    `Make ${plural(p.count, 'it', 'them')} yours alone, then run smurg host again:\n  ${p.command}`,
  'host.insecure.owner': (p: { path: string; count: number; owner?: string }) =>
    `${stateFiles(p.count, 'belongs', 'belong')} to another user, not to you${p.count === 1 ? '' : '; the first'}${p.owner === undefined ? '' : ` (${p.owner})`}: ${p.path}`,
  'host.owner.root': () => 'root',
  'host.owner.uid': (p: { uid: number }) => `user ID ${p.uid}`,
  'host.insecure.owner.hint': (p: { count: number }) =>
    `smurg uses only state files that belong to you, and chmod does not change who owns a file. If you ever ran smurg with sudo, that is where ${plural(p.count, 'it comes', 'they come')} from. ` +
    `The owner or an administrator of this computer gives ${plural(p.count, 'it', 'them')} back to you (chown); then run smurg host again.`,
  'host.insecure.symlink': (p: { path: string; count: number }) =>
    `${stateFiles(p.count, 'is a symbolic link', 'are symbolic links')}, and smurg follows no link in its state folder${p.count === 1 ? '' : '; the first'}: ${p.path}`,
  'host.insecure.symlink.hint': () => 'smurg host starts when the file itself is in that place: a regular file that belongs to you, mode 600.',
  'host.insecure.notFile': (p: { path: string; count: number; found: string }) =>
    p.count === 1
      ? `Where a file of this workspace's state belongs there is ${p.found}: ${p.path}`
      : `In ${p.count} places where files of this workspace's state belong there is something else; in the first, ${p.found}: ${p.path}`,
  'host.found.directory': () => 'a folder',
  'host.found.fifo': () => 'a named pipe (FIFO)',
  'host.found.socket': () => 'a socket',
  'host.found.device': () => 'a device',
  'host.found.other': () => 'something that is not a regular file',
  'host.insecure.notFile.hint': () => 'smurg reads only a regular file there. smurg host starts when the file itself is back in that place.',
  // cannot-open: the file is there and the system refused to open or write it
  'host.cannotOpen': (p: { path: string; count: number; reason: string }) =>
    `${stateFiles(p.count, 'could not be opened or written', 'could not be opened or written')}${p.count === 1 ? '' : '; the first'} (${p.reason}): ${p.path}`,
  'host.cannotOpen.reason': (p: { code: string }) => (p.code === 'unknown' ? 'the system gave no reason' : ERRNO_WORDS[p.code] === undefined ? p.code : `${ERRNO_WORDS[p.code]}, ${p.code}`),
  'host.cannotOpen.unchanged': () => 'smurg host did not start, and nothing in the workspace was changed or reset: its members, invite links, keys and settings are as they were.',
  'host.cannotOpen.owner': (p: { owner: string }) =>
    `The file belongs to another user (${p.owner}). If you ever ran smurg with sudo, that is where it comes from: the owner or an administrator of this computer gives it back to you (chown).`,
  'host.cannotOpen.hint': () => 'When the file can be opened and written again, run smurg host again.',
  // other-workspace
  'host.otherWorkspace': (p: { path: string; workspaceId: string }) => `The state file in the folder of workspace ${p.workspaceId} names another workspace: ${p.path}`,
  'host.otherWorkspace.hint': () =>
    "The folder was copied from another workspace's, or mixed up with it. smurg does not use it, and no command repairs this: put this workspace's own folder back in its place.",
  // unreadable, by reason
  'host.unreadable.notJson': (p: { path: string }) => `A file of this workspace's state is damaged: it is not valid JSON (it may be empty or cut off): ${p.path}`,
  'host.unreadable.shape': (p: { path: string; current: string }) => `A file of this workspace's state is not in a form that smurg ${p.current} or an earlier published smurg wrote: ${p.path}`,
  'host.unreadable.missingState': (p: { path: string }) => `The state file of this workspace is not there, although other files of the workspace are: ${p.path}`,
  'host.unreadable.missingKey': (p: { path: string }) => `The daemon's key of this workspace is not there, although its state file is: ${p.path}`,
  'host.unreadable.carried': (p: { path: string; current: string }) => `A state file that an earlier smurg wrote holds a value that smurg ${p.current} does not accept: ${p.path}`,
  'host.unreadable.problems': (p: { problems: readonly string[]; more: number }) => `What does not fit: ${p.problems.join('; ')}${p.more > 0 ? `; and ${p.more} more` : ''}`,
  'host.unreadable.missing.unchanged': () => 'Nothing was changed, and smurg made no new file in its place. If the file was moved or renamed by hand, put it back.',
  'host.unreadable.maybeNewer': () => 'First: if a newer smurg was ever used on this computer, run smurg update, then smurg host again.',
  'host.unreadable.writerNewer': (p: { writtenBy: string }) => `First: this folder was last written by smurg ${p.writtenBy}, which is newer than this one. Run smurg update, then smurg host again.`,
  'host.unreadable.copy.state': (p: { name: string; date: string }) =>
    'smurg kept a copy of this file as it was before an upgrade, for reading what the workspace held. Putting it back undoes everything decided since then: ' +
    'people removed since are members again, revoked devices and revoked or used-up invite links work again, and role changes are gone; ' +
    `whoever joined since is no longer a member, and invite links made since no longer work. The newest copy: ${p.name}, kept ${p.date}.`,
  'host.unreadable.copy.other': (p: { name: string; date: string }) =>
    `smurg kept a copy of this file as it was before an upgrade, for reading what it held. Putting it back replaces everything recorded in this file since then. The newest copy: ${p.name}, kept ${p.date}.`,
  // A file the host can set aside alone (the daemon says which): named BEFORE the last resort, which is then not printed.
  'host.setAside': (p: { document: SetAsideDocument }) =>
    `This one file can be set aside without losing the workspace: its members, invite links, settings and daemon key stay. ${SET_ASIDE[p.document]}`,
  'host.setAside.command': (p: { command: string }) => `To do that, move the file aside and run smurg host again (smurg makes a new, empty one in its place):\n  ${p.command}`,
  'host.unreadable.lastResort': () =>
    "The last resort is a new workspace. It costs: this workspace's members and invite links (your teammates join again with a new link), its topics, conversations and audit log, " +
    'and the daemon\'s key (teammates who joined before will see "The host computer\'s key has changed": tell them the new key fingerprint that smurg status shows through another channel, in person or by phone); ' +
    "and smurg no longer knows the worktrees it kept (their folders stay in the shared folder's .smurg/worktrees, with work that is not merged).",
  'host.unreadable.lastResort.command': (p: { command: string }) => `If you accept that, move this workspace's folder away and run smurg host again:\n  ${p.command}`,
  // ---- the folder's own entry in workspaces.json that this smurg cannot read: never a new workspace for the folder
  'host.entryUnread': (p: { place: number; path: string; current: string }) =>
    `This folder's entry in the workspace list (workspaces.json) is not in a form this smurg can read (this is ${p.current}): entry ${p.place} of "shared" in ${p.path}`,
  'host.entryUnread.fields': (p: { fields: readonly string[] }) => `What this smurg cannot read in the entry: ${p.fields.join(', ')}`,
  'host.entryUnread.unchanged': () =>
    'Nothing was changed, and smurg host did not start: the entry is the only link from this folder to its workspace, and without it smurg host would give the folder a new workspace (new members, new invite links, a new daemon key).',
  'host.entryUnread.next': (p: { workspacesDir: string }) =>
    'If a newer smurg was ever used on this computer, run smurg update, then smurg host again. Otherwise repair the entry or put a copy of the file back: ' +
    `an entry holds "folder" (the folder's full path), "relay" (the relay's URL), "workspaceId" (the name of the workspace's folder in ${p.workspacesDir}) and "createdAt" (a whole number).`,
  // ---- what a start found (one line each): an upgrade, an older file put back, a folder set aside, a refused peer
  'host.upgraded': (p: { from?: string }) =>
    `This workspace was last shared with ${p.from === undefined ? 'an earlier smurg' : `smurg ${p.from}`}: its members, invite links and settings were carried over. What changed: ${GUIDE_KEPT}`,
  'host.putBack.state': (p: { names: readonly string[] }) =>
    `Warning: an OLDER ${p.names.join(', ')} was put back into this workspace and upgraded again. Everything decided since it was written is undone: ` +
    'people removed since are members again, revoked devices and revoked or used-up invite links work again, and role changes are gone; ' +
    `whoever joined since is no longer a member, and invite links made since no longer work. Guide: ${GUIDE_KEPT}`,
  'host.putBack.other': (p: { names: readonly string[] }) =>
    `Warning: an OLDER ${p.names.join(', ')} was put back into this workspace and upgraded again: what it holds replaces everything recorded there since. Guide: ${GUIDE_KEPT}`,
  'host.oldFolder': (p: { path: string; more: number }) =>
    `An earlier state folder of this workspace lies beside the one in use: ${p.path}${p.more > 0 ? ` (and ${p.more} more)` : ''}. smurg does not use it. ` +
    `If you moved it away because smurg 0.5.0 told you to after an update, it still holds the members, invite links and daemon key you had before, and the guide says how to go back to it: ${GUIDE_GOING_BACK}`,
  'host.peer.newer': () => "\nWarning: a teammate's page or smurg is newer than this smurg and was turned away. Stop sharing, run smurg update, then share again.",
  'host.peer.older': () => "\nA teammate's page or smurg is older than this smurg and was turned away. That teammate reloads the page or updates smurg; if you run your own relay, deploy it again.",
  'host.alreadyRunning': () => 'A smurg host is already running for this workspace',
  'host.alreadyShared': () => 'This folder is already being shared',
  'host.alreadyShared.hint': () => 'Look with smurg status, or stop it with smurg stop.',
  'host.otherVersion': (p: { current: string; why: UnreadableHost }) =>
    `This folder is already being shared, by a smurg host of another version (this smurg is ${p.current}): ${UNREADABLE_HOST[p.why]}`,
  'host.controlSocket': () => "Could not create the daemon's control socket",
  'host.seeLog': (p: { logPath: string }) => `The log has the details: ${p.logPath}`,
  'host.daemonFailed': (p: { name: string }) => `The daemon could not start (${p.name})`,
  'host.role.host': () => 'An invite link cannot have the Host role (host)',
  'host.role.host.hint': () => 'The roles are: agent, editor, viewer.',
  'host.role.unknown': (p: { role: string }) => `Unknown role "${p.role}"`,
  'host.role.unknown.hint': () => 'The roles are: agent (Agent access), editor (Editor), viewer (Viewer).',
  'host.name.invalid': () => '--name must be 1 to 80 characters without control characters',
  'host.expires.unreadable': (p: { text: string }) => `--expires: "${p.text}" is not a duration`,
  'host.expires.unreadable.hint': () => 'Write a number and a unit, for example 30m, 12h, 7d, 2w (s seconds, m minutes, h hours, d days, w weeks).',
  'host.expires.range': () => '--expires must be between 1 minute and 365 days',
  'host.maxUses.notInteger': (p: { text: string }) => `--max-uses must be a positive whole number (it is "${p.text}")`,
  'host.maxUses.range': (p: { min: number; max: number }) => `--max-uses must be between ${p.min} and ${p.max}`,
  'host.workspaceTaken': (p: { workspaceId: string }) => `Workspace ID ${p.workspaceId} is used by another account on the relay`,
  'host.workspaceTaken.hint': (p: { name: string; userId: string }) => `This folder was shared with another account before; you are logged in as ${p.name} (${p.userId}).`,
  'host.native': (p: { reason: string }) => `The native modules built into the smurg executable cannot be used (${p.reason})`,
  'host.native.hint': () => 'Check that the cache folder can be written (SMURG_CACHE_DIR sets it), or download smurg again.',
  'host.stopping.wait': () => 'Stopping the share (ending terminals and agents, cleaning up temporary folders); one moment...',
  'host.stopping.again': () => '\nInterrupted again; leaving now (the daemon may not have stopped completely).',
  'host.stopping.signal': (p: { signal: string }) => `\nReceived ${p.signal}; stopping the share...`,
  'host.stopping.control': () => '\nAsked to stop (smurg stop); stopping the share...',
  'host.inviteFailed': () => 'Could not create the invite link',
  'host.noHostMember': () => "The host's member record was not found; could not create the invite link",
  'host.keepAwake.notice': (p: { state: string }) => `\nWarning: keep-awake: ${p.state}. While the computer sleeps, your teammates see "Host offline".`,
  'host.keepAwake.lost': (p: { state: string }) => `\nWarning: keep-awake was lost: ${p.state}. While the computer sleeps, your teammates see "Host offline".`,
  'host.stopped': () => 'Stopped sharing.',
  'host.agentsPaused': (p: { count: number }) =>
    `${p.count} agent ${plural(p.count, 'session is', 'sessions are')} paused. ${plural(p.count, 'It continues', 'They continue')} when you share this folder again.`,
  'host.overlap.same': () => 'This folder is already being shared',
  'host.overlap.ancestor': (p: { folder: string }) => `A folder above this one (${p.folder}) is already being shared`,
  'host.overlap.inside': (p: { folder: string }) => `${p.folder} inside this folder is already being shared`,
  'host.overlap.hint': (p: { workspaceId: string; relay: string }) =>
    `One smurg host at a time can share the same files (workspace ${p.workspaceId}, relay ${p.relay}). Look with smurg status, or stop it first with smurg stop --workspace ${p.workspaceId}.`,
  'host.overlap.otherVersion.hint': (p: { workspaceId: string; current: string }) =>
    `It is workspace ${p.workspaceId}, shared by a smurg host of another version (this smurg is ${p.current}).\n  ` +
    `Stop it first: smurg stop --workspace ${p.workspaceId}, or Ctrl-C in the terminal that runs smurg host.`,
  'host.relay.back': () => 'Reconnected to the relay; your teammates can connect again.',
  'host.relay.authRejected': (p: { origin: string }) =>
    `\nWarning: the relay refused this computer's login (it expired or is no longer valid); your teammates cannot connect right now.\n  Run smurg login --relay ${p.origin} in another terminal; smurg host picks up the new login and reconnects by itself, and you do not have to share again.`,
  'host.relay.down': () => '\nWarning: the connection to the relay was lost; your teammates cannot connect for now. Reconnecting...',
  'host.state.unsaved': () =>
    "\nWarning: smurg's state file could not be written (is the disk full, or a permission missing?). Recent changes (removing a member, changing a role, revoking an invite) are in force now, " +
    'but they are lost after a restart if you stop sharing before a write succeeds; smurg keeps trying.',
  'host.state.saved': () => "smurg's state file was written again.",
  'host.login.otherAccount': (p: { origin: string; name: string }) =>
    `\nWarning: the new login for ${p.origin} is another account (${p.name}); this workspace belongs to the original account, so smurg host does not use it.`,
  'host.login.renewed': () => 'Now using the new relay login.',
  'host.login.expiring': (p: { time: string; origin: string }) =>
    `\nWarning: the relay login expires at ${p.time}; after that your teammates cannot connect. Run smurg login --relay ${p.origin} in another terminal; smurg host picks up the new login by itself.`,
  'host.invite.heading': (p: { amount: number; unit: DurationUnit; maxUses?: number; role?: string }) =>
    `Link for your teammates (send it to them privately; valid for ${duration(p.amount, p.unit)}${p.maxUses === undefined ? '' : `; ${p.maxUses} ${plural(p.maxUses, 'use', 'uses')}`}${p.role === undefined ? '' : `; role: ${p.role}`}):`,
  'host.summary': (p: { name: string; hostUrl?: string; inviteHeading: string; inviteUrl: string }) =>
    ['', `smurg is sharing "${p.name}"`, '', 'Your link (for you only):', `  ${p.hostUrl ?? '(could not be created)'}`, '', p.inviteHeading, `  ${p.inviteUrl}`, '', 'Press Ctrl-C to stop sharing.'].join('\n'),
  'host.update.notice': (p: { latest: string; current: string }) => `Version ${p.latest} is available (this is ${p.current}): stop sharing, then run smurg update`,

  // ---- keep-awake
  'power.on': (p: { mechanism: string }) => `on (${p.mechanism})`,
  'power.off.disabled': () => 'off (turned off with --no-keep-awake)',
  'power.off.notStarted': () => 'off (not started yet)',
  'power.off.stopped': () => 'off (stopped)',
  'power.off.noSystemdInhibit': () => 'off (systemd-inhibit was not found)',
  'power.off.startFailed': () => 'off (the keep-awake program could not be started)',
  'power.off.exited': () => 'off (the keep-awake program has ended)',
  'power.off.refused': () =>
    'off (the system (polkit) does not allow blocking sleep, as Ubuntu does by default for an SSH login; log in at this computer\'s desktop and run smurg host there, or ask the administrator to allow it)',
  'power.off.unsupported': () => 'off (this operating system is not supported)',
  'power.off.unknown': () => 'off (reason unknown)',

  // ---- stop / status
  'usage.stop': () => `Usage: smurg stop [--workspace ID]

  Stop sharing: disconnect everyone and end every terminal session. Agent sessions are paused: their agents stop,
  their conversations are kept, and they continue when you share the folder again.
  Without a workspace, stops the one shared from the current folder, or the only one being shared.
`,
  'usage.status': () => `Usage: smurg status [--workspace ID]

  Show the workspaces being shared: the folder, the relay and its connections, the daemon key fingerprint,
  keep-awake, the settings of smurg host, Claude Code and the agent sessions, and where the log is.
  What each line means: https://smurg.ai/docs/hosting/#7-status-and-stopping

  Exit code: 0 when every share is shown; 3 when nothing is being shared; 5 when a smurg host of another
  version is sharing (this smurg cannot read its answer: stop it and start it again).
`,
  'stop.refused': (p: { reason: string }) => `smurg host refused to stop: ${p.reason}`,
  'stop.timeout': (p: { seconds: number }) => `smurg host did not stop within ${duration(p.seconds, 'second')}`,
  'stop.timeout.hint': () => 'Look at the terminal that runs smurg host.',
  'stop.stopping': (p: { workspaceId: string }) => `Stopping the share of workspace ${p.workspaceId}...`,
  'stop.otherVersion.asking': (p: { current: string; workspaceId?: string }) =>
    `A smurg host of another version is sharing ${p.workspaceId === undefined ? 'here' : `workspace ${p.workspaceId}`} (this smurg is ${p.current}); asking it to stop...`,
  'stop.otherVersion.failed': (p: { seconds: number }) => `The smurg host of another version did not stop within ${duration(p.seconds, 'second')}`,
  'stop.otherVersion.failed.hint': () => 'Press Ctrl-C in the terminal that runs smurg host.',
  'status.relay.online': () => 'connected',
  'status.relay.connecting': () => 'connecting',
  'status.relay.waiting': () => 'waiting to reconnect',
  'status.relay.authRejected': () => "the relay refused the host's login (run smurg login to log in again)",
  'status.relay.replaced': () => 'replaced by another host connection',
  'status.relay.stopped': () => 'stopped',
  'status.relay.none': () => 'not used',
  'status.none': () => 'No workspace is being shared.',
  'status.noneFor': (p: { workspaceId: string }) => `No smurg host is running for workspace ${p.workspaceId}.`,
  'status.otherVersion': (p: { current: string; why: UnreadableHost; socket: string; workspaceId?: string; folder?: string }) =>
    [
      p.workspaceId === undefined ? `A workspace (control socket ${p.socket})` : `Workspace ${p.workspaceId}`,
      ...(p.folder === undefined ? [] : [`  Folder: ${p.folder}`]),
      `  A smurg host of another version is sharing it (this smurg is ${p.current}): ${UNREADABLE_HOST[p.why]}.`,
      `  To stop it: smurg stop${p.workspaceId === undefined ? '' : ` --workspace ${p.workspaceId}`}, or Ctrl-C in the terminal that runs smurg host. To use this smurg, start it again with smurg host.`,
    ].join('\n'),
  'status.bookUnreadable': (p: { problem: string; hint?: string }) => `Note: ${p.problem}${p.hint === undefined ? '' : `\n  ${p.hint}`}`,
  'status.workspace': (p: {
    workspaceId: string;
    stopping: boolean;
    folder?: string;
    relay?: string;
    builtIn: boolean;
    interactive: string;
    transfer: string;
    connections: number;
    onlineMembers: number;
    fingerprint?: string;
    power: string;
    bashAttribution?: boolean;
    claude: string;
    agents?: string;
    topics?: string;
    projectSettings?: string;
    hostRules?: string;
    logPath: string;
    pid?: string;
  }) =>
    [
      `Workspace ${p.workspaceId}${p.stopping ? ' (stopping)' : ''}`,
      ...(p.folder === undefined ? [] : [`  Folder: ${p.folder}`]),
      `  Relay: ${p.relay === undefined ? '' : `${p.relay}${p.builtIn ? " (smurg's built-in public relay)" : ''}, `}interactive connection ${p.interactive}, file transfer ${p.transfer}`,
      `  Connections: ${p.connections}, members online: ${p.onlineMembers}`,
      ...(p.fingerprint === undefined ? [] : [`  Daemon key fingerprint: ${p.fingerprint}`]),
      `  Keep-awake: ${p.power}`,
      ...(p.bashAttribution === undefined ? [] : [`  Notices of agents' shell commands: ${p.bashAttribution ? 'on' : 'off (--no-bash-attribution)'}`]),
      `  Claude Code: ${p.claude}`,
      ...(p.agents === undefined ? [] : [`  Agent sessions: ${p.agents}`]),
      ...(p.topics === undefined ? [] : [`  Topics: ${p.topics}`]),
      ...(p.projectSettings === undefined ? [] : [`  Claude Code project settings: ${p.projectSettings}`]),
      ...(p.hostRules === undefined ? [] : [`  Your own Claude Code allow rules: ${p.hostRules}`]),
      `  Log: ${p.logPath}`,
      ...(p.pid === undefined ? [] : [`  Daemon process: ${p.pid}`]),
    ].join('\n'),
  'status.claude': (p: { version?: string; verdict: ClaudeVerdict; login: ClaudeLogin }) =>
    `${p.version === undefined ? 'version unknown' : p.version} (${CLAUDE_VERDICT[p.verdict]}), ${CLAUDE_LOGIN[p.login]}`,
  'status.claude.notChecked': () => 'not checked yet (smurg checks it when the first agent session starts)',
  'status.agents': (p: { running: number; waiting: number; stalled: number; idle: number }) =>
    p.running + p.waiting + p.stalled + p.idle === 0
      ? 'none'
      : `${p.running} running, ${p.waiting} waiting for a person, ${p.stalled} stopped without a report or failed, ${p.idle} idle`,
  'status.topics': (p: { total: number; paused: number }) => (p.total === 0 ? 'none' : `${p.total} (${p.paused} paused)`),
  'status.projectSettings': (p: { trust: ProjectSettings }) => PROJECT_SETTINGS[p.trust],
  'status.hostRules': (p: { count: number }) =>
    p.count === 0 ? 'none apply to agent sessions' : `${p.count} ${plural(p.count, 'applies', 'apply')} to agent sessions (agents run what ${plural(p.count, 'it allows', 'they allow')} without asking)`,

  // ---- licenses
  'usage.licenses': () => `Usage: smurg licenses [--third-party]

  Show smurg's license (LICENSE: MIT) and the licenses and notices of the third-party software inside the smurg
  executable (THIRD-PARTY-NOTICES).
  The license on the web: https://smurg.ai/license/
  The source code: https://smurg.ai/github
  --third-party       show only the third-party licenses and notices
`,
  'licenses.missing': () => 'This smurg executable has no license files inside',
  'licenses.missing.hint': (p: { install: string }) => `Install smurg again: ${p.install}`,

  // ---- downloads (update, and the notice of smurg host)
  'downloads.notUrl': (p: { text: string }) => `The download location is not a URL: ${p.text}`,
  'downloads.notUrl.hint': (p: { env: string; default: string }) => `${p.env} must be an https URL (default ${p.default}).`,
  'downloads.notHttps': (p: { text: string }) => `The download location must be an https URL: ${p.text}`,
  'downloads.notHttps.hint': (p: { env: string }) => `${p.env} accepts only https (http, for tests, only on 127.0.0.1 and localhost).`,
  'downloads.badCharacters': (p: { text: string }) => `The download location has characters that are not allowed: ${p.text}`,

  // ---- update
  'usage.update': (p: { downloads: string }) => `Usage: smurg update [--check]

  Update smurg to the latest version: downloads this computer's executable from ${p.downloads}
  and replaces the current one only when its sha256 matches that version's SHA256SUMS. When this is already the
  latest version nothing happens, and smurg is never replaced by an older version.
  It does not update while you share: run smurg stop first.
  --check             only check for a new version; download and change nothing

  Changelog: https://smurg.ai/docs/changelog/
  Guide: https://smurg.ai/docs/hosting/#9-updating-and-removing
`,
  'update.timeout': (p: { url: string }) => `The download location took too long to answer: ${p.url}`,
  'update.unchanged.checkNetwork': () => `${UNCHANGED} Check your network connection and run the command again.`,
  'update.http': (p: { status: string; url: string }) => `The download location does not have this file (HTTP ${p.status}): ${p.url}`,
  'update.unchanged': () => UNCHANGED,
  'update.redirect': (p: { url: string }) => `The download location redirected to a URL that is not allowed: ${p.url}`,
  'update.redirect.hint': () => `${UNCHANGED} Only https is accepted (and http on this computer, for tests).`,
  'update.incomplete': (p: { url: string }) => `The download is incomplete (the connection dropped, or the size differs from what the server said): ${p.url}`,
  'update.unchanged.again': () => `${UNCHANGED} Run the command again.`,
  'update.unexpectedContent': (p: { url: string }) => `The download location answered with something that is not in the expected format: ${p.url}`,
  'update.unreachable': (p: { url: string }) => `Cannot reach the download location: ${p.url}`,
  'update.failed': (p: { code: string }) => `The update failed (${p.code})`,
  'update.progress.unknown': (p: { received: string }) => `${p.received} MB`,
  'update.progress': (p: { percent: number; received: string; total: string }) => `${p.percent}% (${p.received} / ${p.total} MB)`,
  'update.tempCreate': (p: { dir: string; code: string }) => `Could not create a temporary file in ${p.dir} (${p.code})`,
  'update.tempWrite': (p: { temp: string; code: string }) => `Could not write the temporary file ${p.temp} (${p.code})`,
  'update.tempWrite.hint': () => `${UNCHANGED} Is there enough disk space?`,
  'update.sha256': (p: { name: string; expected: string; actual: string }) =>
    `The sha256 of ${p.name} does not match (expected ${p.expected}, got ${p.actual}): the file may have been tampered with, or the download is incomplete`,
  'update.wrongBuild.none': (p: { name: string; version: string }) => `The downloaded ${p.name} is not the executable of smurg ${p.version} (it has no version marker)`,
  'update.wrongBuild': (p: { name: string; version: string; markers: readonly string[] }) =>
    `The downloaded ${p.name} is not the executable of smurg ${p.version} (its version marker says ${p.markers.join(', ')})`,
  'update.quarantine': (p: { file: string; attribute: string }) => `Could not remove the ${p.attribute} attribute of ${p.file}`,
  'update.cannotRun': (p: { version: string }) => `The downloaded smurg ${p.version} does not run on this computer`,
  'update.cannotRun.hint': (p: { detail: string }) => `${UNCHANGED} It said: ${p.detail}`,
  'update.wrongVersion': (p: { version: string; reported: string }) => `The downloaded executable does not report version ${p.version} (${p.reported})`,
  'update.fromSource': () => 'This smurg runs from source, not as the installed single executable; smurg update cannot update it',
  'update.fromSource.hint': (p: { install: string }) => `Get the new source with git, then run pnpm install. To install the single executable: ${p.install}`,
  'update.versionFormat': (p: { current: string }) => `This smurg's version (${p.current}) is not in the format of a released version, so it cannot be compared with the latest one`,
  'update.reinstall.hint': (p: { install: string }) => `Install it again: ${p.install}`,
  'update.noTarget': (p: { platform: string }) => `smurg has no executable for this platform (${p.platform})`,
  'update.latest': (p: { current: string }) => `smurg ${p.current} is the latest version.`,
  'update.newer': (p: { current: string; latest: string }) => `This smurg (${p.current}) is newer than the latest published version (${p.latest}); it is not replaced by an older one.`,
  'update.available': (p: { latest: string; current: string }) => `Version ${p.latest} is available (this is ${p.current}). Run smurg update to update.\nChangelog: https://smurg.ai/docs/changelog/`,
  'update.sharing': (p: { ids: readonly string[] }) => `This computer is sharing a workspace (${p.ids.join(', ')}); nothing was updated`,
  'update.sharing.hint': (p: { latest: string; current: string; several: boolean }) =>
    `Version ${p.latest} is available (this is ${p.current}). Run smurg stop first${p.several ? ' (once per workspace: smurg stop --workspace <ID>)' : ''}, then smurg update.\n  ` +
    'An update while you share would mix the old daemon that is still running with the new smurg commands.',
  'update.noExecutable': (p: { executable: string }) => `The current executable was not found: ${p.executable}`,
  'update.notWritable': (p: { dir: string }) => `Cannot write to the folder smurg is in: ${p.dir}`,
  'update.notWritable.hint': (p: { executable: string; install: string }) =>
    `smurg update replaces ${p.executable} inside the same folder. Update it the way it was installed, or run the installer again (it installs into ~/.local/bin): ${p.install}`,
  'update.notInSums': (p: { latest: string; name: string }) => `The SHA256SUMS of smurg ${p.latest} does not list ${p.name} (this version has no executable for this platform)`,
  'update.downloading': (p: { latest: string; name: string; from: string }) => `Downloading smurg ${p.latest} (${p.name}, ${p.from})...`,
  'update.startedSharing': (p: { ids: readonly string[] }) => `A workspace started being shared during the download (${p.ids.join(', ')}); nothing was updated`,
  'update.startedSharing.hint': () => 'Run smurg stop first, then smurg update again.',
  'update.otherVersion': (p: { labels: readonly string[]; current: string }) =>
    `A smurg host of another version is sharing on this computer (${p.labels.join(', ')}; this smurg is ${p.current}); nothing was updated`,
  'update.otherVersion.hint': () =>
    'Stop it first (smurg stop, or Ctrl-C in the terminal that runs smurg host), then run smurg update again.\n  ' +
    'An update while it shares would mix the daemon that is still running with the new smurg commands.',
  'update.replaceFailed': (p: { executable: string; code: string }) => `Could not replace ${p.executable} (${p.code})`,
  'update.done': (p: { current: string; latest: string; executable: string }) => `Updated smurg: ${p.current} -> ${p.latest} (${p.executable})`,
  'update.quarantineRemoved': (p: { attribute: string }) => `Removed the ${p.attribute} attribute of the downloaded file (after its sha256 matched)`,
  'update.changelog': () => 'Changelog: https://smurg.ai/docs/changelog/',
  'update.cancelled.check': () => '\nCancelled.',
  'update.cancelled': () => `\nCancelled; ${UNCHANGED}`,

  // ---- uninstall
  'usage.uninstall': () => `Usage: smurg uninstall [--keep-data] [--yes]

  Remove smurg from this computer: the executable itself, the cache (the native modules the executable unpacked)
  and the state folder ~/.smurg (logins, the device key, every workspace's keys, members and invite links, the
  conversations of agent sessions, the logs). It lists the paths it will remove first and acts only after you
  confirm; workspaces being shared are stopped first (as smurg stop does).
  The .smurg/ folders inside project folders (worktrees and changes that are not merged yet) are not touched; they
  are only listed, for you to decide.
  --keep-data         keep the state folder; remove only the executable and the cache
  --yes               do not ask, remove right away (required when not run in a terminal)

  Guide: https://smurg.ai/docs/hosting/#9-updating-and-removing
`,
  'uninstall.size.bytes': (p: { bytes: number }) => ` (${p.bytes} B)`,
  'uninstall.size.kb': (p: { kb: number }) => ` (${p.kb} KB)`,
  'uninstall.size.mb': (p: { mb: string }) => ` (${p.mb} MB)`,
  'uninstall.refusal.hint': (p: { stateDir: string }) =>
    `Nothing was removed. To remove only the executable and the cache: smurg uninstall --keep-data; check what is in the state folder (${p.stateDir}) and delete it yourself, or set SMURG_HOME back to smurg's state folder and run the command again.`,
  'uninstall.what.state': () => "state folder: logins, the device key, every workspace's keys, members and invite links, the conversations of agent sessions, the logs",
  'uninstall.what.stateSymlink': () =>
    "state folder: logins, the device key, every workspace's keys, members and invite links, the conversations of agent sessions, the logs (this is a symlink: only the link itself is removed)",
  'uninstall.what.cache': () => 'cache: the native modules the executable unpacked',
  'uninstall.what.executable': () => 'the executable',
  'uninstall.state.notDirectory': (p: { stateDir: string }) => `smurg's state folder is not a folder: ${p.stateDir}`,
  'uninstall.state.topLevel': (p: { path: string }) => `${p.path} will not be removed: it is not smurg's state folder (SMURG_HOME points at a top-level folder of the system)`,
  'uninstall.state.isHome': (p: { path: string }) => `${p.path} will not be removed: it is your home folder (is SMURG_HOME set wrong?)`,
  'uninstall.state.containsHome': (p: { path: string }) => `${p.path} will not be removed: your home folder is inside it (is SMURG_HOME set wrong?)`,
  'uninstall.state.containsHomes': (p: { path: string }) => `${p.path} will not be removed: users' home folders are inside it (is SMURG_HOME set wrong?)`,
  'uninstall.state.foreign': (p: { path: string; names: readonly string[]; total: number }) =>
    `${p.path} will not be removed: it holds things smurg did not create (${p.names.join(', ')}${p.total > p.names.length ? `... ${p.total} in all` : ''})`,
  'uninstall.changed': (p: { path: string }) => `${p.path} was replaced by something else after you confirmed; it was not removed`,
  'uninstall.fromSource': () => 'This smurg runs from source; there is no installed executable to remove',
  'uninstall.fromSource.hint': (p: { stateDir: string; cacheRoots: readonly string[] }) =>
    `To remove it, delete these yourself: the source folder, the state folder ${p.stateDir} (logins, keys, workspace state, logs) and the cache ${p.cacheRoots.join(', ')}.\n  ` +
    'Delete the .smurg/ folders inside project folders you shared (the worktrees are there) only when you are sure you no longer need them.',
  'uninstall.noExecutable': (p: { executable: string }) => `The smurg executable was not found: ${p.executable}`,
  'uninstall.notWritable': (p: { executable: string; dir: string }) => `Cannot remove ${p.executable}: no permission to write to ${p.dir}`,
  'uninstall.notWritable.hint': () => 'Nothing was removed. Delete the file with the account that installed it (or as the administrator).',
  'uninstall.plan.heading': () => 'smurg uninstall will remove:',
  'uninstall.plan.item': (p: { path: string; size: string; what: string }) => `  ${p.path}${p.size}  ${p.what}`,
  'uninstall.plan.stateNote': () =>
    '  After the state folder is removed, the members and invite links of the workspaces you shared stop working, and this computer has to join the workspaces it joined again with an invite link.',
  'uninstall.plan.stops': (p: { ids: readonly string[] }) =>
    `Workspaces being shared are stopped first (as smurg stop does: everyone is disconnected, terminal sessions end and agents stop): ${p.ids.join(', ')}`,
  'uninstall.kept.heading': () => 'Not touched:',
  'uninstall.kept.state': (p: { stateDir: string }) => `  ${p.stateDir}  the state folder (--keep-data)`,
  'uninstall.kept.linkTarget': (p: { target: string }) => `  ${p.target}  the folder the state folder's symlink points to`,
  'uninstall.kept.project': (p: { path: string }) => `  ${p.path}  smurg's data inside a project folder (worktrees and changes that are not merged yet are here)`,
  'uninstall.noTerminal': () => 'Not run in a terminal, so smurg cannot ask; nothing was removed',
  'uninstall.noTerminal.hint': () => 'To remove it, run the command again with --yes.',
  'uninstall.question': () => 'Remove these? [y/N] ',
  'uninstall.cancelled': () => 'Cancelled; nothing was removed.',
  'uninstall.removeFailed': (p: { path: string; code: string }) => `Could not remove ${p.path} (${p.code})`,
  'uninstall.removeFailed.hint': (p: { removed: readonly string[]; rest: readonly string[] }) =>
    `${p.removed.length > 0 ? `Removed: ${p.removed.join(', ')}. ` : ''}Not removed yet: ${p.rest.join(', ')}. Fix the problem and run smurg uninstall again, or delete them yourself.`,
  'uninstall.left.path': (p: { dir: string }) =>
    `  PATH in your shell profile: the installer only suggested adding export PATH="${p.dir}:$PATH", and smurg never changed your profile; if you added that line, remove it yourself`,
  'uninstall.done': (p: { removed: readonly string[]; left: readonly string[]; install: string }) =>
    ['', 'Removed:', ...p.removed.map((path) => `  ${path}`), '', 'Still there:', ...p.left, '', `smurg was removed from this computer. To install it again: ${p.install}`].join('\n'),
  'uninstall.stopFailed': (p: { workspaceId: string; reason?: string }) =>
    `Could not stop the share of workspace ${p.workspaceId}${p.reason === undefined ? '' : ` (${p.reason})`}; nothing was removed`,
  'uninstall.stopFailed.hint': () => 'Press Ctrl-C in the terminal that runs smurg host to stop sharing, then run smurg uninstall again.',
  'uninstall.otherVersion': (p: { labels: readonly string[] }) => `A smurg host of another version is sharing on this computer (${p.labels.join(', ')}); nothing was removed`,
  'uninstall.otherVersion.hint': () => 'Stop it first (smurg stop, or Ctrl-C in the terminal that runs smurg host), then run smurg uninstall again.',
} as const;

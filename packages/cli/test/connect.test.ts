// `smurg connect slack|discord [folder] --channel <id>` and `smurg disconnect slack|discord [folder]` (DESIGN 0.8.0
// D6.2), through the dispatcher with an injected io: the channel id checked by its source's pattern before anything is
// asked, the token read without echo (io.readSecret, never an argument) and checked by its form, never printed, kept in
// ~/.smurg/connectors.json with mode 0600; the workspace is the one `smurg host` shares the folder as; an entry this
// smurg cannot read is kept; disconnect removes the token (and the file once nothing is connected); both languages.
// No request is made to Slack or Discord here (the command makes none), and no test token is a real one.
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/run.ts';
import { loadConnectors } from '../src/state/connectors.ts';
import { statePaths } from '../src/state/paths.ts';
import { rememberSharedFolder } from '../src/state/workspaces.ts';
import { makeDirs, testIo, type Dirs, type TestIo } from './helpers.ts';

// No built-in relay: the workspace is found by the relay given here (no test reaches a real relay; nothing does here).
vi.mock('../src/relay/default-relay.ts', () => ({ DEFAULT_RELAY_URL: null }));

const RELAY = 'http://localhost:8787';
const WORKSPACE = 'ws_connect_aaaaaaaa';
const SLACK_TOKEN = 'xoxb-' + '1111111111111-2222222222222-FakeTokenForTestsOnly';
const DISCORD_TOKEN = 'FAKE0discord0token.for-tests_only.0123456789abcdef';
const NOW = Date.parse('2026-11-12T09:00:00Z');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
});

interface Setup {
  readonly dirs: Dirs;
  readonly env: Record<string, string>;
  /** The shared folder as `smurg host` recorded it (its real path). */
  readonly folder: string;
}

async function setup(): Promise<Setup> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir, SMURG_RELAY_URL: RELAY };
  const folder = await realpath(dirs.project);
  await rememberSharedFolder(statePaths(env), { folder, relay: RELAY, workspaceId: WORKSPACE, createdAt: 1 });
  return { dirs, env, folder };
}

/** One run of the command; `secret`: what the person pastes at the prompt (null: Ctrl-C), recorded with its prompt. */
async function run(s: Setup, argv: readonly string[], options: { readonly secret?: string | null; readonly lang?: 'en' | 'zh-TW'; readonly cwd?: string } = {}): Promise<{ code: number; io: TestIo; prompts: string[] }> {
  const prompts: string[] = [];
  const io = testIo({
    env: { ...s.env, SMURG_LANG: options.lang ?? 'en' },
    cwd: options.cwd ?? s.folder,
    now: () => NOW,
    readSecret: async (prompt) => {
      prompts.push(prompt);
      return options.secret === undefined ? null : options.secret;
    },
  });
  const code = await runCli(argv, io);
  return { code, io, prompts };
}

const connectorsFile = (s: Setup): string => join(s.dirs.stateDir, 'connectors.json');
const stored = async (s: Setup): Promise<unknown> => JSON.parse(await readFile(connectorsFile(s), 'utf8')) as unknown;
const exists = (path: string): Promise<boolean> => lstat(path).then(
  () => true,
  () => false,
);

describe('smurg connect and smurg disconnect (DESIGN 0.8.0 D6.2)', () => {
  it('connects a Slack channel: the token is asked without echo, checked, never printed, and kept in connectors.json with mode 0600 for the folder’s workspace', async () => {
    const s = await setup();
    const { code, io, prompts } = await run(s, ['connect', 'slack', '--channel', 'C0123ABCDE'], { secret: `  ${SLACK_TOKEN}\n` });
    expect(io.err()).toBe('');
    expect(code).toBe(0);
    // The one way the token comes in: the prompt of io.readSecret (no echo at a terminal), never an argument.
    expect(prompts).toEqual(['Bot token of your Slack app (it is not shown): ']);
    expect(io.out()).toBe(
      `Connected the Slack channel C0123ABCDE to ${s.folder}.\n` +
        "While smurg host shares this folder, this computer reads the channel's new messages once a minute; messages of people become feedback on sticky notes (the guide says which are not taken). " +
        'A smurg host that shares it now starts within a few seconds. Guide: https://smurg.ai/docs/hosting/#11-slack-and-discord\n',
    );
    expect(io.out() + io.err()).not.toContain('FakeTokenForTestsOnly');
    expect(await stored(s)).toEqual({ version: 1, workspaces: { [WORKSPACE]: { slack: { token: SLACK_TOKEN, channel: 'C0123ABCDE', connectedAt: NOW } } } });
    expect((await lstat(connectorsFile(s))).mode & 0o777).toBe(0o600);
    expect(await loadConnectors(statePaths(s.env), WORKSPACE)).toEqual({ slack: { token: SLACK_TOKEN, channel: 'C0123ABCDE', connectedAt: NOW } });
    // The folder may be named, in any spelling of the shared folder itself (`<folder>/.` is that folder).
    const named = await run(s, ['connect', 'discord', join(s.folder, '.'), '--channel', '123456789012345678'], { secret: DISCORD_TOKEN });
    expect(named.code).toBe(0);
    expect(await loadConnectors(statePaths(s.env), WORKSPACE)).toEqual({
      slack: { token: SLACK_TOKEN, channel: 'C0123ABCDE', connectedAt: NOW },
      discord: { token: DISCORD_TOKEN, channel: '123456789012345678', connectedAt: NOW },
    });
  });

  it('the token is never an argument: --token is an unknown option, and nothing is asked or written', async () => {
    const s = await setup();
    const { code, io, prompts } = await run(s, ['connect', 'slack', '--channel', 'C0123ABCDE', '--token', SLACK_TOKEN], { secret: SLACK_TOKEN });
    expect(code).toBe(2);
    expect(io.err()).toContain('smurg: Unknown option --token');
    expect(prompts).toEqual([]);
    expect(await exists(connectorsFile(s))).toBe(false);
  });

  it('the channel id is checked by its source’s pattern before the token is asked for: a path, a lower-case id, letters in a Discord id, none at all', async () => {
    const s = await setup();
    const cases: [readonly string[], string, string][] = [
      [['connect', 'slack', '--channel', 'C0123/../x'], 'The --channel value is not a Slack channel id', "A Slack channel id is C or G and then letters and digits (C0123ABCDE): it is at the bottom of the channel's details."],
      [['connect', 'slack', '--channel', 'c0123abcde'], 'The --channel value is not a Slack channel id', 'A Slack channel id is C or G'],
      [['connect', 'slack', '--channel', 'D0123ABCDE'], 'The --channel value is not a Slack channel id', 'A Slack channel id is C or G'],
      [['connect', 'discord', '--channel', '12345678901234567a'], 'The --channel value is not a Discord channel id', 'A Discord channel id is 17 to 20 digits: turn on Developer Mode, then choose Copy Channel ID on the channel.'],
      [['connect', 'discord', '--channel', '1234'], 'The --channel value is not a Discord channel id', 'A Discord channel id is 17 to 20 digits'],
      [['connect', 'discord'], 'Name the channel with --channel <id>', 'A Discord channel id is 17 to 20 digits'],
      [['connect', 'teams', '--channel', 'C0123ABCDE'], 'smurg connects a Slack or a Discord channel, not "teams"', 'Write smurg connect slack or smurg connect discord.'],
      [['connect'], 'Missing argument <slack|discord>', ''],
    ];
    for (const [argv, message, hint] of cases) {
      const { code, io, prompts } = await run(s, argv, { secret: SLACK_TOKEN });
      expect(code, argv.join(' ')).toBe(2);
      expect(io.err(), argv.join(' ')).toContain(`smurg: ${message}`);
      expect(io.err(), argv.join(' ')).toContain(hint);
      expect(prompts, argv.join(' ')).toEqual([]);
    }
    expect(await exists(connectorsFile(s))).toBe(false);
  });

  it('a token of another form, or none, changes nothing: a person’s xoxp- token, a line break inside, Ctrl-C', async () => {
    const s = await setup();
    for (const [source, channel, secret, message] of [
      ['slack', 'C0123ABCDE', 'xoxp-' + '1111111111111-2222222222222-APersonsToken', 'This is not a bot token of Slack; nothing was changed'],
      ['slack', 'C0123ABCDE', 'xoxb-1111 2222', 'This is not a bot token of Slack; nothing was changed'],
      ['discord', '123456789012345678', 'short', 'This is not a bot token of Discord; nothing was changed'],
      ['discord', '123456789012345678', null, 'No token was given; nothing was changed'],
    ] as const) {
      const { code, io } = await run(s, ['connect', source, '--channel', channel], { secret });
      expect(code, String(secret)).toBe(1);
      expect(io.err(), String(secret)).toContain(`smurg: ${message}`);
      if (secret !== null) expect(io.err()).not.toContain(secret);
    }
    expect(await exists(connectorsFile(s))).toBe(false);
  });

  it('a folder this computer does not share is refused before anything is asked (smurg host first); so is one that is not there', async () => {
    const s = await setup();
    const other = await realpath(s.dirs.home);
    const notShared = await run(s, ['connect', 'slack', other, '--channel', 'C0123ABCDE'], { secret: SLACK_TOKEN });
    expect(notShared.code).toBe(1);
    expect(notShared.io.err()).toContain(`smurg: This folder is not shared from this computer yet: ${other}`);
    expect(notShared.io.err()).toContain('Run smurg host <folder> once (with the same --relay), then connect the channel.');
    expect(notShared.prompts).toEqual([]);
    // Shared at another relay: another workspace, so not this one.
    const elsewhere = await run(s, ['connect', 'slack', '--relay', 'http://localhost:9999', '--channel', 'C0123ABCDE'], { secret: SLACK_TOKEN });
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.io.err()).toContain('not shared from this computer yet');
    const gone = await run(s, ['disconnect', 'slack', join(s.folder, 'nope')]);
    expect(gone.code).toBe(2);
    expect(gone.io.err()).toContain('Folder not found');
    expect(await exists(connectorsFile(s))).toBe(false);
  });

  it('a folder below the shared one is not the shared folder: named, or as the working directory, connect and disconnect refuse it before anything is asked, and connectors.json stays as it was', async () => {
    const s = await setup();
    expect((await run(s, ['connect', 'slack', '--channel', 'C0123ABCDE'], { secret: SLACK_TOKEN })).code).toBe(0);
    const before = await readFile(connectorsFile(s), 'utf8');
    const sub = join(s.folder, 'sub');
    await mkdir(sub);
    const cases: [readonly string[], string][] = [
      [['connect', 'slack', sub, '--channel', 'G0999ZZZZZ'], s.folder],
      [['connect', 'slack', 'sub', '--channel', 'G0999ZZZZZ'], s.folder],
      [['connect', 'discord', '--channel', '123456789012345678'], sub],
      [['disconnect', 'slack', sub], s.folder],
      [['disconnect', 'slack'], sub],
    ];
    for (const [argv, cwd] of cases) {
      const { code, io, prompts } = await run(s, argv, { secret: SLACK_TOKEN, cwd });
      const what = `${argv.join(' ')} (in ${cwd})`;
      expect(code, what).toBe(1);
      expect(io.err(), what).toContain(`smurg: This folder is not shared from this computer yet: ${sub}`);
      expect(io.err(), what).toContain('Run smurg host <folder> once (with the same --relay), then connect the channel.');
      expect(io.out(), what).toBe('');
      expect(prompts, what).toEqual([]);
    }
    expect(await readFile(connectorsFile(s), 'utf8')).toBe(before);
  });

  it('connecting again replaces the channel (and says which one is no longer read); disconnect removes the token, the file goes once nothing is connected', async () => {
    const s = await setup();
    expect((await run(s, ['connect', 'slack', '--channel', 'C0123ABCDE'], { secret: SLACK_TOKEN })).code).toBe(0);
    const again = await run(s, ['connect', 'slack', '--channel', 'G0999ZZZZZ'], { secret: SLACK_TOKEN });
    expect(again.code).toBe(0);
    expect(again.io.out()).toContain('It takes the place of the Slack channel C0123ABCDE, which is no longer read.');
    expect((await run(s, ['connect', 'discord', '--channel', '123456789012345678'], { secret: DISCORD_TOKEN })).code).toBe(0);
    const slackGone = await run(s, ['disconnect', 'slack']);
    expect(slackGone.code).toBe(0);
    expect(slackGone.io.out()).toBe(`Disconnected the Slack channel G0999ZZZZZ from ${s.folder}: its token was removed, and a smurg host that shares the folder stops reading it within a few seconds.\n`);
    expect(await stored(s)).toEqual({ version: 1, workspaces: { [WORKSPACE]: { discord: { token: DISCORD_TOKEN, channel: '123456789012345678', connectedAt: NOW } } } });
    expect((await lstat(connectorsFile(s))).mode & 0o777).toBe(0o600);
    expect((await run(s, ['disconnect', 'discord'])).code).toBe(0);
    expect(await exists(connectorsFile(s))).toBe(false);
    const none = await run(s, ['disconnect', 'discord']);
    expect(none.code).toBe(0);
    expect(none.io.out()).toBe(`No Discord channel is connected to ${s.folder}.\n`);
    expect(slackGone.io.out() + none.io.out()).not.toContain('FakeTokenForTestsOnly');
  });

  it('what this smurg cannot read in connectors.json is kept as it is and said once; a file others can read is refused and nothing changes', async () => {
    const s = await setup();
    const kept = { version: 1, workspaces: { ws_other_bbbbbbbb: 'garbage', [WORKSPACE]: { discord: { token: 7 }, teams: { x: 1 } } } };
    await writeFile(connectorsFile(s), `${JSON.stringify(kept)}\n`, { mode: 0o600 });
    const { code, io } = await run(s, ['connect', 'slack', '--channel', 'C0123ABCDE'], { secret: SLACK_TOKEN });
    expect(code).toBe(0);
    expect(io.err()).toContain(`Note: The list of connected channels (connectors.json) holds 2 entries this smurg cannot read`);
    expect(await stored(s)).toEqual({ version: 1, workspaces: { ws_other_bbbbbbbb: 'garbage', [WORKSPACE]: { discord: { token: 7 }, teams: { x: 1 }, slack: { token: SLACK_TOKEN, channel: 'C0123ABCDE', connectedAt: NOW } } } });
    // The entry it could not read is disconnected all the same (the person asked): its token leaves the file.
    const removed = await run(s, ['disconnect', 'discord']);
    expect(removed.io.out()).toBe(`Removed the Discord entry of ${s.folder}, which this smurg could not read.\n`);
    // Mode 0644: refused, nothing written, nothing asked.
    await writeFile(connectorsFile(s), `${JSON.stringify(kept)}\n`);
    await chmod(connectorsFile(s), 0o644);
    const before = await readFile(connectorsFile(s), 'utf8');
    const refused = await run(s, ['connect', 'slack', '--channel', 'C0123ABCDE'], { secret: SLACK_TOKEN });
    expect(refused.code).toBe(1);
    expect(refused.io.err()).toContain('The list of connected channels (connectors.json) can be read by other users');
    expect(await readFile(connectorsFile(s), 'utf8')).toBe(before);
  });

  it('in zh-TW: the prompt, what was connected and disconnected, the refusals and both --help texts', async () => {
    const s = await setup();
    const connected = await run(s, ['connect', 'slack', '--channel', 'C0123ABCDE'], { secret: SLACK_TOKEN, lang: 'zh-TW' });
    expect(connected.code).toBe(0);
    expect(connected.prompts).toEqual(['你的 Slack app 的 bot token（不會顯示）：']);
    expect(connected.io.out()).toContain(`已把 Slack 頻道 C0123ABCDE 連接到 ${s.folder}。\n`);
    expect(connected.io.out()).toContain('說明：https://smurg.ai/zh-TW/docs/hosting/#11-slack-和-discord');
    const bad = await run(s, ['connect', 'discord', '--channel', 'abc'], { lang: 'zh-TW' });
    expect(bad.io.err()).toContain('smurg：--channel 的值不是 Discord 頻道的 id');
    expect(bad.io.err()).toContain('Discord 頻道的 id 是 17 到 20 位數字');
    const token = await run(s, ['connect', 'discord', '--channel', '123456789012345678'], { secret: 'short', lang: 'zh-TW' });
    expect(token.io.err()).toContain('這不是 Discord 的 bot token，什麼都沒有改');
    const disconnected = await run(s, ['disconnect', 'slack'], { lang: 'zh-TW' });
    expect(disconnected.io.out()).toContain('已中斷 Slack 頻道 C0123ABCDE 和');
    const none = await run(s, ['disconnect', 'slack'], { lang: 'zh-TW' });
    expect(none.io.out()).toBe(`${s.folder} 沒有連接 Slack 頻道。\n`);
    for (const command of ['connect', 'disconnect']) {
      const en = await run(s, [command, '--help']);
      expect(en.io.out()).toContain(`Usage: smurg ${command} slack|discord [folder]`);
      const zh = await run(s, [command, '--help'], { lang: 'zh-TW' });
      expect(zh.io.out()).toContain(`用法：smurg ${command} slack|discord [資料夾]`);
    }
    expect((await run(s, ['connect', '--help'])).io.out()).toContain('~/.smurg/connectors.json (mode 0600); agent');
  });
});

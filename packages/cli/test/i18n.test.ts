// The CLI's catalog (src/i18n): both languages have the same messages with the same parameters, English is ASCII,
// zh-TW is Chinese, every message renders with sample values, every id is used; and how the language of a run is
// chosen (resolveLang) and how a message of the daemon is shown in this terminal's language (wireText / wireError).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { msg } from '@smurg/protocol/i18n';
import { ENV_CASES } from '@smurg/protocol/locale/test-table';
import { CliError, errorText, formatFailure, usageError } from '../src/cli/errors.ts';
import { powerState } from '../src/cli/power-text.ts';
import { CATALOGS, m, renderText, resolveLang, roleText, systemLanguages, wireError, wireText, type MessageId } from '../src/i18n/index.ts';
import { en } from '../src/i18n/en.ts';
import { zhTW } from '../src/i18n/zh-TW.ts';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const IDS = Object.keys(en) as MessageId[];
const CJK = /[　-〿㐀-鿿＀-￯]/;

/** Parameters by name: what kind of value each one is (everything else is a string). */
const NUMBERS = new Set([
  'count',
  'minutes',
  'exitCode',
  'status',
  'amount',
  'maxUses',
  'seconds',
  'cols',
  'rows',
  'bytes',
  'kb',
  'percent',
  'connections',
  'onlineMembers',
  'min',
  'max',
  'total',
  'paused',
  'running',
  'waiting',
  'stalled',
  'idle',
]);
const LISTS = new Set(['ids', 'others', 'markers', 'names', 'cacheRoots', 'removed', 'rest', 'left']);
const BOOLEANS = new Set(['stopping', 'builtIn', 'several', 'bashAttribution']);
/** Parameters a message may be rendered without. */
const OPTIONAL: Readonly<Record<string, readonly string[]>> = {
  'failure.line': ['hint'],
  'host.folder.containsHome.hint': ['example'],
  'host.invite.heading': ['maxUses', 'role'],
  'host.summary': ['hostUrl'],
  'status.workspace': ['folder', 'relay', 'fingerprint', 'bashAttribution', 'agents', 'topics', 'projectSettings', 'hostRules', 'pid'],
  'status.claude': ['version'],
  'attach.agents.browser': ['url'],
  'uninstall.stopFailed': ['reason'],
};
const UNIONS: Readonly<Record<string, readonly string[]>> = {
  action: ['claim', 'login', 'dev-login', 'verify'],
  unit: ['day', 'hour', 'minute', 'second'],
  verdict: ['verified', 'unverified', 'too-old', 'unknown'],
  login: ['logged-in', 'logged-out', 'unknown'],
  trust: ['used', 'ignored', 'none'],
};
const SUBJECTS: Readonly<Record<string, readonly string[]>> = {
  'relay.badUrl': ['flag', 'web-origin', 'env', 'credentials', 'built-in', 'invite'],
  state: ['credentials', 'workspaces', 'logs', 'daemon-key', 'device-key'],
};

interface Sample {
  readonly number: number;
  readonly list: number;
  readonly flag: boolean;
  readonly optional: boolean;
  readonly variant: number;
}

/** Renders `id` in `lang` with sample values; returns the text and the names of the parameters the message read. */
function sample(lang: 'en' | 'zh-TW', id: MessageId, s: Sample): { text: string; read: string[] } {
  const read = new Set<string>();
  const params = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== 'string') return undefined;
        read.add(name);
        if (!s.optional && OPTIONAL[id]?.includes(name)) return undefined;
        if (NUMBERS.has(name)) return s.number;
        if (LISTS.has(name)) return Array.from({ length: s.list }, (_, i) => `<${name}${i + 1}>`);
        if (BOOLEANS.has(name)) return s.flag;
        const union = name === 'subject' ? (SUBJECTS[id] ?? SUBJECTS['state']) : UNIONS[name];
        if (union) return union[s.variant % union.length];
        return `<${name}>`;
      },
    },
  );
  const text = (CATALOGS[lang][id] as (p: unknown) => string)(params);
  return { text, read: [...read].sort() };
}

const SAMPLES: readonly Sample[] = [
  { number: 1, list: 1, flag: true, optional: true, variant: 0 },
  { number: 2, list: 5, flag: false, optional: true, variant: 1 },
  { number: 25, list: 7, flag: true, optional: false, variant: 2 },
  { number: 0, list: 2, flag: false, optional: false, variant: 3 },
  { number: 3, list: 3, flag: true, optional: true, variant: 4 },
  { number: 3, list: 3, flag: true, optional: true, variant: 5 },
];

/** zh-TW texts that are the same as the English ones on purpose (a URL-free name, a unit, a table cell). */
const IDENTICAL_IN_BOTH: readonly MessageId[] = ['arg.session', 'attach.note', 'uninstall.plan.item', 'update.progress.unknown'];

describe('the CLI catalog (src/i18n)', () => {
  it('has the same ids in both languages', () => {
    expect(Object.keys(zhTW).sort()).toEqual([...IDS].sort());
    expect(IDS.length).toBeGreaterThan(300);
    for (const id of IDS) expect(id, id).toMatch(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/);
  });

  it('every message renders in both languages with sample values, reads the same parameters, and leaves nothing unfilled', () => {
    for (const id of IDS) {
      for (const s of SAMPLES) {
        const english = sample('en', id, s);
        const chinese = sample('zh-TW', id, s);
        for (const [lang, out] of [['en', english], ['zh-TW', chinese]] as const) {
          expect(out.text, `${id} (${lang})`).not.toMatch(/undefined|\[object|NaN|\bnull\b/);
          expect(typeof out.text, id).toBe('string');
          expect(out.text.length, `${id} (${lang})`).toBeGreaterThan(0);
        }
        // The same parameters in both languages (a zh-TW message that ignores a count or a name has drifted).
        expect(chinese.read, id).toEqual(english.read);
        // Every string parameter that English shows, zh-TW shows too.
        for (const name of english.read) {
          const token = `<${name}`;
          if (english.text.includes(token)) expect(chinese.text, `${id}: ${name}`).toContain(token);
        }
      }
    }
  });

  it('English is ASCII only (safe under LANG=C); zh-TW is Chinese', async () => {
    // eslint-disable-next-line no-control-regex
    expect(await readFile(join(SRC, 'i18n', 'en.ts'), 'utf8')).toMatch(/^[\x00-\x7f]*$/);
    for (const id of IDS) {
      const english = sample('en', id, SAMPLES[0] as Sample).text;
      const chinese = sample('zh-TW', id, SAMPLES[0] as Sample).text;
      // eslint-disable-next-line no-control-regex
      expect(english, id).toMatch(/^[\x00-\x7f]*$/);
      if (IDENTICAL_IN_BOTH.includes(id)) expect(chinese, id).toBe(english);
      else expect(CJK.test(chinese), `${id}: ${chinese}`).toBe(true);
    }
  });

  it('English counts have real plural forms; zh-TW has none', () => {
    const text = (lang: 'en' | 'zh-TW', number: number): string => sample(lang, 'host.invite.heading', { number, list: 1, flag: true, optional: true, variant: 0 }).text;
    expect(text('en', 1)).toContain('valid for 1 day; 1 use;');
    expect(text('en', 2)).toContain('valid for 2 days; 2 uses;');
    expect(text('zh-TW', 1)).toContain('1 天內有效，可以使用 1 次');
    expect(text('zh-TW', 2)).toContain('2 天內有效，可以使用 2 次');
    expect(renderText('en', m('logout.all', { count: 1 }))).toBe('Logged out of every relay (1 login).');
    expect(renderText('en', m('logout.all', { count: 3 }))).toBe('Logged out of every relay (3 logins).');
    expect(renderText('en', m('stop.timeout', { seconds: 1 }))).toBe('smurg host did not stop within 1 second');
    expect(renderText('en', m('stop.timeout', { seconds: 30 }))).toBe('smurg host did not stop within 30 seconds');
    expect(renderText('en', m('login.open', { page: 'P', code: 'ABCD-EFGH', minutes: 1 }))).toContain('(valid for 1 minute)');
    // The line at a stop (DESIGN v0.5.0 §6) and the host's own rules in `smurg status`.
    expect(renderText('en', m('host.agentsPaused', { count: 3 }))).toBe('3 agent sessions are paused. They continue when you share this folder again.');
    expect(renderText('en', m('host.agentsPaused', { count: 1 }))).toBe('1 agent session is paused. It continues when you share this folder again.');
    expect(renderText('zh-TW', m('host.agentsPaused', { count: 3 }))).toBe('3 個 agent session 已暫停，下次分享這個資料夾時會繼續。');
    expect(renderText('en', m('status.hostRules', { count: 1 }))).toBe('1 applies to agent sessions (agents run what it allows without asking)');
    expect(renderText('en', m('status.hostRules', { count: 12 }))).toBe('12 apply to agent sessions (agents run what they allow without asking)');
    expect(renderText('en', m('status.hostRules', { count: 0 }))).toBe('none apply to agent sessions');
  });

  it('every id is used somewhere in src (no dead messages), and src has no text outside the catalog', async () => {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
      }
    };
    await walk(SRC);
    let source = '';
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (file.endsWith(join('i18n', 'en.ts')) || file.endsWith(join('i18n', 'zh-TW.ts'))) continue;
      // No CJK anywhere in the CLI's source but the zh-TW table: not in a string, not in a comment.
      const at = text.split('\n').findIndex((line) => CJK.test(line));
      expect(at === -1 ? '' : `${file}:${at + 1}`).toBe('');
      source += text;
    }
    const unused = IDS.filter((id) => !source.includes(`'${id}'`));
    expect(unused).toEqual([]);
  });
});

describe('renderText', () => {
  it('renders a message of the catalog in the given language; a parameter may be another message', () => {
    const text = m('args.missing', { name: m('arg.folder') });
    expect(renderText('en', text)).toBe('Missing argument <folder>');
    expect(renderText('zh-TW', text)).toBe('缺少參數 <資料夾>');
    expect(renderText('en', 'a path/is data')).toBe('a path/is data');
    expect(renderText('zh-TW', m('host.keepAwake.lost', { state: powerState({ active: false, mechanism: 'none', reason: 'exited' }) }))).toBe(
      '\n⚠ 防止睡眠已失效：未啟用（防睡眠程式已經結束）。電腦睡眠時組員會看到「主人已離線」。',
    );
  });

  it('a daemon message is rendered from its reference in this terminal’s language; the English text is only the fallback', () => {
    // A zh-TW member attaching to a host whose own terminal is English (and the other way round): the reference decides.
    const refusal = { code: 'forbidden', message: 'You do not have permission to do this.', text: { id: 'error.default.forbidden' } };
    expect(renderText('zh-TW', wireError(refusal))).toBe('你沒有權限執行這個動作');
    expect(renderText('en', wireError(refusal))).toBe('You do not have permission to do this.');
    // An id this build does not know: the default text of the error code, in this language.
    expect(renderText('zh-TW', wireError({ code: 'not_found', message: 'A newer sentence.', text: { id: 'some.newer.message' } }))).toBe('找不到指定的項目');
    // Wrong parameters, no code: the English message as sent.
    expect(renderText('zh-TW', wireText({ id: 'session.title.agent', params: { owner: 7 as unknown as string } }, 'Claude (Ian)'))).toBe('Claude (Ian)');
    expect(renderText('zh-TW', wireError({ message: 'plain' }))).toBe('plain');
    // Nested in one of the CLI's own messages.
    expect(renderText('zh-TW', m('stop.refused', { reason: wireError(refusal) }))).toBe('smurg host 拒絕停止：你沒有權限執行這個動作');
    expect(renderText('en', m('ctl.attachRefused', { reason: wireError(refusal) }))).toBe('smurg host refused the connection: You do not have permission to do this.');
  });

  it('role labels and default session titles come from the wire catalog: one wording for the web app and the CLI', () => {
    expect(renderText('en', roleText('agent'))).toBe('Agent access');
    expect(renderText('zh-TW', roleText('agent'))).toBe('可使用 agent');
    expect(renderText('en', roleText('viewer'))).toBe('Viewer');
    expect(renderText('en', roleText('someday'))).toBe('someday');
    const ref = msg('session.title.terminal', { owner: 'Ian' });
    expect(renderText('en', wireText(ref, 'x'))).toBe('Terminal (Ian)');
    expect(renderText('zh-TW', wireText(ref, 'x'))).toBe('終端機（Ian）');
  });

  it('keep-awake: one text per reason code of the daemon; an unknown code reads "reason unknown"', () => {
    const off = (reason: string | null): string => renderText('en', powerState({ active: false, mechanism: 'none', reason }));
    expect(renderText('en', powerState({ active: true, mechanism: 'caffeinate', reason: null }))).toBe('on (caffeinate)');
    expect(off('disabled')).toBe('off (turned off with --no-keep-awake)');
    expect(off('not-started')).toBe('off (not started yet)');
    expect(off('stopped')).toBe('off (stopped)');
    expect(off('systemd-inhibit-not-found')).toBe('off (systemd-inhibit was not found)');
    expect(off('unsupported-platform')).toBe('off (this operating system is not supported)');
    expect(off('spawn-failed')).toBe('off (the keep-awake program could not be started)');
    expect(off('start-failed')).toBe('off (the keep-awake program could not be started)');
    expect(off('exited')).toBe('off (the keep-awake program has ended)');
    expect(off('refused')).toContain('polkit');
    for (const unknown of ['something new', 'constructor', '', null]) expect(off(unknown)).toBe('off (reason unknown)');
  });
});

describe('CliError', () => {
  it('carries its message as a Text: printed in the language of the run, with the prefix of that language', () => {
    const err = usageError(m('host.folder.notFound', { folder: './nope' }), m('host.folder.example', { example: '/home/amy/my-project' }));
    expect(err.message).toBe('Folder not found: ./nope'); // Error.message: English, for logs
    expect(formatFailure(err, 'en')).toEqual({ text: 'smurg: Folder not found: ./nope\n  For example: smurg host /home/amy/my-project\n', exitCode: 2 });
    expect(formatFailure(err, 'zh-TW')).toEqual({ text: 'smurg：找不到資料夾：./nope\n  例如：smurg host /home/amy/my-project\n', exitCode: 2 });
    expect(formatFailure(new CliError(m('host.inviteFailed')), 'en').text).toBe('smurg: Could not create the invite link\n');
    expect(formatFailure(new TypeError('x'), 'en').text).toBe('smurg: an unexpected error occurred (TypeError).\n  If it keeps happening, report it with the logs in ~/.smurg/logs.\n');
    expect(formatFailure(new TypeError('x'), 'zh-TW').text).toContain('smurg：發生未預期的錯誤（TypeError）。');
  });

  it('errorText: a CliError’s own text, an error with a wire reference, any other message, else the given text', () => {
    const fallback = m('attach.failed');
    expect(renderText('zh-TW', errorText(new CliError(m('ctl.notRunning')), fallback))).toBe('這個工作區沒有正在執行的 smurg host');
    const wire = Object.assign(new Error('The session has ended.'), { code: 'conflict', text: { id: 'error.default.conflict' } });
    expect(renderText('zh-TW', errorText(wire, fallback))).toBe('與目前的狀態衝突，請重新整理後再試');
    expect(renderText('en', errorText(wire, fallback))).toBe('This conflicts with the current state. Reload and try again.');
    expect(renderText('en', errorText(new Error('as it is'), fallback))).toBe('as it is');
    expect(renderText('en', errorText('not an error', fallback))).toBe('Could not attach to the session');
    expect(renderText('zh-TW', errorText(new Error(''), fallback))).toBe('無法接上 session');
  });
});

describe('resolveLang', () => {
  it('follows the shared table: SMURG_LANG, then the first non-empty of LC_ALL, LC_MESSAGES, LANG; else English', () => {
    for (const [env, expected] of ENV_CASES) expect(resolveLang(env), JSON.stringify(env)).toBe(expected);
  });

  it('asks the system (macOS: AppleLanguages) only when none of the three is set and SMURG_LANG gives nothing', () => {
    let asked = 0;
    const system = (tags: readonly string[] | null) => (): readonly string[] | null => {
      asked += 1;
      return tags;
    };
    expect(resolveLang({}, system(['zh-Hant-TW', 'en-TW']))).toBe('zh-TW');
    expect(resolveLang({ LANG: '', LC_ALL: '' }, system(['ja-JP', 'zh-Hant-HK', 'en']))).toBe('zh-TW');
    expect(resolveLang({}, system(['en-US', 'zh-Hant-TW']))).toBe('en');
    expect(resolveLang({}, system(['zh-Hans-CN']))).toBe('en');
    expect(resolveLang({}, system(null))).toBe('en');
    expect(resolveLang({ SMURG_LANG: 'fr' }, system(['zh-Hant-TW']))).toBe('zh-TW'); // an unknown SMURG_LANG is ignored
    expect(asked).toBe(6);
    expect(resolveLang({}, () => { throw new Error('defaults failed'); })).toBe('en');
    // A locale or SMURG_LANG decides alone: the system is never asked.
    asked = 0;
    expect(resolveLang({ LANG: 'en_US.UTF-8' }, system(['zh-Hant-TW']))).toBe('en');
    expect(resolveLang({ LC_ALL: 'C' }, system(['zh-Hant-TW']))).toBe('en');
    expect(resolveLang({ LANG: 'zh_TW.Big5' }, system(['zh-Hant-TW']))).toBe('en');
    expect(resolveLang({ SMURG_LANG: 'en' }, system(['zh-Hant-TW']))).toBe('en');
    expect(resolveLang({ SMURG_LANG: 'zh_tw', LC_ALL: 'C' }, system(['en']))).toBe('zh-TW');
    expect(asked).toBe(0);
    // Without a reader (every test io): the environment alone.
    expect(resolveLang({})).toBe('en');
  });

  it('the real reader never throws: a list of tags on macOS (read once), null elsewhere', () => {
    const first = systemLanguages();
    if (process.platform === 'darwin') expect(first === null || (Array.isArray(first) && first.every((tag) => typeof tag === 'string'))).toBe(true);
    else expect(first).toBeNull();
    expect(systemLanguages()).toBe(first); // cached: `defaults` runs at most once per process
  });
});

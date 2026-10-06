// The wire catalog as a whole: parity of the two locales, wording rules, and the seed families. Every message added
// under ./messages is covered by the generic checks here without editing this file (except a new entry in
// IDENTICAL_IN_BOTH when a zh-TW text is deliberately the same as the English one).
import { describe, expect, it } from 'vitest';
import { CLIENT_REQUEST_FAILURES } from '../client/errors.ts';
import { ERROR_CODES } from '../errors.ts';
import { ROLES } from '../roles.ts';
import { PERMISSION_MODES } from '../schema/entities.ts';
import { ATTENTION_SUBJECTS } from '../schema/inbox.ts';
import { REPORT_OUTCOMES } from '../schema/topics.ts';
import {
  ADMIN_CHANGES,
  CONFLICT_RECOVERY_REASONS,
  FILE_CHANGES,
  GIT_STEPS,
  MESSAGES,
  MESSAGE_GROUPS,
  MESSAGE_IDS,
  attentionRef,
  clientFailureRef,
  defaultErrorRef,
  formatBytes,
  isMessageId,
  msg,
  permissionModeRef,
  render,
  renderEnglish,
  reportOutcomeRef,
  roleLabel,
  roleRef,
  type MessageId,
  type MessageRef,
  type ParamKind,
} from './index.ts';

// Han, Bopomofo, CJK punctuation (U+3000-303F) and full-width forms (U+FF00-FFEF): the no-CJK lint's definition.
const CJK = /[　-〿㄀-ㄯ㐀-鿿豈-﫿＀-￯]/u;
/** zh-TW texts that are deliberately identical to the English ones (proper names, loanwords). */
const IDENTICAL_IN_BOTH: ReadonlySet<string> = new Set<string>(['session.title.agent', 'session.title.item']);

/**
 * String parameters that are one of a fixed set of values (a nested table inside the form picks the words): every
 * value must render in both locales, and a value this version does not know must still give a sentence.
 */
const ENUM_PARAMS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'git.stepFailed': { step: GIT_STEPS },
  'git.outputTooLarge': { step: GIT_STEPS },
  'git.objectUnreadable': { step: GIT_STEPS },
  'admin.appliedNotSaved': { change: ADMIN_CHANGES },
  'activity.agentChange': { change: FILE_CHANGES },
  'activity.agentBashChange': { change: FILE_CHANGES },
  'activity.externalChange': { change: FILE_CHANGES },
  'activity.worktreeChange': { change: FILE_CHANGES },
  'activity.conflictRecovered': { reason: CONFLICT_RECOVERY_REASONS },
  'conversation.mode.changed': { mode: PERMISSION_MODES },
};

function sample(kind: ParamKind, name: string, variant: number): string | number | boolean | string[] {
  const base = kind.replace('?', '');
  if (base === 'number') return [1, 2, 25][variant % 3] as number;
  if (base === 'boolean') return variant % 2 === 0;
  if (base === 'list') return [['Amy'], ['Amy', 'Bob', 'Cat', 'Dan', 'Eve'], ['A', 'B', 'C', 'D', 'E', 'F', 'G']][variant % 3] as string[];
  return `<${name}>`;
}

/** References to `id` with sample parameters: all given (three variants: counts 1/2/25, lists of 1/5/7) and only the required ones. */
function sampleRefs(id: MessageId): MessageRef[] {
  const spec = MESSAGES[id].params as Readonly<Record<string, ParamKind>>;
  const names = Object.keys(spec);
  if (names.length === 0) return [{ id }];
  const refs: MessageRef[] = [0, 1, 2].map((variant) => ({
    id,
    params: Object.fromEntries(names.map((name) => [name, sample(spec[name] as ParamKind, name, variant)])),
  }));
  const required = names.filter((name) => !(spec[name] as string).endsWith('?'));
  if (required.length < names.length) {
    refs.push({ id, params: Object.fromEntries(required.map((name) => [name, sample(spec[name] as ParamKind, name, 0)])) });
    // An explicit `false` / 0 / empty list / empty string for the optional ones.
    refs.push({
      id,
      params: Object.fromEntries(
        names.map((name) => {
          const kind = spec[name] as ParamKind;
          if (!kind.endsWith('?')) return [name, sample(kind, name, 0)];
          const base = kind.replace('?', '');
          return [name, base === 'number' ? 0 : base === 'boolean' ? false : base === 'list' ? [] : ''];
        }),
      ),
    });
  }
  return refs;
}

describe('wire catalog', () => {
  it('has no id defined in two message files', () => {
    const all = Object.values(MESSAGE_GROUPS).flatMap((group) => Object.keys(group));
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...MESSAGE_IDS].sort());
  });

  it.each(MESSAGE_IDS)('%s renders in both locales with every sample, without placeholders or "undefined"', (id) => {
    for (const ref of sampleRefs(id)) {
      const en = render('en', ref);
      const zh = render('zh-TW', ref);
      for (const text of [en, zh]) {
        expect(text, JSON.stringify(ref)).toEqual(expect.any(String));
        expect(text, JSON.stringify(ref)).not.toMatch(/undefined|\[object|NaN|[{}]|\$\(/);
        expect((text as string).trim(), JSON.stringify(ref)).toBe(text);
      }
      // English: no CJK and no full-width punctuation.
      expect(en, id).not.toMatch(CJK);
      // zh-TW: Chinese, unless deliberately identical.
      if (IDENTICAL_IN_BOTH.has(id)) expect(zh, id).toBe(en);
      else expect(zh, id).toMatch(CJK);
      expect(renderEnglish(ref)).toBe(en);
    }
  });

  it.each(MESSAGE_IDS)('%s uses every string and list parameter in both locales', (id) => {
    const spec = MESSAGES[id].params as Readonly<Record<string, ParamKind>>;
    const ref = sampleRefs(id)[1] ?? sampleRefs(id)[0];
    for (const [name, kind] of Object.entries(spec)) {
      const base = kind.replace('?', '');
      if (base !== 'string' && base !== 'list') continue;
      if (ENUM_PARAMS[id]?.[name] !== undefined) continue;
      const marker = base === 'string' ? `<${name}>` : 'Bob';
      expect(render('en', ref), `${id} ${name}`).toContain(marker);
      expect(render('zh-TW', ref), `${id} ${name}`).toContain(marker);
    }
  });

  it('every IDENTICAL_IN_BOTH entry is a message', () => {
    for (const id of IDENTICAL_IN_BOTH) expect(isMessageId(id), id).toBe(true);
  });

  it('every value of an enumerated parameter has its own wording in both locales; an unknown value still renders', () => {
    for (const [id, params] of Object.entries(ENUM_PARAMS)) {
      expect(isMessageId(id), id).toBe(true);
      const spec = MESSAGES[id as MessageId].params as Readonly<Record<string, ParamKind>>;
      const base = sampleRefs(id as MessageId)[0] as MessageRef;
      for (const [name, values] of Object.entries(params)) {
        expect(spec[name], `${id} ${name}`).toBe('string');
        const texts = { en: new Set<string>(), 'zh-TW': new Set<string>() };
        for (const value of [...values, 'somethingNew']) {
          const ref = { id, params: { ...base.params, [name]: value } };
          for (const locale of ['en', 'zh-TW'] as const) {
            const text = render(locale, ref);
            expect(text, `${id} ${name}=${value} ${locale}`).toEqual(expect.any(String));
            expect(text, `${id} ${name}=${value} ${locale}`).not.toMatch(/undefined|\[object/);
            texts[locale].add(text as string);
          }
          expect(render('en', ref)).not.toMatch(CJK);
          expect(render('zh-TW', ref)).toMatch(CJK);
        }
        // (the unknown value may share the wording of a catch-all value)
        expect(texts.en.size, `${id} ${name} en`).toBeGreaterThanOrEqual(values.length);
        expect(texts['zh-TW'].size, `${id} ${name} zh-TW`).toBeGreaterThanOrEqual(values.length);
      }
    }
  });
});

describe('plural and list messages (the table of DESIGN A.10)', () => {
  it('counts: 1 / 2 / 25', () => {
    const burst = (count: number): MessageRef => msg('activity.externalBurst', { count, sample: ['a.ts'] });
    expect(render('en', burst(1))).toBe('An outside program changed 1 file (e.g. a.ts)');
    expect(render('en', burst(2))).toBe('An outside program changed 2 files (e.g. a.ts)');
    expect(render('en', burst(25))).toBe('An outside program changed 25 files (e.g. a.ts)');
    expect(render('zh-TW', burst(1))).toBe('外部程式變更了 1 個檔案（例如 a.ts）');
    expect(render('zh-TW', burst(25))).toBe('外部程式變更了 25 個檔案（例如 a.ts）');
    expect(render('en', msg('activity.externalBurst', { count: 4 }))).toBe('An outside program changed 4 files');
    expect(render('en', msg('activity.mergeConflict', { requester: 'Amy', count: 1 }))).toBe("Merging Amy's worktree hit conflicts in 1 file. The main workspace was not changed");
    expect(render('zh-TW', msg('activity.mergeConflict', { requester: 'Amy', count: 3 }))).toBe('合併Amy的 worktree 時發生衝突（3 個檔案），主工作區沒有改變');
    expect(render('en', msg('activity.conflict', { path: 'a.md', count: 1 }))).toMatch(/^1 change to "a\.md" overlaps /);
    expect(render('en', msg('activity.conflict', { path: 'a.md', count: 2 }))).toMatch(/^2 changes to "a\.md" overlap /);
  });

  it('names: 1 / 5 / 7', () => {
    const five = ['Amy', 'Bob', 'Cat', 'Dan', 'Eve'];
    expect(render('en', msg('file.lockedByPeople', { names: ['Amy'] }))).toBe('Amy is editing this file.');
    expect(render('en', msg('file.lockedByPeople', { names: five }))).toBe('Amy, Bob, Cat, Dan, Eve are editing this file.');
    expect(render('zh-TW', msg('file.lockedByPeople', { names: five }))).toBe('Amy、Bob、Cat、Dan、Eve 正在編輯這個檔案');
    const held = (holders: string[], holderCount: number): MessageRef =>
      msg('activity.lockDeniedHeld', { agent: 'Claude (Ian)', path: 'a.ts', holders, holderCount, holderIsAgent: false });
    expect(render('en', held(['Amy'], 1))).toBe('Claude (Ian) wanted to change a.ts, but Amy is editing it: blocked');
    expect(render('en', held(five, 5))).toBe('Claude (Ian) wanted to change a.ts, but Amy, Bob, Cat, Dan, Eve are editing it: blocked');
    expect(render('en', held(five, 7))).toBe('Claude (Ian) wanted to change a.ts, but Amy, Bob, Cat, Dan, Eve and 2 more are editing it: blocked');
    expect(render('zh-TW', held(five, 7))).toBe('Claude (Ian) 想修改 a.ts，但 Amy、Bob、Cat、Dan、Eve 等 7 人 正在編輯，已被擋下');
    expect(render('zh-TW', held(['Amy'], 1))).toBe('Claude (Ian) 想修改 a.ts，但 Amy 正在編輯，已被擋下');
    // Names in front of "are": the last two are joined by "and", not by a comma.
    const waits = (holders: string[]): MessageRef => msg('conversation.locked.spec', { path: 'specs/checkout/SPEC.md', holders });
    expect(render('en', waits(['Amy']))).toBe('Claude waits to edit specs/checkout/SPEC.md: Amy is typing in it.');
    expect(render('en', waits(['Amy', 'Mei']))).toBe('Claude waits to edit specs/checkout/SPEC.md: Amy and Mei are typing in it.');
    expect(render('en', waits(five))).toBe('Claude waits to edit specs/checkout/SPEC.md: Amy, Bob, Cat, Dan and Eve are typing in it.');
    expect(render('zh-TW', waits(['Amy', 'Mei']))).toBe('Claude 正在等待編輯 specs/checkout/SPEC.md：Amy、Mei 正在輸入');
  });

  it('sizes are formatted the same way in both locales', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MiB');
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(-1536)).toBe('-1.50 KiB');
    expect(render('en', msg('doc.tooLarge', { maxBytes: 5 * 1024 * 1024 }))).toBe('The file is larger than 5.00 MiB and cannot be opened in the editor.');
    expect(render('zh-TW', msg('doc.tooLarge', { maxBytes: 5 * 1024 * 1024 }))).toBe('檔案超過 5.00 MiB，無法在編輯器中開啟');
  });

  it('a session nobody named gets its title from the kind and the owner', () => {
    expect(render('en', msg('session.title.terminal', { owner: 'Ian' }))).toBe('Terminal (Ian)');
    expect(render('zh-TW', msg('session.title.terminal', { owner: 'Ian' }))).toBe('終端機（Ian）');
    expect(render('zh-TW', msg('session.title.agent', { owner: 'Ian' }))).toBe('Claude (Ian)');
  });
});

describe('seed: role labels (docs/GLOSSARY.md)', () => {
  it('names the four roles', () => {
    expect(ROLES.map((role) => roleLabel('en', role))).toEqual(['Host', 'Agent access', 'Editor', 'Viewer']);
    expect(ROLES.map((role) => roleLabel('zh-TW', role))).toEqual(['主人', '可使用 agent', '可編輯', '旁觀']);
    expect(render('en', msg('role.agent'))).toBe('Agent access');
  });

  it('every role has a reference; an unknown role is shown as given', () => {
    for (const role of ROLES) expect(roleRef(role)).toEqual({ id: `role.${role}` });
    expect(roleRef('owner')).toBeUndefined();
    expect(roleRef('constructor')).toBeUndefined();
    expect(roleRef(undefined as unknown as string)).toBeUndefined();
    expect(roleLabel('en', 'owner')).toBe('owner');
  });
});

describe('seed: default error texts', () => {
  it.each(ERROR_CODES)('%s has a default in both locales', (code) => {
    const ref = defaultErrorRef(code);
    expect(ref.id).toMatch(/^error\.default\.[a-z][A-Za-z]*$/);
    if (code !== 'internal') expect(ref.id).not.toBe('error.default.internal');
    expect(render('en', ref)).toMatch(/^[A-Z].*\.$/);
    expect(render('zh-TW', ref)).toMatch(CJK);
  });

  it('there are exactly as many defaults as codes; an unknown code gets the internal default', () => {
    expect(MESSAGE_IDS.filter((id) => id.startsWith('error.default.')).length).toBe(ERROR_CODES.length);
    expect(defaultErrorRef('nope')).toEqual({ id: 'error.default.internal' });
    expect(defaultErrorRef('constructor')).toEqual({ id: 'error.default.internal' });
    expect(defaultErrorRef(undefined as unknown as string)).toEqual({ id: 'error.default.internal' });
    expect(defaultErrorRef('bad_request')).toEqual({ id: 'error.default.badRequest' });
  });
});

describe('seed: client request failures', () => {
  it.each(CLIENT_REQUEST_FAILURES)('%s has a message in both locales', (failure) => {
    const ref = clientFailureRef(failure);
    expect(ref?.id).toMatch(/^client\.[a-z][A-Za-z]*$/);
    expect(render('en', ref)).toMatch(/^[A-Z].*\.$/);
    expect(render('zh-TW', ref)).toMatch(CJK);
  });

  it('a sent request that timed out or was cancelled says the outcome is unknown', () => {
    expect(clientFailureRef('timeout', true)).toEqual({ id: 'client.timeoutOutcomeUnknown' });
    expect(clientFailureRef('cancelled', true)).toEqual({ id: 'client.cancelledOutcomeUnknown' });
    expect(clientFailureRef('timeout', false)).toEqual({ id: 'client.timeout' });
    expect(clientFailureRef('closed', true)).toEqual({ id: 'client.closed' });
    expect(clientFailureRef('connection-lost')).toEqual({ id: 'client.connectionLost' });
    expect(clientFailureRef('not-connected')).toEqual({ id: 'client.notConnected' });
    expect(clientFailureRef('nope')).toBeUndefined();
    expect(clientFailureRef('timeoutOutcomeUnknown')).toBeUndefined();
  });

  it('every client.* message belongs to a failure', () => {
    const reachable = new Set(CLIENT_REQUEST_FAILURES.flatMap((failure) => [clientFailureRef(failure)?.id, clientFailureRef(failure, true)?.id]));
    expect(MESSAGE_IDS.filter((id) => id.startsWith('client.')).filter((id) => !reachable.has(id))).toEqual([]);
  });
});

describe('seed: enumerated values with their own wording (protocol 4)', () => {
  it('the two permission modes', () => {
    expect(PERMISSION_MODES.map((mode) => render('en', permissionModeRef(mode)))).toEqual(['Asks before edits and commands', 'Asks before commands']);
    expect(PERMISSION_MODES.map((mode) => render('zh-TW', permissionModeRef(mode)))).toEqual(['編輯和執行指令前都先問', '執行指令前先問']);
    expect(permissionModeRef('ask-nothing')).toBeUndefined();
    expect(permissionModeRef('constructor')).toBeUndefined();
    expect(render('en', msg('conversation.mode.changed', { by: 'Mei', mode: 'ask-all' }))).toBe('Mei changed the permission mode: asks before edits and commands');
    expect(render('zh-TW', msg('conversation.mode.changed', { by: 'Mei', mode: 'ask-commands' }))).toBe('Mei 變更了權限模式：執行指令前先問');
  });

  it('how a work item ended', () => {
    expect(REPORT_OUTCOMES.map((outcome) => render('en', reportOutcomeRef(outcome)))).toEqual(['Complete', 'Partial', 'Blocked']);
    expect(REPORT_OUTCOMES.map((outcome) => render('zh-TW', reportOutcomeRef(outcome)))).toEqual(['完成', '部分完成', '受阻']);
    expect(reportOutcomeRef('done')).toBeUndefined();
  });

  it('every attention subject, and nothing else under attention.*', () => {
    const refs = ATTENTION_SUBJECTS.map((subject) => attentionRef(subject));
    for (const ref of refs) {
      expect(render('en', ref)).toEqual(expect.any(String));
      expect(render('zh-TW', ref)).toMatch(CJK);
    }
    expect(render('en', attentionRef('item-stalled'))).toBe('Stopped without a report');
    expect(render('zh-TW', attentionRef('item-stalled'))).toBe('沒寫報告就停下了');
    expect(new Set(refs.map((ref) => ref?.id)).size).toBe(ATTENTION_SUBJECTS.length);
    expect(MESSAGE_IDS.filter((id) => id.startsWith('attention.')).length).toBe(ATTENTION_SUBJECTS.length);
    expect(attentionRef('coffee')).toBeUndefined();
  });

  it('the owner’s decisions: the zh-TW word for Inbox (OWNER-DECISIONS Q14); the host’s own Claude Code rules apply (Q7)', () => {
    expect(render('zh-TW', msg('inbox.notDismissable'))).toBe('這個項目處理完才會離開收件夾');
    expect(render('en', msg('hostRules.found', { count: 12 }))).toBe('Your own Claude Code settings allow 12 kinds of commands without asking. Agents here run them without asking too.');
    expect(render('en', msg('hostRules.found', { count: 1 }))).toContain('1 kind of commands');
  });

  it('the default titles of agent sessions', () => {
    expect(render('en', msg('session.title.discussion'))).toBe('Discussion');
    expect(render('zh-TW', msg('session.title.discussion'))).toBe('討論');
    expect(render('en', msg('session.title.item', { number: 2, title: 'Payment form' }))).toBe('2 · Payment form');
  });
});

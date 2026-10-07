import { describe, expect, it } from 'vitest';
import { ROLES } from '../roles.ts';
import { MESSAGE_SAMPLES } from './message-samples.fixture.ts';
import { isSensitiveWireType, redactForLog } from './redact.ts';
import {
  HANDLER_CHECKS,
  MESSAGE_REGISTRY,
  MESSAGE_TYPES,
  RATE_BUCKETS,
  VOLATILE_SKIP_BUFFERED_BYTES,
  type MessageAccess,
  type MessageType,
  getMessageSpec,
  isMessageType,
  isRequestType,
  mayInvoke,
  mayReceive,
  parseWireType,
  responseTypeOf,
} from './registry.ts';
import { EVENTS_BATCH_MAX_BYTES, EVENTS_PAGE_MAX_BYTES, LIST_REPLY_MAX_BYTES, MESSAGE_TYPE_MAX_CHARS, RATE_LIMITS_PER_MINUTE } from './limits.ts';

// ---------------------------------------------------------------------------------------------------------------
// ARCHITECTURE §5, transcribed. Every row is one table row of §5.1–§5.11 as written there:
//   [type, Dir column, capability notation of the architecture]
// Notation: '[cap]' = capability in brackets, '(…)' = resource rule in parentheses (the handler decides), '' = nothing
// given. If this list and the registry disagree, either the code or the architecture changed without the other.
// ---------------------------------------------------------------------------------------------------------------

type ArchDir = 'c→d' | 'd→c' | 'both';
const ARCH_CATALOG: readonly (readonly [string, ArchDir, string])[] = [
  // §5.1 (channel.hello / channel.welcome are handshake structures, not Envelopes)
  ['channel.memberUpdated', 'd→c', ''],
  ['channel.settingsUpdated', 'd→c', ''],
  ['channel.closed', 'd→c', ''],
  ['channel.ack', 'both', ''],
  ['channel.leave', 'c→d', ''],
  ['error', 'd→c', ''],
  // §5.2
  ['file.tree', 'c→d', '[file.read]'],
  ['file.stat', 'c→d', '[file.read]'],
  ['file.create', 'c→d', '[file.write]'],
  ['file.rename', 'c→d', '[file.write]'],
  ['file.delete', 'c→d', '[file.write]'],
  ['file.read', 'c→d', '[file.read]'],
  ['file.write', 'c→d', '[file.write]'],
  ['file.changed', 'd→c', ''],
  ['file.upload.plan', 'c→d', '[file.write]'],
  ['file.upload.begin', 'c→d', '[file.write]'],
  ['file.upload.hashes', 'c→d', '[file.write]'],
  ['file.upload.chunk', 'c→d', '[file.write]'],
  ['file.upload.commit', 'c→d', '[file.write]'],
  ['file.upload.abort', 'c→d', '[file.write]'],
  ['file.download.begin', 'c→d', '[file.download]'],
  ['file.download.chunk', 'd→c', ''],
  ['file.download.ack', 'c→d', '[file.download]'],
  ['file.download.end', 'd→c', ''],
  ['file.download.cancel', 'c→d', '[file.download]'],
  // §5.3
  ['doc.open', 'c→d', '[file.read]'],
  ['doc.reset', 'd→c', ''],
  ['doc.sync', 'both', ''],
  ['doc.awareness', 'both', ''],
  ['doc.close', 'c→d', ''],
  ['doc.saved', 'd→c', ''],
  ['doc.rejected', 'd→c', ''],
  ['doc.conflict', 'd→c', ''],
  ['doc.conflict.list', 'c→d', '[file.read]'],
  ['doc.conflict.resolve', 'c→d', '[file.write]'],
  ['doc.conflict.get', 'c→d', '[file.read]'],
  // §5.4
  ['lock.state', 'd→c', ''],
  ['lock.list', 'c→d', '[file.read]'],
  ['lock.release', 'c→d', '[file.write]'],
  ['lock.forceRelease', 'c→d', '[lock.force-release]'],
  ['presence.heartbeat', 'd→c', ''],
  ['presence.state', 'd→c', ''],
  ['presence.update', 'c→d', ''],
  ['activity.event', 'd→c', ''],
  ['activity.list', 'c→d', '[file.read]'],
  ['activity.notify', 'd→c', ''],
  // §5.5 sessions of both kinds, and terminals
  ['session.create', 'c→d', '[session.create]'],
  ['session.list', 'c→d', '[session.view]'],
  ['session.state', 'd→c', ''],
  ['session.host.get', 'c→d', '[session.view]'],
  ['session.host', 'd→c', ''],
  ['session.end', 'c→d', '(who may end it)'],
  ['session.rename', 'c→d', '[session.drive]'],
  ['session.attach', 'c→d', '[session.view]'],
  ['session.detach', 'c→d', ''],
  ['exec.output', 'd→c', ''],
  ['exec.input', 'c→d', '[session.drive]'],
  ['exec.resize', 'both', '(opener)'],
  // §5.9 agent sessions: the conversation, questions, permission requests
  ['session.watch', 'c→d', '[session.view]'],
  ['session.unwatch', 'c→d', ''],
  ['session.history', 'c→d', '[session.view]'],
  ['session.cards.get', 'c→d', '[session.view]'],
  ['session.events', 'd→c', ''],
  ['session.delta', 'd→c', ''],
  ['session.message.send', 'c→d', '[session.drive]'],
  ['session.interrupt', 'c→d', '[session.drive]'],
  ['session.retry', 'c→d', '[session.drive]'],
  ['session.restart', 'c→d', '[session.drive]'],
  ['session.responsible.set', 'c→d', '[session.drive]'],
  ['session.mode.set', 'c→d', '[session.drive]'],
  ['session.rules.get', 'c→d', '[session.view]'],
  ['session.rule.remove', 'c→d', '[session.drive]'],
  ['session.loginStatus', 'c→d', '[session.drive]'],
  ['question.vote', 'c→d', '[discuss]'],
  ['question.comment', 'c→d', '[discuss]'],
  ['question.submit', 'c→d', '[discuss]'],
  ['question.remind', 'c→d', '[discuss]'],
  ['question.seen', 'c→d', '[discuss]'],
  ['question.changed', 'd→c', ''],
  ['question.updated', 'd→c', ''],
  ['permission.decide', 'c→d', '[session.drive]'],
  ['permission.updated', 'd→c', ''],
  // §5.6
  ['suggest.create', 'c→d', '[suggest.create]'],
  ['suggest.edit', 'c→d', '(author, pending)'],
  ['suggest.withdraw', 'c→d', '(author, pending)'],
  ['suggest.accept', 'c→d', '[session.drive]'],
  ['suggest.reject', 'c→d', '[session.drive]'],
  ['suggest.list', 'c→d', '[session.view]'],
  ['suggest.updated', 'd→c', ''],
  // §5.10
  ['topic.create', 'c→d', '[session.create]'],
  ['topic.list', 'c→d', '[session.view]'],
  ['topic.updated', 'd→c', ''],
  ['topic.removed', 'd→c', ''],
  ['topic.rename', 'c→d', '[session.drive]'],
  ['topic.archive', 'c→d', '[session.create]'],
  ['topic.delete', 'c→d', '[admin]'],
  ['topic.discussion.restart', 'c→d', '[session.create]'],
  ['topic.revise', 'c→d', '[suggest.create]'],
  ['topic.spec.request', 'c→d', '[session.drive]'],
  ['topic.rule.add', 'c→d', '[session.drive]'],
  ['topic.rule.remove', 'c→d', '[session.drive]'],
  ['plan.generate', 'c→d', '[session.drive]'],
  ['plan.get', 'c→d', '[session.view]'],
  ['plan.updated', 'd→c', ''],
  ['plan.mode.set', 'c→d', '[session.drive]'],
  ['plan.assign', 'c→d', '[session.drive]'],
  ['plan.suggest', 'c→d', '[session.drive]'],
  ['plan.preflight', 'c→d', '[session.create]'],
  ['plan.start', 'c→d', '[session.create]'],
  ['plan.changes', 'c→d', '[session.view]'],
  ['plan.resume', 'c→d', '[session.drive]'],
  ['plan.item.retry', 'c→d', '[session.create]'],
  ['plan.item.continue', 'c→d', '[session.drive]'],
  ['plan.item.resolve', 'c→d', '[session.drive]'],
  ['report.get', 'c→d', '[session.view]'],
  ['report.updated', 'd→c', ''],
  ['report.followUp', 'c→d', '[suggest.create]'],
  ['report.review', 'c→d', '[discuss]'],
  // §5.11
  ['inbox.list', 'c→d', ''],
  ['inbox.changed', 'd→c', ''],
  ['inbox.seen', 'c→d', ''],
  ['inbox.dismiss', 'c→d', ''],
  // §5.7
  ['worktree.list', 'c→d', '[file.read]'],
  ['worktree.remove', 'c→d', '(owner or host)'],
  ['worktree.merge.request', 'c→d', '[worktree.merge.request]'],
  ['worktree.merge.list', 'c→d', '[file.read]'],
  ['worktree.merge.diff', 'c→d', '[file.read]'],
  ['worktree.merge.fileDiff', 'c→d', '[file.read]'],
  ['worktree.merge.approve', 'c→d', '[worktree.merge.decide]'],
  ['worktree.merge.reject', 'c→d', '[worktree.merge.decide]'],
  ['worktree.updated', 'd→c', ''],
  ['worktree.merge.updated', 'd→c', ''],
  ['worktree.removed', 'd→c', ''],
  // §5.8 ("all require admin"; admin.audit.entry is d→c, host only)
  ['admin.invite.create', 'c→d', '[admin]'],
  ['admin.invite.list', 'c→d', '[admin]'],
  ['admin.invite.revoke', 'c→d', '[admin]'],
  ['admin.member.list', 'c→d', '[admin]'],
  ['admin.member.setRole', 'c→d', '[admin]'],
  ['admin.member.kick', 'c→d', '[admin]'],
  ['admin.session.terminate', 'c→d', '[admin]'],
  ['admin.audit.query', 'c→d', '[admin]'],
  ['admin.audit.entry', 'd→c', '[admin]'],
  ['admin.settings.get', 'c→d', '[admin]'],
  ['admin.settings.set', 'c→d', '[admin]'],
  ['admin.claudeConfig.get', 'c→d', '[admin]'],
  ['admin.claudeConfig.decide', 'c→d', '[admin]'],
  ['admin.hostRules.get', 'c→d', '[admin]'],
  ['admin.hostRules.seen', 'c→d', '[admin]'],
  ['admin.transcript.redact', 'c→d', '[admin]'],
];

function expectedAccess(dir: ArchDir, notation: string): MessageAccess {
  const bracket = /^\[(.+)\]$/.exec(notation);
  if (bracket !== null) return bracket[1] as MessageAccess;
  if (notation.startsWith('(')) return 'owner-checked-in-handler';
  if (dir === 'c→d' || dir === 'both') return 'none';
  return 'd→c: recipients' as MessageAccess; // events are checked separately
}

const TO_DIR = { 'c→d': 'c2d', 'd→c': 'd2c', both: 'both' } as const;

describe('registry completeness (ARCHITECTURE §5 ⇄ code)', () => {
  const archTypes = ARCH_CATALOG.map(([type]) => type);

  it('the transcription has no duplicates', () => {
    expect(new Set(archTypes).size).toBe(archTypes.length);
  });

  it.each(archTypes)('%s is registered', (type) => {
    expect(isMessageType(type)).toBe(true);
  });

  it('registers nothing beyond the catalog', () => {
    expect([...MESSAGE_TYPES].sort()).toEqual([...archTypes].sort());
  });

  it('keeps the handshake structures out of the Envelope registry', () => {
    expect(isMessageType('channel.hello')).toBe(false);
    expect(isMessageType('channel.welcome')).toBe(false);
  });

  it('what protocol 4 removed or never had is not a type', () => {
    for (const type of ['admin.hostRules.decide', 'admin.session.usage', 'session.importConfig', 'session.usage']) expect(isMessageType(type), type).toBe(false);
  });
});

describe('direction (Dir column)', () => {
  const rows: [string, ArchDir][] = ARCH_CATALOG.map(([type, dir]) => [type, dir] as [string, ArchDir]);
  it.each(rows)('%s flows %s', (type, dir) => {
    expect(getMessageSpec(type)?.dir).toBe(TO_DIR[dir]);
  });

  it('requests are exactly the c2d types with a result schema', () => {
    for (const type of MESSAGE_TYPES) {
      const spec = MESSAGE_REGISTRY[type];
      if (spec.result !== null) expect(spec.dir, type).toBe('c2d');
    }
  });
});

describe('required capability matches ARCHITECTURE', () => {
  const requestRows = ARCH_CATALOG.filter(([, dir]) => dir !== 'd→c');
  it.each(requestRows)('%s (%s %s)', (type, dir, notation) => {
    expect(getMessageSpec(type)?.capability).toEqual(expectedAccess(dir, notation));
  });

  it('admin.audit.entry is delivered to admins (the host) only', () => {
    expect(MESSAGE_REGISTRY['admin.audit.entry'].capability).toBe('admin');
    expect(MESSAGE_REGISTRY['admin.audit.entry'].checks).toContain('recipients:host');
  });

  it('every owner-checked type names the rule its handler must apply', () => {
    const ownershipChecks = new Set(['session-owner', 'session-end-rule', 'suggestion-author-pending', 'worktree-owner-or-host']);
    for (const type of MESSAGE_TYPES) {
      const spec = MESSAGE_REGISTRY[type];
      if (spec.capability === 'owner-checked-in-handler') {
        expect(spec.checks.some((check) => ownershipChecks.has(check)), type).toBe(true);
      }
    }
  });

  it('the resource rules of ARCHITECTURE §3 are attached to their types', () => {
    // Suggestions go to agent sessions, the author's own included (protocol 3's "not your own session" is gone).
    expect(MESSAGE_REGISTRY['suggest.create'].checks).toEqual(['agent-session', 'session-open', 'suggestion-limit', 'mentions-checked']);
    // ARCHITECTURE §11 D-15: any member who may request a merge may request it for any worktree.
    expect(MESSAGE_REGISTRY['worktree.merge.request'].checks).toEqual([]);
    expect(MESSAGE_REGISTRY['suggest.accept'].checks).toEqual(['suggestion-pending']);
    expect(MESSAGE_REGISTRY['suggest.reject'].checks).toEqual(['suggestion-pending']);
    expect(MESSAGE_REGISTRY['session.end'].checks).toEqual(['session-end-rule']);
    expect(MESSAGE_REGISTRY['exec.resize'].checks).toContain('session-owner');
    expect(MESSAGE_REGISTRY['lock.release'].checks).toContain('human-lock-holder');
    expect(MESSAGE_REGISTRY['file.upload.chunk'].checks).toContain('transfer-connection');
    expect(MESSAGE_REGISTRY['doc.sync'].checks).toContain('doc-content-needs-file.write');
    expect(MESSAGE_REGISTRY['session.create'].checks).toEqual([]);
    // Terminals and agent sessions never share a stream.
    for (const type of ['session.attach', 'exec.input', 'exec.resize'] as const) expect(MESSAGE_REGISTRY[type].checks, type).toContain('terminal-session');
    for (const type of ['session.watch', 'session.history', 'session.cards.get', 'session.message.send', 'session.interrupt', 'session.retry', 'session.restart', 'session.mode.set'] as const) {
      expect(MESSAGE_REGISTRY[type].checks, type).toContain('agent-session');
    }
    // Who decides (routing.ts) is the handler's rule on top of the capability.
    expect(MESSAGE_REGISTRY['question.submit'].checks).toContain('question-may-submit');
    expect(MESSAGE_REGISTRY['permission.decide'].checks).toEqual(['permission-open', 'permission-may-decide']);
    expect(MESSAGE_REGISTRY['report.review'].checks).toContain('report-may-review');
    expect(MESSAGE_REGISTRY['session.retry'].checks).toContain('retry-host-only');
    expect(MESSAGE_REGISTRY['session.mode.set'].checks).toContain('mode-not-fixed');
    expect(MESSAGE_REGISTRY['plan.start'].checks).toContain('plan-pins');
    expect(MESSAGE_REGISTRY['topic.rule.add'].checks).toContain('rule-form');
    // A member without session.drive never messages an agent: their text becomes a suggestion.
    for (const type of ['topic.revise', 'report.followUp'] as const) expect(MESSAGE_REGISTRY[type].checks, type).toContain('drive-or-suggest');
    for (const type of ['session.responsible.set', 'plan.assign'] as const) expect(MESSAGE_REGISTRY[type].checks, type).toContain('responsible-eligible');
    // Every member reads a request's changes; host-private files are withheld.
    for (const type of ['worktree.merge.diff', 'worktree.merge.fileDiff'] as const) expect(MESSAGE_REGISTRY[type].checks, type).toEqual(['host-private-withheld']);
    // Nothing of the inbox names another member.
    for (const type of ['inbox.list', 'inbox.seen', 'inbox.dismiss'] as const) expect(MESSAGE_REGISTRY[type].checks, type).toEqual(['own-inbox']);
    expect(MESSAGE_REGISTRY['inbox.changed'].checks).toEqual(['recipients:self']);
  });

  it('events name their recipients; c2d types do not', () => {
    for (const type of MESSAGE_TYPES) {
      const spec = MESSAGE_REGISTRY[type];
      const hasRecipients = spec.checks.some((check) => check.startsWith('recipients:'));
      if (spec.dir === 'd2c') expect(hasRecipients, type).toBe(true);
      if (spec.dir === 'c2d') expect(hasRecipients, type).toBe(false);
      for (const check of spec.checks) expect(HANDLER_CHECKS).toContain(check);
    }
  });

  it('every handler check is used by some type', () => {
    const used = new Set(MESSAGE_TYPES.flatMap((type) => [...MESSAGE_REGISTRY[type].checks]));
    expect(HANDLER_CHECKS.filter((check) => !used.has(check))).toEqual([]);
  });

  it('card and conversation updates go to the watchers of the session; deltas only to live watchers', () => {
    for (const type of ['session.events', 'question.changed', 'question.updated', 'permission.updated'] as const) {
      expect(MESSAGE_REGISTRY[type].checks, type).toEqual(['recipients:watchers']);
    }
    expect(MESSAGE_REGISTRY['session.delta'].checks).toEqual(['recipients:live-watchers']);
  });
});

describe('volatile messages, rates and size rules (ARCHITECTURE §4.3, §5.9)', () => {
  it('only session.delta is volatile, and it is a d→c event', () => {
    expect(MESSAGE_TYPES.filter((type) => MESSAGE_REGISTRY[type].volatile)).toEqual(['session.delta']);
    expect(MESSAGE_REGISTRY['session.delta'].dir).toBe('d2c');
    expect(VOLATILE_SKIP_BUFFERED_BYTES).toBe(1024 * 1024);
  });

  it('the per-member token buckets the Router applies', () => {
    const rated = Object.fromEntries(MESSAGE_TYPES.filter((type) => MESSAGE_REGISTRY[type].rate !== null).map((type) => [type, MESSAGE_REGISTRY[type].rate]));
    expect(rated).toEqual({
      'question.vote': 'vote',
      'question.comment': 'comment',
      'suggest.create': 'suggestion',
      // An edit is sent whole to everyone a new suggestion is sent to: the same bucket (review R2-05).
      'suggest.edit': 'suggestion',
      'topic.revise': 'suggestion',
      'report.followUp': 'suggestion',
    });
    for (const type of Object.keys(rated)) expect(MESSAGE_REGISTRY[type as MessageType].dir, type).toBe('c2d');
    expect([...RATE_BUCKETS].sort()).toEqual(Object.keys(RATE_LIMITS_PER_MINUTE).sort());
    expect(RATE_LIMITS_PER_MINUTE).toEqual({ vote: 30, comment: 10, suggestion: 10, mention: 20 });
  });

  it('the size rule of every message that carries events, cards or an open-ended list', () => {
    const ruled = Object.fromEntries(MESSAGE_TYPES.filter((type) => MESSAGE_REGISTRY[type].sizeRule !== null).map((type) => [type, MESSAGE_REGISTRY[type].sizeRule]));
    expect(ruled).toEqual({
      'session.list': 'list',
      'suggest.list': 'list',
      'session.watch': 'page',
      'session.history': 'page',
      'session.cards.get': 'page',
      'session.events': 'batch',
      'topic.list': 'list',
      'inbox.list': 'list',
      'inbox.changed': 'list',
      'admin.claudeConfig.get': 'list',
    });
    expect(EVENTS_PAGE_MAX_BYTES).toBeLessThan(LIST_REPLY_MAX_BYTES);
    expect(EVENTS_BATCH_MAX_BYTES).toBeLessThan(EVENTS_PAGE_MAX_BYTES);
  });
});

describe('channels', () => {
  it('transfer messages travel only on the transfer socket, and nothing else does', () => {
    for (const type of MESSAGE_TYPES) {
      const channel = MESSAGE_REGISTRY[type].channel;
      if (type.startsWith('file.upload.') || type.startsWith('file.download.')) expect(channel, type).toBe('transfer');
      else if (type === 'error' || type === 'channel.closed') expect(channel, type).toBe('both');
      else expect(channel, type).toBe('interactive');
    }
  });

  it('uses only the prefixes of SPEC §7.2 plus ARCHITECTURE’s channel/activity/worktree and protocol 4’s six', () => {
    const prefixes = new Set([
      'file', 'doc', 'exec', 'session', 'suggest', 'lock', 'presence', 'admin', 'channel', 'activity', 'worktree',
      'topic', 'plan', 'report', 'question', 'permission', 'inbox',
    ]);
    for (const type of MESSAGE_TYPES) {
      if (type === 'error') continue;
      expect(prefixes.has(type.split('.')[0] as string), type).toBe(true);
    }
  });

  it('type names are well-formed and their .ok names fit MESSAGE_TYPE_MAX_CHARS', () => {
    for (const type of MESSAGE_TYPES) {
      expect(type).toMatch(/^(error|[a-z]+(\.[a-z][A-Za-z]*)+)$/);
      expect(type.endsWith('.ok'), type).toBe(false);
      expect(`${type}.ok`.length).toBeLessThanOrEqual(MESSAGE_TYPE_MAX_CHARS);
    }
  });
});

describe('sensitivity', () => {
  const SENSITIVE_PAYLOADS = [
    'file.write',
    'file.upload.chunk',
    'file.download.chunk',
    'doc.sync',
    'doc.conflict',
    'exec.output',
    'exec.input',
    // what people and agents wrote in a conversation
    'session.events',
    'session.delta',
    'session.message.send',
    'permission.updated',
    'topic.revise',
    'report.followUp',
  ];
  const SENSITIVE_RESULTS = [
    'file.read',
    'doc.conflict.list',
    'doc.conflict.resolve',
    'doc.conflict.get',
    'session.attach',
    'session.watch',
    'session.history',
    'session.cards.get',
    'permission.decide',
    'plan.changes',
    'report.get',
    'worktree.merge.diff',
    'worktree.merge.fileDiff',
    'admin.invite.create',
    'admin.claudeConfig.get',
  ];

  it('flags exactly the payloads that carry contents, keys or secrets', () => {
    expect(MESSAGE_TYPES.filter((type) => MESSAGE_REGISTRY[type].sensitive).sort()).toEqual([...SENSITIVE_PAYLOADS].sort());
    expect(MESSAGE_TYPES.filter((type) => MESSAGE_REGISTRY[type].resultSensitive).sort()).toEqual([...SENSITIVE_RESULTS].sort());
  });

  it('isSensitiveWireType covers payloads, results and unknown types', () => {
    expect(isSensitiveWireType('exec.input')).toBe(true);
    expect(isSensitiveWireType('file.read')).toBe(false);
    expect(isSensitiveWireType('file.read.ok')).toBe(true);
    expect(isSensitiveWireType('admin.invite.create.ok')).toBe(true);
    expect(isSensitiveWireType('bogus.type')).toBe(true);
  });

  it('redactForLog leaves no bytes and no redacted strings in any valid sample', () => {
    const SECRETS = [
      'sk-ant-api03-abc', '#k=abc&s=def', 'diff --git', 'amy()', 'agent()', 'base()',
      // conversations: a person's message, a command, an edit's diff, a note, a suggestion, a report section, a raw settings file
      'Where should the cart live?', 'pnpm test cart', '+++ b/docs/x.md', 'Amy asked for the server', 'Both, behind a flag', 'Run the unit tests only',
      'please run the tests', 'Make the scope smaller', 'does not check stock yet', '"hooks"', '/Users/ian/notes.txt',
      // the diff of the spec since the last Start
      'The cart is kept on the server',
    ];
    for (const type of MESSAGE_TYPES) {
      const samples = MESSAGE_SAMPLES[type];
      const views = [
        ...samples.payload.valid.map((payload) => redactForLog(type, payload)),
        ...(samples.result?.valid ?? []).map((result) => redactForLog(`${type}.ok`, result)),
      ];
      for (const view of views) {
        const text = JSON.stringify(view, (_key, value: unknown) => {
          expect(value instanceof Uint8Array, `${type}: bytes left in log view`).toBe(false);
          return value;
        });
        for (const secret of SECRETS) expect(text.includes(secret), `${type} leaks ${secret}`).toBe(false);
      }
    }
  });

  it('redactForLog keeps a __proto__ key as data and never logs unknown types', () => {
    const view = redactForLog('error', JSON.parse('{"code":"internal","message":"x","detail":{"__proto__":{"polluted":true}}}')) as {
      detail: object;
    };
    expect(Object.getPrototypeOf(view.detail)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(redactForLog('nope', { data: 'secret' })).toBe('[unknown message type: payload not logged]');
  });
});

describe('wire types and router checks', () => {
  it('parses message and response types, and nothing else', () => {
    expect(parseWireType('file.tree')?.kind).toBe('message');
    const response = parseWireType('file.tree.ok');
    expect(response?.kind === 'response' && response.request).toBe('file.tree');
    expect(parseWireType('exec.input.ok')).toBeNull(); // one-way: no .ok
    expect(parseWireType('file.changed.ok')).toBeNull(); // event: no .ok
    expect(parseWireType('error.ok')).toBeNull();
    expect(parseWireType('file.tree.ok.ok')).toBeNull();
    expect(parseWireType('__proto__')).toBeNull();
    expect(parseWireType('constructor')).toBeNull();
    expect(parseWireType('toString.ok')).toBeNull();
    expect(responseTypeOf('doc.open')).toBe('doc.open.ok');
    expect(isRequestType('doc.open')).toBe(true);
    expect(isRequestType('doc.sync')).toBe(false);
  });

  it('mayInvoke applies the capability matrix to client messages', () => {
    expect(mayInvoke('viewer', 'file.write')).toBe(false);
    expect(mayInvoke('editor', 'file.write')).toBe(true);
    expect(mayInvoke('viewer', 'file.upload.chunk')).toBe(false);
    expect(mayInvoke('viewer', 'doc.sync')).toBe(true); // content is dropped by the handler
    expect(mayInvoke('editor', 'session.create')).toBe(false);
    expect(mayInvoke('agent', 'session.create')).toBe(true);
    expect(mayInvoke('host', 'session.create')).toBe(true);
    expect(mayInvoke('host', 'session.importConfig')).toBe(false); // gone with the guest sandbox (D-15)
    expect(mayInvoke('agent', 'admin.member.kick')).toBe(false);
    // ARCHITECTURE §11 D-15: typing into a session and deciding its suggestions is session.drive, for ANY session.
    for (const type of [
      'exec.input', 'suggest.accept', 'suggest.reject', 'session.loginStatus',
      'session.message.send', 'session.interrupt', 'session.retry', 'session.restart', 'session.responsible.set', 'session.mode.set', 'session.rule.remove', 'session.rename',
      'permission.decide', 'topic.rename', 'topic.spec.request', 'topic.rule.add', 'topic.rule.remove',
      'plan.generate', 'plan.mode.set', 'plan.assign', 'plan.suggest', 'plan.resume', 'plan.item.continue', 'plan.item.resolve',
    ]) {
      expect(mayInvoke('host', type)).toBe(true);
      expect(mayInvoke('agent', type)).toBe(true);
      expect(mayInvoke('editor', type)).toBe(false);
      expect(mayInvoke('viewer', type)).toBe(false);
    }
    // Opening or ending agent sessions for a topic is session.create.
    for (const type of ['topic.create', 'topic.archive', 'topic.discussion.restart', 'plan.preflight', 'plan.start', 'plan.item.retry']) {
      expect(mayInvoke('host', type), type).toBe(true);
      expect(mayInvoke('agent', type), type).toBe(true);
      expect(mayInvoke('editor', type), type).toBe(false);
      expect(mayInvoke('viewer', type), type).toBe(false);
    }
    // Everyone but viewers votes, comments, submits among the options (the handler checks who decides) and reviews.
    for (const type of ['question.vote', 'question.comment', 'question.submit', 'question.remind', 'question.seen', 'report.review']) {
      for (const role of ['host', 'agent', 'editor'] as const) expect(mayInvoke(role, type), `${role} ${type}`).toBe(true);
      expect(mayInvoke('viewer', type), type).toBe(false);
    }
    // An Editor's text for an agent is a suggestion; a viewer writes nothing.
    for (const type of ['suggest.create', 'topic.revise', 'report.followUp']) {
      expect(mayInvoke('editor', type), type).toBe(true);
      expect(mayInvoke('viewer', type), type).toBe(false);
    }
    // Viewers watch everything.
    for (const type of ['session.list', 'session.host.get', 'session.watch', 'session.history', 'session.cards.get', 'session.rules.get', 'topic.list', 'plan.get', 'plan.changes', 'report.get', 'inbox.list', 'worktree.merge.diff']) {
      expect(mayInvoke('viewer', type), type).toBe(true);
    }
    for (const type of ['topic.delete', 'admin.claudeConfig.decide', 'admin.hostRules.get', 'admin.transcript.redact']) {
      expect(mayInvoke('host', type), type).toBe(true);
      expect(mayInvoke('agent', type), type).toBe(false);
    }
    expect(mayInvoke('viewer', 'exec.resize')).toBe(true); // the owner check happens in the handler
    expect(mayInvoke('viewer', 'session.end')).toBe(true); // the handler decides who may end which session
    for (const role of ROLES) {
      expect(mayInvoke(role, 'file.changed')).toBe(false); // d→c
      expect(mayInvoke(role, 'file.tree.ok')).toBe(false); // responses are not invocable
      expect(mayInvoke(role, 'nope')).toBe(false);
    }
  });

  it('mayReceive filters events by the recipient capability', () => {
    expect(mayReceive('viewer', 'admin.audit.entry')).toBe(false);
    expect(mayReceive('host', 'admin.audit.entry')).toBe(true);
    expect(mayReceive('viewer', 'exec.output')).toBe(true);
    for (const type of ['session.host', 'session.events', 'session.delta', 'question.updated', 'permission.updated', 'topic.updated', 'plan.updated', 'report.updated', 'inbox.changed']) {
      expect(mayReceive('viewer', type), type).toBe(true);
    }
    expect(mayReceive('viewer', 'file.read.ok')).toBe(true);
    expect(mayReceive('viewer', 'file.read')).toBe(false);
    expect(mayReceive('viewer', 'nope')).toBe(false);
  });

  it('the registry cannot be modified at runtime', () => {
    expect(Object.isFrozen(MESSAGE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(MESSAGE_REGISTRY['file.write'])).toBe(true);
    expect(Object.isFrozen(MESSAGE_REGISTRY['file.write'].checks)).toBe(true);
  });
});

describe('payload and result schemas (table-driven samples)', () => {
  it('there are samples for exactly the registered types', () => {
    expect(Object.keys(MESSAGE_SAMPLES).sort()).toEqual([...MESSAGE_TYPES].sort());
  });

  for (const type of MESSAGE_TYPES) {
    const spec = MESSAGE_REGISTRY[type];
    const samples = MESSAGE_SAMPLES[type as MessageType];
    describe(type, () => {
      it('has at least one valid and one invalid payload sample', () => {
        expect(samples.payload.valid.length).toBeGreaterThan(0);
        expect(samples.payload.invalid.length).toBeGreaterThan(0);
      });
      it.each(samples.payload.valid.map((sample, index) => [index, sample]))('accepts valid payload #%i', (_index, sample) => {
        const result = spec.payload.safeParse(sample);
        expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
      });
      it.each(samples.payload.invalid.map((sample, index) => [index, sample]))('rejects invalid payload #%i', (_index, sample) => {
        expect(spec.payload.safeParse(sample).success).toBe(false);
      });
      if (spec.result === null) {
        it('has no result samples (not a request)', () => expect(samples.result).toBeUndefined());
      } else {
        const resultSchema = spec.result;
        it('has at least one valid and one invalid result sample', () => {
          expect(samples.result?.valid.length).toBeGreaterThan(0);
          expect(samples.result?.invalid.length).toBeGreaterThan(0);
        });
        it.each((samples.result?.valid ?? []).map((sample, index) => [index, sample]))('accepts valid result #%i', (_index, sample) => {
          const result = resultSchema.safeParse(sample);
          expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
        });
        it.each((samples.result?.invalid ?? []).map((sample, index) => [index, sample]))('rejects invalid result #%i', (_index, sample) => {
          expect(resultSchema.safeParse(sample).success).toBe(false);
        });
      }
    });
  }
});

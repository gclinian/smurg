import { describe, expect, it } from 'vitest';
import { ROLES } from '../roles.ts';
import { MESSAGE_SAMPLES } from './message-samples.fixture.ts';
import { isSensitiveWireType, redactForLog } from './redact.ts';
import {
  HANDLER_CHECKS,
  MESSAGE_REGISTRY,
  MESSAGE_TYPES,
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
import { MESSAGE_TYPE_MAX_CHARS } from './limits.ts';

// ---------------------------------------------------------------------------------------------------------------
// ARCHITECTURE §5, transcribed. Every row is one table row of §5.1–§5.8 as written there:
//   [type, Dir column, capability notation of the architecture]
// Notation: '[cap]' = capability in brackets, '(…)' = resource rule in parentheses, '' = nothing given.
// Rows the architecture marks "(addition)" (types added after the original catalog, each with its reason) are in
// ADDED_TYPES below instead. If these lists and the registry disagree, either the code or the architecture changed
// without the other.
// ---------------------------------------------------------------------------------------------------------------

type ArchDir = 'c→d' | 'd→c' | 'both';
const ARCH_CATALOG: readonly (readonly [string, ArchDir, string])[] = [
  // §5.1 (channel.hello / channel.welcome are handshake structures, not Envelopes)
  ['channel.memberUpdated', 'd→c', ''],
  ['channel.closed', 'd→c', ''],
  ['channel.ack', 'both', ''],
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
  // §5.5
  ['session.create', 'c→d', '[session.create]'],
  ['session.list', 'c→d', '[session.view]'],
  ['session.loginStatus', 'c→d', '[session.drive]'],
  ['session.attach', 'c→d', '[session.view]'],
  ['session.detach', 'c→d', ''],
  ['session.end', 'c→d', '(owner)'],
  ['session.state', 'd→c', ''],
  ['exec.output', 'd→c', ''],
  ['exec.input', 'c→d', '[session.drive]'],
  ['exec.resize', 'both', '(owner)'],
  // §5.6
  ['suggest.create', 'c→d', '[suggest.create]'],
  ['suggest.edit', 'c→d', '(author, pending)'],
  ['suggest.withdraw', 'c→d', '(author, pending)'],
  ['suggest.accept', 'c→d', '[session.drive]'],
  ['suggest.reject', 'c→d', '[session.drive]'],
  ['suggest.list', 'c→d', '[session.view]'],
  ['suggest.updated', 'd→c', ''],
  // §5.7
  ['worktree.list', 'c→d', '[file.read]'],
  ['worktree.remove', 'c→d', '(owner or host)'],
  ['worktree.merge.request', 'c→d', '[worktree.merge.request]'],
  ['worktree.merge.list', 'c→d', '[file.read]'],
  ['worktree.merge.diff', 'c→d', '[worktree.merge.request]'],
  ['worktree.merge.approve', 'c→d', '[worktree.merge.decide]'],
  ['worktree.merge.reject', 'c→d', '[worktree.merge.decide]'],
  ['worktree.updated', 'd→c', ''],
  ['worktree.merge.updated', 'd→c', ''],
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
];

/** Rows ARCHITECTURE §5 marks "(addition)"; the registry gives each one its reason (`addition`). */
const ADDED_TYPES: Readonly<Record<string, ArchDir>> = {
  'channel.leave': 'c→d',
  'channel.settingsUpdated': 'd→c',
  'doc.conflict.get': 'c→d',
  'activity.notify': 'd→c',
  'worktree.removed': 'd→c',
  'worktree.merge.fileDiff': 'c→d',
};

/** Architecture notation → the registry's capability, where the two disagree on purpose (none right now). */
const DEVIATING_ACCESS: Readonly<Record<string, { expected: MessageAccess; note: string }>> = {};

function expectedAccess(type: string, dir: ArchDir, notation: string): MessageAccess {
  const deviation = DEVIATING_ACCESS[type];
  if (deviation !== undefined) return deviation.expected;
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

  it('registers nothing beyond the catalog and the documented additions', () => {
    const expected = [...archTypes, ...Object.keys(ADDED_TYPES)].sort();
    expect([...MESSAGE_TYPES].sort()).toEqual(expected);
  });

  it('marks exactly the additions with a reason', () => {
    for (const type of MESSAGE_TYPES) {
      const addition = MESSAGE_REGISTRY[type].addition;
      if (type in ADDED_TYPES) expect(addition, type).toMatch(/\S{10}/);
      else expect(addition, type).toBeNull();
    }
  });

  it('keeps the handshake structures out of the Envelope registry', () => {
    expect(isMessageType('channel.hello')).toBe(false);
    expect(isMessageType('channel.welcome')).toBe(false);
  });
});

describe('direction (Dir column)', () => {
  const rows: [string, ArchDir][] = [...ARCH_CATALOG.map(([type, dir]) => [type, dir] as [string, ArchDir]), ...Object.entries(ADDED_TYPES)];
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
    expect(getMessageSpec(type)?.capability).toEqual(expectedAccess(type, dir, notation));
  });

  it('every deviation note names a real deviation', () => {
    for (const [type, deviation] of Object.entries(DEVIATING_ACCESS)) {
      const row = ARCH_CATALOG.find(([t]) => t === type);
      expect(row, type).toBeDefined();
      expect(deviation.note.length).toBeGreaterThan(5);
      expect(row?.[2].startsWith('['), `${type} already has a bracketed capability`).toBe(false);
    }
  });

  it('admin.audit.entry is delivered to admins (the host) only', () => {
    expect(MESSAGE_REGISTRY['admin.audit.entry'].capability).toBe('admin');
    expect(MESSAGE_REGISTRY['admin.audit.entry'].checks).toContain('recipients:host');
  });

  it('every owner-checked type names the ownership rule its handler must apply', () => {
    const ownershipChecks = new Set([
      'session-owner',
      'suggestion-author-pending',
      'worktree-owner-or-host',
    ]);
    for (const type of MESSAGE_TYPES) {
      const spec = MESSAGE_REGISTRY[type];
      if (spec.capability === 'owner-checked-in-handler') {
        expect(spec.checks.some((check) => ownershipChecks.has(check)), type).toBe(true);
      }
    }
  });

  it('the resource rules of ARCHITECTURE §3 are attached to their types', () => {
    expect(MESSAGE_REGISTRY['suggest.create'].checks).toContain('target-session-not-own');
    // ARCHITECTURE §11 D-15: any member who may request a merge may request it for any worktree.
    expect(MESSAGE_REGISTRY['worktree.merge.request'].checks).toEqual([]);
    expect(MESSAGE_REGISTRY['suggest.accept'].checks).toEqual(['suggestion-pending']);
    expect(MESSAGE_REGISTRY['suggest.reject'].checks).toEqual(['suggestion-pending']);
    expect(MESSAGE_REGISTRY['session.end'].checks).toEqual(['session-owner']);
    expect(MESSAGE_REGISTRY['exec.resize'].checks).toContain('session-owner');
    expect(MESSAGE_REGISTRY['lock.release'].checks).toContain('human-lock-holder');
    expect(MESSAGE_REGISTRY['file.upload.chunk'].checks).toContain('transfer-connection');
    expect(MESSAGE_REGISTRY['doc.sync'].checks).toContain('doc-content-needs-file.write');
    expect(MESSAGE_REGISTRY['session.create'].checks).toEqual([]);
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

  it('uses only the prefixes of SPEC §7.2 plus ARCHITECTURE’s channel/activity/worktree', () => {
    const prefixes = new Set(['file', 'doc', 'exec', 'session', 'suggest', 'lock', 'presence', 'admin', 'channel', 'activity', 'worktree']);
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
  ];
  const SENSITIVE_RESULTS = [
    'file.read',
    'doc.conflict.list',
    'doc.conflict.resolve',
    'doc.conflict.get',
    'session.attach',
    'worktree.merge.diff',
    'worktree.merge.fileDiff',
    'admin.invite.create',
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
    const SECRETS = ['sk-ant-api03-abc', '#k=abc&s=def', 'diff --git', 'amy()', 'agent()', 'base()'];
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
    for (const type of ['exec.input', 'suggest.accept', 'suggest.reject', 'session.loginStatus']) {
      expect(mayInvoke('host', type)).toBe(true);
      expect(mayInvoke('agent', type)).toBe(true);
      expect(mayInvoke('editor', type)).toBe(false);
      expect(mayInvoke('viewer', type)).toBe(false);
    }
    expect(mayInvoke('viewer', 'exec.resize')).toBe(true); // the owner check happens in the handler
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

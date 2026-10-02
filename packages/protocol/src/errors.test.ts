import { describe, expect, it } from 'vitest';
import { decodeEnvelope, encodeEnvelope } from './codec.ts';
import {
  ERROR_CODES,
  ERROR_MESSAGE_MAX_CHARS,
  SmurgError,
  errorPayloadSchema,
  isErrorCode,
  isSmurgError,
} from './errors.ts';
import { defaultErrorRef, msg, render } from './i18n/index.ts';
import {
  diskReportOfError,
  errorReasonOf,
  insufficientDiskError,
  lockOfError,
  lockedError,
} from './schema/error-details.ts';
import { agentLock, disk } from './schema/message-samples.fixture.ts';

describe('error codes', () => {
  it('are exactly those of ARCHITECTURE §4.3', () => {
    expect(ERROR_CODES).toEqual([
      'bad_request',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'locked',
      'path_denied',
      'insufficient_disk',
      'too_large',
      'host_only',
      'internal',
    ]);
    expect(isErrorCode('locked')).toBe(true);
    expect(isErrorCode('hash_mismatch')).toBe(false);
  });

  it('each has a default message: English in `message`, a reference in `text`', () => {
    for (const code of ERROR_CODES) {
      const error = new SmurgError(code);
      expect(error.text).toEqual(defaultErrorRef(code));
      expect(error.message).toBe(render('en', defaultErrorRef(code)));
      expect(/[\u3400-\u9fff]/u.test(error.message)).toBe(false);
      expect(/[\u3400-\u9fff]/u.test(render('zh-TW', error.text) ?? '')).toBe(true);
    }
  });
});

describe('SmurgError', () => {
  it('survives an error Envelope round trip (code, message, detail)', () => {
    const original = new SmurgError('locked', msg('file.lockedByPeople', { names: ['Amy'] }), { reason: 'human-lock', lock: agentLock });
    expect(original.message).toBe('Amy is editing this file.');
    expect(original.toPayload()).toEqual({
      code: 'locked',
      message: 'Amy is editing this file.',
      detail: { reason: 'human-lock', lock: agentLock },
      text: { id: 'file.lockedByPeople', params: { names: ['Amy'] } },
    });
    const bytes = encodeEnvelope({ type: 'error', id: 'req-7', seq: 3, payload: original.toPayload() }, { from: 'daemon', channel: 'interactive' });
    const decoded = decodeEnvelope(bytes, { from: 'daemon', channel: 'interactive' });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.envelope.type !== 'error') throw new Error('unreachable');
    expect(decoded.envelope.id).toBe('req-7');
    const received = SmurgError.fromPayload(decoded.envelope.payload);
    expect(received).toBeInstanceOf(SmurgError);
    expect(received.code).toBe('locked');
    expect(received.message).toBe(original.message);
    expect(received.text).toEqual(original.text);
    expect(render('zh-TW', received.text)).toBe('Amy 正在編輯這個檔案');
    expect(received.detail).toEqual(original.detail);
    expect(lockOfError(received)).toEqual(agentLock);
  });

  it('uses the default message when none is given and omits an absent detail', () => {
    const error = new SmurgError('forbidden');
    expect(error.message).toBe('You do not have permission to do this.');
    expect(error.toPayload()).toEqual({ code: 'forbidden', message: 'You do not have permission to do this.', text: { id: 'error.default.forbidden' } });
    expect('detail' in error.toPayload()).toBe(false);
    expect(error.name).toBe('SmurgError');
    expect(isSmurgError(error)).toBe(true);
    expect(isSmurgError(new Error('x'))).toBe(false);
  });

  it('a plain string is a message without a reference; a payload without `text` gives an error without one', () => {
    const plain = new SmurgError('conflict', 'something specific', { reason: 'x' });
    expect(plain.text).toBeUndefined();
    expect(plain.toPayload()).toEqual({ code: 'conflict', message: 'something specific', detail: { reason: 'x' } });
    expect(SmurgError.fromPayload({ code: 'conflict', message: 'from an older peer' }).text).toBeUndefined();
    const withCause = new SmurgError('internal', msg('git.failed'), undefined, { cause: new Error('boom') });
    expect(withCause.cause).toBeInstanceOf(Error);
    expect(withCause.text).toEqual({ id: 'git.failed' });
  });

  it('clamps long messages to the schema limit without splitting a surrogate pair', () => {
    const long = `${'x'.repeat(ERROR_MESSAGE_MAX_CHARS - 1)}😀tail`;
    const payload = new SmurgError('internal', long).toPayload();
    expect(payload.message.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_CHARS);
    expect(payload.message.endsWith('\ud83d')).toBe(false);
    expect(errorPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('wrap() never exposes internal error text (host paths, stack traces)', () => {
    const fsError = new Error("ENOENT: no such file or directory, open '/Users/ian/.ssh/id_ed25519'");
    const wrapped = SmurgError.wrap(fsError);
    expect(wrapped.code).toBe('internal');
    expect(JSON.stringify(wrapped.toPayload())).not.toContain('/Users/ian');
    expect(wrapped.cause).toBe(fsError);
    const own = new SmurgError('not_found');
    expect(SmurgError.wrap(own)).toBe(own);
  });

  it('falls back to internal for an unknown code', () => {
    expect(new SmurgError('teapot' as 'internal').code).toBe('internal');
  });
});

describe('typed error details', () => {
  it('insufficient_disk carries the DiskReport', () => {
    const error = insufficientDiskError(disk as never, 'Not enough disk space: 20 GiB would be left, less than the reserve of 25 GiB');
    expect(error.code).toBe('insufficient_disk');
    expect(diskReportOfError(error)).toEqual(disk);
    expect(diskReportOfError(new SmurgError('insufficient_disk'))).toBeNull();
    expect(diskReportOfError(new SmurgError('locked', 'x', { disk }))).toBeNull();
  });

  it('locked carries the LockInfo', () => {
    expect(lockOfError(lockedError(agentLock as never))).toEqual(agentLock);
    expect(lockOfError(new SmurgError('locked', 'x', { lock: { kind: 'nope' } }))).toBeNull();
  });

  it('reason is read from detail.reason', () => {
    expect(errorReasonOf(new SmurgError('bad_request', 'x', { reason: 'hash-mismatch' }))).toBe('hash-mismatch');
    expect(errorReasonOf(new SmurgError('bad_request'))).toBeNull();
  });
});

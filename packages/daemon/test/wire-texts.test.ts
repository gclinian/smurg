// The daemon never chooses a display language (ARCHITECTURE §1): everything it writes for people travels as a code
// + a message reference (`@smurg/protocol/i18n`) + its English rendering. These checks are static (they read the
// source) plus a few real objects, so a new throw site or sentence cannot slip in as a finished string.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SmurgError, agentDisplayName, defaultSessionTitle, errorPayloadSchema, messageRefSchema } from '@smurg/protocol';
import { GIT_STEPS, MESSAGE_IDS, isMessageId, msg, render } from '@smurg/protocol/i18n';
import { AuthorizationError, PATH_DENIED_REASONS, PathDeniedError, notImplemented } from '../src/core/errors.ts';
import { POWER_REASONS } from '../src/core/interfaces.ts';
import { unsupportedMessage } from '../src/docs/text-codec.ts';
import { SHARE_ERROR_REASONS, ShareError } from '../src/workspace/share.ts';
import { GitUnavailableError, listedPaths, requireOk } from '../src/worktree/git.ts';
import { policyError } from '../src/worktree/review.ts';
import { mergeCommitMessage, worktreeCommitMessage } from '../src/worktree/worktree-manager.ts';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const PROTOCOL_SRC = fileURLToPath(new URL('../../protocol/src', import.meta.url));
// Han, Bopomofo, CJK punctuation and full-width forms: the definition of the repository's no-CJK rule.
const CJK = /[\u3000-\u303f\u3100-\u312f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

function sourceFiles(dir: string, skip: (path: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path, skip));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !skip(path)) out.push(path);
  }
  return out;
}

const daemonSources = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));

describe('daemon source: no display language', () => {
  it('has no CJK anywhere (code, comments, strings)', () => {
    const offenders = daemonSources.flatMap(({ path, text }) => text.split('\n').flatMap((line, index) => (CJK.test(line) ? [`${path}:${index + 1}`] : [])));
    expect(offenders).toEqual([]);
  });

  it('no error that reaches a client is made from a string: the message argument is msg(...), a reference, or absent', () => {
    // Where the message sits in each constructor / helper that makes a wire error.
    const MESSAGE_ARGUMENT: Readonly<Record<string, number>> = {
      'new SmurgError': 1,
      'new GitUnavailableError': 1,
      'new AuthorizationError': 0,
      sessionError: 1,
      badRequest: 1,
      notAvailable: 1,
      lockedError: 1,
      insufficientDiskError: 1,
    };
    const call = new RegExp(`(?<![A-Za-z.])(${Object.keys(MESSAGE_ARGUMENT).join('|')})\\(`, 'g');
    /** The top-level arguments of the call that starts at `from` (after its opening parenthesis), as far as the line goes. */
    const argumentsAt = (line: string, from: number): string[] => {
      const args: string[] = [];
      let depth = 0;
      let quote: string | null = null;
      let current = '';
      for (let i = from; i < line.length; i++) {
        const ch = line[i] as string;
        if (quote !== null) {
          current += ch;
          if (ch === '\\') current += line[++i] ?? '';
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        if (ch === ')' || ch === ']' || ch === '}') {
          if (depth === 0) break;
          depth -= 1;
        }
        if (ch === ',' && depth === 0) {
          args.push(current.trim());
          current = '';
          continue;
        }
        current += ch;
      }
      args.push(current.trim());
      return args;
    };
    let calls = 0;
    const literalMessages = (line: string): number => {
      if (/^\s*(?:export )?function /.test(line)) return 0; // the helpers' own declarations
      let found = 0;
      for (const match of line.matchAll(call)) {
        calls += 1;
        const message = argumentsAt(line, (match.index ?? 0) + match[0].length)[MESSAGE_ARGUMENT[match[1] as string] as number];
        if (message !== undefined && /^['"`]/.test(message)) found += 1;
      }
      return found;
    };
    // The detector itself: what it must catch and what it must leave alone.
    expect(literalMessages("throw new SmurgError('conflict', 'a finished sentence', { reason: 'x' });")).toBe(1);
    expect(literalMessages('if (bad) throw new SmurgError("conflict", `a ${template}`);')).toBe(1);
    expect(literalMessages("throw new AuthorizationError('a finished sentence', { reason: 'x' });")).toBe(1);
    expect(literalMessages("throw sessionError('conflict', 'a finished sentence', 'stopping');")).toBe(1);
    expect(literalMessages("return notAvailable('git-too-old', `git ${version} is too old`);")).toBe(1);
    expect(literalMessages("throw new SmurgError('conflict', msg('daemon.stopping'), { reason: 'stopping' });")).toBe(0);
    expect(literalMessages("throw new SmurgError('not_found', undefined, { reason: 'vanished' });")).toBe(0);
    expect(literalMessages("throw new SmurgError('forbidden');")).toBe(0);
    expect(literalMessages("throw new AuthorizationError(undefined, { reason: 'capability' });")).toBe(0);
    expect(literalMessages("throw new RootRegistrationError('a local error with English text');")).toBe(0);
    calls = 0;
    const offenders: string[] = [];
    for (const { path, text } of daemonSources) {
      if (path.startsWith('testing/')) continue;
      text.split('\n').forEach((line, index) => {
        if (literalMessages(line) > 0) offenders.push(`${path}:${index + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(calls).toBeGreaterThan(200);
    expect(offenders).toEqual([]);
  });

  it('every wire message id is used: by the daemon, by the client SDK, or through a family helper', () => {
    const haystack = [
      ...daemonSources.map((source) => source.text),
      ...sourceFiles(PROTOCOL_SRC, (path) => path.includes(`${join('i18n', 'messages')}`)).map((path) => readFileSync(path, 'utf8')),
    ].join('\n');
    // Families reached through a helper that builds the id (defaultErrorRef, clientFailureRef, roleRef).
    const viaHelper = (id: string): boolean => id.startsWith('error.default.') || id.startsWith('client.') || id.startsWith('role.');
    const unused = MESSAGE_IDS.filter((id) => !viaHelper(id) && !haystack.includes(`'${id}'`));
    expect(unused).toEqual([]);
  });

  it('every msg(...) id in the daemon exists in the catalog (also a compile error; this catches `as` casts)', () => {
    const used = new Set(daemonSources.flatMap(({ text }) => [...text.matchAll(/\bmsg\(\s*'([^']+)'/g)].map((match) => match[1] as string)));
    expect(used.size).toBeGreaterThan(120);
    expect([...used].filter((id) => !isMessageId(id))).toEqual([]);
  });
});

describe('errors as they reach a client', () => {
  const payloadOf = (error: SmurgError): ReturnType<SmurgError['toPayload']> => {
    const payload = error.toPayload();
    expect(errorPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.message).not.toMatch(CJK);
    // (`message` is clamped to the payload's limit; the reference renders the whole sentence.)
    expect(payload.text === undefined ? null : render('en', payload.text)?.startsWith(payload.message)).toBe(true);
    return payload;
  };

  it('a path refusal: code, reason, one message per reason', () => {
    for (const reason of PATH_DENIED_REASONS) {
      const payload = payloadOf(new PathDeniedError(reason, 'x'));
      expect(payload).toMatchObject({ code: reason === 'host-only' ? 'host_only' : 'path_denied', detail: { reason }, text: { id: expect.stringMatching(/^path\.[a-zA-Z]+$/) } });
    }
    expect(new Set(PATH_DENIED_REASONS.map((reason) => new PathDeniedError(reason, 'x').text?.id)).size).toBe(PATH_DENIED_REASONS.length);
  });

  it('defaults: an authorization refusal and a stub answer carry the default reference of their code', () => {
    expect(payloadOf(new AuthorizationError(undefined, { reason: 'capability' }))).toEqual({
      code: 'forbidden',
      message: 'You do not have permission to do this.',
      detail: { reason: 'capability' },
      text: { id: 'error.default.forbidden' },
    });
    expect(payloadOf(new AuthorizationError(msg('suggest.authorOnly'), { reason: 'not-author:suggestion' }))).toMatchObject({ text: { id: 'suggest.authorOnly' } });
    expect(payloadOf(notImplemented('FileService'))).toMatchObject({ code: 'internal', detail: { reason: 'not-implemented', service: 'FileService' }, text: { id: 'error.default.internal' } });
  });

  it('git steps are ids (never a sentence fragment), also in detail.step', () => {
    const failed = { code: 1, stdout: Buffer.alloc(0), stderr: '', truncated: false } as never;
    const truncated = { code: 0, stdout: Buffer.alloc(0), stderr: '', truncated: true } as never;
    for (const step of GIT_STEPS) {
      let error: unknown = null;
      try {
        requireOk(failed, step);
      } catch (err) {
        error = err;
      }
      expect(payloadOf(error as SmurgError)).toMatchObject({ code: 'internal', detail: { reason: 'git-failed', step }, text: { id: 'git.stepFailed', params: { step } } });
    }
    expect(() => requireOk(truncated, 'diff')).toThrowError(expect.objectContaining({ code: 'too_large', text: { id: 'git.outputTooLarge', params: { step: 'diff' } } }));
    expect(payloadOf(new GitUnavailableError('git-not-found', msg('worktree.unavailable.gitNotFound')))).toMatchObject({ code: 'conflict', detail: { reason: 'git-not-found' } });
  });

  it('lists and sizes are parameters, clipped so the reference always fits the wire', () => {
    const many = Array.from({ length: 40 }, (_, i) => `${'deep/'.repeat(80)}file-${i}.ts`);
    expect(listedPaths(many)).toHaveLength(10);
    expect(listedPaths(many).every((path) => path.length <= 200)).toBe(true);
    const policy = payloadOf(policyError({ reason: 'host-only-paths', paths: many }));
    expect(policy).toMatchObject({ code: 'host_only', detail: { reason: 'host-only-paths', count: 40 }, text: { id: 'merge.containsHostOnly' } });
    expect((policy.detail?.['paths'] as string[]).length).toBe(20);
    expect(messageRefSchema.safeParse(policy.text).success).toBe(true);
    const tooLarge = unsupportedMessage('too-large');
    expect(tooLarge).toEqual({ code: 'too_large', message: { id: 'doc.tooLarge', params: { maxBytes: 5 * 1024 * 1024 } } });
    expect(render('en', tooLarge.message)).toBe('The file is larger than 5.00 MiB and cannot be opened in the editor.');
  });
});

describe('fixed English and language-neutral names', () => {
  it('git commit messages smurg writes are English', () => {
    expect(worktreeCommitMessage('Amy')).toBe('smurg: worktree changes by Amy');
    expect(mergeCommitMessage('smurg/amy-1', 'Amy', undefined)).toBe('Merge smurg/amy-1 (Amy)');
    expect(mergeCommitMessage('smurg/amy-1', 'Amy', 'add tests')).toBe('Merge smurg/amy-1 (Amy)\n\nadd tests');
  });

  it('the agent name and the English default session title', () => {
    expect(agentDisplayName('Ian')).toBe('Claude (Ian)');
    expect(defaultSessionTitle('agent', 'Ian')).toBe('Claude (Ian)');
    expect(defaultSessionTitle('terminal', 'Ian')).toBe('Terminal (Ian)');
  });

  it('reason codes the CLI switches on: ShareError and keep-awake', () => {
    expect([...SHARE_ERROR_REASONS]).toEqual([
      'not-found',
      'not-a-directory',
      'filesystem-root',
      'home-directory',
      'contains-home',
      'contains-homes',
      'state-dir-inside-share',
      'share-inside-state-dir',
      'smurg-not-a-directory',
    ]);
    for (const reason of SHARE_ERROR_REASONS) {
      const error = new ShareError(reason);
      expect(error.reason).toBe(reason);
      expect(error.message).toMatch(/^[a-z.]/);
      expect(error.message).not.toMatch(CJK);
    }
    expect([...POWER_REASONS]).toEqual(['disabled', 'not-started', 'stopped', 'unsupported-platform', 'systemd-inhibit-not-found', 'spawn-failed', 'start-failed', 'exited', 'refused']);
  });
});

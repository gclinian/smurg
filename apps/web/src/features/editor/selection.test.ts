import { MAIN_ROOT, suggestionTextSchema, suggestionSourceSchema } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { capabilitiesForRole } from '../../lib/capabilities.ts';
import { makeSession } from '../../testing/fixtures.ts';
import { buildSelectionPayload, canSendToAgent, formatSelectionForAgent, sanitizeForAgent, selectionLines, sessionTargets } from './selection.ts';

const FILE = { root: MAIN_ROOT, path: 'src/lib/番茄鐘.ts' };

describe('selection → agent text (R6: code selected in the editor goes, with one click, into someone else’s session as a suggestion, or straight into one’s own)', () => {
  it('names the file and the 1-based inclusive line range; a selection ending at column 1 excludes that line', () => {
    expect(selectionLines({ startLine: 3, startColumn: 5, endLine: 7, endColumn: 2 })).toEqual({ startLine: 3, endLine: 7 });
    expect(selectionLines({ startLine: 3, startColumn: 1, endLine: 8, endColumn: 1 })).toEqual({ startLine: 3, endLine: 7 });
    expect(selectionLines({ startLine: 8, startColumn: 1, endLine: 3, endColumn: 1 })).toEqual({ startLine: 3, endLine: 7 });
    expect(selectionLines({ startLine: 4, startColumn: 2, endLine: 4, endColumn: 9 })).toEqual({ startLine: 4, endLine: 4 });

    const result = buildSelectionPayload(FILE, { startLine: 12, startColumn: 1, endLine: 14, endColumn: 10 }, 'const a = 1;\nconst b = 2;\nfoo(a, b);', 'sess_2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The location travels as fields; the text is the code itself (the suggest feature quotes it under the path).
    expect(result.payload).toEqual({ file: FILE, startLine: 12, endLine: 14, sessionId: 'sess_2', text: 'const a = 1;\nconst b = 2;\nfoo(a, b);' });
    // What a suggestion made from it looks like: path and line range, then the code (also the size bound).
    const quoted = formatSelectionForAgent({ file: FILE, startLine: 12, endLine: 14, code: result.payload.text });
    expect(quoted).toBe('src/lib/番茄鐘.ts:12-14\n```\nconst a = 1;\nconst b = 2;\nfoo(a, b);\n```');
    // Valid for the protocol (what suggest.create will carry).
    expect(suggestionTextSchema.safeParse(result.payload.text).success).toBe(true);
    expect(suggestionTextSchema.safeParse(quoted).success).toBe(true);
    expect(suggestionSourceSchema.safeParse({ file: FILE, startLine: 12, endLine: 14 }).success).toBe(true);
  });

  it('cleans what must not reach a terminal (ESC, C1 CSI, bidi overrides, lone surrogates, CR) and keeps emoji and CJK', () => {
    const nasty = 'a\u001b[31mb\u009bc\u202ed\ud800e\r\nf 🙂 你好\tg';
    const clean = sanitizeForAgent(nasty);
    expect(clean).toBe('a\ufffd[31mb\ufffdc\ufffdd\ufffde\nf 🙂 你好\tg');
    const result = buildSelectionPayload(FILE, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 20 }, nasty, 'sess_2');
    expect(result.ok && result.payload.text).toBe(clean);
    expect(result.ok && suggestionTextSchema.safeParse(result.payload.text).success).toBe(true);
  });

  it('uses a code fence longer than any backtick run in the code, and names the worktree', () => {
    const text = formatSelectionForAgent({ file: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'README.md' }, startLine: 2, endLine: 2, code: 'x ```` y' });
    expect(text).toContain('README.md:2 (worktree wt_1)\n');
    expect(text).toContain('`````\nx ```` y\n`````');
  });

  it('refuses an empty or a too large selection instead of sending it', () => {
    expect(buildSelectionPayload(FILE, null, '', 's')).toEqual({ ok: false, problem: 'empty' });
    expect(buildSelectionPayload(FILE, { startLine: 1, startColumn: 3, endLine: 1, endColumn: 3 }, '', 's')).toEqual({ ok: false, problem: 'empty' });
    expect(buildSelectionPayload(FILE, { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }, '   \n', 's')).toEqual({ ok: false, problem: 'empty' });
    const huge = 'x'.repeat(70_000);
    expect(buildSelectionPayload(FILE, { startLine: 1, startColumn: 1, endLine: 1, endColumn: 70_001 }, huge, 's')).toEqual({ ok: false, problem: 'too-large' });
  });

  it('targets: the host and members with agent access type into every running agent session; an editor suggests to other people’s; never terminals or ended sessions', () => {
    const sessions = [
      makeSession({ id: 'mine', ownerUserId: 'dev:amy', ownerName: 'Amy' }),
      makeSession({ id: 'mine-terminal', kind: 'terminal', ownerUserId: 'dev:amy' }),
      makeSession({ id: 'ian', ownerUserId: 'dev:host', ownerName: 'Ian' }),
      makeSession({ id: 'ian-old', ownerUserId: 'dev:host', status: 'exited' }),
    ];
    for (const role of ['agent', 'host'] as const) {
      const driver = sessionTargets(sessions, 'dev:amy', capabilitiesForRole(role));
      expect(driver.own.map((s) => s.id), role).toEqual(['mine', 'ian']);
      expect(driver.others, role).toEqual([]);
    }
    // An editor cannot type but can suggest (never to a session of their own).
    const editor = sessionTargets(sessions, 'dev:amy', capabilitiesForRole('editor'));
    expect(editor.own).toEqual([]);
    expect(editor.others.map((s) => s.id)).toEqual(['ian']);
    // A viewer can do neither: the action is not offered at all.
    const viewer = sessionTargets(sessions, 'dev:amy', capabilitiesForRole('viewer'));
    expect(viewer).toEqual({ own: [], others: [] });
    expect(canSendToAgent(capabilitiesForRole('viewer'))).toBe(false);
    expect(canSendToAgent(capabilitiesForRole('editor'))).toBe(true);
    expect(canSendToAgent(capabilitiesForRole('agent'))).toBe(true);
  });
});

// A result report file → its sections (design Appendix B.2). Pure: a string in, a result out.
import { describe, expect, it } from 'vitest';
import { REPORT_SECTION_MAX_BYTES, reportChecksSchema, wireTextSchema } from '@smurg/protocol';
import { render } from '@smurg/protocol/i18n';
import { REPORT_ERROR_SENTENCES, parseReport, reportMarker, type ReportErrorKind } from '../../src/topics/report-format.ts';

export const CART_REPORT = `# Result report: Cart API

<!-- smurg:report v1 item=cart-api -->
- outcome: complete

## What was done
The cart endpoints (\`GET /cart\`, \`POST /cart/items\`, \`DELETE /cart/items/:id\`) and their tests.

## Why it was done this way
The cart lives in the session store, as decided in question 2 of the spec.

## How it was verified
- [x] \`pnpm test cart\`: 14 tests passed
- [ ] Manual check in the browser: not verified: no browser in this session

## What to watch out for
\`POST /cart/items\` does not check stock yet (item 5 does).

## Follow-ups
None.
`;

function kindsOf(source: string, itemId = 'cart-api'): { kind: ReportErrorKind; line: number; id: string }[] {
  const parse = parseReport(source, itemId);
  if (parse.ok) throw new Error('expected the report not to parse');
  return parse.errors.map((error) => ({ kind: error.kind, line: error.line, id: error.text.id }));
}

describe('the result report format', () => {
  it('reads the outcome, the four sections, the checks with what passed and what was not verified, and the optional follow-ups', () => {
    const parse = parseReport(CART_REPORT, 'cart-api');
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.report).toEqual({
      outcome: 'complete',
      sections: {
        done: 'The cart endpoints (`GET /cart`, `POST /cart/items`, `DELETE /cart/items/:id`) and their tests.',
        why: 'The cart lives in the session store, as decided in question 2 of the spec.',
        verified: [
          { text: '`pnpm test cart`: 14 tests passed', passed: true },
          { text: 'Manual check in the browser', passed: false, note: 'no browser in this session' },
        ],
        watchOut: '`POST /cart/items` does not check stock yet (item 5 does).',
        followUps: 'None.',
      },
      checks: { passed: 1, notVerified: 1 },
    });
  });

  it('partial and blocked are outcomes; Follow-ups may be missing; CRLF parses the same', () => {
    const partial = CART_REPORT.replace('- outcome: complete', '- outcome: partial').replace(/## Follow-ups\nNone\.\n/, '');
    const parse = parseReport(partial.replace(/\n/g, '\r\n'), 'cart-api');
    expect(parse.ok && parse.report.outcome).toBe('partial');
    expect(parse.ok && parse.report.sections.followUps).toBeUndefined();
    expect(parseReport(CART_REPORT.replace('- outcome: complete', '- outcome: Blocked'), 'cart-api')).toMatchObject({ ok: true, report: { outcome: 'blocked' } });
  });

  it('the marker line names the item: a report copied from another item is not this item\'s report', () => {
    expect(kindsOf(CART_REPORT, 'payment-form')).toEqual([{ kind: 'marker', line: 3, id: 'report.error.format' }]);
    expect(reportMarker('cart-api')).toBe('<!-- smurg:report v1 item=cart-api -->');
  });

  it('every failure is one error with its line, a catalog id for people and one fixed sentence for the model', () => {
    expect(kindsOf('')).toEqual([
      { kind: 'title', line: 1, id: 'report.error.format' },
      { kind: 'marker', line: 1, id: 'report.error.format' },
      { kind: 'outcome', line: 1, id: 'report.error.outcome' },
      { kind: 'section-missing', line: 1, id: 'report.error.format' },
      { kind: 'section-missing', line: 1, id: 'report.error.format' },
      { kind: 'section-missing', line: 1, id: 'report.error.format' },
      { kind: 'section-missing', line: 1, id: 'report.error.format' },
    ]);
    expect(kindsOf(CART_REPORT.replace('# Result report: Cart API', '# Cart API'))[0]).toEqual({ kind: 'title', line: 1, id: 'report.error.format' });
    expect(kindsOf(CART_REPORT.replace('- outcome: complete', '- outcome: done'))).toEqual([{ kind: 'outcome', line: 4, id: 'report.error.outcome' }]);
    expect(kindsOf(CART_REPORT.replace('- outcome: complete\n', ''))).toEqual([{ kind: 'outcome', line: 5, id: 'report.error.outcome' }]);
    const withoutWhy = CART_REPORT.replace('## Why it was done this way\nThe cart lives in the session store, as decided in question 2 of the spec.\n\n', '');
    expect(kindsOf(withoutWhy)).toEqual([{ kind: 'section-missing', line: withoutWhy.split('\n').length, id: 'report.error.format' }]);
    expect(kindsOf(CART_REPORT.replace('The cart lives in the session store, as decided in question 2 of the spec.', ''))).toEqual([{ kind: 'section-empty', line: 9, id: 'report.error.format' }]);
    expect(kindsOf(CART_REPORT.replace('## What to watch out for', '## Risks'))).toEqual([
      { kind: 'heading', line: 16, id: 'report.error.format' },
      { kind: 'section-missing', line: CART_REPORT.split('\n').length, id: 'report.error.format' },
    ]);
    // A check that did not pass must say why.
    expect(kindsOf(CART_REPORT.replace(': not verified: no browser in this session', ''))).toEqual([{ kind: 'verified-why', line: 14, id: 'report.error.format' }]);
    expect(kindsOf(CART_REPORT.replace(': not verified: no browser in this session', ': not verified:'))).toEqual([{ kind: 'verified-why', line: 14, id: 'report.error.format' }]);
    expect(kindsOf(CART_REPORT.replace(/- \[x\].*\n- \[ \].*\n/, 'Everything was checked by hand.\n'))).toEqual([{ kind: 'verified-none', line: 12, id: 'report.error.format' }]);
  });

  it('0.7.0 D5: a check that failed is "- [!] <what>: failed: <what happened>", counted apart from the ones not verified', () => {
    const failed = CART_REPORT.replace('- outcome: complete', '- outcome: partial').replace(
      '- [ ] Manual check in the browser: not verified: no browser in this session',
      '- [ ] Manual check in the browser: not verified: no browser in this session\n- [!] `pnpm lint`: failed: 2 errors in src/cart.ts\n* [!] Load test : FAILED : timed out after 30 s',
    );
    const parse = parseReport(failed, 'cart-api');
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.report.outcome).toBe('partial');
    expect(parse.report.sections.verified).toEqual([
      { text: '`pnpm test cart`: 14 tests passed', passed: true },
      { text: 'Manual check in the browser', passed: false, note: 'no browser in this session' },
      { text: '`pnpm lint`', passed: false, failed: true, note: '2 errors in src/cart.ts' },
      { text: 'Load test', passed: false, failed: true, note: 'timed out after 30 s' },
    ]);
    expect(parse.report.checks).toEqual({ passed: 1, notVerified: 1, failed: 2 });
    // What the wire carries: the protocol's own schema of a report's checks takes it.
    expect(reportChecksSchema.safeParse(parse.report.checks).success).toBe(true);
    // Blocked with a failed check is a report too.
    expect(parseReport(failed.replace('- outcome: partial', '- outcome: blocked'), 'cart-api')).toMatchObject({ ok: true, report: { outcome: 'blocked', checks: { failed: 2 } } });
    // Only failed checks: there is no check that passed, but the report reads (whether it merges is not the parser's).
    const onlyFailed = CART_REPORT.replace('- outcome: complete', '- outcome: partial').replace(/- \[x\].*\n- \[ \].*\n/, '- [!] tests: failed: 3 of 14 failed\n');
    expect(parseReport(onlyFailed, 'cart-api')).toMatchObject({ ok: true, report: { checks: { passed: 0, notVerified: 0, failed: 1 } } });
  });

  it('0.7.0 D5: a failed check must say what happened; with a failed check the outcome cannot be complete (the error is at the outcome line)', () => {
    const line = (check: string): string => CART_REPORT.replace('- outcome: complete', '- outcome: partial').replace('- [ ] Manual check in the browser: not verified: no browser in this session', check);
    for (const check of ['- [!] `pnpm lint`', '- [!] `pnpm lint`: failed:', '- [!] : failed: 2 errors', '- [!] `pnpm lint`: not verified: no linter', '- [!] `pnpm lint` failed with 2 errors']) {
      expect(kindsOf(line(check)), check).toEqual([{ kind: 'verified-failed-why', line: 14, id: 'report.error.format' }]);
    }
    const complete = CART_REPORT.replace('- [ ] Manual check in the browser: not verified: no browser in this session', '- [!] `pnpm lint`: failed: 2 errors in src/cart.ts');
    expect(kindsOf(complete)).toEqual([{ kind: 'outcome-failed', line: 4, id: 'report.error.outcome' }]);
    const parse = parseReport(complete, 'cart-api');
    if (parse.ok) throw new Error('a complete report with a failed check');
    expect(parse.errors[0]?.model).toBe('A report with a failed check is not complete: set the outcome line to partial, or make the check pass and mark it "- [x]".');
    expect(REPORT_ERROR_SENTENCES['verified-failed-why']).toBe('A check that failed is written "- [!] <what>: failed: <what happened>" and must say what happened.');
    expect(REPORT_ERROR_SENTENCES['verified-none']).toBe(
      'Under "How it was verified" list at least one check as "- [x] <what passed>", "- [ ] <what>: not verified: <why>" or "- [!] <what>: failed: <what happened>".',
    );
    // A failed check without its words is not "no check at all": one error, the one to fix.
    expect(kindsOf(CART_REPORT.replace(/- \[x\].*\n- \[ \].*\n/, '- [!] lint\n'))).toEqual([{ kind: 'verified-failed-why', line: 13, id: 'report.error.format' }]);
    // Fixed: partial, or the check passed.
    expect(parseReport(complete.replace('- outcome: complete', '- outcome: partial'), 'cart-api').ok).toBe(true);
    expect(parseReport(complete.replace('- [!] `pnpm lint`: failed: 2 errors in src/cart.ts', '- [x] `pnpm lint`: no errors'), 'cart-api').ok).toBe(true);
  });

  it('0.7.0 D5: a report of 0.6.0 parses to exactly what it did (no `failed` key without a failed check)', () => {
    const parse = parseReport(CART_REPORT, 'cart-api');
    expect(parse.ok && parse.report.checks).toEqual({ passed: 1, notVerified: 1 });
    expect(parse.ok && Object.keys(parse.report.checks)).toEqual(['passed', 'notVerified']);
    expect(parse.ok && parse.report.sections.verified.some((check) => 'failed' in check)).toBe(false);
    // `[x]`, `[X]` and `[ ]` read as before; "failed" in a passed check's words is the agent's own text. (Changed in the
    // 0.7.0 review: the words of a failed check's line, "<what>: failed: …", with a ticked box are refused now, below.)
    const passedWithWord = CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', '- [X] `pnpm test cart`: 14 passed, 0 failed');
    expect(parseReport(passedWithWord, 'cart-api')).toMatchObject({ ok: true, report: { checks: { passed: 1, notVerified: 1 } } });
  });

  it('0.7.0 review: a ticked box whose words are those of a check that failed or did not run is refused at its line, not counted as passed', () => {
    // (until the review `- [x] pnpm test: failed: …` parsed as a passed check, and smurg merged the report by itself;
    // the line said what the `[!]` line says)
    const failedTicked = CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', '- [x] `pnpm test cart`: failed: 2 of 14 tests failed');
    const parse = parseReport(failedTicked, 'cart-api');
    expect(parse.ok).toBe(false);
    expect(parse.ok ? [] : parse.errors.map((entry) => [entry.kind, entry.model])).toEqual([['verified-ticked', 'A ticked box "- [x]" is a check that passed. A check that failed is written "- [!] <what>: failed: <what happened>", one that did not run "- [ ] <what>: not verified: <why>".']]);
    expect(parseReport(CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', '- [X] Manual check: not verified: no browser'), 'cart-api').ok).toBe(false);
    // Written as the line it means, it parses.
    expect(parseReport(CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', '- [!] `pnpm test cart`: failed: 2 of 14 tests failed').replace('- outcome: complete', '- outcome: partial'), 'cart-api')).toMatchObject({ ok: true, report: { checks: { passed: 0, failed: 1 } } });
  });

  // 0.7.0 verify (W/verify/safe h2, h3): only the exact "<what>: failed: …" and "<what>: not verified: …" were refused;
  // a ticked box saying the same in nearly the same words parsed as passed, and smurg merged the report by itself.
  it('0.7.0 verify: a ticked box whose words say the check failed or did not run, in other words than the exact form, is refused too', () => {
    const ticked = (line: string): string => CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', line);
    for (const line of [
      '- [x] `pnpm test`: FAILED (2 of 3 tests failed)',
      '- [x] `pnpm test` failed: 2 of 3 tests',
      '- [x] `pnpm test` — failed: 2 of 3 tests',
      '- [x] `pnpm test` - fails on CI',
      '- [x] `pnpm test`: failed (2 of 3 tests)',
      '- [x] `pnpm test`: not verified (no network)',
      '- [x] `pnpm test` failed (2 of 3)',
      '- [X] `pnpm test`：失敗：2 個測試沒過',
      '- [x] 手動測試：未驗證（沒有瀏覽器）',
    ]) {
      const parse = parseReport(ticked(line), 'cart-api');
      expect(parse.ok, line).toBe(false);
      expect(parse.ok ? [] : parse.errors.map((entry) => entry.kind), line).toEqual(['verified-ticked']);
    }
    // A passed check whose own words mention failures is still a passed check.
    for (const line of ['- [x] `pnpm test`: 14 passed, 0 failed', '- [x] `pnpm test` (14 passed, 0 failed)', '- [x] lint: no failures', '- [x] `pnpm test`: failures fixed, all 14 pass', '- [x] the failover test passes']) {
      expect(parseReport(ticked(line), 'cart-api'), line).toMatchObject({ ok: true, report: { checks: { passed: 1 } } });
    }
  });

  it('0.7.0 verify: reading a ticked check\'s words takes linear time (a long run of blanks and dashes)', () => {
    const long = `- [x] ${'a '.repeat(20_000)}${' '.repeat(20_000)}-${' -'.repeat(20_000)} done`;
    const start = performance.now();
    parseReport(CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', long), 'cart-api');
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('the sections must come in the fixed order, each once', () => {
    const swapped = CART_REPORT.replace('## What was done', '## TEMP').replace('## Why it was done this way', '## What was done').replace('## TEMP', '## Why it was done this way');
    expect(kindsOf(swapped).map((error) => error.kind)).toEqual(['section-order']);
  });

  it('a section larger than 64 KiB is refused', () => {
    const big = CART_REPORT.replace('`POST /cart/items` does not check stock yet (item 5 does).', 'x'.repeat(REPORT_SECTION_MAX_BYTES + 1));
    expect(kindsOf(big)).toEqual([{ kind: 'section-too-long', line: 16, id: 'report.error.format' }]);
  });

  it('a "## heading" or a "- [ ]" inside a code fence is text of its section', () => {
    const fenced = CART_REPORT.replace('The cart endpoints', 'Like this:\n\n```md\n## Not a section\n- [ ] not a check\n```\n\nThe cart endpoints');
    const parse = parseReport(fenced, 'cart-api');
    expect(parse.ok && parse.report.sections.done).toContain('## Not a section');
    expect(parse.ok && parse.report.checks).toEqual({ passed: 1, notVerified: 1 });
  });

  it('what agents print is masked in the sections people read', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const parse = parseReport(CART_REPORT.replace('and their tests.', `and their tests. Token used: ${secret}`), 'cart-api');
    expect(parse.ok && parse.report.sections.done).not.toContain(secret);
    expect(parse.ok && parse.report.sections.done).toContain('[masked]');
  });

  it('findings never copy a token from the file', () => {
    const parse = parseReport('# Result report: X\n\n<!-- smurg:report v1 item=SECRET -->\n- outcome: SECRET\n\n## SECRET heading\ntext\n', 'cart-api');
    expect(parse.ok).toBe(false);
    if (parse.ok) return;
    for (const error of parse.errors) {
      expect(error.model).toBe(REPORT_ERROR_SENTENCES[error.kind]);
      expect(JSON.stringify(error.text)).not.toMatch(/SECRET/);
      expect(render('zh-TW', error.text)).toBeTruthy();
      expect(wireTextSchema.safeParse({ text: error.text, fallback: render('en', error.text) }).success).toBe(true);
    }
    expect(Object.values(REPORT_ERROR_SENTENCES).every((sentence) => /^[\x20-\x7e]+$/.test(sentence))).toBe(true);
  });
});

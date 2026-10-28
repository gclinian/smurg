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

/** What the agent reads when a ticked box's words read as a check that failed or did not run (`verified-ticked`). */
const TICKED_SENTENCE =
  'A ticked box "- [x]" is a check that passed, and these words read as a check that failed or did not run. If the check passed, keep it ticked and reword it so that its words do not read as a failure. If it failed, write it "- [!] <what>: failed: <what happened>"; if it did not run, "- [ ] <what>: not verified: <why>".';

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
    // (changed in the 0.7.0 last check, fix3: the sentence also says what to do with a check that passed, so that a
    // passed check whose words were taken for a failure is reworded, never written as failed or not run)
    expect(parse.ok ? [] : parse.errors.map((entry) => [entry.kind, entry.model])).toEqual([['verified-ticked', TICKED_SENTENCE]]);
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
      // (changed in the 0.7.0 last check, fix3: "- fails on CI" reads like "Login: fails with a wrong password, as it
      // should", a passed check naming a failure; "fails" says the check failed only where the words stop after it or
      // punctuation follows, "failed" whatever follows: the table below)
      '- [x] `pnpm test` - failed on CI',
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

  // 0.7.0 last check (W/verify/last F2, the lead's decision; fix3): a failure word at the start of the words after the
  // first colon, or at the end of the words before it, refused ticked checks that PASSED ("failing writes are
  // retried", "… when the database fails:"). An agent that followed the sentence rewrote such a check as failed or not
  // run, and an unattended run stopped on a check that passed. Now: after the first colon or dash, the outcome words
  // (failed, not verified, not run, 未驗證) say so whatever follows them, and fail, fails, failing, failure and 失敗 only
  // where the words stop after them or punctuation or a parenthesis follows; before the colon, only the outcome words
  // at the end of <what> do. The sentence tells the agent to reword a check that passed.
  describe('0.7.0 last check: a ticked check that names a failure is a passed check; one whose words say it failed or did not run is refused', () => {
    const ticked = (line: string): string => CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', line);
    const PASSED: readonly string[] = [
      // the five lines of the last check (they were refused on ce17d71)
      '- [x] Error handling: failing writes are retried (`pnpm test retry`, 6 passed)',
      '- [x] `pnpm test upload`: failure path and success path both pass (9 passed)',
      '- [x] The API answers 503 when the database fails: `pnpm test api` (12 passed)',
      '- [x] Checkout shows an error when the payment fails: covered by `pnpm test checkout`, 8 passed',
      '- [x] Login: fails with a wrong password, as it should (`pnpm test auth`, 5 passed)',
      // more of the same kind
      '- [x] Upload - failure messages are shown in red (`pnpm test upload`, 3 passed)',
      '- [x] Storage: fail-safe mode keeps the data (`pnpm test storage`, 4 passed)',
      '- [x] Retry: a write that fails is retried twice (`pnpm test retry`, 6 passed)',
      '- [x] Billing: payments that failed are retried (`pnpm test billing`, 7 passed)',
      '- [x] When the network fails, the page says so (`pnpm test offline`, 2 passed)',
      '- [x] `pnpm test`: 14 passed, 0 failed',
      '- [x] `pnpm test` (14 passed, 0 failed)',
      '- [x] lint: no failures',
      '- [x] the failover test passes',
      // Traditional Chinese
      '- [x] 錯誤處理：失敗的寫入會重試（`pnpm test retry`，6 個通過）',
      '- [x] `pnpm test upload`：失敗和成功的路徑都通過（9 個通過）',
      '- [x] 資料庫失敗時 API 回 503：`pnpm test api`（12 個通過）',
      '- [x] 付款失敗時結帳頁顯示錯誤：`pnpm test checkout` 涵蓋，8 個通過',
      '- [x] 登入：密碼錯誤時會失敗，這是對的（`pnpm test auth`，5 個通過）',
      '- [x] 上傳 — 失敗的訊息顯示成紅色（`pnpm test upload`，3 個通過）',
      '- [x] `pnpm test`：14 個通過，0 個失敗',
    ];
    const REFUSED: readonly string[] = [
      // every form the safe verifier's finding 5 listed (W/verify/safe h2, h3)
      '- [x] `pnpm test`: FAILED (2 of 3 tests failed)',
      '- [x] `pnpm test` failed: 2 of 3 tests failed',
      '- [x] `pnpm test` — failed: 2 of 3 tests failed',
      '- [x] `pnpm test`: failed (2 of 3 tests)',
      '- [x] `pnpm test`: not verified (no network)',
      '- [x] `pnpm test`：失敗：3 個測試中 2 個失敗',
      // the exact forms
      '- [x] `pnpm test`: failed: 2 of 3 tests failed',
      '- [X] Manual check: not verified: no browser',
      // failed, not verified, not run: whatever follows them
      '- [x] `pnpm test`: failed because the database was down',
      '- [x] `pnpm test`: failed with 2 errors in src/cart.ts',
      '- [x] `pnpm test`: failed 2 of 3 tests',
      '- [x] `pnpm lint`: Failed!',
      '- [x] `pnpm test` - failed on CI',
      '- [x] `pnpm e2e`: not run (no browser)',
      '- [x] `pnpm e2e`: not run because there is no browser here',
      '- [x] Manual check: not verified, no browser here',
      '- [x] `pnpm test` not run',
      '- [x] `pnpm test` not verified (no network)',
      '- [x] `pnpm test` failed (2 of 3)',
      '- [x] `pnpm test` failed',
      // fail, fails, failing, failure: where the words stop after them or punctuation or a parenthesis follows
      '- [x] `pnpm test`: FAIL (2 of 3)',
      '- [x] `pnpm test`: fails.',
      '- [x] `pnpm test`: fails',
      '- [x] `pnpm test`: failing, 2 of 3',
      '- [x] `pnpm test`: failure (exit code 1)',
      '- [x] `pnpm test` - FAIL - 2 of 3',
      '- [x] `pnpm test` — fails; see the log',
      // Traditional Chinese
      '- [X] `pnpm test`：失敗：2 個測試沒過',
      '- [x] `pnpm test`：失敗（3 個中 2 個）',
      '- [x] `pnpm test`：失敗，資料庫沒有開',
      '- [x] `pnpm test`：失敗了，3 個中 2 個',
      '- [x] `pnpm test`：失敗。',
      '- [x] `pnpm test`：失敗',
      '- [x] `pnpm test`: 失敗 (2 of 3)',
      '- [x] 手動測試：未驗證（沒有瀏覽器）',
      '- [x] 手動測試：未驗證，因為沒有瀏覽器',
      '- [x] 手動測試：未驗證因為沒有瀏覽器',
      '- [x] `pnpm test` 失敗：3 個中 2 個',
      '- [x] `pnpm test` 失敗（3 個中 2 個）',
      '- [x] `pnpm test` — 失敗：3 個中 2 個',
      '- [x] `pnpm test` 未驗證（沒有網路）',
    ];

    it.each(PASSED)('passes: %s', (line) => {
      expect(parseReport(ticked(line), 'cart-api'), line).toMatchObject({ ok: true, report: { outcome: 'complete', checks: { passed: 1, notVerified: 1 } } });
    });

    it.each(REFUSED)('refused at its line, with the sentence that says how to write it: %s', (line) => {
      const parse = parseReport(ticked(line), 'cart-api');
      expect(parse.ok, line).toBe(false);
      expect(parse.ok ? [] : parse.errors.map((entry) => [entry.kind, entry.line, entry.model]), line).toEqual([['verified-ticked', 13, TICKED_SENTENCE]]);
    });

    it('a check that passed but was taken for a failure costs one rewording: the same check in other words passes, nothing is written as failed', () => {
      const taken = '- [x] Billing: failed payments are retried (`pnpm test billing`, 7 passed)';
      const parse = parseReport(ticked(taken), 'cart-api');
      expect(parse.ok ? [] : parse.errors.map((entry) => entry.kind)).toEqual(['verified-ticked']);
      expect(parse.ok ? '' : parse.errors[0]?.model).toContain('If the check passed, keep it ticked and reword it so that its words do not read as a failure.');
      expect(parseReport(ticked('- [x] Billing: payments that failed are retried (`pnpm test billing`, 7 passed)'), 'cart-api')).toMatchObject({ ok: true, report: { checks: { passed: 1 } } });
    });
  });

  // The check of 76114a1 (W/verify/last3/ticked, the lead's decisions T1-T3; fix4): ticked lines that say the check failed
  // without a colon or dash, or in the runner's own upper-case FAIL after one, merged untested work (T1); `mask()` ran
  // before the words were read, so "password:" or "token:" before "failed" hid it (T2); a line that counts failures or
  // errors that are not zero is a failed check too (the lead's addition to T1, "T4"); and three kinds of passed checks
  // are no longer taken for failures (T3).
  describe('0.7.0 fix4: a ticked check that says it failed in any of these words is refused; the passed checks next to them pass', () => {
    const ticked = (line: string): string => CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', line);
    const REFUSED_NOW: readonly string[] = [
      // T1: neither colon nor dash, a behaviour word at the end; the runner's FAIL before a file or a package
      '- [x] `pnpm test` FAIL (2 of 14)',
      '- [x] `pnpm test` fails',
      '- [x] `pnpm test` is failing (2 of 14)',
      '- [x] `pnpm test` FAIL',
      '- [x] `pnpm test`: FAIL src/cart.test.ts (2 tests)',
      '- [x] `go test ./...`: FAIL github.com/acme/cart 0.41s',
      '- [x] `pnpm test` — FAIL src/cart.test.ts > total > rounds to cents',
      '- [x] `pnpm test`：FAIL src/cart.test.ts',
      // T2: a credential's name before the failure word
      '- [x] Login with a wrong password: failed (got 500, expected 401)',
      '- [x] Refresh token: fails (expired after 1 s)',
      '- [x] Refresh token: failed: expired after 1 s',
      '- [x] Reset password: FAILED (mail server down)',
      // T4: a count of failures or errors that is not zero
      '- [x] `pnpm test`: 12 passed, 2 failed',
      '- [x] `pnpm test`: 2 tests fail in cart.test.ts',
      '- [x] `pnpm test`: 2 tests fail',
      '- [x] Ran `pnpm test`: 2 of 14 failed',
      '- [x] `pnpm test`: 2/14 failed',
      '- [x] `pnpm lint` failed with 3 errors',
      '- [x] `pnpm lint`: 1 error',
      '- [x] `pnpm test`: 2 failures in legacy.test.ts (they failed before this change too)',
      '- [x] `node --test`: pass 12, fail 2',
      '- [x] `pnpm test`：2 個測試失敗',
      '- [x] `pnpm test` 失敗了 2 個',
      '- [x] `pnpm build`：型別檢查有 3 個錯誤',
      '- [x] `pnpm test`：未通過（2 個失敗）',
    ];
    const PASSED_STILL: readonly string[] = [
      // next to T1: a parenthesis that holds a command, a count after FAIL, a runner's ok
      '- [x] Shows a toast when saving fails (`pnpm test toast`, 2 passed)',
      '- [x] `pnpm test`: FAIL 0, PASS 42',
      '- [x] `go test ./...`: ok github.com/acme/cart 0.41s',
      // next to T4: a zero, none, and counts of what is no failure
      '- [x] `pnpm test`: 14 passed, 0 failed',
      '- [x] `cargo test`: test result: ok. 31 passed; 0 failed',
      '- [x] `pnpm lint`: no failures',
      '- [x] `pnpm lint`: 0 errors, 2 warnings',
      '- [x] `node --test`: pass 14, fail 0',
      '- [x] `pnpm test`：0 個失敗，42 個通過',
      '- [x] Negative case: fails with exit code 1 on a missing file (`pnpm test cli`, 7 passed)',
      '- [x] Exit codes: a failed build exits 1, a passing one 0 (`pnpm test cli`, 4 passed)',
      '- [x] Lockout: 5 failed logins lock the account (`pnpm test auth`, 5 passed)',
      '- [x] Retry: a write is retried up to 3 times (`pnpm test retry`, 6 passed)',
      '- [x] Not found: a 404 error page is shown (`pnpm test web`, 2 passed)',
      '- [x] `pnpm test`: 14 passed (2 failed before the fix)',
      '- [x] `pnpm vitest -t "2 tests fail"`: 4 passed',
      '- [x] 錯誤訊息：3 個錯誤訊息都正確顯示（`pnpm test ui`，3 個通過）',
      '- [x] 重試：寫入最多重試 3 次（`pnpm test retry`，6 個通過）',
      // T3: refused on 76114a1, passed checks that name a failure
      '- [x] Requests that failed (HTTP 503) are retried: `pnpm test retry`, 6 passed',
      '- [x] API：未驗證的請求回傳 401（`pnpm test api`，8 個通過）',
      '- [x] 登入：未驗證的 email 無法登入（`pnpm test auth`，4 個通過）',
      '- [x] 寫入 DB 失敗（逾時）會重試：`pnpm test retry`（6 個通過）',
    ];

    it.each(REFUSED_NOW)('refused at its line, with the sentence that says how to write it: %s', (line) => {
      const parse = parseReport(ticked(line), 'cart-api');
      expect(parse.ok, line).toBe(false);
      expect(parse.ok ? [] : parse.errors.map((entry) => [entry.kind, entry.line, entry.model]), line).toEqual([['verified-ticked', 13, TICKED_SENTENCE]]);
    });

    it.each(PASSED_STILL)('passes: %s', (line) => {
      expect(parseReport(ticked(line), 'cart-api'), line).toMatchObject({ ok: true, report: { outcome: 'complete', checks: { passed: 1, notVerified: 1 } } });
    });

    it('T2: a failed check after a credential\'s name is written as the sentence says, and every part of it is stored masked', () => {
      const failed = (line: string): string => CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', line).replace('- outcome: complete', '- outcome: partial');
      // (on 76114a1 both were refused 'verified-failed-why': "failed" was masked, and the sentence named the form used)
      expect(parseReport(failed('- [!] Refresh token: failed: expired after 1 s'), 'cart-api')).toMatchObject({
        ok: true,
        report: { checks: { passed: 0, notVerified: 1, failed: 1 }, sections: { verified: [{ text: 'Refresh token', passed: false, failed: true, note: 'expired after 1 s' }, { passed: false }] } },
      });
      expect(parseReport(failed('- [!] Login with a wrong password: failed: the API answered 500, not 401'), 'cart-api')).toMatchObject({ ok: true, report: { checks: { failed: 1 } } });
      // Read unmasked, stored masked: nothing of a credential reaches the stored check, in either part of the line.
      const key = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
      const parse = parseReport(failed(`- [!] Deploy with token: ${key}: failed: password: hunter22 was refused`), 'cart-api');
      expect(parse).toMatchObject({ ok: true, report: { sections: { verified: [{ text: 'Deploy with token: [masked]', failed: true, note: 'password: [masked] was refused' }, { passed: false }] } } });
      expect(JSON.stringify(parse)).not.toMatch(/ghp_|hunter22/);
      const passed = parseReport(CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', `- [x] Deploy with token: ${key} (\`pnpm deploy --dry-run\`, ok)`), 'cart-api');
      expect(passed).toMatchObject({ ok: true, report: { sections: { verified: [{ text: 'Deploy with token: [masked] (`pnpm deploy --dry-run`, ok)', passed: true }, { passed: false }] } } });
      const notRun = parseReport(CART_REPORT.replace('- [ ] Manual check in the browser: not verified: no browser in this session', `- [ ] Deploy with token: ${key}: not verified: secret: hunter22 expired`), 'cart-api');
      expect(notRun).toMatchObject({ ok: true, report: { sections: { verified: [{ passed: true }, { text: 'Deploy with token: [masked]', passed: false, note: 'secret: [masked] expired' }] } } });
      // A refused line's error never carries the words.
      const refused = parseReport(CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', `- [x] Deploy with token: ${key}: failed: password: hunter22 was refused`), 'cart-api');
      expect(refused.ok ? null : refused.errors.map((entry) => entry.kind)).toEqual(['verified-ticked']);
      expect(JSON.stringify(refused)).not.toMatch(/ghp_|hunter22/);
    });
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

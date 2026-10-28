// A result report file → its sections (design Appendix B.2). Pure: a string in, a result out.
import { describe, expect, it } from 'vitest';
import { REPORT_SECTION_MAX_BYTES, reportChecksSchema, wireTextSchema } from '@smurg/protocol';
import { render } from '@smurg/protocol/i18n';
import { costOf, machineSlowness } from '@smurg/protocol/testing';
import { TOPIC_FILE_MAX_BYTES } from '../../src/topics/core.ts';
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

  // The check of d374e39 (W/verify/last4/ticked, the lead's decisions R1-R6; fix5): ticked lines that say the check
  // failed or did not run before a parenthesis and more words, or 未驗證 and a reason, merged untested work again (R1, a
  // regression of fix4's narrowing); counts quoted after the colon and in the usual wordings were not read (R3); the
  // runners' verdicts where they print them were not either (R4); passed checks that name a count of failures in quotes
  // or after "after" were refused (R5); and a key block split by ": failed:" was stored (R6). The reading stays a net
  // for the common contradictions: number words (`two tests fail`) are not read, nor is `fails (`total()` is off by one)`.
  describe('0.7.0 fix5: the runners\' verdicts and counts where they print them, and an outcome before a parenthesis and more words, are refused; counts a check looks at pass', () => {
    const ticked = (line: string): string => CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', line);
    const REFUSED_FIX5: readonly string[] = [
      // R1: an outcome word, a parenthesis (with code spans), then a place or what comes of it; 未驗證 and a reason
      '- [x] `pnpm test` failed (2 of 14) on CI',
      '- [x] `pnpm test` failed (see `total()`)',
      '- [x] `pnpm e2e` not run (no browser), will run in CI',
      '- [x] `pnpm test` failed (exit code 1) after the rebase',
      '- [x] `pnpm test` failed (2 of 14; `total()` rounds wrong)',
      '- [x] `pnpm e2e` was not run (no browser) and needs a manual check',
      '- [x] `pnpm test` failed (2 of 14), see the CI log',
      '- [x] `pnpm test` 失敗（3 個中 2 個），之後再修',
      '- [x] `pnpm test` 失敗（見 `total()`）',
      '- [x] `pnpm e2e` 未驗證（沒有瀏覽器），留待 CI',
      '- [x] `pnpm e2e`：未驗證 因為沒有瀏覽器',
      '- [x] 手動測試：未驗證過',
      '- [x] 手動測試：未驗證是因為沒有瀏覽器',
      '- [x] 手動測試：未驗證 沒有瀏覽器',
      // R3: the runner's line quoted after the colon (or in a line with neither), and the usual count wordings
      '- [x] `pnpm test`: `Tests  2 failed | 12 passed (14)`',
      '- [x] `pnpm vitest run` printed `Tests  2 failed | 40 passed (42)`',
      '- [x] `pytest -q`: `2 failed, 21 passed in 1.02s`',
      '- [x] `go test ./...`: `FAIL github.com/acme/cart 0.41s`',
      '- [x] `pnpm test`：輸出 `2 failed | 12 passed`',
      '- [x] `pnpm test`: 2 tests are failing',
      '- [x] `pnpm test`: 2 tests still fail',
      '- [x] `pytest`: Interrupted: 1 error during collection',
      '- [x] `cargo test`: error: could not compile `cart` due to 2 previous errors',
      '- [x] `pnpm test`：2/14 失敗',
      '- [x] `pnpm build`：型別錯誤 3 個',
      // R4: the runners' verdicts where they print them
      '- [x] `go test ./...`: --- FAIL: TestTotal (0.00s)',
      '- [x] `go test ./...` exits 1: --- FAIL: TestTotal',
      '- [x] `go test ./...`：--- FAIL: TestTotal',
      '- [x] `cargo test`: test result: FAILED',
      '- [x] `pytest` FAILED tests/test_cart.py::test_total',
      '- [x] `npx jest` → FAIL src/cart.test.js',
      '- [x] `pnpm test` FAIL (`src/cart.test.ts`)',
    ];
    const PASSED_FIX5: readonly string[] = [
      // R5: a count inside quotes, or right after "after", is what a check looks at
      '- [x] Lockout: the account locks after 5 failures (`pnpm test auth`, 3 passed)',
      '- [x] Circuit breaker opens after 3 errors in a row (`pnpm test breaker`, 4 passed)',
      '- [x] Retry: gives up after 3 failures and shows an error (`pnpm test retry`, 6 passed)',
      '- [x] Batch import: shows "2 of 10 failed" when two rows are bad (`pnpm test import`, 4 passed)',
      '- [x] Alerting: fires after 3 errors (`pnpm test alert`, 2 passed)',
      '- [x] 匯入結果：顯示「2 個失敗」的紅色標籤（`pnpm test import`，4 個通過）',
      // next to R1, R3, R4: a parenthesis and other words, a count in the command, FAIL before a count or a comma
      '- [x] Redis 失敗（逾時）時改用記憶體快取（`pnpm test cache`，5 個通過）',
      '- [x] `pnpm vitest run -t "2 tests fail"`: 3 passed',
      '- [x] `pnpm test`: `Tests  14 passed (14)`',
      '- [x] 回歸測試：修正前 FAIL，修正後 PASS（`pnpm test cart`）',
      '- [x] Summary line: shows “2 tests failed” in red (`pnpm test summary`, 3 passed)',
    ];

    it.each(REFUSED_FIX5)('refused at its line, with the sentence that says how to write it: %s', (line) => {
      const parse = parseReport(ticked(line), 'cart-api');
      expect(parse.ok, line).toBe(false);
      expect(parse.ok ? [] : parse.errors.map((entry) => [entry.kind, entry.line, entry.model]), line).toEqual([['verified-ticked', 13, TICKED_SENTENCE]]);
    });

    it.each(PASSED_FIX5)('passes: %s', (line) => {
      expect(parseReport(ticked(line), 'cart-api'), line).toMatchObject({ ok: true, report: { outcome: 'complete', checks: { passed: 1, notVerified: 1 } } });
    });

    it('R6: a key block that ": failed:" or ": not verified:" cuts in two is masked whole before the line is read: refused, nothing of the key stored', () => {
      const body = 'MIIEpAIBAAKCAQEAsecretkeybody';
      const failed = CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', `- [!] -----BEGIN RSA PRIVATE KEY----- ${body}: failed: x -----END RSA PRIVATE KEY-----`).replace('- outcome: complete', '- outcome: partial');
      const parse = parseReport(failed, 'cart-api');
      expect(parse.ok ? null : parse.errors.map((entry) => entry.kind)).toEqual(['verified-failed-why']);
      expect(JSON.stringify(parse)).not.toContain(body);
      const notRun = CART_REPORT.replace('- [ ] Manual check in the browser: not verified: no browser in this session', `- [ ] -----BEGIN PRIVATE KEY----- ${body}: not verified: x -----END PRIVATE KEY-----`);
      const parsed = parseReport(notRun, 'cart-api');
      expect(parsed.ok ? null : parsed.errors.map((entry) => entry.kind)).toEqual(['verified-why']);
      expect(JSON.stringify(parsed)).not.toContain(body);
      // A whole block in one part is masked there, and the line is the failed check it says.
      const whole = parseReport(failed.replace(`-----BEGIN RSA PRIVATE KEY----- ${body}: failed: x -----END RSA PRIVATE KEY-----`, `Deploy key -----BEGIN RSA PRIVATE KEY----- ${body} -----END RSA PRIVATE KEY-----: failed: refused`), 'cart-api');
      expect(whole).toMatchObject({ ok: true, report: { checks: { failed: 1 }, sections: { verified: [{ text: 'Deploy key [masked]', failed: true, note: 'refused' }, { passed: false }] } } });
      expect(JSON.stringify(whole)).not.toContain(body);
    });
  });

  // The check of bb6c323 (W/verify/last5/ticked, the lead's C4; fix6): fix5's blanking of quoted text for the count
  // (R5) also blanked a quote that opens the words after the colon or dash, which is where R3 reads the runner's own
  // line: the runner's count in "…", “…” or 「…」 instead of backticks was accepted, and smurg merged untested work (d374e39
  // refused these lines). That quote is kept now; a quote elsewhere in the words is still what a check looks at.
  describe('0.7.0 fix6: the runner\'s line quoted after the colon is read as one in a code span is', () => {
    const ticked = (line: string): string => CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', line);
    const REFUSED_FIX6: readonly string[] = [
      '- [x] `pnpm test`: "Tests  2 failed | 12 passed (14)"',
      '- [x] `pnpm test`: \u201cTests  2 failed | 12 passed (14)\u201d',
      '- [x] `pytest -q`: "2 failed, 21 passed in 1.02s"',
      '- [x] `pnpm test`\uff1a\u300c2 failed | 12 passed\u300d',
      '- [x] `pnpm test`\uff1a\u300c2 \u500b\u6e2c\u8a66\u5931\u6557\u300d',
    ];
    it.each(REFUSED_FIX6)('refused at its line, with the sentence that says how to write it: %s', (line) => {
      const parse = parseReport(ticked(line), 'cart-api');
      expect(parse.ok, line).toBe(false);
      expect(parse.ok ? [] : parse.errors.map((entry) => [entry.kind, entry.line, entry.model]), line).toEqual([['verified-ticked', 13, TICKED_SENTENCE]]);
    });
    it.each([
      '- [x] Batch import: shows "2 of 10 failed" when two rows are bad (`pnpm test import`, 4 passed)',
      '- [x] `pnpm test`: "Tests  14 passed (14)"',
      '- [x] `pnpm test` \u2014 "Tests  14 passed (14)", 0 failed',
    ])('passes: %s', (line) => {
      expect(parseReport(ticked(line), 'cart-api'), line).toMatchObject({ ok: true, report: { outcome: 'complete', checks: { passed: 1, notVerified: 1 } } });
    });
  });

  // The check of 06cfc6d (W/verify/last6/ticked, the lead's D4-D6; fix7): a colon or a dash inside the command's code
  // span (`pnpm test:unit`, `pnpm test -- --run`) was taken for the line's own, so the outcome after the real one was
  // never read and smurg merged a check that said it failed or did not run (o); the runner's line quoted after such a
  // command was missed the same way, and after an ideographic blank (k, w); and keeping the quote that opens the words
  // after the colon or dash lost counts that a blank in the quote's place joined (z, refused by bb6c323). The colon and
  // the dash are found outside the code spans, and the count is read with every quote blanked first, then again with
  // that quote kept.
  describe('0.7.0 fix7: the colon and the dash of a ticked line stand outside its code spans, and a count is read with the quotes blanked and then with the opening quote kept', () => {
    const ticked = (line: string): string => CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', line);
    const REFUSED_FIX7: readonly string[] = [
      // o: the outcome after a command whose code span holds a colon or a dash
      '- [x] `pnpm test:unit`: failed',
      '- [x] `pnpm test:unit` \u2014 failed',
      '- [x] `pnpm test -- --run`: failed',
      '- [x] `pnpm test:e2e`: not run (no browser)',
      '- [x] `pnpm test:unit` fails',
      // k: the runner's line quoted after such a command
      '- [x] `pnpm test:unit`: "Tests  2 failed | 12 passed (14)"',
      '- [x] `pnpm test:unit`: \u201cTests  2 failed | 12 passed (14)\u201d',
      '- [x] `npm run test:py`: "2 failed, 21 passed in 1.02s"',
      '- [x] `pnpm test:unit`\uff1a\u300c2 failed | 12 passed\u300d',
      '- [x] `pnpm test:unit`\uff1a\u300c2 \u500b\u6e2c\u8a66\u5931\u6557\u300d',
      '- [x] `pnpm test:unit` \u2014 "Tests  2 failed | 12 passed (14)"',
      // w: an ideographic blank before the quote
      '- [x] `pnpm test`\uff1a\u3000\u300c2 failed | 12 passed\u300d',
      // z: a count that the blank in a quote's place joins
      '- [x] Lint errors: "src/cart.ts" 2',
      '- [x] 2 \u500b\u6e2c\u8a66 \u2014 \u300ccart.test.ts\u300d\u5931\u6557',
      '- [x] 2 \u500b\u6e2c\u8a66 \u2014 \u300c\u7e3d\u8a08\u300d\u5931\u6557',
    ];
    const PASSED_FIX7: readonly string[] = [
      // p37: a failure word inside the command's code span, before the real colon (refused until now)
      '- [x] `pnpm vitest run -t "upload: failed chunk is resent"`: 2 passed',
      '- [x] `pnpm test:unit`: "Tests  14 passed (14)"',
      '- [x] `pnpm test:unit`: 14 passed',
      '- [x] `pnpm test -- --run`: 14 passed',
      '- [x] `curl -i localhost:3000/health` returns 200 OK',
      '- [x] `pnpm test`\uff1a\u3000\u300c14 passed\u300d',
    ];
    it.each(REFUSED_FIX7)('refused at its line, with the sentence that says how to write it: %s', (line) => {
      const parse = parseReport(ticked(line), 'cart-api');
      expect(parse.ok, line).toBe(false);
      expect(parse.ok ? [] : parse.errors.map((entry) => [entry.kind, entry.line, entry.model]), line).toEqual([['verified-ticked', 13, TICKED_SENTENCE]]);
    });
    it.each(PASSED_FIX7)('passes: %s', (line) => {
      expect(parseReport(ticked(line), 'cart-api'), line).toMatchObject({ ok: true, report: { outcome: 'complete', checks: { passed: 1, notVerified: 1 } } });
    });
  });

  // The check of 6f42b50 (W/verify/last7/ticked, the lead's E4-E6; fix8): a label before the command (`Unit tests —
  // `pnpm test`: failed`, `Unit tests: `pnpm test` failed`) gave the line its dash or colon, and the words after it began
  // with the command, so the outcome after the command was never read (m, e04); fix7's colon outside the code spans
  // missed a line whose only colon or dash is inside one (`pnpm test: failed`, Jest's `Tests: 2 failed, …`, a stray
  // backtick before `: failed`), which 06cfc6d refused (x, u05); and an ideographic blank after the full-width colon hid
  // the word for failing (f06). Each was accepted, and smurg merged a check that said it failed or did not run. The
  // words from the command on are read once more as a line of their own; a line with neither colon nor dash outside
  // its spans is also read with the one inside taken for the line's; U+3000 is a blank there. Accepted costs: a label,
  // then a passed check whose words begin with a failure word (m09, m10), is refused as its form without the label is;
  // c10 is refused as its form without a colon is (x08 too until fix9). A runner's line in a second code span with neither
  // colon nor dash outside it (`` `go test ./...` `--- FAIL: TestTotal` ``) stays accepted: a known limit.
  describe('0.7.0 fix8: a label before the command, and a colon or a dash only inside a code span, do not hide the outcome', () => {
    const ticked = (line: string): string => CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', line);
    const REFUSED_FIX8: readonly string[] = [
      // m, e04: a label before the command
      '- [x] Unit tests \u2014 `pnpm test`: failed',
      '- [x] Unit tests \u2014 `pnpm test:unit`: failed',
      '- [x] E2E - `pnpm test:e2e`: not run (no browser)',
      '- [x] Unit tests: `pnpm test`: failed',
      '- [x] Upload resume: `pnpm test upload` failed',
      '- [x] Tests:`pnpm test:unit` failed',
      // (two code spans before the colon: refused since fix7)
      '- [x] `pnpm test:unit` `--reporter=dot`: failed',
      // x, u05: the colon or the dash only inside a code span
      '- [x] `pnpm test: failed`',
      '- [x] Jest `Tests: 2 failed, 40 passed, 42 total`',
      '- [x] `pnpm e2e: not run (no browser)`',
      '- [x] `Tests: 2 failed | 12 passed (14)` from `pnpm test`',
      '- [x] Ran pnpm test`: failed, see `cart.test.ts`',
      // f06: an ideographic blank after the full-width colon
      '- [x] `pnpm test`\uff1a\u3000\u5931\u6557',
      // the accepted costs: passed checks refused as their other forms are
      '- [x] Retry: `pnpm test retry` - failed writes are retried (6 passed)',
      '- [x] Webhooks \u2014 `pnpm test webhook`: failed deliveries are re-queued (11 passed)',
      '- [x] `pnpm test:unit` exits 0, nothing failed',
    ];
    const PASSED_FIX8: readonly string[] = [
      '- [x] Unit tests \u2014 `pnpm test:unit`: 14 passed',
      '- [x] Tests: `pnpm test:unit` 14 passed',
      '- [x] Jest `Tests: 42 passed, 42 total`',
      '- [x] `pnpm test`\uff1a\u300014 passed',
      // x08: refused by fix8 (its colon inside the quotes of a test's name was taken for the line's); the colon of the
      // reading inside a code span is looked for with the quotes blanked (fix9)
      '- [x] `pnpm vitest -t "upload: failed chunk is resent"` 2 passed',
    ];
    it.each(REFUSED_FIX8)('refused at its line, with the sentence that says how to write it: %s', (line) => {
      const parse = parseReport(ticked(line), 'cart-api');
      expect(parse.ok, line).toBe(false);
      expect(parse.ok ? [] : parse.errors.map((entry) => [entry.kind, entry.line, entry.model]), line).toEqual([['verified-ticked', 13, TICKED_SENTENCE]]);
    });
    it.each(PASSED_FIX8)('passes: %s', (line) => {
      expect(parseReport(ticked(line), 'cart-api'), line).toMatchObject({ ok: true, report: { outcome: 'complete', checks: { passed: 1, notVerified: 1 } } });
    });
  });

  // The check of 13591fb (W/verify/last8/ticked, the lead's F3-F6; fix9): fix8 read a colon or dash inside a code span
  // only when none stood outside the spans, so an outcome inside the span with a URL, a time or "— see CI" after it was
  // accepted (S07-S10, which 06cfc6d and bb6c323 refused); it read from the command only when the words after the
  // line's separator began with it, so a label with its own colon or dash hid the outcome (L01-L03, L06); the zh-TW
  // words for failed and not verified before a span's closing backtick were no outcome (S01, S02); and U+3000 after a
  // dash was no blank (U03). The words before the line's first separator outside the spans are read with one inside a
  // span taken for the line's (looked for with the quotes blanked: x08 passes again), the words after a separator from
  // their first code span on, a backtick ends an outcome word, and U+3000 is a blank after a dash. K04 (a label before a
  // passed command whose span holds a failure count) stays refused: a known limit.
  describe('0.7.0 fix9: an outcome inside a code span with a separator after it, a label with its own colon or dash, the zh-TW words before a closing backtick, and U+3000 after a dash do not hide the outcome', () => {
    const ticked = (line: string): string => CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', line);
    const REFUSED_FIX9: readonly string[] = [
      // S07-S10: the outcome inside the code span, a colon or dash outside it after it
      '- [x] `pnpm test: failed` (see https://ci.example.com/run/12)',
      '- [x] `pnpm test: failed` \u2014 see the CI log',
      '- [x] Jest `Tests: 2 failed, 40 passed, 42 total` - see CI run 12',
      '- [x] `pnpm e2e: not run (no browser)`, at 10:30 in CI',
      // L01-L03, L06: a label with its own colon or dash before the command
      '- [x] Unit tests: cart \u2014 `pnpm test cart`: failed',
      '- [x] Tests - unit: `pnpm test:unit` failed',
      '- [x] CI: unit tests: `pnpm test`: failed',
      '- [x] Tests: unit \u2014 `pnpm test:unit`: failed',
      // S01, S02: the zh-TW words for failed and not verified right before the span's closing backtick
      '- [x] `pnpm test\uff1a\u5931\u6557`',
      '- [x] `pnpm e2e\uff1a\u672a\u9a57\u8b49`',
      // U03: U+3000 after a dash
      '- [x] `pnpm test` \u2014\u3000\u5931\u6557',
    ];
    const PASSED_FIX9: readonly string[] = [
      // L09, L10, N05, Q05, Q06: a label, then a passed check
      '- [x] Login: `pnpm test auth` \u2014 fails with a wrong password, as it should (5 passed)',
      '- [x] Errors \u2014 `pnpm test errors`: failing requests are logged (4 passed)',
      '- [x] Unit tests \u2014 `pnpm test` `--run`: 14 passed',
      '- [x] Unit tests \u2014 `pnpm test`: "Tests  14 passed (14)"',
      '- [x] Import \u2014 `pnpm test import`: shows "2 of 10 failed" when two rows are bad (4 passed)',
      // U05, U06: U+3000 after the full-width colon of a passed check
      '- [x] API\uff1a\u3000\u672a\u9a57\u8b49\u7684\u8acb\u6c42\u56de\u50b3 401\uff08`pnpm test api`\uff0c8 \u500b\u901a\u904e\uff09',
      '- [x] `pnpm test`\uff1a\u300014 \u500b\u901a\u904e',
    ];
    it.each(REFUSED_FIX9)('refused at its line, with the sentence that says how to write it: %s', (line) => {
      const parse = parseReport(ticked(line), 'cart-api');
      expect(parse.ok, line).toBe(false);
      expect(parse.ok ? [] : parse.errors.map((entry) => [entry.kind, entry.line, entry.model]), line).toEqual([['verified-ticked', 13, TICKED_SENTENCE]]);
    });
    it.each(PASSED_FIX9)('passes: %s', (line) => {
      expect(parseReport(ticked(line), 'cart-api'), line).toMatchObject({ ok: true, report: { outcome: 'complete', checks: { passed: 1, notVerified: 1 } } });
    });
  });

  it('0.7.0 verify: reading a ticked check\'s words takes linear time (a long run of blanks and dashes)', () => {
    const long = `- [x] ${'a '.repeat(20_000)}${' '.repeat(20_000)}-${' -'.repeat(20_000)} done`;
    const start = performance.now();
    parseReport(CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', long), 'cart-api');
    expect(performance.now() - start).toBeLessThan(500);
  });

  // 0.7.0 fix5 (the check of d374e39, R2): FAILURE_COUNT tried every split of a run of blanks after "fail" or "errors"
  // (the square of the run): a 2 MiB report of such lines took 2 s of the daemon's one thread, where 76114a1 took 11 ms.
  // Every shape the check timed (W/verify/last4/ticked/timing*.mts) and those of fix5's own expressions, each as a whole
  // report of TOPIC_FILE_MAX_BYTES made of ticked lines of 2,000 characters (what is read of each): read in one pass,
  // each takes 10 to 200 ms of processor time on the machine the bounds were measured on (Apple M3, node 22), and up to
  // 400 ms where fix7 reads a count twice (a quote opens the words after the colon: W/verify/fix7/corpus/timing.log),
  // 420 ms where fix8 reads a line again (a colon only in a code span, a label: W/verify/fix8/ticked/timing-fix8.log),
  // about as much where fix9 does (a separator after the span, a label with its own colon: W/verify/fix9/ticked/timing-fix9.log);
  // one that grows with the square of a line took 1.2 to 4.9 s on d374e39 (W/verify/fix5/corpus/timing1.log). The bound
  // is absolute, so it is multiplied by how much slower this machine is (`machineSlowness`).
  it('0.7.0 fix5: reading a report of TOPIC_FILE_MAX_BYTES of ticked lines takes linear time, for every shape of the expressions that read them', () => {
    const N = 2000;
    const B = (n: number): string => ' '.repeat(n);
    const fill = (unit: string, len: number): string => unit.repeat(Math.ceil(len / unit.length)).slice(0, len);
    const SHAPES: readonly (readonly [string, string])[] = [
      ['fail+blanks+x', `fail${B(N - 5)}x`],
      ['errors+blanks+x', `errors${B(N - 7)}x`],
      ['failures+blanks+x', `failures${B(N - 9)}x`],
      ['fail+blanks+=+blanks+x', `fail${B(N / 2 - 4)}=${B(N / 2 - 4)}x`],
      ['1+blanks+x', `1${B(N - 2)}x`],
      ['2 of+blanks+x', `2 of${B(N - 5)}x`],
      ['2+blanks+/+blanks+x', `2${B(N / 2 - 2)}/${B(N / 2 - 2)}x`],
      ['2 tests+blanks+x', `2 tests${B(N - 8)}x`],
      ['1 type+blanks+x', `1 type${B(N - 7)}x`],
      ['2 unit+blanks', `2 unit${B(N - 7)}x`],
      ['2個+中blank', `2 個${fill('中 ', N - 3)}`],
      ['2個+中', `2 個${fill('中', N - 3)}`],
      ['2個+blanks+x', `2 個${B(N - 4)}x`],
      ['(2個中 )*', fill('2 個中 ', N)],
      ['失敗+blanks+x', `失敗${B(N - 3)}x`],
      ['(fail )*', fill('fail ', N)],
      ['(1 )*', fill('1 ', N)],
      ['(2 of 3 )*', fill('2 of 3 ', N)],
      ['( fail (x)*', fill(' fail (', N)],
      [' fail+blanks+(+x', `a fail${B(N - 10)}(xxx`],
      [' failed (+a*', `a failed (${fill('a', N - 10)}`],
      ['code spans', fill('`a` ', N)],
      ['(FAIL )*', `x: ${fill('FAIL ', N - 3)}`],
      ['colon fail+blanks', `x: fail${B(N - 8)}x`],
      ['dash (- )*', fill(' - ', N)],
      ['(— fail )*', fill(' — fail ', N)],
      ['(2 failed )*', fill('2 failed ', N)],
      ['(errors 1 )*', fill('errors 1x ', N)],
      ['(error: )*', fill('errors: ', N)],
      [' failed (`a*', `x failed (\`${fill('a', N - 11)}`],
      [' failed ((`a`)*', `x failed (${fill('`a` ', N - 10)}`],
      [' failed ((`)*', `x failed (${fill('`(', N - 10)}`],
      ['(FAILED )*', fill('FAILED ', N)],
      ['(--- FAIL )*', fill('--- FAIL ', N)],
      ['2 tests+blanks+are', `2 tests${B(N / 2)}are${B(N / 2 - 12)}x`],
      ['(錯誤 1 )*', fill('錯誤 1 ', N)],
      ['未驗證+blanks', `x：未驗證${B(N - 6)}x`],
      // fix5's own: a verdict after blanks, before blanks; quotes that never close; "after" before blanks
      ['---+blanks+x', `x ---${B(N - 6)}x`],
      ['FAIL+blanks+1', `x FAIL${B(N - 8)}1`],
      ['(“)*', fill('“', N)],
      ['(「)*', fill('「', N)],
      ['(")*', fill('"', N)],
      ['“+a*', `“${fill('a', N - 1)}`],
      ['(after )*', fill('after ', N)],
      ['after+blanks+x', `after${B(N - 6)}x`],
      ['未驗證+blanks+中', `x：未驗證${B(N - 7)}中`],
      [' failed (+blanks+x', `a failed (x)${B(N - 14)}x`],
      // fix7's: the count read again with the quote that opens the words after the colon kept (digits all through it,
      // after an ideographic blank too), and the colon and the dash looked for outside code spans that hold them
      ['x: 「+(14)*+,', `x: \u300c${fill('14', N - 5)},`],
      ['x: “+(9)*+)', `x: \u201c${fill('9', N - 5)})`],
      ['x: 「+(1(`)*', `x: \u300c${fill('1(`', N - 4)}`],
      ['x：　「+(14)*', `x\uff1a\u3000\u300c${fill('14', N - 4)}`],
      ['(`a:` )*', fill('`a:` ', N)],
      ['(`a:` — )*', fill('`a:` \u2014 ', N)],
      ['`x:`: "+(2 failed )*', `\`x:\`: "${fill('2 failed ', N - 7)}`],
      // fix8's: a colon only inside a code span (the line read a second time with it taken for the line's), and a label
      // before the command (the words from the command read once more), before the costliest counts
      ['`a:` ；2+(1(`)*', `\`a:\` \uff1b2${fill('1(`', N - 7)}`],
      ['`a:` “+(9)*+)', `\`a:\` \u201c${fill('9', N - 7)})`],
      ['`a:` 「+(14)*+,', `\`a:\` \u300c${fill('14', N - 7)},`],
      ['L: `a`: 「+(14)*+,', `L: \`a\`: \u300c${fill('14', N - 10)},`],
      ['(L: `a` )*', fill('L: `a` ', N)],
      ['(L — `a:` )*', fill('L \u2014 `a:` ', N)],
      // fix9's: the reading inside a code span with a separator after the span, and from the first code span after a
      // label with its own colon and dash, before the costliest count; U+3000 after a dash
      ['`a:` — 「+(14)*+,', `\`a:\` \u2014 \u300c${fill('14', N - 9)},`],
      ['L: x — `a`: 「+(14)*+,', `L: x \u2014 \`a\`: \u300c${fill('14', N - 15)},`],
      ['(L: x — `a:` )*', fill('L: x \u2014 `a:` ', N)],
      ['x —+(U+3000)*+失敗', `x \u2014${fill('\u3000', N - 5)}\u5931\u6557`],
    ];
    const bound = 1_000 * machineSlowness();
    for (const [name, words] of SHAPES) {
      const line = `- [x] ${words}`;
      const count = Math.floor((TOPIC_FILE_MAX_BYTES - CART_REPORT.length) / (Buffer.byteLength(line) + 1));
      const report = CART_REPORT.replace('- [x] `pnpm test cart`: 14 tests passed', Array.from({ length: count }, () => line).join('\n'));
      // (the cheaper of two runs when the first is over: a shared runner is slow for a moment now and then)
      expect(costOf(() => void parseReport(report, 'cart-api'), bound, 2), name).toBeLessThan(bound);
    }
    // (some 70 shapes of up to 430 ms each, twice when the first run is over: more than vitest's 5 s; fix8, fix9)
  }, 120_000);

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

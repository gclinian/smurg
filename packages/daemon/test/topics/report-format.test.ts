// A result report file → its sections (design Appendix B.2). Pure: a string in, a result out.
import { describe, expect, it } from 'vitest';
import { REPORT_SECTION_MAX_BYTES, wireTextSchema } from '@smurg/protocol';
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

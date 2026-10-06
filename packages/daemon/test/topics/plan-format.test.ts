// PLAN.md → work items (design Appendix B.1, §4.3). The parser is pure: every case here is a string in, a result out.
import { describe, expect, it } from 'vitest';
import { PLAN_ITEMS_MAX, wireTextSchema } from '@smurg/protocol';
import { render } from '@smurg/protocol/i18n';
import { PLAN_ERROR_SENTENCES, PLAN_MARKER_END, PLAN_MARKER_START, parsePlan, planFingerprint, type PlanErrorKind } from '../../src/topics/plan-format.ts';

const CHECKOUT = `# Plan: Checkout

Six work items. 1 and 2 can start at once; 3 needs both.

<!-- smurg:plan v1 -->

### 1. Cart API
- id: cart-api
- size: m
- touches: src/cart/**, test/cart/**

Add the cart endpoints of SPEC "Behaviour" 1–3. Done when the cart tests pass.

More detail that is not part of the summary.

### 2. Payment form
- id: payment-form
- size: s
- touches: src/pay/form.tsx

The form of SPEC "Behaviour" 4, without submitting.

### 3. Checkout page
- id: checkout-page
- depends on: cart-api, payment-form
- size: l
- touches: src/checkout/**

Put both together.

<!-- smurg:plan end -->

## Risks
Anything goes outside the block.
`;

function block(body: string): string {
  return `intro\n${PLAN_MARKER_START}\n${body}\n${PLAN_MARKER_END}\n`;
}

function errorsOf(source: string): { kind: PlanErrorKind; line?: number; id: string }[] {
  const parse = parsePlan(source);
  if (parse.ok) throw new Error('expected the plan not to parse');
  return parse.errors.map((error) => ({ kind: error.kind, ...(error.line === undefined ? {} : { line: error.line }), id: error.text.id }));
}

describe('T3.1 the plan format', () => {
  it('reads the work items of the block: number by position, id, dependencies, size, touches, the first paragraph as summary', () => {
    const parse = parsePlan(CHECKOUT);
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.items).toEqual([
      { id: 'cart-api', number: 1, title: 'Cart API', summary: 'Add the cart endpoints of SPEC "Behaviour" 1–3. Done when the cart tests pass.', dependsOn: [], size: 'm', touches: ['src/cart/**', 'test/cart/**'], line: 7 },
      { id: 'payment-form', number: 2, title: 'Payment form', summary: 'The form of SPEC "Behaviour" 4, without submitting.', dependsOn: [], size: 's', touches: ['src/pay/form.tsx'], line: 16 },
      { id: 'checkout-page', number: 3, title: 'Checkout page', summary: 'Put both together.', dependsOn: ['cart-api', 'payment-form'], size: 'l', touches: ['src/checkout/**'], line: 23 },
    ]);
    expect(parse.warnings).toEqual([]);
  });

  it('the number is the position in the file, whatever digits the heading has; size defaults to m; "none" is no dependency', () => {
    const parse = parsePlan(block('### 7. First\n- id: a\n- depends on: none\n\nText.\n\n### 7. Second\n\n- id: b\n\nText.'));
    expect(parse.ok && parse.items.map((item) => [item.number, item.id, item.size, item.dependsOn])).toEqual([
      [1, 'a', 'm', []],
      [2, 'b', 'm', []],
    ]);
  });

  it('CRLF files and field names in another case parse the same', () => {
    const parse = parsePlan(block('### 1. One\n- ID: a\n- Depends On: none\n- SIZE: L\n\nText.').replace(/\n/g, '\r\n'));
    expect(parse.ok && parse.items[0]).toMatchObject({ id: 'a', size: 'l', summary: 'Text.' });
  });

  it('every failure is one error with its line, a catalog id for people and one fixed sentence for the model', () => {
    expect(errorsOf('# Plan\nno block here\n')).toEqual([{ kind: 'no-block', id: 'plan.error.noBlock' }]);
    expect(errorsOf(`a\n${PLAN_MARKER_START}\n### 1. One\n- id: a\n`)).toEqual([{ kind: 'unclosed', line: 2, id: 'plan.error.unclosed' }]);
    expect(errorsOf(`${PLAN_MARKER_END}\n${PLAN_MARKER_START}\n`)).toEqual([{ kind: 'unclosed', line: 2, id: 'plan.error.unclosed' }]);
    expect(errorsOf(`${block('### 1. One\n- id: a\n\nx')}${PLAN_MARKER_START}\n${PLAN_MARKER_END}\n`)).toEqual([{ kind: 'markers', line: 8, id: 'plan.error.unclosed' }]);
    expect(errorsOf(block(''))).toEqual([{ kind: 'empty', id: 'plan.error.empty' }]);
    expect(errorsOf(block('## Phase one\n### 1. One\n- id: a\n\nx'))).toEqual([{ kind: 'heading', line: 3, id: 'plan.error.heading' }]);
    expect(errorsOf(block('### One\n- id: a'))).toEqual([
      { kind: 'heading', line: 3, id: 'plan.error.heading' },
      { kind: 'empty', id: 'plan.error.empty' },
    ]);
    expect(errorsOf(block(`### 1. ${'x'.repeat(121)}\n- id: a\n\nx`))).toEqual([{ kind: 'heading', line: 3, id: 'plan.error.heading' }]);
    expect(errorsOf(block('### 1. One\n\nText without an id.'))).toEqual([{ kind: 'missing-id', line: 3, id: 'plan.error.missingId' }]);
    expect(errorsOf(block('### 1. One\n- id: Cart_API\n\nx'))).toEqual([{ kind: 'bad-id', line: 4, id: 'plan.error.badId' }]);
    expect(errorsOf(block('### 1. One\n- id: a\n\nx\n### 2. Two\n- id: a\n\ny'))).toEqual([{ kind: 'duplicate-id', line: 8, id: 'plan.error.duplicateId' }]);
    expect(errorsOf(block('### 1. One\n- id: a\n- depends on: ghost\n\nx'))).toEqual([{ kind: 'unknown-dependency', line: 5, id: 'plan.error.unknownDependency' }]);
    expect(errorsOf(block('### 1. One\n- id: a\n- depends on: a\n\nx'))).toEqual([{ kind: 'self-dependency', line: 5, id: 'plan.error.cycle' }]);
    expect(errorsOf(block('### 1. One\n- id: a\n- size: xl\n\nx'))).toEqual([{ kind: 'size', line: 5, id: 'plan.error.size' }]);
    // A typo in a field name must not silently drop a dependency.
    expect(errorsOf(block('### 1. One\n- id: a\n- depend on: b\n\nx\n### 2. Two\n- id: b\n\ny'))).toEqual([{ kind: 'field', line: 5, id: 'plan.error.field' }]);
    expect(errorsOf(block('### 1. One\n- id: a\n- depends-on: b\n\nx\n### 2. Two\n- id: b\n\ny'))).toEqual([{ kind: 'field', line: 5, id: 'plan.error.field' }]);
    // A misspelt "id" is ONE mistake: the line of the typo, not also "this item has no id".
    expect(errorsOf(block('### 1. One\n- ident: a\n\nx'))).toEqual([{ kind: 'field', line: 4, id: 'plan.error.field' }]);
    expect(errorsOf(block('### 1. One\n- id: a\n- id: b\n\nx'))).toEqual([{ kind: 'field', line: 5, id: 'plan.error.field' }]);
    expect(errorsOf(block(`### 1. One\n- id: a\n- touches: ${Array.from({ length: 17 }, (_, i) => `src/${i}/**`).join(', ')}\n\nx`))).toEqual([{ kind: 'field', line: 5, id: 'plan.error.field' }]);
  });

  it('a cycle names the ids (which passed the id pattern) and has no line', () => {
    const parse = parsePlan(block('### 1. One\n- id: a\n- depends on: c\n\nx\n### 2. Two\n- id: b\n- depends on: a\n\ny\n### 3. Three\n- id: c\n- depends on: b\n\nz'));
    expect(parse.ok).toBe(false);
    if (parse.ok) return;
    expect(parse.errors).toHaveLength(1);
    expect(parse.errors[0]).toMatchObject({ kind: 'cycle', text: { id: 'plan.error.cycle', params: { ids: ['a', 'c', 'b'] } } });
    expect(parse.errors[0]?.line).toBeUndefined();
  });

  it(`at most ${PLAN_ITEMS_MAX} items`, () => {
    const many = (count: number): string => block(Array.from({ length: count }, (_, i) => `### ${i + 1}. Item\n- id: item-${i + 1}\n\nText.`).join('\n\n'));
    expect(parsePlan(many(PLAN_ITEMS_MAX)).ok).toBe(true);
    expect(errorsOf(many(PLAN_ITEMS_MAX + 1))).toEqual([{ kind: 'too-many', id: 'plan.error.tooMany' }]);
  });

  it('warnings leave the plan valid: an item without a summary; two items that touch the same files and are not ordered', () => {
    const parse = parsePlan(block('### 1. One\n- id: a\n- touches: src/cart/**\n\n### 2. Two\n- id: b\n- touches: src/cart/api.ts\n\nText.\n\n### 3. Three\n- id: c\n- depends on: a\n- touches: src/cart/**\n\nText.'));
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.warnings.map((warning) => [warning.text.id, warning.text.params])).toEqual([
      ['plan.warning.noSummary', { number: 1 }],
      ['plan.warning.overlap', { first: 1, second: 2 }],
      // 1 and 3 are ordered by a dependency: no warning for them; 2 and 3 are not.
      ['plan.warning.overlap', { first: 2, second: 3 }],
    ]);
    expect(parse.warnings.every((warning) => warning.model.length > 20 && !warning.model.includes('src/cart'))).toBe(true);
  });

  it('a code fence inside a description is description: a "# comment" there is not a heading, a "- key: value" there is not a field', () => {
    const parse = parsePlan(block('### 1. One\n- id: a\n\nRun this:\n\n```sh\n# install first\n- note: not a field\npnpm install\n```\n\n### 2. Two\n- id: b\n\nText.'));
    expect(parse.ok && parse.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('a description may start with a list: a bullet is a field line only when it has the shape "- name: value"', () => {
    const parse = parsePlan(block('### 1. One\n- id: a\n\n- https://example.com/spec is the reference\n- GET /cart: returns the cart\n- [ ] a checkbox\n'));
    expect(parse.ok && parse.items[0]?.summary).toBe('- https://example.com/spec is the reference\n- GET /cart: returns the cart\n- [ ] a checkbox');
  });

  it('text before the first item is ignored; characters the wire refuses are dropped from a title and a summary', () => {
    const parse = parsePlan(block('Some words first.\n\n### 1. One‮ title\u0007\n- id: a\n\nSum\u0000mary‮ here.'));
    expect(parse.ok && parse.items[0]).toMatchObject({ title: 'One title', summary: 'Summary here.' });
  });

  it('the summary is cut at 2,000 characters', () => {
    const parse = parsePlan(block(`### 1. One\n- id: a\n\n${'word '.repeat(600)}`));
    expect(parse.ok && parse.items[0]?.summary.length).toBeLessThanOrEqual(2_000);
  });

  it('findings never copy a token from the file: the model sentence is one per kind, the reference renders in both languages and fits the wire', () => {
    const sources = [
      'nothing',
      block('## SECRET-HEADING\n### 1. One\n- id: a\n- size: SECRET-SIZE\n- secretfield: x\n- depends on: SECRET-DEP\n\nx'),
      block('### 1. One\n- id: SECRET_ID\n\nx'),
      block('### 1. One\n\nx'),
    ];
    for (const source of sources) {
      const parse = parsePlan(source);
      expect(parse.ok).toBe(false);
      if (parse.ok) continue;
      for (const error of parse.errors) {
        expect(error.model).toBe(PLAN_ERROR_SENTENCES[error.kind]);
        expect(JSON.stringify(error.text)).not.toMatch(/SECRET/i);
        expect(render('en', error.text)).not.toMatch(/SECRET/i);
        expect(render('zh-TW', error.text)).toBeTruthy();
        expect(wireTextSchema.safeParse({ text: error.text, fallback: render('en', error.text) }).success).toBe(true);
      }
    }
    expect(Object.values(PLAN_ERROR_SENTENCES).every((sentence) => /^[\x20-\x7e]+$/.test(sentence))).toBe(true);
  });

  it('the fingerprint changes with what an item IS, not with the text around the block', () => {
    const a = parsePlan(CHECKOUT);
    const b = parsePlan(CHECKOUT.replace('Six work items.', 'Three work items.').replace('## Risks', '## Notes'));
    const c = parsePlan(CHECKOUT.replace('- size: s', '- size: m'));
    if (!a.ok || !b.ok || !c.ok) throw new Error('expected the plans to parse');
    expect(planFingerprint(a.items)).toBe(planFingerprint(b.items));
    expect(planFingerprint(a.items)).not.toBe(planFingerprint(c.items));
  });
});

// TEST ONLY. What a zod schema HAS (every optional key, array, record and union branch) and what stored values of it
// VISIT; and a plain description of everything a schema accepts that zod itself can tell (for the pin).
//
// The paths are the ones of the fixtures' coverage.json (test/fixtures/published/README.md): `members[].avatarUrl` a
// key of every element of an array; `members{}.seen{}` a value of a record; `notes[]<kind=mention>.anchor` a key
// inside one branch of a union (a discriminated one by its key and value, another one by `<index:what it is>`);
// `responsible<null>` and `responsible<value>` the two sides of a nullable. The fixtures' coverage was made with this
// walk (then in the scratch tools of the fixtures); a test compares what it finds today with what is written there.
//
// It reads zod's own description of a schema (`schema._zod.def`), nothing of this repository.
import type { z } from 'zod';

type Schema = z.ZodType;
interface Def {
  readonly type: string;
  readonly [key: string]: unknown;
}

const defOf = (schema: unknown): Def | undefined => (schema as { _zod?: { def?: Def } } | undefined)?._zod?.def;

export interface Coverage {
  /** path -> how many instances have the key, and how many leave it out */
  readonly optional: Map<string, { present: number; absent: number }>;
  readonly arrays: Map<string, { nonEmpty: number; empty: number }>;
  readonly records: Map<string, { nonEmpty: number; empty: number }>;
  /** path with its branch label -> how many instances took the branch */
  readonly branches: Map<string, number>;
  readonly problems: string[];
}

export function newCoverage(): Coverage {
  return { optional: new Map(), arrays: new Map(), records: new Map(), branches: new Map(), problems: [] };
}

function literalValues(schema: unknown): unknown[] | null {
  const def = defOf(schema);
  if (!def) return null;
  if (def.type === 'literal') return [...(def['values'] as unknown[])];
  if (def.type === 'enum') return Object.values(def['entries'] as Record<string, unknown>);
  if (def.type === 'optional' || def.type === 'readonly' || def.type === 'nonoptional') return literalValues(def['innerType']);
  return null;
}

function summary(schema: unknown): string {
  const def = defOf(schema);
  if (!def) return 'unknown';
  switch (def.type) {
    case 'object': {
      const keys = Object.keys(def['shape'] as object);
      return `object{${keys.slice(0, 4).join(',')}${keys.length > 4 ? ',…' : ''}}`;
    }
    case 'literal':
      return (def['values'] as unknown[]).map((value) => JSON.stringify(value)).join('|');
    case 'enum':
      return `enum(${Object.values(def['entries'] as object).length})`;
    case 'array':
      return `array<${summary(def['element'])}>`;
    case 'optional':
    case 'nullable':
    case 'readonly':
      return summary(def['innerType']);
    case 'pipe':
      return summary(def['in']);
    default:
      return def.type;
  }
}

/** Through the wrappers that do not change what is stored. */
function unwrap(schema: unknown): unknown {
  let current = schema;
  for (let i = 0; i < 32; i++) {
    const def = defOf(current);
    if (!def) return current;
    if (def.type === 'readonly' || def.type === 'nonoptional' || def.type === 'default' || def.type === 'prefault' || def.type === 'catch') current = def['innerType'];
    else if (def.type === 'pipe') current = def['in'];
    else if (def.type === 'lazy') current = (def['getter'] as () => unknown)();
    else return current;
  }
  return current;
}

/** The label of each option of a union: `<key=value>` for a discriminated one, `<index:summary>` otherwise. */
function branchLabels(def: Def): string[] {
  const discriminator = def['discriminator'] as string | undefined;
  return (def['options'] as unknown[]).map((option, index) => {
    if (discriminator !== undefined) {
      const values = literalValues((defOf(unwrap(option))?.['shape'] as Record<string, unknown> | undefined)?.[discriminator]);
      if (values) return `<${discriminator}=${values.join('|')}>`;
    }
    return `<${index}:${summary(option)}>`;
  });
}

function isOptionalKey(schema: unknown): boolean {
  let current = schema;
  for (let i = 0; i < 32; i++) {
    const def = defOf(current);
    if (!def) return false;
    if (def.type === 'optional') return true;
    if (def.type === 'readonly' || def.type === 'nonoptional') current = def['innerType'];
    else if (def.type === 'pipe') current = def['in'];
    else return false;
  }
  return false;
}

/** Everything the schema has, whether or not a value reaches it. */
export function declare(schema: Schema | unknown, path: string, cov: Coverage, stack: Set<unknown> = new Set()): void {
  const def = defOf(schema);
  if (!def) return;
  if (stack.has(schema)) return; // a recursive schema: declared once
  stack.add(schema);
  try {
    switch (def.type) {
      case 'object': {
        for (const [key, child] of Object.entries(def['shape'] as Record<string, unknown>)) {
          const at = path === '' ? key : `${path}.${key}`;
          if (isOptionalKey(child) && !cov.optional.has(at)) cov.optional.set(at, { present: 0, absent: 0 });
          declare(child, at, cov, stack);
        }
        const catchall = defOf(def['catchall']);
        if (catchall !== undefined && catchall.type !== 'never') cov.problems.push(`${path}: an object that is not strict (a catchall of ${catchall.type})`);
        if (def['catchall'] === undefined) cov.problems.push(`${path || '(root)'}: an object that is not strict (unknown keys are dropped)`);
        break;
      }
      case 'array':
        if (!cov.arrays.has(path)) cov.arrays.set(path, { nonEmpty: 0, empty: 0 });
        declare(def['element'], `${path}[]`, cov, stack);
        break;
      case 'tuple':
        (def['items'] as unknown[]).forEach((item, index) => declare(item, `${path}[${index}]`, cov, stack));
        if (def['rest']) declare(def['rest'], `${path}[rest]`, cov, stack);
        break;
      case 'record':
      case 'map':
        if (!cov.records.has(path)) cov.records.set(path, { nonEmpty: 0, empty: 0 });
        declare(def['valueType'], `${path}{}`, cov, stack);
        break;
      case 'union': {
        const labels = branchLabels(def);
        (def['options'] as unknown[]).forEach((option, index) => {
          const at = `${path}${labels[index] as string}`;
          if (!cov.branches.has(at)) cov.branches.set(at, 0);
          declare(option, at, cov, stack);
        });
        break;
      }
      case 'nullable':
        for (const label of ['<null>', '<value>']) if (!cov.branches.has(`${path}${label}`)) cov.branches.set(`${path}${label}`, 0);
        declare(def['innerType'], path, cov, stack);
        break;
      case 'default':
      case 'prefault':
      case 'catch':
        cov.problems.push(`${path || '(root)'}: a ${def.type} (a stored file would get a value it does not hold)`);
        declare(def['innerType'], path, cov, stack);
        break;
      case 'optional':
      case 'readonly':
      case 'nonoptional':
        declare(def['innerType'], path, cov, stack);
        break;
      case 'pipe':
        declare(def['in'], path, cov, stack);
        // `a.pipe(b)`: what is stored also passed `b` (a transform has no structure to declare).
        if (defOf(def['out'])?.type !== 'transform') declare(def['out'], path, cov, stack);
        break;
      case 'lazy':
        declare((def['getter'] as () => unknown)(), path, cov, stack);
        break;
      case 'intersection':
        declare(def['left'], path, cov, stack);
        declare(def['right'], path, cov, stack);
        break;
      default:
        break; // string, number, int, boolean, enum, literal, null, any, unknown, never, custom, template_literal, transform
    }
  } finally {
    stack.delete(schema);
  }
}

/** What one stored value reaches. The value must already be accepted by the schema. */
export function visit(schema: Schema | unknown, value: unknown, path: string, cov: Coverage, depth = 0): void {
  const def = defOf(schema);
  if (!def || depth > 200) return;
  switch (def.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      for (const [key, child] of Object.entries(def['shape'] as Record<string, unknown>)) {
        const at = path === '' ? key : `${path}.${key}`;
        const present = Object.hasOwn(record, key) && record[key] !== undefined;
        if (isOptionalKey(child)) {
          const entry = cov.optional.get(at) ?? { present: 0, absent: 0 };
          entry[present ? 'present' : 'absent'] += 1;
          cov.optional.set(at, entry);
        }
        if (present) visit(child, record[key], at, cov, depth + 1);
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) return;
      const entry = cov.arrays.get(path) ?? { nonEmpty: 0, empty: 0 };
      entry[value.length > 0 ? 'nonEmpty' : 'empty'] += 1;
      cov.arrays.set(path, entry);
      for (const item of value) visit(def['element'], item, `${path}[]`, cov, depth + 1);
      break;
    }
    case 'tuple': {
      if (!Array.isArray(value)) return;
      const items = def['items'] as unknown[];
      value.forEach((item, index) => {
        const child = items[index] ?? def['rest'];
        if (child) visit(child, item, index < items.length ? `${path}[${index}]` : `${path}[rest]`, cov, depth + 1);
      });
      break;
    }
    case 'record':
    case 'map': {
      if (value === null || typeof value !== 'object') return;
      const values = Object.values(value);
      const entry = cov.records.get(path) ?? { nonEmpty: 0, empty: 0 };
      entry[values.length > 0 ? 'nonEmpty' : 'empty'] += 1;
      cov.records.set(path, entry);
      for (const item of values) visit(def['valueType'], item, `${path}{}`, cov, depth + 1);
      break;
    }
    case 'union': {
      const labels = branchLabels(def);
      const options = def['options'] as Schema[];
      const discriminator = def['discriminator'] as string | undefined;
      let chosen = -1;
      if (discriminator !== undefined && value !== null && typeof value === 'object') {
        chosen = options.findIndex((option) => literalValues((defOf(unwrap(option))?.['shape'] as Record<string, unknown> | undefined)?.[discriminator])?.includes((value as Record<string, unknown>)[discriminator]));
      }
      if (chosen === -1) chosen = options.findIndex((option) => option.safeParse(value).success);
      if (chosen === -1) {
        cov.problems.push(`${path}: no branch of the union accepts the stored value`);
        return;
      }
      const at = `${path}${labels[chosen] as string}`;
      cov.branches.set(at, (cov.branches.get(at) ?? 0) + 1);
      visit(options[chosen], value, at, cov, depth + 1);
      break;
    }
    case 'nullable': {
      const at = `${path}${value === null ? '<null>' : '<value>'}`;
      cov.branches.set(at, (cov.branches.get(at) ?? 0) + 1);
      if (value !== null) visit(def['innerType'], value, path, cov, depth + 1);
      break;
    }
    case 'optional':
    case 'readonly':
    case 'nonoptional':
    case 'default':
    case 'prefault':
    case 'catch':
      if (value !== undefined) visit(def['innerType'], value, path, cov, depth + 1);
      break;
    case 'pipe':
      visit(def['in'], value, path, cov, depth + 1);
      if (defOf(def['out'])?.type !== 'transform') visit(def['out'], value, path, cov, depth + 1);
      break;
    case 'lazy':
      visit((def['getter'] as () => unknown)(), value, path, cov, depth + 1);
      break;
    case 'intersection':
      visit(def['left'], value, path, cov, depth + 1);
      visit(def['right'], value, path, cov, depth + 1);
      break;
    default:
      break;
  }
}

const sorted = (list: Iterable<string>): string[] => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export interface CoverageReport {
  readonly optionalKeys: { readonly visited: string[]; readonly notVisited: string[] };
  readonly arrays: { readonly visited: string[]; readonly notVisited: string[] };
  readonly records: { readonly visited: string[]; readonly notVisited: string[] };
  readonly branches: { readonly visited: string[]; readonly notVisited: string[] };
  readonly problems: string[];
}
export const COVERAGE_PARTS = ['optionalKeys', 'arrays', 'records', 'branches'] as const;

/** Plain data: optional keys present in at least one instance, arrays and records not empty in at least one, branches taken by at least one. */
export function report(cov: Coverage): CoverageReport {
  const split = <T>(map: Map<string, T>, hit: (entry: T) => boolean): { visited: string[]; notVisited: string[] } => {
    const visited: string[] = [];
    const notVisited: string[] = [];
    for (const [path, entry] of map) (hit(entry) ? visited : notVisited).push(path);
    return { visited: sorted(visited), notVisited: sorted(notVisited) };
  };
  return {
    optionalKeys: split(cov.optional, (entry) => entry.present > 0),
    arrays: split(cov.arrays, (entry) => entry.nonEmpty > 0),
    records: split(cov.records, (entry) => entry.nonEmpty > 0),
    branches: split(cov.branches, (count) => count > 0),
    problems: cov.problems,
  };
}

// =====================================================================================================================
// What a schema accepts, as far as zod can say it: for the pin
// =====================================================================================================================

/**
 * One check of a string, number or array, with its numbers. A custom check (`.refine`, `.superRefine`, `.check`) has
 * only its name here: its rule is CODE, and no description of a schema says what that code accepts.
 */
function checkOf(check: unknown): string {
  const def = defOf(check) as (Def & { check?: string }) | undefined;
  if (!def) return 'check?';
  const parts: string[] = [String(def.check ?? def.type)];
  for (const key of ['format', 'minimum', 'maximum', 'value', 'inclusive', 'length', 'size']) if (def[key] !== undefined) parts.push(`${key}=${String(def[key])}`);
  if (def['pattern'] instanceof RegExp) parts.push(`pattern=${def['pattern'].source}/${def['pattern'].flags}`);
  return parts.join(' ');
}

/**
 * A text for everything zod itself knows about what `schema` accepts: every key in its order, whether it may be left
 * out, every type, limit, pattern, literal and enumeration value, every branch of every union, and WHERE a rule
 * written as code sits (`custom`, `transform`).
 *
 * What this text does NOT say: what such code accepts. A `.refine` whose bound goes from 1000 to 50 gives the same
 * text. That is why test/upgrade/pin.test.ts also pins, by hash, the SOURCE of every file such code can be written
 * in or taken from: the daemon's own schema files, and every module of the protocol package that a run-time name
 * they import leads to (its section 2 says exactly which, and what is still not seen).
 */
export function shapeOf(schema: Schema | unknown): string {
  const lines: string[] = [];
  const seen = new Map<unknown, number>();
  const walk = (node: unknown, path: string): void => {
    const def = defOf(node);
    if (!def) {
      lines.push(`${path}: ?`);
      return;
    }
    if (typeof node === 'object' && node !== null && (def.type === 'object' || def.type === 'union' || def.type === 'lazy')) {
      const first = seen.get(node);
      if (first !== undefined) {
        lines.push(`${path}: the same as #${first}`);
        return;
      }
      seen.set(node, seen.size + 1);
    }
    const checks = ((def['checks'] as unknown[] | undefined) ?? []).map(checkOf);
    const own = [def.type, ...(def['format'] !== undefined ? [`format=${String(def['format'])}`] : []), ...(def['pattern'] instanceof RegExp ? [`pattern=${def['pattern'].source}/${def['pattern'].flags}`] : []), ...checks.map((check) => `[${check}]`)].join(' ');
    switch (def.type) {
      case 'object': {
        const catchall = defOf(def['catchall']);
        lines.push(`${path}: #${seen.get(node)} ${own} ${catchall === undefined ? 'strip' : catchall.type === 'never' ? 'strict' : `catchall ${catchall.type}`}`);
        for (const [key, child] of Object.entries(def['shape'] as Record<string, unknown>)) walk(child, path === '' ? key : `${path}.${key}`);
        break;
      }
      case 'array':
        lines.push(`${path}: ${own}`);
        walk(def['element'], `${path}[]`);
        break;
      case 'tuple':
        lines.push(`${path}: ${own}`);
        (def['items'] as unknown[]).forEach((item, index) => walk(item, `${path}[${index}]`));
        if (def['rest']) walk(def['rest'], `${path}[rest]`);
        break;
      case 'record':
      case 'map':
        lines.push(`${path}: ${own}`);
        walk(def['keyType'], `${path}{key}`);
        walk(def['valueType'], `${path}{}`);
        break;
      case 'union':
        lines.push(`${path}: #${seen.get(node)} ${own}${def['discriminator'] === undefined ? '' : ` by ${String(def['discriminator'])}`}`);
        (def['options'] as unknown[]).forEach((option, index) => walk(option, `${path}<${index}>`));
        break;
      case 'intersection':
        lines.push(`${path}: ${own}`);
        walk(def['left'], `${path}&left`);
        walk(def['right'], `${path}&right`);
        break;
      case 'literal':
        lines.push(`${path}: ${own} ${(def['values'] as unknown[]).map((value) => JSON.stringify(value)).join('|')}`);
        break;
      case 'enum':
        lines.push(`${path}: ${own} ${Object.values(def['entries'] as object).map((value) => JSON.stringify(value)).join('|')}`);
        break;
      case 'optional':
      case 'nullable':
      case 'readonly':
      case 'nonoptional':
      case 'default':
      case 'prefault':
      case 'catch':
        lines.push(`${path}: ${own}`);
        walk(def['innerType'], path);
        break;
      case 'pipe':
        lines.push(`${path}: ${own}`);
        walk(def['in'], `${path}|in`);
        walk(def['out'], `${path}|out`);
        break;
      case 'lazy':
        lines.push(`${path}: #${seen.get(node)} ${own}`);
        walk((def['getter'] as () => unknown)(), path);
        break;
      default:
        lines.push(`${path}: ${own}`); // string, number, boolean, null, any, unknown, never, custom, transform, template_literal, …
        break;
    }
  };
  walk(schema, '');
  return `${lines.join('\n')}\n`;
}

/** Every schema object and every check object reachable from `schema` (for "is this exported schema part of that one?"). */
export function nodesOf(schema: Schema | unknown, into: Set<unknown> = new Set()): Set<unknown> {
  const def = defOf(schema);
  if (!def || into.has(schema)) return into;
  into.add(schema);
  for (const check of (def['checks'] as unknown[] | undefined) ?? []) into.add(check);
  for (const key of ['innerType', 'element', 'valueType', 'keyType', 'in', 'out', 'left', 'right', 'rest', 'catchall']) if (def[key] !== undefined) nodesOf(def[key], into);
  if (def.type === 'object') for (const child of Object.values(def['shape'] as Record<string, unknown>)) nodesOf(child, into);
  if (def.type === 'union') for (const option of def['options'] as unknown[]) nodesOf(option, into);
  if (def.type === 'tuple') for (const item of def['items'] as unknown[]) nodesOf(item, into);
  if (def.type === 'lazy') nodesOf((def['getter'] as () => unknown)(), into);
  return into;
}

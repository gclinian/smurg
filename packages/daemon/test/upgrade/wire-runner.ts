// TEST ONLY. Run by test/upgrade/wire.test.ts with plain node, once for the protocol package of a PUBLISHED TAG
// (`git archive v0.5.0 packages/protocol`) and once for this tree's:
//
//   node test/upgrade/wire-runner.ts <path of packages/protocol/src/index.ts>
//
// It prints, as JSON lines, everything that package says about the wire that can be said as text: the protocol
// version; every registered message type with its direction, channel, capability, checks and flags, and the shape of
// its payload and of its result (the pin's own machinery: walker.ts shapeOf); every schema the package exports, as its
// shape; every constant it exports that is plain data (limits, lists of values, patterns). Functions are not text:
// the test compares the package's SOURCE with the tag's for those.
//
// It imports the package it is given and walker.ts beside it, nothing else, and uses no TypeScript that node cannot
// run by leaving the types out.
import { pathToFileURL } from 'node:url';
import { shapeOf } from './walker.ts';

const index = process.argv[2];
if (index === undefined) throw new Error('usage: wire-runner.ts <path of packages/protocol/src/index.ts>');
const protocol = (await import(pathToFileURL(index).href)) as Record<string, unknown>;

const isSchema = (value: unknown): boolean => typeof value === 'object' && value !== null && '_zod' in value;

/** Plain data as it is, a schema as its shape, a pattern as its source; a function has no text. */
function describe(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[deeper]';
  if (isSchema(value)) return { $schema: shapeOf(value) };
  if (value instanceof RegExp) return { $pattern: `${value.source}/${value.flags}` };
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  if (value === null || typeof value !== 'object') return value === undefined ? '[undefined]' : value;
  if (value instanceof Map) return { $map: [...value.entries()].map(([key, entry]) => [describe(key, depth + 1), describe(entry, depth + 1)]) };
  if (value instanceof Set) return { $set: [...value.values()].map((entry) => describe(entry, depth + 1)) };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map((entry) => describe(entry, depth + 1));
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return `[an instance of ${(value as object).constructor?.name ?? 'a class'}]`;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, describe(entry, depth + 1)]));
}

const out: unknown[] = [{ what: 'protocol version', value: protocol['PROTOCOL_VERSION'] }];

const registry = protocol['MESSAGE_REGISTRY'] as Record<string, Record<string, unknown>> | undefined;
if (registry === undefined) throw new Error('the package exports no MESSAGE_REGISTRY');
for (const [type, spec] of Object.entries(registry)) {
  const { payload, result, ...rest } = spec;
  out.push({ what: 'message', type, spec: describe(rest), payload: shapeOf(payload), result: result === null || result === undefined ? null : shapeOf(result) });
}

for (const name of Object.keys(protocol).sort()) {
  const value = protocol[name];
  if (name === 'MESSAGE_REGISTRY' || typeof value === 'function') continue;
  out.push(isSchema(value) ? { what: 'schema', name, shape: shapeOf(value) } : { what: 'constant', name, value: describe(value) });
}

for (const line of out) process.stdout.write(`${JSON.stringify(line)}\n`);

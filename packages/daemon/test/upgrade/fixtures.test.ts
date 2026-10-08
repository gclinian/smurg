// The fixtures of the published versions (test/fixtures/published/, its README): that they are what their files.json
// says, that every file in them is of a kind this smurg knows and passes the schema of its kind, and THE COVERAGE:
// a fixture that leaves an array empty, an optional key out everywhere or a branch of a union untaken proves
// nothing about that part of the shape. That is how 0.5.0 shipped: "a workspace where nobody ever made a suggestion"
// opened, and every real one was refused at suggestions.json.
//
// So: every optional key, array, record and union branch of every persisted schema is visited by at least one stored
// instance, or it is in the fixture's coverage.json with a reason: `cannot` (the code of that version has no way to
// write it; the reason names the code) or `not-made` (it can be written, and the reason says what it would take).
// That list is the allowlist, it is explicit, and this test holds it to what the files really are: a point that is
// listed and visited, or not listed and not visited, fails.
//
// For the NEWEST published version the schemas walked are today's (this smurg writes the shapes it wrote), so a
// schema that gains a key, an array or a branch fails here until the list below names it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLISHED_VERSIONS, copyOf, fixtureDirOf, manifestOf, storedFileProblems, type FixtureCopy, type PublishedVersion } from './fixture.ts';
import { persistedKinds, type PersistedKind } from './persisted.ts';
import { COVERAGE_PARTS, declare, newCoverage, report, visit, type CoverageReport } from './walker.ts';

/**
 * Points of TODAY's schemas that no published fixture can hold yet, because the version that writes them is still
 * being built: `'<kind as coverage.json names it>': ['<path>', …]`. Emptied when the fixture of that version is in
 * the tree (made by its own code, docs/RELEASING.md): it visits them, or lists them with a reason.
 * Adding a point here goes together with a step or a raised WORKSPACE_SHAPES (test/upgrade/pin.test.ts says when).
 */
const NOT_PUBLISHED_YET: Readonly<Record<string, readonly string[]>> = {};

const NEWEST = PUBLISHED_VERSIONS[PUBLISHED_VERSIONS.length - 1] as PublishedVersion;

interface StoredCoverage {
  readonly version: string;
  readonly totals: Readonly<Record<(typeof COVERAGE_PARTS)[number], { readonly visited: number; readonly notVisited: number }>>;
  readonly kinds: readonly ({ readonly kind: string; readonly schema: string; readonly instances: number } & Partial<
    Record<(typeof COVERAGE_PARTS)[number], { readonly visited: string[]; readonly notVisited: { readonly at: string; readonly why: string; readonly reason: string }[] }>
  >)[];
}

function listFiles(dir: string, out: string[] = [], base = dir): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, out, base);
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

interface Walked {
  readonly kind: PersistedKind;
  /** null: a kind without a schema (bytes, text). */
  readonly schema: ReturnType<PersistedKind['schema']>;
  readonly instances: number;
  readonly refused: string[];
  readonly report: CoverageReport | null;
}

/** Every file of both variants of a fixture (through the copy step), by kind: what the schemas have and what the files visit. */
function walk(version: PublishedVersion, stopped: FixtureCopy, running: FixtureCopy): { readonly kinds: Walked[]; readonly ofNoKind: string[] } {
  // Both variants count together; the command member and the devices are the same in both.
  const homes: { readonly label: string; readonly dir: string; readonly home: 'host' | 'member' | 'device' }[] = [
    { label: 'stopped/host', dir: stopped.hostHome, home: 'host' },
    { label: 'running/host', dir: running.hostHome, home: 'host' },
    { label: 'cli-member', dir: stopped.cliMemberHome, home: 'member' },
    ...readdirSync(stopped.devices).sort().map((label) => ({ label: `devices/${label}`, dir: join(stopped.devices, label), home: 'device' as const })),
  ];
  const files = homes.map((home) => ({ ...home, files: listFiles(home.dir) }));
  const seen = new Set<string>();
  const kinds = persistedKinds().map((kind): Walked => {
    const schema = kind.schema(version);
    const cov = newCoverage();
    if (schema) declare(schema.schema, '', cov);
    let instances = 0;
    const refused: string[] = [];
    for (const home of files) {
      if (!kind.homes.includes(home.home)) continue;
      for (const rel of home.files) {
        if (!kind.pattern.test(rel)) continue;
        seen.add(`${home.label}/${rel}`);
        const bytes = readFileSync(join(home.dir, rel));
        let values: unknown[];
        try {
          values = kind.read(bytes);
        } catch (err) {
          refused.push(`${home.label}/${rel}: ${err instanceof Error ? err.message : 'unreadable'}`);
          continue;
        }
        for (const [index, value] of values.entries()) {
          instances += 1;
          if (!schema) continue;
          const parsed = schema.schema.safeParse(value);
          if (parsed.success) visit(schema.schema, value, '', cov);
          else refused.push(`${home.label}/${rel}${values.length > 1 ? ` line ${index + 1}` : ''}: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
        }
        for (const problem of kind.problems?.(bytes) ?? []) refused.push(`${home.label}/${rel}: ${problem}`);
      }
    }
    return { kind, schema, instances, refused, report: schema ? report(cov) : null };
  });
  return { kinds, ofNoKind: files.flatMap((home) => home.files.map((rel) => `${home.label}/${rel}`)).filter((file) => !seen.has(file)) };
}

describe.each(PUBLISHED_VERSIONS)('the fixture of smurg %s', { timeout: 60_000 }, (version) => {
  const stored = JSON.parse(readFileSync(join(fixtureDirOf(version), 'coverage.json'), 'utf8')) as StoredCoverage;
  let stopped: FixtureCopy;
  let running: FixtureCopy;
  let walked: ReturnType<typeof walk>;

  beforeAll(async () => {
    stopped = await copyOf(version, 'stopped');
    running = await copyOf(version, 'running');
    walked = walk(version, stopped, running);
  });
  afterAll(async () => {
    await stopped?.remove();
    await running?.remove();
  });

  it('holds the files its files.json lists, byte for byte, and nothing else (a checkout that changed line ends or left a *.log out shows here)', () => {
    expect(storedFileProblems(version)).toEqual([]);
    expect(stored.version).toBe(version);
    expect(manifestOf(version).version).toBe(version);
  });

  it('the copy step gives a private copy: files without group or other bits, folders 0700, no placeholder left, the copy\'s own path in its place', () => {
    const manifest = manifestOf(version);
    for (const copy of [stopped, running]) {
      expect(copy.at).toBe(manifest.variants[copy.variant]?.at);
      const open: string[] = [];
      const withPlaceholder: string[] = [];
      const check = (path: string): void => {
        const st = statSync(path);
        if ((st.mode & 0o077) !== 0) open.push(`${path} ${(st.mode & 0o777).toString(8)}`);
        if (st.isDirectory()) {
          if ((st.mode & 0o777) !== 0o700) open.push(`${path} ${(st.mode & 0o777).toString(8)}`);
          for (const name of readdirSync(path)) check(join(path, name));
        } else if (readFileSync(path).includes(manifest.placeholder)) withPlaceholder.push(path);
      };
      check(copy.root);
      expect(open).toEqual([]);
      expect(withPlaceholder).toEqual([]);
      // The state names the shared folder by the path the copy has now.
      expect(readFileSync(join(copy.hostHome, 'workspaces.json'), 'utf8')).toContain(JSON.stringify(copy.project));
      expect(readFileSync(join(copy.workspaceDir, 'state.json'), 'utf8')).toContain(`${copy.project}/.smurg/worktrees/`);
    }
  });

  it('every file is of a kind this smurg knows, and every stored instance passes the schema of its kind: nothing would be skipped, dropped or deleted as unreadable', () => {
    expect(walked.ofNoKind).toEqual([]);
    expect(walked.kinds.flatMap((kind) => kind.refused)).toEqual([]);
    // No persisted schema is lenient: no object that drops unknown keys, no default (DESIGN "Fail closed").
    expect(walked.kinds.flatMap((kind) => (kind.report?.problems ?? []).map((problem) => `${kind.kind.kind}: ${problem}`))).toEqual([]);
  });

  it('holds the kinds its coverage.json describes, with as many instances', () => {
    const here = walked.kinds.filter((kind) => kind.instances > 0).map((kind) => `${kind.kind.kind}: ${kind.instances}`);
    expect(here).toEqual(stored.kinds.map((kind) => `${kind.kind}: ${kind.instances}`));
    // Every kind this smurg persists and that version already wrote has an instance.
    expect(walked.kinds.filter((kind) => PUBLISHED_VERSIONS.indexOf(kind.kind.since) <= PUBLISHED_VERSIONS.indexOf(version) && kind.instances === 0).map((kind) => kind.kind.kind)).toEqual([]);
    expect(walked.kinds.filter((kind) => PUBLISHED_VERSIONS.indexOf(kind.kind.since) > PUBLISHED_VERSIONS.indexOf(version) && kind.instances > 0).map((kind) => kind.kind.kind)).toEqual([]);
  });

  it('leaves no optional key out everywhere, no array or record empty everywhere and no union branch untaken, except what its coverage.json lists', () => {
    const problems: string[] = [];
    for (const one of walked.kinds) {
      const listed = stored.kinds.find((kind) => kind.kind === one.kind.kind);
      if (one.report === null || one.schema === null || listed === undefined) continue;
      // The shape is that version's own (a frozen copy, a description of that version's reader, or, for the newest
      // version, today's schema): the walk must say exactly what the list says. Otherwise the schema is today's and
      // may have grown since: what that version could write must be as the list says, and nothing more is asked.
      const own = one.schema.frozen || one.schema.described === true || version === NEWEST;
      const later = new Set(version === NEWEST ? (NOT_PUBLISHED_YET[one.kind.kind] ?? []) : []);
      for (const part of COVERAGE_PARTS) {
        const visitedList = listed[part]?.visited ?? [];
        const notVisitedList = (listed[part]?.notVisited ?? []).map((entry) => entry.at);
        const known = new Set([...visitedList, ...notVisitedList]);
        const inScope = (path: string): boolean => (own ? !later.has(path) : known.has(path));
        const visitedHere = one.report[part].visited.filter(inScope);
        const notVisitedHere = one.report[part].notVisited.filter(inScope);
        for (const path of notVisitedHere.filter((candidate) => !notVisitedList.includes(candidate))) {
          problems.push(
            known.has(path)
              ? `${one.kind.kind}: ${part} ${path}: coverage.json says the fixture visits it, and no stored instance does`
              : `${one.kind.kind}: ${part} ${path}: NO INSTANCE OF THE FIXTURE VISITS IT and coverage.json does not list it. If this smurg now writes another shape than ${version} did: add the step, raise WORKSPACE_SHAPES (test/upgrade/pin.test.ts), and name the point in NOT_PUBLISHED_YET until the fixture of the version being built holds it`,
          );
        }
        for (const path of visitedHere.filter((candidate) => !visitedList.includes(candidate))) problems.push(`${one.kind.kind}: ${part} ${path}: ${known.has(path) ? 'coverage.json lists it as not visited, and a stored instance visits it (the reason given there is not true)' : 'visited, and coverage.json does not know it'}`);
        for (const path of [...visitedList, ...notVisitedList].filter((candidate) => !visitedHere.includes(candidate) && !notVisitedHere.includes(candidate))) problems.push(`${one.kind.kind}: ${part} ${path}: in coverage.json, and the schema has no such point`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('what is not visited is listed with a reason: `cannot` (that version has no way to write it) or `not-made` (it would take more than this fixture)', () => {
    const totals = { optionalKeys: { visited: 0, notVisited: 0 }, arrays: { visited: 0, notVisited: 0 }, records: { visited: 0, notVisited: 0 }, branches: { visited: 0, notVisited: 0 } };
    const unreasoned: string[] = [];
    for (const kind of stored.kinds) {
      for (const part of COVERAGE_PARTS) {
        totals[part].visited += kind[part]?.visited.length ?? 0;
        totals[part].notVisited += kind[part]?.notVisited.length ?? 0;
        for (const entry of kind[part]?.notVisited ?? []) if (!['cannot', 'not-made'].includes(entry.why) || entry.reason.trim().length < 40) unreasoned.push(`${kind.kind}: ${entry.at}`);
      }
    }
    expect(unreasoned).toEqual([]);
    expect(totals).toEqual(stored.totals);
  });
});

describe('the fixture of the newest published version and the shapes this smurg writes', () => {
  it('nothing is listed as "not published yet" that a published fixture already knows, or that today\'s schemas do not have', () => {
    const stored = JSON.parse(readFileSync(join(fixtureDirOf(NEWEST), 'coverage.json'), 'utf8')) as StoredCoverage;
    const stale: string[] = [];
    for (const [kindName, paths] of Object.entries(NOT_PUBLISHED_YET)) {
      const kind = persistedKinds().find((candidate) => candidate.kind === kindName);
      const schema = kind?.schema(NEWEST);
      if (kind === undefined || schema === null || schema === undefined) {
        stale.push(`${kindName}: not a kind with a schema`);
        continue;
      }
      const cov = newCoverage();
      declare(schema.schema, '', cov);
      const has = report(cov);
      const listed = stored.kinds.find((candidate) => candidate.kind === kindName);
      for (const path of paths) {
        if (!COVERAGE_PARTS.some((part) => [...has[part].visited, ...has[part].notVisited].includes(path))) stale.push(`${kindName}: ${path}: today's schema has no such point`);
        if (COVERAGE_PARTS.some((part) => [...(listed?.[part]?.visited ?? []), ...(listed?.[part]?.notVisited ?? []).map((entry) => entry.at)].includes(path))) stale.push(`${kindName}: ${path}: the fixture of ${NEWEST} already knows it`);
      }
    }
    expect(stale).toEqual([]);
  });
});

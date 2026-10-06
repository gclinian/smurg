// The slots of the real features, as the app composes them: every `features/<feature>/slots.tsx` exports `slots` under
// its folder's name, and together they make a registry without a conflict.
import { describe, expect, it } from 'vitest';
import { COLUMN_KINDS } from '../../lib/columns/target.ts';
import { FEATURE_SLOTS, FEATURE_SLOT_MODULES, featureSlotRegistry } from './feature-slots.ts';

/** Every production source file of a feature folder, as text. */
const FEATURE_SOURCES = import.meta.glob<string>(['../../features/**/*.{ts,tsx}', '!../../features/**/*.test.{ts,tsx}', '!../../features/**/test-support.tsx', '!../../features/**/testing/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * The imports from one feature folder into another, as `importer → imported/file`. Features talk through commands
 * (lib/commands.ts) and slots (lib/slots.ts); what is left is one feature MOUNTING a component or using a pure
 * helper that another one owns, and each such line is a decision:
 */
const MOUNTS: readonly string[] = [
  // The console's "Merge requests" section is the worktree feature's list and review.
  'console → worktree/index.tsx',
  // Paths in agent text are found by the terminal's path finder (DESIGN §5.5 "the existing path-links logic").
  'conversation → agents/path-links.ts',
  // Agent text, the spec's Read view and a report's sections are one Markdown renderer.
  'conversation → markdown/index.ts',
  'topics → markdown/index.ts',
  // The force-release confirmation of a file lock is the file tree's.
  'editor → files/ForceReleaseDialog.tsx',
  // The spec and plan columns mount the collaborative editor's document pane.
  'topics → editor/standalone.tsx',
  // A report's changes, "Merge…", the Changes column and "Show the changes" are the worktree feature's review.
  'topics → worktree/index.tsx',
  // The New topic dialog contains the host's review of the folder's Claude Code project settings: the ONE review.
  'topics → console/claude-config.ts',
  'topics → console/ProjectSettingsReview.tsx',
];

describe('features and each other', () => {
  it('a feature imports another feature only where the list says so: everything else goes through commands and slots', () => {
    const found = new Set<string>();
    for (const [path, source] of Object.entries(FEATURE_SOURCES)) {
      const importer = path.split('/features/')[1]?.split('/')[0] as string;
      // From any depth of the importer's folder: the specifier climbs to features/ and enters another folder.
      for (const match of source.matchAll(/from '((?:\.\.\/)+)([a-z-]+)\/([^']+)'/g)) {
        const depth = (path.split('/features/')[1] as string).split('/').length - 1;
        const ups = (match[1] as string).length / 3;
        if (ups !== depth) continue;
        const imported = match[2] as string;
        if (imported !== importer) found.add(`${importer} → ${imported}/${match[3] as string}`);
      }
    }
    expect([...found].sort()).toEqual([...MOUNTS].sort());
  });

  it('no feature reaches into the dialogs of the console: a conversation asks with a command', () => {
    const importers = Object.entries(FEATURE_SOURCES)
      .filter(([path, source]) => !path.includes('/features/console/') && /console\/dialogs\.ts'/.test(source))
      .map(([path]) => path);
    expect(importers).toEqual([]);
  });
});

describe('feature slots', () => {
  it('finds every slots.tsx by convention; each registers under its folder\'s name', () => {
    expect(FEATURE_SLOT_MODULES.length).toBeGreaterThanOrEqual(1);
    expect(FEATURE_SLOTS.map((slots) => slots.feature)).toEqual(FEATURE_SLOT_MODULES.map((path) => path.split('/').at(-2)));
    expect(featureSlotRegistry.features).toEqual(FEATURE_SLOTS.map((slots) => slots.feature));
  });

  it('every column kind is registered by at most one feature (the registry was built without a conflict)', () => {
    for (const kind of COLUMN_KINDS) {
      const owners = FEATURE_SLOTS.filter((slots) => slots.columns?.[kind] !== undefined).map((slots) => slots.feature);
      expect(owners.length, kind).toBeLessThanOrEqual(1);
      expect(featureSlotRegistry.column(kind) !== null, kind).toBe(owners.length === 1);
    }
  });
});

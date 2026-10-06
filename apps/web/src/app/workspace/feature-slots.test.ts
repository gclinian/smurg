// The slots of the real features, as the app composes them: every `features/<feature>/slots.tsx` exports `slots` under
// its folder's name, and together they make a registry without a conflict.
import { describe, expect, it } from 'vitest';
import { COLUMN_KINDS } from '../../lib/columns/target.ts';
import { FEATURE_SLOTS, FEATURE_SLOT_MODULES, featureSlotRegistry } from './feature-slots.ts';

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

// The slots of every feature, found by convention: `src/features/<feature>/slots.tsx` exports `slots`
// (lib/slots.ts says what a feature may contribute). Loaded with the workspace page, so a slots file imports its
// components with React.lazy and nothing heavy itself.
import { createSlotRegistry, type FeatureSlots, type SlotRegistry } from '../../lib/slots.ts';

const modules = import.meta.glob<{ readonly slots?: FeatureSlots }>('../../features/*/slots.tsx', { eager: true });

/** The features that have a slots file, by folder name, in a stable order. */
export const FEATURE_SLOT_MODULES: readonly string[] = Object.keys(modules).sort();

function collect(): FeatureSlots[] {
  const found: FeatureSlots[] = [];
  for (const path of FEATURE_SLOT_MODULES) {
    const folder = path.split('/').at(-2) as string;
    const slots = modules[path]?.slots;
    if (slots === undefined) throw new Error(`${path} must export \`slots\` (defineSlots, lib/slots.ts)`);
    if (slots.feature !== folder) throw new Error(`${path}: slots.feature is "${slots.feature}", the folder is "${folder}"`);
    found.push(slots);
  }
  return found;
}

/** Every feature's slots, as the app composes them. */
export const FEATURE_SLOTS: readonly FeatureSlots[] = collect();

export const featureSlotRegistry: SlotRegistry = createSlotRegistry(FEATURE_SLOTS);

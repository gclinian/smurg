// React access to what the features registered (lib/slots.ts). The workspace route provides the registry of every
// `features/*/slots.tsx` (app/workspace/feature-slots.ts); a test provides its own, or none (every column then shows
// the frame's placeholder).
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { EMPTY_SLOT_REGISTRY, type SlotEnv, type SlotRegistry } from '../slots.ts';
import { useCapabilities, useCommands, useMember, useStores } from './context.tsx';

const SlotRegistryContext = createContext<SlotRegistry>(EMPTY_SLOT_REGISTRY);

export function SlotRegistryProvider({ registry, children }: { registry: SlotRegistry; children: ReactNode }) {
  return <SlotRegistryContext.Provider value={registry}>{children}</SlotRegistryContext.Provider>;
}

export function useSlots(): SlotRegistry {
  return useContext(SlotRegistryContext);
}

/** What a slot function gets: the stores, the command bus and who is looking. Stable until one of them changes. */
export function useSlotEnv(): SlotEnv {
  const stores = useStores();
  const commands = useCommands();
  const capabilities = useCapabilities();
  const member = useMember();
  return useMemo(() => ({ stores, commands, capabilities, member }), [stores, commands, capabilities, member]);
}

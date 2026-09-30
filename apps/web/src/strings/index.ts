// The complete zh-TW catalogue: every app-wide namespace plus every feature's `features/<feature>/strings.ts`, which
// are discovered by convention (import.meta.glob), so adding a feature's strings never means editing this file.
// Import this module once at startup (main.tsx); components import their namespace's translator directly.
import './app.ts';
import './connection.ts';
import './join.ts';
import './stores.ts';
import './ui.ts';
import './workbench.ts';

/**
 * Feature namespaces, loaded eagerly even when the feature's code is lazy. A strings.ts imports only catalog.ts.
 * (Not `Object.keys(import.meta.glob(…))`: Vite then imports nothing and only lists the paths.)
 */
const featureStringModules = import.meta.glob<Record<string, unknown>>('../features/*/strings.ts', { eager: true });
export const FEATURE_STRING_MODULES: readonly string[] = Object.entries(featureStringModules).map(([path]) => path);

export { catalogueEntries, defineStrings, hasString, interpolate, registeredNamespaces, t, type StringVars, type Translator } from './catalog.ts';

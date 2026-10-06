// What the daemon's own suites wait for while v0.5.0 is being built (DESIGN §9.3 P0 "Exit", §9.4): the feature modules
// that are not in DEFAULT_FEATURE_MODULES yet, the service slots that are therefore still stubs, and (in
// wire-text-owners.ts) the catalog ids nothing in the daemon produces yet. Each row names the package that brings it.
//
// The integration engineer (P12) removes a row when the module is composed. With SMURG_RELEASE_GATE=1 every list
// here must be empty: the suites that read them fail otherwise.
import type { FeatureServiceName } from '../../src/core/interfaces.ts';

export const RELEASE_GATE = process.env['SMURG_RELEASE_GATE'] === '1';

/** The module list of the release, in composition order (DESIGN §9.3 P12; stopping runs it backwards). */
export const RELEASE_MODULES = ['locks', 'hooks', 'files', 'docs', 'worktree', 'sessions', 'conversation', 'suggest', 'topics', 'inbox', 'local'] as const;

/** Modules of the release that are not composed yet, with their package. Empty: the release composition is on. */
export const PENDING_MODULES: Readonly<Partial<Record<(typeof RELEASE_MODULES)[number], string>>> = Object.freeze({});

/** Service slots that are still stubs in the default composition, with the package whose module fills them. Empty. */
export const PENDING_SERVICES: Readonly<Partial<Record<FeatureServiceName, string>>> = Object.freeze({});

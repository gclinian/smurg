import { DAEMON_VERSION } from '@smurg/daemon';
import { PROTOCOL_VERSION } from '@smurg/protocol';
import cliPackage from '../package.json' with { type: 'json' };

/** Set by scripts/build-sea.ts (esbuild `define`, from `--version`) in a release build; absent when run from source. */
declare const __SMURG_BUILD_VERSION__: string | undefined;

/** The release version of a built executable, else the package version (from source: package.json, e.g. `0.1.0`). */
export const CLI_VERSION: string = typeof __SMURG_BUILD_VERSION__ === 'string' ? __SMURG_BUILD_VERSION__ : cliPackage.version;

/** One line for `smurg --version`; also proves that both workspace packages resolve and load. */
export function versionBanner(): string {
  return `smurg ${CLI_VERSION} (protocol v${PROTOCOL_VERSION}, daemon ${DAEMON_VERSION}, node ${process.versions.node})`;
}

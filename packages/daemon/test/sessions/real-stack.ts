// TEST ONLY: what tests of the REAL sessions and hooks modules share.
import { fileURLToPath } from 'node:url';

/** The `smurg` command as sessions run it in development: config.sessions.selfCommand = node + this file. */
export const CLI_MAIN = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url));

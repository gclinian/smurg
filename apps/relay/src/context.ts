import type { SigningKeys } from './auth/keys.ts';
import type { RelayConfig } from './lib/config.ts';

/** Everything a Worker route handler needs about the current request. */
export type RequestContext = {
  req: Request;
  url: URL;
  env: Env;
  config: RelayConfig;
  /** Parsed lazily: routes that sign or verify nothing never touch the key. */
  keys(): Promise<SigningKeys>;
};

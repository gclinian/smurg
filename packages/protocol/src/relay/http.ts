import { z } from 'zod';
import type { RelayAuthProvider } from './routes.ts';

// Bodies of the relay's plain HTTP routes (ARCHITECTURE §6) that the relay and its clients both have to agree on.
// Strict like the control frames (./frames.ts): relay and clients ship from one repository, so a new field is a
// protocol change, and an unknown field is rejected rather than silently carried along.

/**
 * `GET /api/login-options` (no session needed, `Cache-Control: no-store`): which login buttons to show.
 *
 *  - `providers.github` / `providers.google`: the relay has a complete configuration for that OAuth provider
 *    (a login through it would start instead of answering 503).
 *  - `dev`: the dev-only login is open for THIS request: DEV_LOGIN=1 on the relay AND the request addressed a local
 *    hostname. Always false in production.
 *
 * Booleans only: never a client id, an endpoint or anything else about the configuration.
 */
export const relayLoginOptionsSchema = z.strictObject({
  providers: z.strictObject({
    github: z.boolean(),
    google: z.boolean(),
  } satisfies Record<RelayAuthProvider, z.ZodBoolean>),
  dev: z.boolean(),
});
export type RelayLoginOptions = z.infer<typeof relayLoginOptionsSchema>;

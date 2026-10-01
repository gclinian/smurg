// smurg relay Worker (ARCHITECTURE §6): OAuth login and relay sessions (the CLI's through the device-code login),
// identity tokens, and per-workspace WebSocket tunnels that forward ciphertext only. It also serves the web SPA
// (wrangler.jsonc `assets`); only the paths in RELAY_WORKER_FIRST_PATTERNS reach this code.
import { handleRequest } from './router.ts';

export { DeviceLoginDO } from './auth/device-store.ts';
export { TransferDO } from './rooms/transfer.ts';
export { WorkspaceDO } from './rooms/workspace.ts';

export default {
  fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

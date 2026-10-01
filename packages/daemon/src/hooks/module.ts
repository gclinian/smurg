// Feature module of src/hooks/ (ARCHITECTURE §7.2, §7.7): the hook + MCP Unix socket (config.runPaths.hook), the
// session settings / mcp.json writer, and the backend of the coordination MCP tools (op 'mcp' on the same socket).
// The processes Claude Code starts are separate entry points that never import the daemon: src/hooks/hook-cli.ts
// (`smurg hook`) and src/mcp/coord-server.ts (`smurg mcp`).
// Slot: `hooks` (HookServer; the implementation also writes the session launch files, see HookServerImpl).
//
// Order (src/daemon.ts): after locks, before sessions. start() opens the socket before any session can
// start; stop() runs after the sessions module stopped, so a dying session's Stop / SessionEnd hooks are still
// answered. start() never depends on selfCommand or a claude binary: without selfCommand the daemon runs and only
// writeSessionFiles() refuses (fail closed at session start, not at daemon start).
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { DisposableStack } from '../core/lifecycle.ts';
import { HookServerImpl } from './hook-server.ts';

const servers = new WeakMap<DaemonContext, HookServerImpl>();

export const hooksModule: FeatureModule = {
  name: 'hooks',
  create: (ctx) => {
    const server = new HookServerImpl(ctx);
    servers.set(ctx, server);
    return { hooks: server };
  },
  register: (_router, ctx) => {
    const stack = new DisposableStack();
    const server = servers.get(ctx);
    // Belt and braces: the session manager unregisters sessions itself; a session that exited must never keep a
    // working token.
    if (server) stack.add(ctx.bus.on('session.exited', ({ session }) => server.unregisterSession(session.id)));
    return stack;
  },
  start: async (ctx) => {
    await servers.get(ctx)?.start();
  },
  stop: async (ctx) => {
    await servers.get(ctx)?.stop();
  },
};

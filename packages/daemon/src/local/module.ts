// Feature module of src/local/ (ARCHITECTURE §7.2, §8 "Control socket"): the control socket (config.runPaths.ctl)
// for `smurg stop`, `smurg status` and the host's local `smurg attach`, built on ctx.lifecycle and the frames of
// src/local/protocol.ts (server: ./control-server.ts).
// Slot: none (it implements no feature service; it uses ctx.lifecycle, which only the composition root provides).
//
// Order (src/daemon.ts): last. start() opens the socket after every other module is up (a local attach never sees a
// half-started daemon) and refuses to start when another live daemon answers on the path (fail closed: the daemon
// start is aborted).
//
// Stopping. This module's stop() runs FIRST (reverse order), after the hub already sent channel.closed{stopped} to
// the local clients. The socket is NOT closed there: it stays open while the rest of the daemon stops (sessions end,
// guests' temp dirs are removed, documents are flushed) and closes when the handler registrations are disposed, which
// the composition root does after every module's stop(). Otherwise `smurg stop`, which waits for the socket to go,
// would report "sharing stopped" while the sessions are still being ended. Meanwhile the socket keeps answering from the
// daemon's own state: `status` with `stopped: true`, `stop` with ok (nothing left to do), `attach` with an error (the
// daemon refuses local attaches once it stops). whenClosed() tells a host process when the socket and pid file are gone.
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { toDisposable } from '../core/lifecycle.ts';
import { ControlServer, type ControlServerLimits } from './control-server.ts';
import { namedWebOrigin } from './protocol.ts';

export interface LocalControlModuleOptions {
  /**
   * Carries out a `stop` request (after its reply went out). Default: ctx.lifecycle.stop(reason), not awaited from
   * inside the module (stop() stops this module too). A host process that must know when the stop finished passes its
   * own routine that calls daemon.stop() and awaits it.
   */
  readonly requestStop?: (ctx: DaemonContext, reason: string) => void;
  readonly limits?: Partial<ControlServerLimits>;
}

export interface LocalControlModule extends FeatureModule {
  /** Resolves when every control socket this module opened is closed again and its files are removed (at once if none). */
  whenClosed(): Promise<void>;
}

export function createLocalControlModule(options: LocalControlModuleOptions = {}): LocalControlModule {
  const servers = new WeakMap<DaemonContext, ControlServer>();
  const closing = new Set<Promise<void>>();

  const close = (ctx: DaemonContext): void => {
    const server = servers.get(ctx);
    servers.delete(ctx);
    if (!server) return;
    const done = server.stop().catch((err: unknown) => {
      ctx.log.error('control socket stop failed', { error: err instanceof Error ? err.name : 'unknown' });
    });
    closing.add(done);
    void done.finally(() => closing.delete(done));
  };

  return {
    name: 'local',
    // Disposed by the composition root after every module stopped: the moment the socket may go (see above).
    register: (_router, ctx) => toDisposable(() => close(ctx)),
    start: async (ctx) => {
      const requestStop = options.requestStop;
      const server = new ControlServer({
        path: ctx.config.runPaths.ctl,
        pidPath: ctx.config.runPaths.pid,
        hostUserId: ctx.config.hostUserId,
        webOrigin: namedWebOrigin(ctx.config.webOrigin),
        lifecycle: ctx.lifecycle,
        log: ctx.log.child({ module: 'control' }),
        ...(requestStop ? { requestStop: (reason: string) => requestStop(ctx, reason) } : {}),
        ...(options.limits ? { limits: options.limits } : {}),
      });
      await server.start();
      servers.set(ctx, server);
    },
    // Nothing to do yet: the hub already ended every attached client; the socket stays until the registrations go.
    stop: async () => {},
    whenClosed: async () => {
      await Promise.all([...closing]);
    },
  };
}

/** The module DEFAULT_FEATURE_MODULES composes. `smurg host` awaits its whenClosed() after daemon.stop(). */
export const localControlModule: LocalControlModule = createLocalControlModule();

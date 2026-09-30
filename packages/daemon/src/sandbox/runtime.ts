// srt's SandboxManager is a PROCESS-WIDE singleton: one configuration (network allow-list, the allowed Unix socket,
// the proxies it runs in this event loop) for everything wrapped in this process. SrtRuntime owns it for exactly one
// daemon at a time: a second daemon in the same process (tests only; production runs one) is refused instead of
// silently sharing the first one's allow-list and hook socket (fail closed).
//
// Verified srt behaviour this relies on (docs/research/sandbox.md, srt 0.0.77 source):
//  * wrapWithSandbox() before initialize() still wraps, but with `(allow network*)` and no read denies: never wrap
//    unless this runtime's own `ready` flag is set (srt's isSandboxingEnabled() stays true even after reset()).
//  * initialize() sets its config before checking dependencies; a failed initialize is followed by reset() here.
//  * updateConfig() replaces the WHOLE stored config (structuredClone); only the network part reaches processes that
//    already run. Callers always pass the complete base config.
//  * initialize() registers process.once('SIGINT' | 'SIGTERM' | 'exit') handlers that call reset().
import type { SrtBaseConfig, SrtSessionConfig } from './policy.ts';

/** The subset of srt's SandboxManager smurg uses (injectable: unit tests pass a fake). */
export interface SrtApi {
  isSupportedPlatform(): boolean;
  /** srt's own flag (a config is set). Necessary, not sufficient: it stays true after reset(). */
  isSandboxingEnabled(): boolean;
  checkDependenciesAsync(): Promise<{ readonly errors: readonly string[]; readonly warnings: readonly string[] }>;
  initialize(config: SrtBaseConfig): Promise<void>;
  updateConfig(config: SrtBaseConfig): void;
  wrapWithSandbox(command: string, binShell: string, customConfig: SrtSessionConfig): Promise<string>;
  /** Linux: after a wrapped command exited, lets srt remove bubblewrap's mount-point files. No-op on macOS. */
  cleanupAfterCommand(): void;
  /**
   * Linux, after initialize(): srt's network bridge sockets (HTTP and SOCKS; the same file when srt's mux serves both),
   * which srt binds into every sandbox as the only way out of its network namespace. [] on macOS.
   */
  linuxProxySockets(): readonly string[];
  reset(): Promise<void>;
  /** srt's own schema check of a whole configuration (SandboxRuntimeConfigSchema). */
  validate(config: SrtBaseConfig & Partial<SrtSessionConfig>): string | null;
  /** The installed srt version (package.json), or null when unknown. */
  readonly version: string | null;
}

/** Loads the real srt lazily: importing it evaluates its whole module graph, which only guest sessions need. */
export async function loadSrt(): Promise<SrtApi> {
  const mod = await import('@anthropic-ai/sandbox-runtime');
  const manager = mod.SandboxManager;
  const schema = mod.SandboxRuntimeConfigSchema;
  let version: string | null = null;
  try {
    const { createRequire } = await import('node:module');
    const pkg = createRequire(import.meta.url)('@anthropic-ai/sandbox-runtime/package.json') as { version?: unknown };
    version = typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    version = null; // the package's exports map may hide package.json; the pin is then checked by the tests only
  }
  type SrtConfig = Parameters<typeof manager.initialize>[0];
  type SrtCustom = NonNullable<Parameters<typeof manager.wrapWithSandbox>[2]>;
  return {
    version,
    isSupportedPlatform: () => manager.isSupportedPlatform(),
    isSandboxingEnabled: () => manager.isSandboxingEnabled(),
    checkDependenciesAsync: async () => manager.checkDependenciesAsync(),
    initialize: (config) => manager.initialize(structuredClone(config) as unknown as SrtConfig),
    updateConfig: (config) => manager.updateConfig(structuredClone(config) as unknown as SrtConfig),
    wrapWithSandbox: (command, binShell, customConfig) => manager.wrapWithSandbox(command, binShell, structuredClone(customConfig) as unknown as SrtCustom),
    cleanupAfterCommand: () => manager.cleanupAfterCommand(),
    linuxProxySockets: () => [...new Set([manager.getLinuxHttpSocketPath(), manager.getLinuxSocksSocketPath()].filter((p): p is string => typeof p === 'string' && p.length > 0))],
    reset: () => manager.reset(),
    validate: (config) => {
      const result = schema.safeParse(config);
      return result.success ? null : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    },
  };
}

/** Sets TMPDIR (what os.tmpdir() reads first on POSIX) and returns the function that restores it exactly. */
function pointTmpdirAt(dir: string): () => void {
  const previous = process.env['TMPDIR'];
  process.env['TMPDIR'] = dir;
  return () => {
    if (previous === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previous;
  };
}

export class RuntimeBusyError extends Error {
  constructor() {
    super('srt is owned by another daemon in this process');
    this.name = 'RuntimeBusyError';
  }
}

export class RuntimeInitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RuntimeInitError';
  }
}

/** A failed live update closed the network; nothing may be wrapped until the owner releases the runtime. */
export class RuntimeBrokenError extends Error {
  constructor() {
    super('the network allow-list could not be applied; the sandbox runtime is closed');
    this.name = 'RuntimeBrokenError';
  }
}

/**
 * The one owner of srt in this process. Every operation runs through one promise chain, so initialize / update /
 * wrap / reset never interleave.
 */
export class SrtRuntime {
  private owner: object | null = null;
  private api: SrtApi | null = null;
  private config: SrtBaseConfig | null = null;
  private ready = false;
  private broken = false;
  private chain: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  isOwnedBy(owner: object): boolean {
    return this.owner === owner && this.ready;
  }

  /**
   * Initializes srt for `owner` with `config`, or applies `config` when `owner` already holds it. `socketDir`: where
   * srt must create its proxy sockets when os.tmpdir() is too long for a Unix socket path (checks.ts
   * srtSocketDirProblem). srt reads os.tmpdir() only while initialize() starts its listeners, so TMPDIR is pointed at
   * `socketDir` for exactly that call and restored afterwards (the daemon's run dir: private, and short by design).
   */
  acquire(owner: object, api: SrtApi, config: SrtBaseConfig, options: { readonly socketDir?: string } = {}): Promise<void> {
    return this.serialize(async () => {
      if (this.owner !== null && this.owner !== owner) throw new RuntimeBusyError();
      if (this.owner === owner && this.ready) {
        if (this.broken) throw new RuntimeBrokenError();
        if (JSON.stringify(this.config) !== JSON.stringify(config)) this.applyUpdate(config);
        return;
      }
      const problem = api.validate(config);
      if (problem !== null) throw new RuntimeInitError(`srt rejected the configuration: ${problem}`);
      this.owner = owner;
      this.api = api;
      const restoreTmp = options.socketDir === undefined ? () => {} : pointTmpdirAt(options.socketDir);
      try {
        await api.initialize(config);
      } catch (err) {
        this.owner = null;
        this.api = null;
        await api.reset().catch(() => undefined);
        throw new RuntimeInitError(`srt initialize failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      } finally {
        restoreTmp();
      }
      this.config = config;
      this.ready = true;
      this.broken = false;
    });
  }

  /** Live change of the workspace-wide config (network allow-list). No-op while nobody holds the runtime. */
  update(owner: object, config: SrtBaseConfig): Promise<void> {
    return this.serialize(async () => {
      if (this.owner !== owner || !this.ready) return;
      if (this.broken) throw new RuntimeBrokenError();
      this.applyUpdate(config);
    });
  }

  private applyUpdate(config: SrtBaseConfig): void {
    const api = this.api as SrtApi;
    try {
      const problem = api.validate(config);
      if (problem !== null) throw new Error(problem);
      api.updateConfig(config);
      this.config = config;
    } catch (err) {
      // The old (possibly wider) allow-list must not stay in force: close the network for every running guest.
      const closed: SrtBaseConfig = { ...(this.config as SrtBaseConfig), network: { ...(this.config as SrtBaseConfig).network, allowedDomains: [] } };
      try {
        api.updateConfig(closed);
        this.config = closed;
      } catch {
        // nothing more can be done here; `broken` refuses every further wrap
      }
      this.broken = true;
      throw new RuntimeBrokenError();
    }
  }

  wrap(owner: object, command: string, binShell: string, custom: SrtSessionConfig): Promise<string> {
    return this.serialize(async () => {
      if (this.owner !== owner || !this.ready) throw new RuntimeBusyError();
      if (this.broken) throw new RuntimeBrokenError();
      return (this.api as SrtApi).wrapWithSandbox(command, binShell, custom);
    });
  }

  /** Stops srt's proxies and forgets the owner (daemon stop). */
  release(owner: object): Promise<void> {
    return this.serialize(async () => {
      if (this.owner !== owner) return;
      const api = this.api;
      this.owner = null;
      this.api = null;
      this.config = null;
      this.ready = false;
      this.broken = false;
      await api?.reset();
    });
  }
}

/** The runtime of this process (production). Tests with a fake SrtApi create their own. */
export const processSrtRuntime = new SrtRuntime();

// Public surface of @smurg/daemon (ARCHITECTURE §7.2): the composition root and the internal contract feature
// modules build against. DAEMON_VERSION stays exported: packages/cli/src/version.ts prints it.
// The test harness is NOT exported here (it pulls in test-only code): tests import `@smurg/daemon/testing`.
// Neither are the entry points Claude Code runs inside sessions: they must start without loading the daemon, so the
// CLI imports them as `@smurg/daemon/hook-cli` (runHookCli) and `@smurg/daemon/mcp` (runMcpServer).
export { DAEMON_VERSION, DEFAULT_FEATURE_MODULES, createDaemon, type Daemon, type DaemonOptions, type DaemonStatus } from './daemon.ts';
export {
  CLAUDE_MIN_VERSION,
  CLAUDE_VERIFIED_VERSIONS,
  DEFAULT_LIMITS,
  DEFAULT_TIMING,
  claudeVersionVerdict,
  compareClaudeVersions,
  defaultHostSettings,
  parseClaudeVersion,
  resolveConfig,
  type ClaudeVersionVerdict,
  type DaemonConfig,
  type DaemonConfigInput,
  type LimitsConfig,
  type SessionLaunchConfig,
  type TimingConfig,
} from './core/config.ts';
export { SOCKET_PATH_MAX_BYTES, SocketPathError, assertSocketPath, runPathsFor, shortRunId, type RunPaths } from './core/sockets.ts';
// The control-socket protocol (`smurg stop` / status / local attach), shared with the CLI.
export {
  CTL_CONTROL_MAX_BYTES,
  CTL_FRAME_KIND,
  CTL_FRAME_MAX_BYTES,
  CTL_PROTOCOL_VERSION,
  CTL_STOP_REASON,
  CtlFrameDecoder,
  CtlProtocolError,
  ctlRequestSchema,
  ctlResponseSchema,
  daemonStatusSchema,
  encodeCtlControl,
  encodeCtlFrame,
  parseCtlRequest,
  parseCtlResponse,
  type CtlFrame,
  type CtlFrameKind,
  type CtlRequest,
  type CtlResponse,
  type CtlStatus,
} from './local/protocol.ts';
export type { DaemonContext, FeatureModule } from './core/context.ts';
// The control-socket module: `smurg host` awaits whenClosed() so it exits only after `smurg stop` saw the socket go.
export { createLocalControlModule, localControlModule, type LocalControlModule, type LocalControlModuleOptions } from './local/module.ts';
export type * from './core/interfaces.ts';
export { FEATURE_SERVICE_LABELS, FEATURE_SERVICE_NAMES, LOCAL_DEVICE_ID, POWER_REASONS } from './core/interfaces.ts';
export { AuthorizationError, PATH_DENIED_REASONS, PathDeniedError, isAuthorizationError, isPathDeniedError, notImplemented, type PathDeniedReason } from './core/errors.ts';
export { DisposableStack, ManualClock, ShiftableClock, monotonicNow, newId, systemClock, toDisposable, type Clock, type Disposable } from './core/lifecycle.ts';
export { LOG_UNSAFE_CHARACTER, createLineLogger, createMemoryLogger, quoteForLog, silentLogger, type LogFields, type Logger, type LogLevel } from './core/logger.ts';
export { SYSTEM_ACTOR, SYSTEM_PRINCIPAL, agentDisplayName, agentPrincipalFor, isHostPrincipal, principalCan, userActor, userPrincipal } from './core/permissions.ts';
export { auditDetailForMessage, sanitizeAuditDetail } from './core/audit.ts';
export { createStubService, isStubService } from './core/stubs.ts';
export { StateFileError } from './core/state-store.ts';
export { wsHostSocketFactory, type HostSocket, type HostSocketFactory, type HostSocketHandlers } from './net/host-socket.ts';
export { IDENTITY_TOKEN_TYPE, jwksKeySource, staticKeySource, type IdentityKeySource } from './net/identity.ts';
export { KeepAwake } from './workspace/power.ts';
export { HOMES_PARENTS, SHARE_ERROR_REASONS, ShareError, type ShareErrorReason } from './workspace/share.ts';
export { SHARE_LOCK_MARKER, ShareLockError } from './workspace/share-lock.ts';
export type { RelayLinkState } from './net/relay-connection.ts';
export type { UnsavedDocument } from './core/state-store.ts';

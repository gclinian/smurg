// Public surface of @smurg/daemon (ARCHITECTURE §7.2): the composition root and the internal contract feature
// modules build against. DAEMON_VERSION stays exported: packages/cli/src/version.ts prints it.
// The test harness is NOT exported here (it pulls in test-only code): tests import `@smurg/daemon/testing`, and the
// in-memory fakes of the protocol 4 services `@smurg/daemon/fakes` (src/core/fakes).
// Neither are the entry points Claude Code runs inside sessions: they must start without loading the daemon, so the
// CLI imports them as `@smurg/daemon/hook-cli` (runHookCli) and `@smurg/daemon/mcp` (runMcpServer).
export { DAEMON_VERSION, DEFAULT_FEATURE_MODULES, START_FAILURE_LOGS, createDaemon, type Daemon, type DaemonOptions, type DaemonStatus } from './daemon.ts';
export {
  CLAUDE_MIN_VERSION,
  CLAUDE_VERIFIED_VERSIONS,
  DEFAULT_AGENTS_CONFIG,
  DEFAULT_LIMITS,
  DEFAULT_TIMING,
  claudeVersionVerdict,
  compareClaudeVersions,
  defaultHostSettings,
  defaultMaxLiveAgents,
  parseClaudeVersion,
  resolveConfig,
  type AgentsConfig,
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
  // The command's side (0.5.1): an answer read with unknown keys ignored; the daemon keeps sending the strict ones.
  commandCtlResponseSchema,
  commandDaemonStatusSchema,
  readCtlResponse,
  type CtlFrame,
  type CtlFrameKind,
  type CtlRequest,
  type CtlResponse,
  type CtlResponseRead,
  type CtlStatus,
} from './local/protocol.ts';
export type { DaemonContext, FeatureModule } from './core/context.ts';
// The control-socket module: `smurg host` awaits whenClosed() so it exits only after `smurg stop` saw the socket go.
export { createLocalControlModule, localControlModule, type LocalControlModule, type LocalControlModuleOptions } from './local/module.ts';
export type * from './core/interfaces.ts';
export { AUDIT_FULL_TEXT_HEAD_CHARS, FEATURE_SERVICE_LABELS, FEATURE_SERVICE_NAMES, LOCAL_DEVICE_ID, POWER_REASONS } from './core/interfaces.ts';
export { AuthorizationError, PATH_DENIED_REASONS, PathDeniedError, isAuthorizationError, isPathDeniedError, notImplemented, type PathDeniedReason } from './core/errors.ts';
export { DisposableStack, ManualClock, ShiftableClock, monotonicNow, newId, systemClock, toDisposable, type Clock, type Disposable } from './core/lifecycle.ts';
export { LOG_UNSAFE_CHARACTER, createLineLogger, createMemoryLogger, quoteForLog, silentLogger, type LogFields, type Logger, type LogLevel } from './core/logger.ts';
export { SYSTEM_ACTOR, SYSTEM_PRINCIPAL, agentDisplayName, agentPrincipalFor, isHostPrincipal, principalCan, userActor, userPrincipal } from './core/permissions.ts';
export { auditDetailForMessage, sanitizeAuditDetail } from './core/audit.ts';
export { RATE_BUCKET_SIZES, TokenBucketLimiter } from './core/rates.ts';
export { createStubService, isStubService } from './core/stubs.ts';
export {
  STATE_FILE_INSECURE_CAUSES,
  STATE_FILE_KINDS,
  STATE_FILE_PROBLEMS_MAX,
  STATE_FILE_UNREADABLE_REASONS,
  StateFileError,
  type StateFileCopy,
  type StateFileErrorInit,
  type StateFileInsecureCause,
  type StateFileKind,
  type StateFilePhase,
  type StateFileUnreadableReason,
} from './core/state-file-error.ts';
export { wsHostSocketFactory, type HostSocket, type HostSocketFactory, type HostSocketHandlers } from './net/host-socket.ts';
export { IDENTITY_TOKEN_TYPE, jwksKeySource, staticKeySource, type IdentityKeySource } from './net/identity.ts';
export { KeepAwake } from './workspace/power.ts';
export { HOMES_PARENTS, SHARE_ERROR_REASONS, ShareError, type ShareErrorReason } from './workspace/share.ts';
export { SHARE_LOCK_MARKER, ShareLockError } from './workspace/share-lock.ts';
export type { RelayLinkState } from './net/relay-connection.ts';
export type { UnsavedDocument } from './core/state-store.ts';
// What a module declares (FeatureModule.documents), and the two files a start adds to a workspace folder (0.5.1): the
// stamp `written-by.json` and the kept copies `<name>.json.before-upgrade-from-<step>`.
export { STAMP_FILE, WORKSPACE_SHAPES, declareDocument, defineStep, type DocumentDeclaration, type DocumentStep, type StepEnv, type WorkspaceStamp } from './core/state-store.ts';

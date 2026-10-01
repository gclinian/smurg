// TEST ONLY: a daemon in its own process, spawned (and, for the "daemon crash" case, SIGKILLed by its recorded pid)
// by a test. No relay: only local connections through the control socket. Its state dir is $SMURG_HOME, so the CLI
// finds its control socket exactly as in production (<SMURG_HOME>/run/<short>.ctl). The test controls the whole
// environment (fake HOME, SHELL=/bin/sh, a minimal PATH): host terminal sessions run a login /bin/sh with it, never
// the developer's own shell setup.
//
//   node daemon-proc.ts <shareDir> <workspaceId> [<host terminal title>]
//     → with a title: opens a terminal session of the host first (as the host's web client would: the control socket
//       cannot open sessions, review F1) and prints "session <SessionInfo JSON>";
//     → prints "ready <ctl path>" once listening; SIGTERM stops it.
import { DEFAULT_FEATURE_MODULES, createDaemon, silentLogger, userPrincipal, type ClientConnection } from '@smurg/daemon';

const [shareDir, workspaceId, hostTerminalTitle] = process.argv.slice(2);
const stateDir = process.env['SMURG_HOME'];
if (!shareDir || !workspaceId || !stateDir) {
  process.stderr.write('usage: SMURG_HOME=<dir> node daemon-proc.ts <shareDir> <workspaceId> [<host terminal title>]\n');
  process.exit(2);
}

// The real sessions module and the real control socket; nothing else is needed for host terminals.
const modules = DEFAULT_FEATURE_MODULES.filter((m) => m.name === 'sessions' || m.name === 'local');
const daemon = await createDaemon({
  config: { stateDir, shareDir, workspaceId, hostUserId: 'dev:host', hostName: 'Host', relayUrl: null, keepAwake: false },
  modules,
  log: silentLogger,
  homeDir: process.env['HOME'] as string,
});
await daemon.start();
if (hostTerminalTitle) {
  const host = daemon.ctx.members.active('dev:host');
  const principal = host ? userPrincipal(host) : null;
  if (!principal) throw new Error('the host is not a member');
  // SessionManager.create does not use the connection (the owner is the principal); there is none on this side.
  const session = await daemon.ctx.services.sessions.create(
    { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24, title: hostTerminalTitle },
    null as unknown as ClientConnection,
    principal,
  );
  process.stdout.write(`session ${JSON.stringify(session)}\n`);
}
process.stdout.write(`ready ${daemon.config.runPaths.ctl}\n`);
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  void daemon.stop('test').then(() => process.exit(0));
});

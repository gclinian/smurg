// TEST ONLY. Run by test/upgrade/other-version.test.ts INSIDE A TREE OF A PUBLISHED TAG (`git archive v0.5.0`), with
// plain node: it starts THAT tree's daemon (its own createTestDaemon: every module of that release, an in-memory
// relay, no way to start an agent process) on a workspace folder, says what that daemon read, and stops it.
//
//   node test/upgrade/published-runner.ts <SMURG_HOME> <workspace id> <shared folder> <clock, epoch ms>
//
// It prints one line `RESULT <json>`: `{ ok: true, … }` and exit code 0, or, when that daemon refuses the folder,
// `{ ok: false, name, message }` and exit code 2. It uses nothing a published tree may lack: only what tag v0.5.0
// already had, and no TypeScript that node cannot run by leaving the types out.
import { createTestDaemon } from '../../src/testing/index.ts';
import { DAEMON_VERSION } from '../../src/daemon.ts';

const [stateDir, workspaceId, root, at] = process.argv.slice(2);
if (stateDir === undefined || workspaceId === undefined || root === undefined || at === undefined) throw new Error('usage: published-runner.ts <SMURG_HOME> <workspace id> <shared folder> <clock ms>');

// A clock that stands at the given instant and runs on from there.
const offset = Number(at) - Date.now();
const clock = { now: (): number => Date.now() + offset, monotonic: (): number => performance.now() };

let result: Record<string, unknown>;
try {
  const t = await createTestDaemon({ stateDir, workspaceId, root, clock });
  const members = t.ctx.members.list({ includeKicked: true });
  result = {
    ok: true,
    smurg: DAEMON_VERSION,
    workspaceId: t.daemon.workspaceId,
    fingerprint: t.daemon.fingerprint,
    members: members.map((member) => `${member.userId} ${member.role} ${member.status}`),
    revokedDevices: members.flatMap((member) => t.daemon.internals.members.devicesOf(member.userId)).filter((device) => device.revoked).map((device) => device.deviceId).sort(),
    devices: members.flatMap((member) => t.daemon.internals.members.devicesOf(member.userId)).length,
    invites: t.ctx.invites.list().map((invite) => invite.id),
    settings: t.ctx.settings.get(),
  };
  await t.cleanup();
} catch (err) {
  result = { ok: false, name: err instanceof Error ? err.name : 'unknown', message: err instanceof Error ? err.message : String(err) };
}
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
// Timers of an in-memory relay may outlive the daemon: this process is done.
setTimeout(() => process.exit(result['ok'] === true ? 0 : 2), 50);

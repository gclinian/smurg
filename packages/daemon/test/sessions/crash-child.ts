// TEST ONLY: the child process of the REL-09 test in kill.test.ts. A daemon (the test harness) on the state dir, share
// and workspace id the parent chose, with one host terminal session that starts a `nohup` background job (a dev
// server, a watcher). It prints READY once the job's pid is in the daemon's live-session record, then waits for the
// parent to SIGKILL it: the "daemon died hard" moment. It signals nothing itself.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestDaemon, waitFor } from '../../src/testing/index.ts';

const [stateDir, root, workspaceId, pidFile, seconds] = process.argv.slice(2) as [string, string, string, string, string];
if (!/^[0-9]{7}$/.test(seconds)) throw new Error('bad job duration');
const t = await createTestDaemon({ stateDir, root, workspaceId });
const host = await t.connectHost();
const { session } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
host.conn.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode(`nohup sleep ${seconds} >/dev/null 2>&1 & echo $! > '${pidFile}'\r`) });
await waitFor(async () => (await readFile(pidFile, 'utf8').catch(() => '')).trim() !== '', { timeoutMs: 20_000, what: 'the background job' });
const pid = (await readFile(pidFile, 'utf8')).trim();
const recorded = async (): Promise<boolean> => {
  const text = await readFile(join(t.ctx.state.dir, 'sessions.json'), 'utf8').catch(() => '{}');
  const doc = JSON.parse(text) as { procs?: Record<string, { pid: number }[]> };
  return Object.values(doc.procs ?? {}).some((list) => list.some((entry) => String(entry.pid) === pid));
};
await waitFor(recorded, { timeoutMs: 20_000, what: 'the job in the live-session record' });
process.stdout.write('READY\n');
setInterval(() => {}, 1_000);

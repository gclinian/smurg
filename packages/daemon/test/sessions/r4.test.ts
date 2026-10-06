// SPEC R4 acceptance at the daemon level: real sessions module, real PTYs, real SDK clients through the in-memory
// relay. R4.3 and R4.4 (a guest's own environment and temp dir) are superseded by ARCHITECTURE §11 D-15: every session
// runs like the host's own, and what replaces them is tested here (the host's environment minus a parent Claude Code
// session's kill switches; the sessions of a member who leaves end within R4.4's 5 s).
import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_HOST_USER } from '../../src/testing/index.ts';
import { TestViewer, sleep, typeInto, waitFor } from './helpers.ts';
import { startSessionStack, type SessionStack } from './setup.ts';

const execFileAsync = promisify(execFile);
const stacks: SessionStack[] = [];
const viewers: TestViewer[] = [];

afterEach(async () => {
  for (const viewer of viewers.splice(0)) viewer.dispose();
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function stack(options: Parameters<typeof startSessionStack>[0] = {}): Promise<SessionStack> {
  const s = await startSessionStack(options);
  stacks.push(s);
  return s;
}

function viewer(...args: ConstructorParameters<typeof TestViewer>): TestViewer {
  const v = new TestViewer(...args);
  viewers.push(v);
  return v;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('R4 agent session', { timeout: 60_000 }, () => {
  it('one session attached from the web and the CLI at once shows the same screen — two clients\' rendered buffers after output that repaints, scrolls and resizes', async () => {
    const s = await stack();
    const phaseOne = [
      'FILL=0123456789012345678901234567890123456789',
      'i=1',
      "while [ $i -le 150 ]; do printf '\\033[3%dmrow %03d\\033[0m %s\\n' $((i % 7 + 1)) $i \"$(echo $FILL | cut -c1-$((i % 40 + 1)))\"; i=$((i+1)); done",
      'j=0',
      "while [ $j -le 20 ]; do printf '\\r\\033[2Kprogress %d%%' $((j * 5)); j=$((j+1)); done",
      "printf '\\n\\033[3A\\033[2Krepainted-above\\033[3B\\n'",
      "printf 'PHASE-ONE-%s\\n' DONE",
    ].join('\n');
    const phaseTwo = [
      "printf '%s\\n' 'LONG-LINE-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-END'",
      "printf '\\033[?1049h\\033[2J\\033[5;5Halternate-screen\\033[?1049l'",
      "printf '\\033[1;33mbold-yellow\\033[0m \\033[4munderlined\\033[0m\\n'",
      "printf 'PHASE-TWO-%s\\n' DONE",
    ].join('\n');
    await writeFile(join(s.t.root, 'phase1.sh'), `${phaseOne}\n`);
    await writeFile(join(s.t.root, 'phase2.sh'), `${phaseTwo}\n`);

    const web = await s.t.connectHost();
    const cli = await s.t.connect({ userId: TEST_HOST_USER, role: 'host', displayName: 'Host', connection: { clientKind: 'cli', deviceName: 'smurg attach' } });
    const amy = await s.t.connect({ userId: 'dev:amy', role: 'editor' });
    const { session } = await web.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
    const webView = viewer(web.conn, session.id);
    const cliView = viewer(cli.conn, session.id);
    const amyView = viewer(amy.conn, session.id);
    await webView.attach({ cols: 100, rows: 30 });
    await cliView.attach({ cols: 90, rows: 28 });
    await amyView.attach();
    expect(s.sessions.get(session.id)).toMatchObject({ cols: 90, rows: 28, attached: 3 });

    // The owner types in the web client: it drives the size again (100x30), then runs output that scrolls and repaints.
    typeInto(web.conn, session.id, 'sh ./phase1.sh\r');
    await waitFor(() => webView.received.includes('PHASE-ONE-DONE') && cliView.received.includes('PHASE-ONE-DONE') && amyView.received.includes('PHASE-ONE-DONE'), 'phase one in every viewer');
    // The owner's window changes size mid-session.
    web.conn.notify('exec.resize', { sessionId: session.id, cols: 120, rows: 32 });
    await waitFor(() => {
      const now = s.sessions.get(session.id);
      return now?.kind === 'terminal' && now.cols === 120;
    }, 'the PTY resize');
    typeInto(web.conn, session.id, 'sh ./phase2.sh\r');
    await waitFor(() => [webView, cliView, amyView].every((v) => v.received.includes('PHASE-TWO-DONE')), 'phase two in every viewer');

    const settledOffset = async (): Promise<number> => {
      let last = -1;
      for (;;) {
        await sleep(200);
        const now = s.sessions.outputOffset(session.id) ?? 0;
        if (now === last) return now;
        last = now;
      }
    };
    const end = await settledOffset();
    await waitFor(() => [webView, cliView, amyView].every((v) => v.lastOffset === end), 'every viewer at the same offset');
    await Promise.all([webView.drained(), cliView.drained(), amyView.drained()]);

    for (const v of [webView, cliView, amyView]) expect(v.gaps).toEqual([]);
    expect(cliView.state()).toEqual(webView.state());
    expect(amyView.state()).toEqual(webView.state());
    expect(webView.state()).toMatchObject({ cols: 120, rows: 32, type: 'normal' });
    expect(cliView.lines()).toEqual(webView.lines());
    expect(amyView.lines()).toEqual(webView.lines());
    const lines = webView.lines();
    expect(lines.some((line) => line.startsWith('row 150'))).toBe(true);
    expect(lines).toContain('repainted-above');
    expect(lines.filter((line) => line.startsWith('progress'))).toEqual(['progress 100%']); // repainted in place
    expect(lines).not.toContain('alternate-screen'); // left the alternate screen again

    // A client attaching now (snapshot) shows the same screen.
    const late = await s.t.connect({ userId: 'dev:bob', role: 'viewer' });
    const lateView = viewer(late.conn, session.id);
    expect((await lateView.attach()).mode).toBe('snapshot');
    await lateView.drained();
    expect(lateView.state()).toEqual(webView.state());
    expect(lateView.viewport()).toEqual(webView.viewport());
  });

  it('a session keeps running on the host when its client disconnects; re-attaching shows the whole scrollback', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const { session } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 });
    const first = viewer(host.conn, session.id);
    await first.attach({ cols: 100, rows: 30 });
    typeInto(host.conn, session.id, 'i=1; while [ $i -le 300 ]; do echo "scroll-$i"; i=$((i+1)); sleep 0.01; done; echo LOOP-$((6*7))-FINISHED\r');
    await waitFor(() => first.received.includes('scroll-5'), 'the loop to start');

    // The client goes away (closed tab, sleeping laptop): no leave.
    const pid = s.sessions.ptyPid(session.id) as number;
    const offsetAtDisconnect = s.sessions.outputOffset(session.id) as number;
    host.close();
    await waitFor(() => s.t.ctx.hub.connections({ userId: TEST_HOST_USER }).length === 0, 'the disconnect');
    await sleep(1_500);
    expect(() => process.kill(pid, 0)).not.toThrow(); // our own child, signal 0: still alive
    expect(s.sessions.get(session.id)?.status).toBe('running');
    expect(s.sessions.outputOffset(session.id) as number).toBeGreaterThan(offsetAtDisconnect); // it kept producing

    const back = await host.reconnect();
    const second = viewer(back.conn, session.id);
    expect((await second.attach({ cols: 100, rows: 30 })).mode).toBe('snapshot');
    await waitFor(() => second.text().includes('LOOP-42-FINISHED'), 'the loop to finish');
    await second.drained();
    const lines = second.lines();
    for (let i = 1; i <= 300; i++) expect(lines.filter((line) => line === `scroll-${i}`), `scroll-${i}`).toHaveLength(1);
    expect(second.gaps).toEqual([]);
  });

  it('every session gets the host\'s own environment (its login included), never what a parent Claude Code session injected (its hook kill switches) — the real environment of processes in a session an Agent access member opened', async () => {
    // The host's own provider / login settings: every session runs with them (§11 D-15).
    const kept: Record<string, string> = {
      ANTHROPIC_API_KEY: 'sk-ant-api03-SMURG-HOST-OWN-KEY',
      CLAUDE_CODE_USE_BEDROCK: 'SMURG-HOST-BEDROCK',
    };
    // A daemon started from inside a Claude Code session must not hand its markers or hook kill switches on.
    const planted: Record<string, string> = {
      CLAUDECODE: 'SMURG-PARENT-1',
      CLAUDE_CODE_ENTRYPOINT: 'SMURG-PARENT-ENTRY',
      CLAUDE_CODE_SAFE_MODE: 'SMURG-PARENT-SAFE',
      CLAUDE_CODE_SIMPLE: 'SMURG-PARENT-SIMPLE',
      SMURG_SESSION_TOKEN: 'SMURG-PARENT-TOKEN',
    };
    const saved = new Map([...Object.keys(planted), ...Object.keys(kept)].map((name) => [name, process.env[name]]));
    Object.assign(process.env, planted, kept);
    try {
      // The daemon reads the host environment from its own process environment (the default).
      const s = await stack({ module: { hostEnv: () => process.env } });
      const carol = await s.t.connect({ userId: 'dev:carol', role: 'agent' });
      const { session } = await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 120, rows: 40 });
      const view = viewer(carol.conn, session.id);
      await view.attach({ cols: 120, rows: 40 });
      const token = `smurg-r43-${process.pid}-${Date.now()}`;
      // A non-platform binary, so macOS `ps -E` shows its environment: node started from the session's shell.
      typeInto(carol.conn, session.id, `/usr/bin/env; echo ENV-$((40+2))-DONE; '${process.execPath}' -e 'setInterval(()=>{},1000)' ${token} &\r`);
      await waitFor(() => view.received.includes('ENV-42-DONE'), 'the env listing');
      // What the shell's children see (the whole listing, not only the planted names).
      expect(view.received).toContain(`SMURG_SESSION_ID=${session.id}`);
      expect(view.received).toContain(`HOME=${s.hostHome}`);
      for (const [name, value] of Object.entries(planted)) {
        expect(view.received, name).not.toContain(`${name}=`);
        expect(view.received, name).not.toContain(value);
      }
      for (const [name, value] of Object.entries(kept)) expect(view.received, name).toContain(`${name}=${value}`);
      // The real environment of a process running in the session.
      let pid = 0;
      await waitFor(async () => {
        const { stdout } = await execFileAsync('/bin/ps', ['-A', '-ww', '-o', 'pid=,command=']);
        const line = stdout.split('\n').find((l) => l.includes(token) && l.includes('setInterval'));
        pid = line ? Number(line.trim().split(/\s+/)[0]) : 0;
        return pid > 0;
      }, 'the probe process');
      const environment =
        process.platform === 'linux'
          ? (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').join('\n')
          : (await execFileAsync('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)])).stdout;
      expect(environment).toContain(`SMURG_SESSION_ID=${session.id}`); // positive control: we read the right thing
      for (const [name, value] of Object.entries(planted)) {
        expect(environment, name).not.toContain(`${name}=`);
        expect(environment, name).not.toContain(value);
      }
      for (const [name, value] of Object.entries(kept)) expect(environment, name).toContain(`${name}=${value}`);
      await carol.conn.request('session.end', { sessionId: session.id });
      await waitFor(async () => !(await execFileAsync('/bin/ps', ['-A', '-ww', '-o', 'command=']).then((r) => r.stdout.includes(token))), 'the probe to go with the session');
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('a member who leaves loses the sessions they opened within 5 s (R4.4\'s bound) — measured from channel.leave; a disconnect alone keeps them', async () => {
    const s = await stack();
    const carol = await s.t.connect({ userId: 'dev:carol', role: 'agent' });
    const { session } = await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
    const pid = s.sessions.ptyPid(session.id) as number;

    // §11 D-9: a mere disconnect keeps the session.
    carol.close();
    await waitFor(() => s.t.ctx.hub.connections({ userId: 'dev:carol' }).length === 0, 'the disconnect');
    await sleep(300);
    expect(s.sessions.get(session.id)?.status).toBe('running');

    const back = await carol.reconnect();
    const t0 = Date.now();
    await back.conn.leave();
    await waitFor(() => s.sessions.get(session.id)?.status === 'exited', 'the session to end', 5_000);
    const elapsed = Date.now() - t0;
    console.info(`[R4.4] the leaver's session ended ${elapsed} ms after channel.leave`);
    expect(elapsed).toBeLessThan(5_000);
    expect(s.sessions.get(session.id)?.endReason).toBe('left');
    await sleep(100);
    expect(() => process.kill(pid, 0)).toThrow(); // our own child is gone
    const entries = await s.t.ctx.audit.query({ limit: 100 });
    expect(entries.some((e) => e.action === 'member.leave' && e.target === 'dev:carol')).toBe(true);
    // No guest dir exists any more to be removed.
    expect(await exists(join(s.t.stateDir, 'guests'))).toBe(false);
  });
});

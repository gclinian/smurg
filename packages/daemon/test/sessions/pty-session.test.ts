// PtySession against real PTYs (node-pty, /bin/sh scripts): fan-out, attach by snapshot or delta without loss or
// duplicates, the owner resize policy, exit. Only processes spawned here are touched; each one exits on its own or is
// hung up by its own session.
import xtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../src/core/logger.ts';
import { PtySession, type ViewerSink } from '../../src/sessions/pty-session.ts';
import { TermMirror } from '../../src/sessions/term-mirror.ts';
import { sleep, waitFor } from './helpers.ts';

const { Terminal } = xtermHeadless;
type HeadlessTerminal = InstanceType<typeof Terminal>;

const ENV = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const sessions: PtySession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

function start(script: string, options: { cols?: number; rows?: number } = {}): PtySession {
  const session = new PtySession({
    ownerUserId: 'dev:owner',
    spawn: { file: '/bin/sh', args: ['-c', script], cwd: '/', env: ENV, cols: options.cols ?? 80, rows: options.rows ?? 24 },
    log: silentLogger,
  });
  sessions.push(session);
  return session;
}

/** A viewer of one PtySession, directly on the sink (no network). */
class SinkViewer {
  readonly term: HeadlessTerminal = new Terminal({ cols: 80, rows: 24, scrollback: 10_000, allowProposedApi: true });
  offset = 0;
  readonly anomalies: string[] = [];
  resizes: string[] = [];
  readonly sink: ViewerSink = {
    output: (offset, data) => {
      if (offset !== this.offset) this.anomalies.push(`expected ${this.offset} got ${offset}`);
      this.term.write(data);
      this.offset = offset + data.length;
    },
    resize: (cols, rows) => {
      this.resizes.push(`${cols}x${rows}`);
      this.term.write('', () => this.term.resize(cols, rows));
    },
  };

  async attach(session: PtySession, key: string, userId: string, viewport: { cols: number; rows: number } | null, haveOffset?: number): Promise<string> {
    const plan = await session.attach(key, userId, this.sink, viewport, haveOffset);
    if (plan.mode === 'snapshot') {
      this.term.write('', () => {
        this.term.reset();
        this.term.resize(plan.cols, plan.rows);
      });
    } else {
      this.term.write('', () => this.term.resize(plan.cols, plan.rows));
    }
    this.term.write(plan.data);
    this.offset = plan.nextOffset;
    plan.commit();
    return plan.mode;
  }

  drained(): Promise<void> {
    return new Promise((resolve) => this.term.write('', () => resolve()));
  }

  lines(): string[] {
    const buffer = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '');
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }
}

describe('PtySession', { timeout: 30_000 }, () => {
  it('fans the same bytes out to every attached viewer; a late viewer gets the full scrollback by snapshot', async () => {
    const session = start('i=1; while [ $i -le 400 ]; do echo "line-$i"; i=$((i+1)); done; sleep 30');
    const a = new SinkViewer();
    const b = new SinkViewer();
    await a.attach(session, 'ch-a', 'dev:owner', { cols: 80, rows: 24 });
    await b.attach(session, 'ch-b', 'dev:guest', null);
    await waitFor(() => a.lines().includes('line-400') && b.lines().includes('line-400'), 'the output in both viewers');
    const late = new SinkViewer();
    expect(await late.attach(session, 'ch-late', 'dev:guest', null)).toBe('snapshot');
    await Promise.all([a.drained(), b.drained(), late.drained()]);
    expect(a.anomalies).toEqual([]);
    expect(b.anomalies).toEqual([]);
    expect(late.lines().filter((line) => line.startsWith('line-'))).toHaveLength(400);
    expect(late.lines()).toEqual(b.lines().slice(b.lines().length - late.lines().length));
  });

  it('re-attach with a buffered offset is an exact raw delta (no duplicate, no gap)', async () => {
    const session = start('echo first; sleep 0.3; echo second; sleep 30');
    const viewer = new SinkViewer();
    await viewer.attach(session, 'ch', 'dev:guest', null);
    await waitFor(() => viewer.lines().includes('first'), 'first');
    const have = viewer.offset;
    session.detach('ch');
    await waitFor(() => session.offset > have, 'more output while detached');
    await sleep(50);
    expect(await viewer.attach(session, 'ch', 'dev:guest', null, have)).toBe('delta');
    await viewer.drained();
    expect(viewer.lines().filter((line) => line === 'first')).toHaveLength(1);
    expect(viewer.lines()).toContain('second');
    expect(viewer.anomalies).toEqual([]);
  });

  it('owner policy: the owner\'s most recently active viewer drives the PTY size; others never resize it', async () => {
    const session = start('while :; do sleep 1; done', { cols: 80, rows: 24 });
    const guest = new SinkViewer();
    await guest.attach(session, 'guest', 'dev:guest', { cols: 200, rows: 60 });
    expect([session.cols, session.rows]).toEqual([80, 24]);
    const web = new SinkViewer();
    await web.attach(session, 'web', 'dev:owner', { cols: 120, rows: 40 });
    expect([session.cols, session.rows]).toEqual([120, 40]);
    expect(guest.resizes).toEqual(['120x40']);
    const cli = new SinkViewer();
    await cli.attach(session, 'cli', 'dev:owner', { cols: 100, rows: 30 });
    expect([session.cols, session.rows]).toEqual([100, 30]);
    // typing in the web client makes it the driver again
    session.input('web', new Uint8Array([0x20]));
    expect([session.cols, session.rows]).toEqual([120, 40]);
    session.ownerViewport('guest', 20, 5); // not the owner: ignored
    expect([session.cols, session.rows]).toEqual([120, 40]);
    session.detach('web');
    expect([session.cols, session.rows]).toEqual([100, 30]); // the next most recent owner viewer
    session.detach('cli');
    expect([session.cols, session.rows]).toEqual([100, 30]); // no owner viewer: the size stays
  });

  it('a viewer whose link is slow pauses the PTY (REL-06): output follows the link\'s speed and continues once it drains', async () => {
    // `seq` writes ~10-25 MB/s into a PTY; the viewer's link drains 512 KiB/s. Without flow control the whole output
    // would be pushed into the (shared) send buffer at the PTY's speed.
    const session = start('exec seq 1 30000000');
    const rate = 512 * 1024; // bytes per second
    let queued = 0;
    let last = Date.now();
    let draining = true;
    const drain = (): void => {
      const now = Date.now();
      queued = draining ? Math.max(0, queued - ((now - last) * rate) / 1000) : 0;
      last = now;
    };
    let received = 0;
    const sink: ViewerSink = {
      output: (_offset, data) => {
        drain();
        queued += data.byteLength;
        received += data.byteLength;
      },
      resize: () => {},
      backlog: () => {
        drain();
        return queued;
      },
    };
    const plan = await session.attach('slow', 'dev:guest', sink, null);
    plan.commit();
    const startedAt = Date.now();
    await sleep(3_000);
    const elapsed = (Date.now() - startedAt) / 1000;
    // What the link carried, plus the 1 MiB window, one coalesced chunk and what was in flight: a few MiB, not tens.
    const bound = elapsed * rate + 1024 * 1024 + 2 * 1024 * 1024;
    expect(session.offset).toBeLessThan(bound);
    expect(received).toBeGreaterThan(0);
    // The link recovers (or the viewer leaves): the PTY runs at full speed again.
    draining = false;
    const before = session.offset;
    await waitFor(() => session.offset > before + 8 * 1024 * 1024, 'output resumes at full speed');
  });

  it('a viewer that is not ready yet (attach not committed) or reports no backlog never pauses the PTY', async () => {
    const session = start('exec seq 1 30000000');
    const stuck: ViewerSink = { output: () => {}, resize: () => {}, backlog: () => 64 * 1024 * 1024 };
    await session.attach('pending', 'dev:guest', stuck, null); // never committed: not a live viewer
    const plain: ViewerSink = { output: () => {}, resize: () => {} };
    (await session.attach('plain', 'dev:guest', plain, null)).commit();
    await waitFor(() => session.offset > 8 * 1024 * 1024, 'output at full speed');
  });

  it('reports the exit after the mirror caught up; late viewers still get the final screen', async () => {
    const exits: number[] = [];
    const session = new PtySession({
      ownerUserId: 'dev:owner',
      spawn: { file: '/bin/sh', args: ['-c', 'echo bye-now; exit 3'], cwd: '/', env: ENV, cols: 80, rows: 24 },
      log: silentLogger,
      onExit: (exit) => exits.push(exit.exitCode),
    });
    sessions.push(session);
    expect(await session.waitExit(10_000)).toBe(true);
    expect(exits).toEqual([3]);
    expect(session.input('x', new Uint8Array([0x61]))).toBe(false);
    const viewer = new SinkViewer();
    await viewer.attach(session, 'late', 'dev:guest', null);
    await viewer.drained();
    expect(viewer.lines()).toContain('bye-now');
  });
});

describe('PtySession.paste (an accepted suggestion)', { timeout: 30_000 }, () => {
  // The program switches bracketed paste on, turns echo off and prints what it receives (cat -v shows ESC as ^[).
  // It prints READY itself; the word is spelled with an octal escape so that only the printf can produce it.
  const PROGRAM = "printf '\\033[?2004h'; stty -echo; printf 'REA\\104Y\\n'; exec cat -v";

  it('decides about the paste brackets only after the mirror has parsed what the program printed', async () => {
    const session = start(PROGRAM);
    const viewer = new SinkViewer();
    await viewer.attach(session, 'owner', 'dev:owner', { cols: 80, rows: 24 });
    await waitFor(() => viewer.lines().some((line) => line.includes('READY')), 'the program to be ready');

    // The gap between "output received" and "output parsed", held open: the mirror answers only when released.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realDrained = TermMirror.prototype.drained;
    const drained = vi.spyOn(TermMirror.prototype, 'drained').mockImplementation(function (this: TermMirror) {
      return gate.then(() => realDrained.call(this));
    });
    const writes: string[] = [];
    const realWrite = session.writeRaw.bind(session);
    const writeRaw = vi.spyOn(session, 'writeRaw').mockImplementation((data: string) => {
      writes.push(data);
      return realWrite(data);
    });
    try {
      expect(session.paste('line one\rline two')).toBe(true);
      await sleep(150);
      expect(writes).toEqual([]); // nothing reaches the PTY while the decision is open
      release();
      await waitFor(() => writes.includes('\r'), 'the paste and its Enter');
      expect(writes).toEqual(['\u001b[200~line one\rline two\u001b[201~', '\r']);
      await waitFor(() => viewer.lines().some((line) => line.includes('line two^[[201~')), 'the program to print the paste');
    } finally {
      drained.mockRestore();
      writeRaw.mockRestore();
    }
  });

  it('pastes without brackets when the program did not ask for them, and refuses once the session has ended', async () => {
    const session = start("stty -echo; printf 'REA\\104Y\\n'; exec cat -v");
    const viewer = new SinkViewer();
    await viewer.attach(session, 'owner', 'dev:owner', { cols: 80, rows: 24 });
    await waitFor(() => viewer.lines().some((line) => line.includes('READY')), 'the program to be ready');
    expect(session.paste('plain text')).toBe(true);
    await waitFor(() => viewer.lines().some((line) => line.includes('plain text')), 'the paste');
    await viewer.drained();
    expect(viewer.lines().join('\n')).not.toContain('^[[200~');

    const ended = start('exit 0');
    expect(await ended.waitExit(10_000)).toBe(true);
    expect(ended.paste('too late')).toBe(false);
  });
});

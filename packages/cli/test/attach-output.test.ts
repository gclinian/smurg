// attachSession's output path (SEC-D-02 at the level of the attach loop): an escape sequence split across a pause is
// never written half-way (the old 50 ms idle flush wrote a held OSC 52 prefix, whose terminator then arrived as plain
// text), and a fresh snapshot starts with a fresh filter (an unfinished sequence of the old stream swallows nothing).
import { describe, expect, it } from 'vitest';
import type { TerminalSession } from '@smurg/protocol';
import type { ChannelEnd, WorkspaceChannel } from '../src/channel/channel.ts';
import { attachSession } from '../src/attach/attach-session.ts';
import { fakeTerminal } from './helpers.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function fakeChannel(session: TerminalSession) {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const restart = new Set<() => void>();
  const ended = new Set<(end: ChannelEnd) => void>();
  let attaches = 0;
  const channel = {
    kind: 'local',
    welcome: { member: { userId: session.openedBy.userId } },
    request: async (type: string) => {
      if (type !== 'session.attach') throw new Error(`unexpected ${type}`);
      attaches += 1;
      return { session, mode: 'snapshot', data: enc(attaches === 1 ? 'first\r\n' : 'second picture\r\n'), cols: 80, rows: 24, nextOffset: 0 };
    },
    notify: () => true,
    on: (type: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
      return () => set.delete(handler);
    },
    onEnd: (listener: (end: ChannelEnd) => void) => (ended.add(listener), () => ended.delete(listener)),
    onRestart: (listener: () => void) => (restart.add(listener), () => restart.delete(listener)),
    onStatus: () => () => {},
    close: () => {},
  } as unknown as WorkspaceChannel;
  let offset = 0;
  return {
    channel,
    output(text: string): void {
      const data = enc(text);
      for (const h of handlers.get('exec.output') ?? []) h({ sessionId: session.id, offset, data });
      offset += data.length;
    },
    restart(): void {
      offset = 0;
      for (const l of [...restart]) l();
    },
    end(): void {
      for (const l of [...ended]) l({ reason: 'closed', message: 'bye' });
    },
  };
}

const session: TerminalSession = { id: 'sess_filter_1', kind: 'terminal', openedBy: { userId: 'dev:me', displayName: 'me' }, title: 't', root: { kind: 'main' }, status: 'running', cols: 80, rows: 24, attached: 0, createdAt: 1 };
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('attachSession output', () => {
  it('an OSC 52 whose terminator comes after a pause never reaches the terminal', async () => {
    const terminal = fakeTerminal();
    const fake = fakeChannel(session);
    const done = attachSession({ channel: fake.channel, session, terminal, io: { onExit: () => () => {}, onSignal: () => () => {} }, lang: 'en' });
    await pause(20);
    fake.output(`visible\x1b]52;c;${Buffer.from('MARKER').toString('base64')}`);
    await pause(200); // far longer than the old 50 ms idle flush
    fake.output('\x07after');
    await pause(20);
    fake.end();
    await done;
    const shown = terminal.text();
    expect(shown).toContain('visible');
    expect(shown).toContain('after');
    expect(shown.includes('\x1b]52')).toBe(false);
    expect(shown.includes(Buffer.from('MARKER').toString('base64'))).toBe(false);
  });

  it('a new snapshot after a restart is painted even when the old stream ended inside a sequence', async () => {
    const terminal = fakeTerminal();
    const fake = fakeChannel(session);
    const done = attachSession({ channel: fake.channel, session, terminal, io: { onExit: () => () => {}, onSignal: () => () => {} }, lang: 'en' });
    await pause(20);
    fake.output('old\x1b]0;an unfinished title');
    fake.restart();
    await pause(50);
    fake.end();
    await done;
    expect(terminal.text()).toContain('second picture');
  });
});

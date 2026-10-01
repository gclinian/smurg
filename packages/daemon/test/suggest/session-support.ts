// TEST ONLY: the real sessions module with test seams (a controlled host environment, /bin/sh) and a terminal output
// collector.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection } from '@smurg/protocol/client';
import type { FeatureModule } from '../../src/core/context.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import { registerTestDir } from '../../src/testing/run-registry.ts';

export interface TestSessions {
  readonly module: FeatureModule;
  readonly hostHome: string;
  cleanup(): Promise<void>;
}

/** The real sessions module for TERMINALS of any member (no claude, no hooks needed). */
export async function testSessionsModule(): Promise<TestSessions> {
  const scratch = await mkdtemp(join(process.env['TMPDIR'] ?? '/tmp', 'smurg-collab-sessions-'));
  registerTestDir(scratch);
  const hostHome = join(scratch, 'host-home');
  await mkdir(hostHome, { recursive: true });
  const hostEnv = Object.freeze({
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: hostHome,
    USER: process.env['USER'] ?? 'host',
    LANG: 'en_US.UTF-8',
    SHELL: '/bin/sh',
    PS1: '$ ',
  });
  const module = createSessionsModule({
    hostEnv: () => hostEnv,
    hostShell: '/bin/sh',
  });
  return { module, hostHome, cleanup: () => rm(scratch, { recursive: true, force: true }) };
}

/** Collects one session's terminal output as a client sees it (attach snapshot + live exec.output). */
export class OutputCollector {
  private text = '';
  private readonly decoder = new TextDecoder();
  private readonly off: () => void;
  private readonly conn: Connection;
  private readonly sessionId: string;

  constructor(conn: Connection, sessionId: string) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.off = conn.on('exec.output', (payload) => {
      if (payload.sessionId === this.sessionId) this.text += this.decoder.decode(payload.data, { stream: true });
    });
  }

  async attach(owner: boolean): Promise<void> {
    const result = await this.conn.request('session.attach', { sessionId: this.sessionId, ...(owner ? { cols: 100, rows: 30 } : {}) });
    this.text += new TextDecoder().decode(result.data);
  }

  get output(): string {
    return this.text;
  }

  dispose(): void {
    this.off();
  }
}

export function typeInto(conn: Connection, sessionId: string, text: string): void {
  if (!conn.notify('exec.input', { sessionId, data: new TextEncoder().encode(text) })) throw new Error('exec.input was dropped');
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// `~/.smurg/credentials.json` (0600): the CLI's relay session tokens, one per relay origin (relay.md §1.4 "CLI and
// daemon: Authorization: Bearer <token>"). A token is a secret: it is never printed, logged or passed on a command
// line; it only goes into this file and into the Authorization header of requests to the relay it came from.
import type { RelaySession } from '@smurg/protocol/client';
import type { StatePaths } from './paths.ts';
import { isRecord, numberField, readPrivateJson, removePrivateFile, stringField, writePrivateJson } from './private-file.ts';

const WHAT = 'credentials' as const;

export interface StoredSession {
  readonly token: string;
  readonly userId: string;
  readonly displayName: string;
  readonly provider: string;
  readonly savedAt: number;
  /** Epoch ms after which the relay refuses the token. */
  readonly expiresAt: number;
}

export interface Credentials {
  /** The relay of the last login: the default of every command that talks to a relay. */
  readonly defaultRelay: string | null;
  readonly relays: Readonly<Record<string, StoredSession>>;
}

const EMPTY: Credentials = Object.freeze({ defaultRelay: null, relays: Object.freeze({}) });

function parseSession(value: unknown): StoredSession | null {
  if (!isRecord(value)) return null;
  const token = stringField(value, 'token');
  const userId = stringField(value, 'userId', 256);
  const displayName = stringField(value, 'displayName', 256);
  const provider = stringField(value, 'provider', 32);
  const savedAt = numberField(value, 'savedAt');
  const expiresAt = numberField(value, 'expiresAt');
  if (token === null || userId === null || displayName === null || provider === null || savedAt === null || expiresAt === null) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(token)) return null;
  return { token, userId, displayName, provider, savedAt, expiresAt };
}

export async function loadCredentials(paths: StatePaths): Promise<Credentials> {
  const raw = await readPrivateJson(paths.credentials, WHAT);
  if (raw === null) return EMPTY;
  if (!isRecord(raw) || raw['version'] !== 1 || !isRecord(raw['relays'])) return EMPTY;
  const relays: Record<string, StoredSession> = {};
  for (const [origin, value] of Object.entries(raw['relays'])) {
    const session = parseSession(value);
    if (session) relays[origin] = session;
  }
  const defaultRelay = typeof raw['defaultRelay'] === 'string' ? raw['defaultRelay'] : null;
  return { defaultRelay, relays };
}

async function save(paths: StatePaths, credentials: Credentials): Promise<void> {
  await writePrivateJson(paths.credentials, { version: 1, defaultRelay: credentials.defaultRelay, relays: credentials.relays }, WHAT);
}

/** The usable session for `origin`, or null (none, or expired). */
export function sessionFor(credentials: Credentials, origin: string, now: number): StoredSession | null {
  const session = credentials.relays[origin];
  return session && session.expiresAt > now ? session : null;
}

export async function saveSession(paths: StatePaths, origin: string, session: RelaySession, now: number): Promise<StoredSession> {
  const credentials = await loadCredentials(paths);
  const stored: StoredSession = {
    token: session.token,
    userId: session.user.userId,
    displayName: session.user.displayName,
    provider: session.user.provider,
    savedAt: now,
    expiresAt: now + session.expiresIn * 1000,
  };
  await save(paths, { defaultRelay: origin, relays: { ...credentials.relays, [origin]: stored } });
  return stored;
}

/** Forgets the session of `origin` (or every session). Returns how many were removed. */
export async function removeSessions(paths: StatePaths, origin: string | 'all'): Promise<number> {
  const credentials = await loadCredentials(paths);
  if (origin === 'all') {
    const count = Object.keys(credentials.relays).length;
    await removePrivateFile(paths.credentials);
    return count;
  }
  if (!(origin in credentials.relays)) return 0;
  const relays = { ...credentials.relays };
  delete relays[origin];
  await save(paths, { defaultRelay: credentials.defaultRelay === origin ? null : credentials.defaultRelay, relays });
  return 1;
}

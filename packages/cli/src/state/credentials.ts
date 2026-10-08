// `~/.smurg/credentials.json` (0600): the CLI's relay session tokens, one per relay origin (relay.md §1.4 "CLI and
// daemon: Authorization: Bearer <token>"). A token is a secret: it is never printed, logged or passed on a command
// line; it only goes into this file and into the Authorization header of requests to the relay it came from.
//
// A file this smurg cannot read is a refusal that changes nothing (./private-file.ts versionedRecord; 0.5.1, DESIGN
// B5): until 0.5.0 an unknown `version` read as "not logged in", and the next login wrote the file anew with only
// that one relay. As for workspaces.json, the `version` of this file can never be raised (0.4.0 and 0.5.0 would lose
// it): a later smurg adds optional fields only.
//
// An ENTRY of `relays` this smurg cannot read (no token, a token of another alphabet, something that is no object) is
// not a login it uses, and it is never dropped: every write puts it back under its relay exactly as it was, and the
// command says once how many there are (./private-file.ts reportUnreadEntries). Until 0.5.0 it was skipped without a
// word and gone at the next login or logout. A NEW login to that very relay takes the entry's place (the person
// asked for that login); logging out of every relay removes the logins this smurg reads and leaves such entries.
import type { RelaySession } from '@smurg/protocol/client';
import type { StatePaths } from './paths.ts';
import { isRecord, numberField, readPrivateJson, recordField, removePrivateFile, reportUnreadEntries, stringField, versionedRecord, writePrivateJson } from './private-file.ts';

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

/** What stands under one relay in the file: a login this smurg reads, or what is there, kept as it is. */
type Slot = { readonly session: StoredSession } | { readonly kept: unknown };

/** The file as it is written back: every entry of `relays` under its relay, in the file's order. */
interface CredentialsFile {
  /** As the file has it: a relay, null, or (kept as it is) something this smurg does not read as either. */
  readonly defaultRelay: unknown;
  readonly relays: readonly (readonly [origin: string, slot: Slot])[];
}

const NO_FILE: CredentialsFile = Object.freeze({ defaultRelay: null, relays: Object.freeze([]) });

async function readCredentialsFile(paths: StatePaths): Promise<CredentialsFile> {
  // No file: not logged in anywhere. A file this smurg cannot read: refused (never "not logged in").
  const raw = versionedRecord(await readPrivateJson(paths.credentials, WHAT), paths.credentials, WHAT, 1);
  if (raw === null) return NO_FILE;
  const relays = Object.entries(recordField(raw, 'relays', paths.credentials, WHAT)).map(([origin, value]): readonly [string, Slot] => {
    const session = parseSession(value);
    return [origin, session ? { session } : { kept: value }];
  });
  reportUnreadEntries(paths, WHAT, paths.credentials, relays.filter(([, slot]) => 'kept' in slot).length);
  return { defaultRelay: raw['defaultRelay'] ?? null, relays };
}

function credentialsOf(file: CredentialsFile): Credentials {
  if (file === NO_FILE) return EMPTY;
  const relays: Record<string, StoredSession> = {};
  for (const [origin, slot] of file.relays) if ('session' in slot) relays[origin] = slot.session;
  return { defaultRelay: typeof file.defaultRelay === 'string' ? file.defaultRelay : null, relays };
}

export async function loadCredentials(paths: StatePaths): Promise<Credentials> {
  return credentialsOf(await readCredentialsFile(paths));
}

async function save(paths: StatePaths, file: CredentialsFile): Promise<void> {
  // An own property per relay, whatever its name (`__proto__` included): the object is only ever serialized.
  const relays: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [origin, slot] of file.relays) relays[origin] = 'session' in slot ? slot.session : slot.kept;
  await writePrivateJson(paths.credentials, { version: 1, defaultRelay: file.defaultRelay, relays }, WHAT);
}

/** The usable session for `origin`, or null (none, or expired). */
export function sessionFor(credentials: Credentials, origin: string, now: number): StoredSession | null {
  const session = credentials.relays[origin];
  return session && session.expiresAt > now ? session : null;
}

export async function saveSession(paths: StatePaths, origin: string, session: RelaySession, now: number): Promise<StoredSession> {
  const file = await readCredentialsFile(paths);
  const stored: StoredSession = {
    token: session.token,
    userId: session.user.userId,
    displayName: session.user.displayName,
    provider: session.user.provider,
    savedAt: now,
    expiresAt: now + session.expiresIn * 1000,
  };
  // In the place of what stood under this relay (a login, or an entry this smurg could not read), else at the end.
  const there = file.relays.some(([known]) => known === origin);
  const relays = there ? file.relays.map((entry): readonly [string, Slot] => (entry[0] === origin ? [origin, { session: stored }] : entry)) : [...file.relays, [origin, { session: stored }] as const];
  await save(paths, { defaultRelay: origin, relays });
  return stored;
}

/** Forgets the session of `origin` (or every session). Returns how many were removed. */
export async function removeSessions(paths: StatePaths, origin: string | 'all'): Promise<number> {
  const file = await readCredentialsFile(paths);
  const mine = (slot: Slot): boolean => 'session' in slot;
  if (origin === 'all') {
    const kept = file.relays.filter(([, slot]) => !mine(slot));
    // Nothing this smurg could not read: the file goes, as it always has. Otherwise those entries stay in it.
    if (kept.length === 0) await removePrivateFile(paths.credentials);
    else await save(paths, { defaultRelay: kept.some(([known]) => known === file.defaultRelay) ? file.defaultRelay : null, relays: kept });
    return file.relays.length - kept.length;
  }
  if (!file.relays.some(([known, slot]) => known === origin && mine(slot))) return 0;
  await save(paths, { defaultRelay: file.defaultRelay === origin ? null : file.defaultRelay, relays: file.relays.filter(([known]) => known !== origin) });
  return 1;
}

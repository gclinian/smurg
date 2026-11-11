// `~/.smurg/connectors.json` (0600; DESIGN 0.8.0 D6.2): the Slack and Discord channels the host connected to each
// shared folder's workspace, with the bot token of each. A token is a secret: it is never printed, logged, passed on
// a command line or put into the environment; it goes only into this file (from `smurg connect`, which reads it
// without echo) and from it into the daemon of `smurg host`, in the same process, which sends it only to its own
// service. Never through the control socket (agent sessions can reach that socket). Agent sessions run as the host and
// can read this file, as they can read the relay login (the host guide says so).
//
//   { "version": 1, "workspaces": { "<workspace id>": { "slack": { "token", "channel", "connectedAt" }, "discord": … } } }
//
// As for credentials.json, a file this smurg cannot read is a refusal that changes nothing (./private-file.ts
// versionedRecord), and the `version` stays 1: a later smurg adds optional fields only. A source's entry this smurg
// cannot read is kept exactly as it is and not used (the command says once how many there are), and so is every key
// it does not know. A channel id or a token of another form IS handed to the daemon as the file holds it: the daemon
// checks both by their source's form before anything is fetched, and the host sees that source failing.
import type { OutsideSource } from '@smurg/protocol';
import type { StatePaths } from './paths.ts';
import { isRecord, readPrivateJson, recordField, removePrivateFile, reportUnreadEntries, versionedRecord, writePrivateJson } from './private-file.ts';

const WHAT = 'connectors' as const;
const SOURCES: readonly OutsideSource[] = ['slack', 'discord'];
/** The longest token and channel id read from the file (the daemon checks their form). */
const FIELD_MAX_CHARS = 4096;

/** One connected channel. `connectedAt`: when `smurg connect` connected it (epoch ms). */
export interface ConnectedChannel {
  readonly token: string;
  readonly channel: string;
  readonly connectedAt: number;
}

/** The connected channels of one workspace (what `smurg host` hands to its daemon). */
export interface WorkspaceConnectors {
  readonly slack?: ConnectedChannel;
  readonly discord?: ConnectedChannel;
}

function channelOf(value: unknown): ConnectedChannel | null {
  if (!isRecord(value)) return null;
  const { token, channel, connectedAt } = value;
  if (typeof token !== 'string' || token.length === 0 || token.length > FIELD_MAX_CHARS) return null;
  if (typeof channel !== 'string' || channel.length === 0 || channel.length > FIELD_MAX_CHARS) return null;
  if (typeof connectedAt !== 'number' || !Number.isFinite(connectedAt)) return null;
  return { token, channel, connectedAt };
}

/** Every workspace's value as the file holds it (what this smurg cannot read included). */
type Workspaces = readonly (readonly [workspaceId: string, value: unknown])[];

async function readWorkspaces(paths: StatePaths): Promise<Workspaces> {
  const raw = versionedRecord(await readPrivateJson(paths.connectors, WHAT), paths.connectors, WHAT, 1);
  if (raw === null) return [];
  const workspaces = Object.entries(recordField(raw, 'workspaces', paths.connectors, WHAT));
  let unread = 0;
  for (const [, value] of workspaces) {
    if (!isRecord(value)) unread += 1;
    else for (const source of SOURCES) if (value[source] !== undefined && channelOf(value[source]) === null) unread += 1;
  }
  reportUnreadEntries(paths, WHAT, paths.connectors, unread);
  return workspaces;
}

/** The file written with `workspaces`, in their order; with none, no file (no token lies around). */
async function save(paths: StatePaths, workspaces: Workspaces): Promise<void> {
  if (workspaces.length === 0) {
    await removePrivateFile(paths.connectors);
    return;
  }
  // Own data properties whatever the id (`__proto__` included): the object is only ever serialized.
  await writePrivateJson(paths.connectors, { version: 1, workspaces: Object.fromEntries(workspaces) }, WHAT);
}

/** The channels connected to `workspaceId` that this smurg reads (none: an empty object). */
export async function loadConnectors(paths: StatePaths, workspaceId: string): Promise<WorkspaceConnectors> {
  const value = (await readWorkspaces(paths)).find(([id]) => id === workspaceId)?.[1];
  if (!isRecord(value)) return {};
  const slack = channelOf(value['slack']);
  const discord = channelOf(value['discord']);
  return { ...(slack !== null ? { slack } : {}), ...(discord !== null ? { discord } : {}) };
}

/**
 * Connects `source` of `workspaceId` to `channel`, in the place of what stood there (read or not: the person asked for
 * this connection); the workspace's other keys stay. Returns the channel connected before, if this smurg read it.
 */
export async function connectChannel(paths: StatePaths, workspaceId: string, source: OutsideSource, channel: ConnectedChannel): Promise<ConnectedChannel | null> {
  const workspaces = await readWorkspaces(paths);
  const before = workspaces.find(([id]) => id === workspaceId)?.[1];
  const kept = isRecord(before) ? before : {};
  const value = Object.fromEntries([...Object.entries(kept).filter(([key]) => key !== source), [source, { token: channel.token, channel: channel.channel, connectedAt: channel.connectedAt }]]);
  const there = workspaces.some(([id]) => id === workspaceId);
  await save(paths, there ? workspaces.map((entry): readonly [string, unknown] => (entry[0] === workspaceId ? [workspaceId, value] : entry)) : [...workspaces, [workspaceId, value]]);
  return channelOf(kept[source]);
}

/**
 * Disconnects `source` of `workspaceId`: its entry leaves the file (also one this smurg could not read), and so does
 * the workspace when nothing else of it is left. Returns what was there: the channel (null when its entry could not be
 * read), or undefined when nothing was.
 */
export async function disconnectChannel(paths: StatePaths, workspaceId: string, source: OutsideSource): Promise<ConnectedChannel | null | undefined> {
  const workspaces = await readWorkspaces(paths);
  const before = workspaces.find(([id]) => id === workspaceId)?.[1];
  if (!isRecord(before) || before[source] === undefined) return undefined;
  const rest = Object.entries(before).filter(([key]) => key !== source);
  await save(paths, rest.length === 0 ? workspaces.filter(([id]) => id !== workspaceId) : workspaces.map((entry): readonly [string, unknown] => (entry[0] === workspaceId ? [workspaceId, Object.fromEntries(rest)] : entry)));
  return channelOf(before[source]);
}

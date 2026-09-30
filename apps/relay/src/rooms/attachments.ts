// Per-socket state kept in the WebSocket attachment (survives hibernation; max 16 KiB). Short keys: every attachment
// is stored with its socket.
import { isConnId } from '@smurg/protocol/relay';

export type HostAttachment = {
  r: 'h';
  /** hostEpoch at accept time; only the socket of the current epoch is "the host". */
  epoch: number;
  uid: string;
  /** Accept time; counts as the first sign of life before any ping. */
  since: number;
  /** Set once the relay closed it or saw it go, so nothing is reported twice. */
  gone?: 1;
};

export type ClientAttachment = {
  r: 'c';
  conn: number;
  uid: string;
  name: string;
  avatar?: string;
  since: number;
  gone?: 1;
};

export type Attachment = HostAttachment | ClientAttachment;

export function readAttachment(ws: WebSocket): Attachment | null {
  const value: unknown = ws.deserializeAttachment();
  if (typeof value !== 'object' || value === null) return null;
  const a = value as Record<string, unknown>;
  if (typeof a['uid'] !== 'string' || typeof a['since'] !== 'number') return null;
  if (a['r'] === 'h' && typeof a['epoch'] === 'number') return value as HostAttachment;
  if (a['r'] === 'c' && isConnId(a['conn']) && typeof a['name'] === 'string') return value as ClientAttachment;
  return null;
}

export const TAG_HOST = 'host';
export const TAG_CLIENT = 'client';

export function clientTag(conn: number): string {
  return `c:${conn}`;
}

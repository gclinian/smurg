// Compile-time views of the message registry for each socket. The registry records the channel of a type only at
// runtime, so the split is by name: every `file.upload.*` / `file.download.*` type travels on the transfer socket and
// nothing else does (message-types.test.ts asserts this against MESSAGE_REGISTRY, so the two cannot drift apart).
import type { z } from 'zod';
import type { CHANNEL_CLOSED_REASONS } from '../schema/messages/channel.ts';
import type {
  BidirectionalType,
  EventType,
  MessageType,
  NotifyType,
  PayloadInputOf,
  PayloadOf,
  RequestType,
  ResultOf,
} from '../schema/registry.ts';
import type { clientKindSchema } from '../schema/entities.ts';

type TransferTypeName = `file.upload.${string}` | `file.download.${string}`;
/** Internal bookkeeping of the interactive channel; the SDK sends and consumes it itself. */
type InternalType = 'channel.ack';

/** Requests (answered by `X.ok` or `error`) on the interactive socket. */
export type InteractiveRequestType = Exclude<RequestType, TransferTypeName>;
/** Requests on the transfer socket. */
export type TransferRequestType = Extract<RequestType, TransferTypeName>;

/** One-way client→daemon messages (no `.ok`) on the interactive socket: doc.sync, exec.input, presence.update, … */
export type InteractiveNotifyType = Exclude<NotifyType | BidirectionalType, TransferTypeName | InternalType>;
/** One-way client→daemon messages on the transfer socket: file.download.ack / cancel. */
export type TransferNotifyType = Extract<NotifyType | BidirectionalType, TransferTypeName>;

/** Daemon→client messages a listener can subscribe to on the interactive socket (`error` = uncorrelated errors). */
export type InteractiveEventType = Exclude<EventType | BidirectionalType, TransferTypeName | InternalType>;
/** Daemon→client messages on the transfer socket. */
export type TransferEventType = Extract<EventType | BidirectionalType, TransferTypeName> | 'error' | 'channel.closed';

export type ChannelClosedReason = (typeof CHANNEL_CLOSED_REASONS)[number];
export type ClientKind = z.infer<typeof clientKindSchema>;

export interface RequestOptions {
  /** Default: the connection's requestTimeoutMs. 0 disables the timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NotifyOptions {
  /**
   * While no channel is established: 'queue' (default) keeps the message in the outbox, delivered if the channel
   * resumes (dropped if the daemon starts a fresh channel, since the application resyncs then); 'drop' discards it.
   */
  whenDisconnected?: 'queue' | 'drop';
}

/** Where an event came from (seq 0 = unsequenced). */
export interface EventMeta {
  readonly id: string;
  readonly seq: number;
}

export type EventHandler<T extends MessageType> = (payload: PayloadOf<T>, meta: EventMeta) => void;

/** `request()` of the interactive Connection. */
export type InteractiveRequestFn = <T extends InteractiveRequestType>(
  type: T,
  payload: PayloadInputOf<T>,
  options?: RequestOptions,
) => Promise<ResultOf<T>>;

/** `request()` of the TransferConnection. */
export type TransferRequestFn = <T extends TransferRequestType>(
  type: T,
  payload: PayloadInputOf<T>,
  options?: RequestOptions,
) => Promise<ResultOf<T>>;

/** Runtime twin of the name-based split above. */
export function isTransferTypeName(type: string): boolean {
  return type.startsWith('file.upload.') || type.startsWith('file.download.');
}

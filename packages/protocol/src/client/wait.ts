// Promise helpers over the observable connection state (CLI flows and tests await "online" instead of polling).
import { isTerminalState, type ConnectionState } from './state.ts';

export interface StateSource {
  getState(): ConnectionState;
  subscribe(listener: (state: ConnectionState) => void): () => void;
}

/** The state a connection ended in, as an error for promise-based callers. */
export class ConnectionEndedError extends Error {
  readonly state: ConnectionState;

  constructor(state: ConnectionState) {
    super(`connection ended: ${describeState(state)}`);
    this.name = 'ConnectionEndedError';
    this.state = state;
  }
}

export function describeState(state: ConnectionState): string {
  switch (state.kind) {
    case 'rejected':
    case 'closed':
      return `${state.kind} (${state.reason})`;
    case 'key-mismatch':
      return `key-mismatch (${state.detail})`;
    case 'host-offline':
      return `host-offline (${state.reason})`;
    default:
      return state.kind;
  }
}

export interface WaitOptions {
  /** Reject after this long (0 = never). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Resolves with the first state (the current one included) that satisfies `predicate`. Rejects with
 * ConnectionEndedError when the connection reaches a terminal state that does not satisfy it.
 */
export function waitForState(source: StateSource, predicate: (state: ConnectionState) => boolean, options: WaitOptions = {}): Promise<ConnectionState> {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (done) return;
      done = true;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      action();
    };
    const check = (state: ConnectionState): void => {
      if (predicate(state)) finish(() => resolve(state));
      else if (isTerminalState(state)) finish(() => reject(new ConnectionEndedError(state)));
    };
    const onAbort = (): void => finish(() => reject(new Error('wait cancelled')));
    if (options.signal?.aborted) {
      reject(new Error('wait cancelled'));
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(
        () => finish(() => reject(new Error(`timed out after ${options.timeoutMs} ms waiting for the connection (now ${describeState(source.getState())})`))),
        options.timeoutMs,
      );
    }
    unsubscribe = source.subscribe(check);
    check(source.getState());
  });
}

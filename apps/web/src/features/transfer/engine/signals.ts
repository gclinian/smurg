// AbortSignal helpers (AbortSignal.any is recent: Safari 17.4, Firefox 124; this works everywhere).

/** A signal that fires when any of `signals` fires, with that signal's reason. `dispose()` detaches the listeners. */
export function anySignal(...signals: (AbortSignal | undefined)[]): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const detach: (() => void)[] = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    detach.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const off of detach.splice(0)) off();
    },
  };
}

/** Resolves after `ms`, or rejects with the signal's reason when it fires first. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

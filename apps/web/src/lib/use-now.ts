// The time now as React state, for text that ages ("6 min", "3 minutes ago", an invite's expiry, the autosave
// indicator's warning): the ONE such hook of the app (every feature that shows a relative time uses it), on the one
// timer of lib/clock.ts. The caller is redrawn at least every `intervalMs`, and each second while an age under a
// minute is on screen (clock.ts says when and why). `enabled: false` stops the clock while nothing on screen needs it.
//
// `useNow` is the HOST's clock. Everything the daemon stamps (asked at, waiting since, created at, a file's time) is
// a time of the host's computer, and a member's own clock can be minutes off: the browser's time is corrected by the
// difference measured when the host let this browser in (stores.workspace `clockSkewMs`). Outside a workspace there
// is no host and nothing is corrected.
//
// `useLocalNow` is the browser's own clock, for a time this browser set itself (the next automatic reconnection, the
// moment of an edit that is not saved yet).
import { useEffect, useReducer } from 'react';
import { readClock, subscribeClock } from './clock.ts';
import { useStore } from './store.ts';
import { INITIAL_WORKSPACE_STATE, selectClockSkew, type WorkspaceState } from './stores/workspace.ts';
import { useOptionalWorkspaceSession } from './workspace/context.tsx';

const NO_WORKSPACE = { getState: (): WorkspaceState => INITIAL_WORKSPACE_STATE, subscribe: () => () => {} };

export function useLocalNow(intervalMs = 30_000, enabled = true): number {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => (enabled ? subscribeClock(intervalMs, redraw) : undefined), [intervalMs, enabled]);
  return readClock();
}

export function useNow(intervalMs = 30_000, enabled = true): number {
  const skew = useStore(useOptionalWorkspaceSession()?.stores.workspace ?? NO_WORKSPACE, selectClockSkew);
  return useLocalNow(intervalMs, enabled) + skew;
}

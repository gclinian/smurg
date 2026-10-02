// The current time, refreshed every `intervalMs` while `enabled`: the "recently changed" badge fades after RECENT_CHANGE_MS
// without anything else re-rendering the tree. (A copy of the editor's hook: features never import each other.)
import { useEffect, useState } from 'react';

export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

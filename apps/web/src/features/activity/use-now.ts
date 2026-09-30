// The current time, refreshed every `intervalMs` (relative times in the feed: 「3 分鐘前」). A copy of the editor's
// hook: features never import each other.
import { useEffect, useState } from 'react';

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

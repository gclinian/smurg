import { useEffect, useState } from 'react';

/** The current time, refreshed every `tickMs` (relative times such as 「3 分鐘前」 stay current). */
export function useNow(tickMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);
  return now;
}

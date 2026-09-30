import { useEffect, useState } from 'react';

/** The current time, refreshed every `tickMs` (invite expiry and relative times stay current). */
export function useNow(tickMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);
  return now;
}

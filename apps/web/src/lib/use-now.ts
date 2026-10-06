// The current time as React state, for text that ages ("6 min", "3 minutes ago", an invite's expiry, the autosave
// indicator's warning): re-renders the caller every `intervalMs`. The ONE such hook of the app (every feature that
// shows a relative time uses it). `enabled: false` stops the clock while nothing on screen needs it; when it is
// enabled again the time is read at once, because the value kept from before is stale.
import { useEffect, useRef, useState } from 'react';

export function useNow(intervalMs = 30_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  const paused = useRef(!enabled);
  useEffect(() => {
    if (!enabled) {
      paused.current = true;
      return;
    }
    if (paused.current) {
      paused.current = false;
      setNow(Date.now());
    }
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

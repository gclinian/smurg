import { useEffect, useRef } from 'react';

/**
 * Calls `onChange` when `signal` moves from one KNOWN value to another. `null` means "not known yet" (a store that
 * has not loaded): the first known value is where things stand, not a change, so a page that just loaded its own
 * data is not made to load it twice.
 */
export function useChangeSignal(signal: string | null, onChange: () => void): void {
  const previous = useRef<string | null>(signal);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    const before = previous.current;
    previous.current = signal;
    if (before !== null && signal !== null && before !== signal) latest.current();
  }, [signal]);
}

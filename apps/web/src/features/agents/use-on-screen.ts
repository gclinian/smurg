// Whether an element is actually shown (not inside a collapsed pane or a hidden tab panel): a terminal that nobody
// can see detaches, so the daemon stops streaming into it. Where IntersectionObserver does not exist (jsdom), the
// element counts as shown and only the tab selection decides. Hiding is reported after a short delay, so dragging a
// pane past zero width does not detach and re-attach the terminal.
import { useEffect, useState, type RefObject } from 'react';

const HIDE_DELAY_MS = 1_500;

export function useOnScreen(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node || typeof IntersectionObserver === 'undefined') {
      setOnScreen(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      clearTimeout(timer);
      if (entry.isIntersecting) setOnScreen(true);
      else timer = setTimeout(() => setOnScreen(false), HIDE_DELAY_MS);
    });
    observer.observe(node);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref, enabled]);
  return onScreen;
}

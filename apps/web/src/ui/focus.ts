// Focus helpers shared by Dialog, Menu and the blocking screens.
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true' && !el.closest('[inert]'));
}

/** Keeps Tab / Shift+Tab inside `root`. Returns true when it handled the event. */
export function trapTab(event: KeyboardEvent | ReactKeyboardEvent, root: HTMLElement): boolean {
  if (event.key !== 'Tab') return false;
  const items = focusableWithin(root);
  if (items.length === 0) {
    event.preventDefault();
    root.focus();
    return true;
  }
  const first = items[0] as HTMLElement;
  const last = items[items.length - 1] as HTMLElement;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

let inertCount = 0;

/**
 * Makes the app behind a modal inert (not focusable, not read) while at least one modal is open. The modal itself
 * is portalled next to #root, so it stays interactive.
 */
export function holdAppInert(): () => void {
  const root = typeof document === 'undefined' ? null : document.getElementById('root');
  inertCount++;
  if (root && inertCount === 1) root.setAttribute('inert', '');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inertCount = Math.max(0, inertCount - 1);
    if (root && inertCount === 0) root.removeAttribute('inert');
  };
}

/**
 * Where the focus goes when one of a row of things goes away (a closed column, a settled row): the next one, else
 * the previous one, else null (the caller then picks a fallback, e.g. the session list). `ids` is the row BEFORE the
 * removal.
 */
export function neighbourAfterRemoval<T>(ids: readonly T[], removed: T): T | null {
  const index = ids.indexOf(removed);
  if (index === -1) return null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

/**
 * Focuses `element` without scrolling the page under the reader, after the current render was committed (an element
 * that was mounted by the same update exists by then). Returns a function that cancels a focus still pending.
 */
export function focusSoon(find: () => HTMLElement | null | undefined): () => void {
  let cancelled = false;
  queueMicrotask(() => {
    if (cancelled) return;
    find()?.focus({ preventScroll: false });
  });
  return () => {
    cancelled = true;
  };
}

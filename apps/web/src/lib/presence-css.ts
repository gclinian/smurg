// Remote cursors for y-monaco (yjs-monaco.md Q1 "Presence rendering", ported from the spike's presenceCss.ts).
// y-monaco only adds the classes `yRemoteSelection-<clientID>` / `yRemoteSelectionHead-<clientID>`; colours and the
// name label ("Claude (Ian)" for agents) are ours. Names come from the daemon (it overwrites `user` in awareness), but
// they still end up inside a CSS string, so they are escaped and cut.
//
//   awareness.on('change', () => { styleElement.textContent = presenceCss(awareness.getStates(), doc.clientID); });

import { readableTextOn } from './color.ts';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A CSS string literal that cannot break out of its declaration. */
export function cssString(value: string): string {
  const cleaned = [...value]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .slice(0, 60)
    .join('');
  return `"${cleaned.replace(/[\\"]/g, (ch) => `\\${ch}`).replace(/</g, '\\3c ')}"`;
}

export function safeColor(value: unknown): string {
  return typeof value === 'string' && HEX.test(value) ? value : '#888888';
}

interface PresenceUser {
  readonly name?: unknown;
  readonly color?: unknown;
}

/**
 * The name label shows for a moment after its owner moved or typed, then fades to the bare caret (it
 * covered the line above for as long as the caret stayed). `changes` counts each client's awareness changes: the label
 * alternates between two identical keyframes (`smurg-cursor-label-a` / `-b`, in the editor's stylesheet), so a change
 * restarts the animation while an idle client's label stays faded when someone else's changes regenerate the sheet.
 * Hovering the caret shows the name again.
 */
export function presenceCss(
  states: ReadonlyMap<number, { readonly user?: PresenceUser } | null | undefined>,
  selfClientId: number,
  changes: ReadonlyMap<number, number> = new Map(),
): string {
  let css = '';
  for (const [id, state] of states) {
    if (id === selfClientId || !state?.user || !Number.isSafeInteger(id)) continue;
    const color = safeColor(state.user.color);
    const label = cssString(String(state.user.name ?? '?'));
    const animation = (changes.get(id) ?? 0) % 2 === 0 ? 'smurg-cursor-label-a' : 'smurg-cursor-label-b';
    css +=
      `.yRemoteSelection-${id}{background-color:${color}40}` +
      `.yRemoteSelectionHead-${id}{position:absolute;border-left:2px solid ${color};height:100%;box-sizing:border-box}` +
      `.yRemoteSelectionHead-${id}::after{content:${label};position:absolute;left:-2px;top:-1.3em;font:11px/1.3em var(--font-sans);` +
      `background:${color};color:${readableTextOn(color)};padding:0 4px;border-radius:2px;white-space:nowrap;pointer-events:none;z-index:10;` +
      `animation:${animation} ${CURSOR_LABEL_SECONDS}s ease-in forwards}` +
      `.yRemoteSelectionHead-${id}:hover::after{animation:none;opacity:1}\n`;
  }
  return css;
}

/** How long a caret's name stays (it fades during the last quarter). */
export const CURSOR_LABEL_SECONDS = 2.5;

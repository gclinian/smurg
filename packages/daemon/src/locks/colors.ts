// Presence colours (SPEC R7 在場感知). A cursor label and a lock banner are drawn in the person's or agent's colour on
// both editor themes, so every colour must stay readable on the light (#ffffff) and the dark (#1e1e1e, Monaco's
// vs-dark) background: a WCAG contrast of at least 3:1 (large text / UI components) against each. Colours must also
// be told apart at a glance, so each palette spreads its hues around the colour wheel.
import { createHash } from 'node:crypto';

export const LIGHT_BACKGROUND = '#ffffff';
export const DARK_BACKGROUND = '#1e1e1e';
export const MIN_CONTRAST = 3;

/** Agents 「Claude（…）」: eight hues, none of them a member colour, each readable on both backgrounds. */
export const AGENT_COLORS: readonly string[] = Object.freeze(['#d97706', '#65a30d', '#059669', '#0891b2', '#2563eb', '#9333ea', '#c026d3', '#db2777']);

/**
 * A readable version of the member palette (members' colours are assigned by the core's MemberDirectory). Four of the
 * colours it uses today fail one background (#3cb44b and #f58231 on white, #911eb4 and #2f4b7c on dark); these are
 * their readable replacements in the same slots.
 */
export const READABLE_MEMBER_COLORS: readonly string[] = Object.freeze([
  '#e6194b',
  '#2e8b3e',
  '#4363d8',
  '#d2691e',
  '#a03cc8',
  '#0f9d9a',
  '#f032e6',
  '#9a6324',
  '#4a6fa8',
  '#d45087',
  '#008080',
  '#b8860b',
]);

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const r = channel(Number.parseInt(hex.slice(1, 3), 16));
  const g = channel(Number.parseInt(hex.slice(3, 5), 16));
  const b = channel(Number.parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function isReadableOnBothThemes(color: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(color) && contrastRatio(color, LIGHT_BACKGROUND) >= MIN_CONTRAST && contrastRatio(color, DARK_BACKGROUND) >= MIN_CONTRAST;
}

/**
 * A stable colour for an agent session: where the session's hash points in AGENT_COLORS, moving on past colours that
 * are already in use (other agents, members) so concurrent agents differ. The same inputs give the same colour.
 */
export function pickAgentColor(sessionId: string, inUse: ReadonlySet<string>): string {
  const start = createHash('sha256').update(sessionId).digest().readUInt32BE(0) % AGENT_COLORS.length;
  for (let i = 0; i < AGENT_COLORS.length; i++) {
    const color = AGENT_COLORS[(start + i) % AGENT_COLORS.length] as string;
    if (!inUse.has(color.toLowerCase())) return color;
  }
  return AGENT_COLORS[start] as string;
}

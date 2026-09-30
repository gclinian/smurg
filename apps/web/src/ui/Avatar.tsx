import { readableTextOn } from '../lib/color.ts';
import { tUi } from '../strings/ui.ts';
import { cx } from './cx.ts';
import { IconAgent } from './icons.tsx';

export type AvatarStatus = 'online' | 'offline' | 'agent';

export interface AvatarProps {
  name: string;
  /** The member's colour from the daemon (#RRGGBB); anything else falls back to a neutral grey. */
  color?: string;
  size?: 'sm' | 'md' | 'lg';
  status?: AvatarStatus;
  className?: string;
  /** Default: an image with the name (and status) as its accessible name. `decorative` hides it (a name is next to it). */
  decorative?: boolean;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const FALLBACK = '#6b7280';

/** One CJK character, or up to two Latin initials. */
export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '?';
  const first = [...trimmed][0] ?? '?';
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(first)) return first;
  const words = trimmed.split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? [...(words[0] ?? '')][0]! + [...(words[1] ?? '')][0]! : [...trimmed].slice(0, 2).join('');
  return letters.toUpperCase();
}

export function Avatar({ name, color, size = 'md', status, className, decorative = false }: AvatarProps) {
  const background = color && HEX.test(color) ? color : FALLBACK;
  const label =
    status === 'online'
      ? tUi('avatar.online', { name })
      : status === 'offline'
        ? tUi('avatar.offline', { name })
        : status === 'agent'
          ? tUi('avatar.agent', { name })
          : name;
  return (
    <span
      className={cx('ui-avatar', `ui-avatar--${size}`, status === 'agent' && 'ui-avatar--agent', status === 'offline' && 'ui-avatar--offline', className)}
      style={{ backgroundColor: background, color: readableTextOn(background) }}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      data-status={status}
    >
      {status === 'agent' ? <IconAgent size={size === 'sm' ? 12 : 14} /> : <span className="ui-avatar__initials">{initialsOf(name)}</span>}
      {status === 'online' ? <span className="ui-avatar__dot" /> : null}
    </span>
  );
}

import { tUi } from '../strings/ui.ts';
import { Avatar, type AvatarProps } from './Avatar.tsx';
import { cx } from './cx.ts';

export interface AvatarStackPerson {
  /** Stable key (a user id). */
  readonly id: string;
  readonly name: string;
  readonly color?: string;
}

export interface AvatarStackProps {
  people: readonly AvatarStackPerson[];
  /** The stack's accessible name ("Voted: Ian, Mei"). */
  label: string;
  /** How many avatars show before "+n" (default 3). */
  max?: number;
  size?: AvatarProps['size'];
  className?: string;
}

/** A few overlapping avatars read as one thing: who voted for an option, who else may answer. */
export function AvatarStack({ people, label, max = 3, size = 'xs', className }: AvatarStackProps) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const hidden = people.length - shown.length;
  return (
    <span className={cx('ui-avatar-stack', className)} role="img" aria-label={label} title={label}>
      {shown.map((person) => (
        <Avatar key={person.id} name={person.name} {...(person.color === undefined ? {} : { color: person.color })} size={size} decorative />
      ))}
      {hidden > 0 ? <span className="ui-avatar-stack__more">{tUi('avatar.more', { count: hidden })}</span> : null}
    </span>
  );
}

// The permission mode picker (DESIGN 0.6.0 D18): "Workspace default (Auto: runs what a check allows)", or "This
// topic's setting (…)" for a work item's session, then smurg's three choices. Never "Asks for nothing": that is the
// host's, for the whole workspace, in the console. When the mode that results is auto, one line says that auto mode's
// checks are extra requests that may count toward the host's usage. A select in the dialogs, radio buttons in a
// session's own mode dialog.
import { useId } from 'react';
import type { PermissionMode, SessionModeChoice } from '@smurg/protocol';
import { Select, cx } from '../../ui/index.ts';
import { FOLLOW_VALUE, modeOptions, resultingMode, type ModeFollows } from './agent-choice.ts';
import { t } from './strings.ts';

export interface ModePickerProps {
  /** Default: "Permission mode". */
  readonly label?: string;
  /** null: it follows (`follows`). */
  readonly value: SessionModeChoice | null;
  onChange(mode: SessionModeChoice | null): void;
  /** What "follow" means here, and the mode it follows now. */
  readonly follows: ModeFollows;
  readonly followed: PermissionMode;
  readonly disabled?: boolean;
  readonly variant?: 'select' | 'radio';
  readonly className?: string;
}

export function ModePicker({ label: givenLabel, value, onChange, follows, followed, disabled = false, variant = 'select', className }: ModePickerProps) {
  const name = useId();
  const label = givenLabel ?? t('mode.label');
  const options = modeOptions(follows, followed);
  const cost = resultingMode(value, followed) === 'auto' ? t('cost.auto') : null;
  const current = value ?? FOLLOW_VALUE;
  const pick = (next: SessionModeChoice | typeof FOLLOW_VALUE): void => onChange(next === FOLLOW_VALUE ? null : next);
  if (variant === 'radio') {
    return (
      <fieldset className={cx('agents-mode', className)} disabled={disabled}>
        <legend>{label}</legend>
        {options.map((option) => (
          <label key={option.value === FOLLOW_VALUE ? 'follow' : option.value} className="agents-mode__option">
            <input type="radio" name={name} checked={current === option.value} onChange={() => pick(option.value)} /> {option.label}
          </label>
        ))}
        {cost !== null ? <p className="ui-field__hint">{cost}</p> : null}
      </fieldset>
    );
  }
  return (
    <Select<SessionModeChoice | typeof FOLLOW_VALUE>
      label={label}
      className={className}
      value={current}
      options={options}
      disabled={disabled}
      hint={cost ?? undefined}
      onChange={pick}
    />
  );
}

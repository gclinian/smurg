import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from './cx.ts';

interface FieldProps {
  /** Visible label (zh-TW). Every control has one; use `hideLabel` to keep it for screen readers only. */
  label: string;
  hideLabel?: boolean;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Error text; also marks the control aria-invalid. */
  error?: ReactNode;
  className?: string;
}

function Field({ id, label, hideLabel, hint, error, className, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className={cx('ui-field', className)}>
      <label htmlFor={id} className={cx('ui-field__label', hideLabel && 'ui-visually-hidden')}>
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="ui-field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="ui-field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

export interface InputProps extends FieldProps, Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  ref?: Ref<HTMLInputElement>;
}

export function Input({ label, hideLabel, hint, error, className, id: givenId, ref, ...rest }: InputProps) {
  const autoId = useId();
  const id = givenId ?? autoId;
  return (
    <Field id={id} label={label} hideLabel={hideLabel} hint={hint} error={error} className={className}>
      <input
        ref={ref}
        id={id}
        className="ui-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </Field>
  );
}

export interface TextAreaProps extends FieldProps, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextArea({ label, hideLabel, hint, error, className, id: givenId, ref, ...rest }: TextAreaProps) {
  const autoId = useId();
  const id = givenId ?? autoId;
  return (
    <Field id={id} label={label} hideLabel={hideLabel} hint={hint} error={error} className={className}>
      <textarea
        ref={ref}
        id={id}
        className="ui-input ui-textarea"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </Field>
  );
}

export interface SelectOption<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps<V extends string> extends FieldProps, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'value' | 'onChange'> {
  options: readonly SelectOption<V>[];
  value: V;
  onChange(value: V): void;
  ref?: Ref<HTMLSelectElement>;
}

/** A native select (keyboard, screen readers and mobile pickers work as the platform does). */
export function Select<V extends string>({ label, hideLabel, hint, error, className, id: givenId, options, value, onChange, ref, ...rest }: SelectProps<V>) {
  const autoId = useId();
  const id = givenId ?? autoId;
  return (
    <Field id={id} label={label} hideLabel={hideLabel} hint={hint} error={error} className={className}>
      <select
        ref={ref}
        id={id}
        className="ui-input ui-select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as V)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

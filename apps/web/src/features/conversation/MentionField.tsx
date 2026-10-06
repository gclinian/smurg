// A text box in which "@" offers the members of the workspace (the composer, a question's comment box). Enter
// submits, Shift+Enter makes a new line, and neither happens while an input method is composing: Chinese is typed with
// Enter (UX §4). While the list of people is open, the arrow keys and Enter belong to it.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { formatRole } from '../../lib/format.ts';
import { Avatar, cx } from '../../ui/index.ts';
import { useConversationEnv } from './env.tsx';
import { applyMention, matchPeople, mentionQueryAt, type MentionQuery, type Person } from './people.ts';
import { t } from './strings.ts';

/** At most this many people are offered at once. */
export const MENTION_OPTIONS_MAX = 8;

export interface MentionFieldProps {
  readonly value: string;
  onChange(value: string): void;
  /** Enter without Shift (never while composing, never while the list of people is open). */
  onSubmit?(): void;
  /** The accessible name (the placeholder says the same to the eye). */
  readonly label: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly maxLength?: number;
  readonly className?: string;
  readonly describedBy?: string;
  readonly ref?: Ref<HTMLTextAreaElement>;
}

/** True while an input method is composing (also Safari's keydown that arrives after compositionend: keyCode 229). */
export function isComposing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

export function MentionField({ value, onChange, onSubmit, label, placeholder, disabled, maxLength, className, describedBy, ref }: MentionFieldProps) {
  const { people, self } = useConversationEnv();
  const listId = useId();
  const box = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  /** The "@" the person closed the list for: it stays closed until they type another one. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  /** Where the caret goes after a name was inserted (applied once React wrote the new value). */
  const pendingCaret = useRef<number | null>(null);

  const query: MentionQuery | null = disabled ? null : mentionQueryAt(value, caret);
  const options: Person[] = query === null || query.start === dismissed ? [] : matchPeople(people, query.query, self?.userId ?? null).slice(0, MENTION_OPTIONS_MAX);
  const open = options.length > 0;
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  useEffect(() => {
    setActive(0);
  }, [query?.query, query?.start]);

  // The box is as tall as its text (the stylesheet caps it).
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    node.style.height = 'auto';
    if (node.scrollHeight > 0) node.style.height = `${node.scrollHeight}px`;
    if (pendingCaret.current !== null) {
      node.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  const pick = (person: Person): void => {
    if (query === null) return;
    const next = applyMention(value, query, caret, person.displayName);
    pendingCaret.current = next.caret;
    setCaret(next.caret);
    // That "@" is answered: the list stays closed for it.
    setDismissed(query.start);
    onChange(next.text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isComposing(event)) return;
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + options.length) % options.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(options[activeIndex] as Person);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(query?.start ?? null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && onSubmit) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="conv-mention">
      <textarea
        ref={(node) => {
          box.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        className={cx('conv-mention__input', className)}
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={describedBy}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        role="combobox"
        disabled={disabled}
        maxLength={maxLength}
        onChange={(event) => {
          setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
          onChange(event.currentTarget.value);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onBlur={() => setDismissed(query?.start ?? null)}
        onFocus={() => setDismissed(null)}
      />
      {open ? (
        <ul id={listId} className="conv-mention__list" role="listbox" aria-label={t('composer.mentions')}>
          {options.map((person, index) => (
            <li
              key={person.userId}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className="conv-mention__option"
              // The box keeps the focus: a pointer picks without taking it.
              onPointerDown={(event) => {
                event.preventDefault();
                pick(person);
              }}
            >
              <Avatar name={person.displayName} color={person.color} size="xs" decorative />
              <span>{t('composer.mention.option', { name: person.displayName, role: formatRole(person.role) })}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

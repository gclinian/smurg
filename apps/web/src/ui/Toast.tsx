import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { tUi } from '../strings/ui.ts';
import { IconButton } from './Button.tsx';
import { cx } from './cx.ts';
import type { Tone } from './Feedback.tsx';
import { IconAlertCircle, IconAlertTriangle, IconCheck, IconClose, IconInfo } from './icons.tsx';

export interface ToastInput {
  tone?: Tone;
  title: string;
  description?: string;
  /** ms before it disappears; 0 keeps it until dismissed. Default 6 s (10 s for danger). */
  duration?: number;
  /** One optional action (e.g. 「重試」). */
  action?: { label: string; onClick(): void };
}

interface ToastItem extends ToastInput {
  readonly id: number;
}

export interface ToastApi {
  /** Shows a toast; returns its id. */
  show(toast: ToastInput): number;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICON: Record<Tone, ReactNode> = {
  neutral: <IconInfo />,
  info: <IconInfo />,
  success: <IconCheck />,
  warning: <IconAlertTriangle />,
  danger: <IconAlertCircle />,
};

const MAX_VISIBLE = 5;

/** Hosts the toast region (a polite live region; danger toasts are announced assertively). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const tone = input.tone ?? 'info';
      const duration = input.duration ?? (tone === 'danger' ? 10_000 : 6_000);
      setToasts((previous) => [...previous, { ...input, tone, id }].slice(-MAX_VISIBLE));
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);
  const polite = toasts.filter((toast) => toast.tone !== 'danger');
  const assertive = toasts.filter((toast) => toast.tone === 'danger');

  const render = (toast: ToastItem) => (
    <div key={toast.id} className={cx('ui-toast', `ui-toast--${toast.tone ?? 'info'}`)}>
      <span className="ui-toast__icon">{ICON[toast.tone ?? 'info']}</span>
      <div className="ui-toast__body">
        <p className="ui-toast__title">{toast.title}</p>
        {toast.description ? <p className="ui-toast__description">{toast.description}</p> : null}
      </div>
      {toast.action ? (
        <button
          type="button"
          className="ui-toast__action"
          onClick={() => {
            toast.action?.onClick();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <IconButton label={tUi('toast.dismiss')} icon={<IconClose size={14} />} size="sm" onClick={() => dismiss(toast.id)} noTooltip />
    </div>
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section className="ui-toast-region" aria-label={tUi('toast.region')}>
        <div role="status" aria-live="polite" className="ui-toast-stack">
          {polite.map(render)}
        </div>
        <div role="alert" aria-live="assertive" className="ui-toast-stack">
          {assertive.map(render)}
        </div>
      </section>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast() outside <ToastProvider>');
  return api;
}

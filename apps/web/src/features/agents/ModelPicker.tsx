// The model picker (DESIGN 0.6.0 D18): "The host's default (Opus)" and every model the host's Claude Code offers, as
// "Opus · <its own line>". While the host's agent was not asked yet only the default is offered and the picker says
// so; when it could not be asked, the line says that sessions use the host's default. A model that may bill usage
// credits without asking says so under the picker. Used by the New session dialog, the New topic dialog, the Start
// dialog, a topic's settings and a session's model dialog.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../lib/store.ts';
import { selectAgentHost } from '../../lib/stores/host.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Select } from '../../ui/index.ts';
import { HOST_DEFAULT_VALUE, billsUsageCredits, modelOptions, modelsNote } from './agent-choice.ts';
import { t } from './strings.ts';

/** How long the picker says "Asking…" before it says that the host's agent could not be asked. */
export const MODELS_WAIT_MS = 15_000;

export interface ModelPickerProps {
  /** Default: "Model". */
  readonly label?: string;
  /** null: the host's default. */
  readonly value: string | null;
  onChange(model: string | null): void;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function ModelPicker({ label, value, onChange, disabled = false, className }: ModelPickerProps) {
  const stores = useStores();
  const agent = useStore(stores.host, selectAgentHost);
  const answered = useStore(stores.host, (state) => state.host !== null);
  const known = agent?.modelsKnown === true;
  const [waited, setWaited] = useState(false);
  // The host answered and does not know the list: ask once more (its smurg asks its Claude Code then), and give it a
  // moment before saying that it could not be asked.
  const asked = useRef(false);
  useEffect(() => {
    if (known || !answered) return;
    if (!asked.current) {
      asked.current = true;
      Promise.resolve()
        .then(() => stores.host.reload())
        .catch(() => {
          // The host store keeps the failure; the note below says the list is not known.
        });
    }
    const timer = setTimeout(() => setWaited(true), MODELS_WAIT_MS);
    return () => clearTimeout(timer);
  }, [known, answered, stores]);

  const options = modelOptions(agent, value);
  const note = billsUsageCredits(agent, value) ? t('model.credits') : modelsNote(agent, waited);
  return (
    <Select<string>
      label={label ?? t('model.label')}
      className={className}
      value={value ?? HOST_DEFAULT_VALUE}
      options={options}
      disabled={disabled}
      hint={note ?? undefined}
      onChange={(next) => onChange(next === HOST_DEFAULT_VALUE ? null : next)}
    />
  );
}

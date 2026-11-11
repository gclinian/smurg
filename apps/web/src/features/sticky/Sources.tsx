// The Slack and Discord channels the host connected (DESIGN 0.8.0 D6.4), at the foot of the list of sticky notes, for
// the HOST only: one line per connected source with what the host's computer does with it, so the host sees that it
// works. Reading (once a minute); waiting for room (the outside budgets of D4.5 are full: it reads on once some of that
// feedback is decided); not read, with the host's own words for why (a channel id or a token of another form, the
// token refused, no access, the service not reached, an answer that could not be read). Nothing while none is connected.
// The state comes with the index (`sticky.list`, `sticky.changed` `sources`); the members are told it too, but only the
// host connected the channels and can change them (`smurg connect`), so only the host is shown it.
import type { OutsideSource, SourceState } from '@smurg/protocol';
import { useId } from 'react';
import { renderWireText } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { useCapabilities, useStores } from '../../lib/workspace/context.tsx';
import { t } from './strings.ts';

/** A service's name: a name, never translated. */
const SOURCE_NAMES: Readonly<Record<OutsideSource, string>> = { slack: 'Slack', discord: 'Discord' };

function lineOf(state: SourceState): string {
  const source = SOURCE_NAMES[state.source];
  switch (state.state) {
    case 'reading':
      return t('sources.reading', { source });
    case 'waiting-for-room':
      return t('sources.waiting', { source });
    case 'failing':
      return t('sources.failing', { source, reason: state.problem === undefined ? '' : renderWireText(state.problem.text, state.problem.fallback) });
  }
}

export function Sources() {
  const stores = useStores();
  const sources = useStore(stores.sticky, (state) => state.sources);
  const isHost = useCapabilities().isHost;
  const headingId = useId();
  if (!isHost || sources.length === 0) return null;
  return (
    <section className="sticky-tree__group sticky-sources" aria-labelledby={headingId}>
      <h2 id={headingId} className="sticky-tree__heading" title={t('sources.hint')}>
        {t('sources.title')}
      </h2>
      <ul className="sticky-sources__list">
        {sources.map((state) => (
          <li key={state.source} className="sticky-sources__item" data-state={state.state}>
            <span className="sticky-sources__dot" aria-hidden="true" />
            <span>{lineOf(state)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

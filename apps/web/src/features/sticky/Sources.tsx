// The Slack and Discord channels the host connected (DESIGN 0.8.0 D6.4), at the foot of the list of sticky notes, for
// the HOST only: one line per connected source with what the host's computer does with it, so the host sees that it
// works. Reading (once a minute); waiting for room (the outside budgets of D4.5 are full: it reads on once some of that
// feedback is decided); not read, with the host's own words for why (a channel id or a token of another form, the
// token refused, no access, the service not reached, an answer that could not be read). Nothing while none is connected.
// While the index lists no sticky note Home, a line says that a message naming no sticky note is not kept (D6.3: the
// daemon drops it), so the host learns it before such messages are lost, not from a log line (review S8-SEC-2).
// The state comes with the index (`sticky.list`, `sticky.changed` `sources`); every member's page is sent it too (the
// hint says so: review S8-SEC-1), but only the host connected the channels and can change them (`smurg connect`), so
// only the host is shown it.
import type { OutsideSource, SourceState } from '@smurg/protocol';
import { useId } from 'react';
import { renderWireText } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { selectHasHome } from '../../lib/stores/sticky.ts';
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
  // Only a loaded index says that Home is not there.
  const noHome = useStore(stores.sticky, (state) => state.status === 'ready' && !selectHasHome(state));
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
      {noHome ? <p className="sticky-sources__note">{t('sources.noHome')}</p> : null}
    </section>
  );
}

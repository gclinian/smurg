// The right side of the sessions view while no column is open (UX §12): in a workspace without topics and sessions,
// "Start with a topic" and the four steps; otherwise "Nothing is open" and the first things that wait.
import { NoCommandHandlerError } from '../../lib/commands.ts';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { useCan, useCommands, useStores } from '../../lib/workspace/context.tsx';
import { tWorkbench } from '../../strings/workbench.ts';
import { Button, useToast } from '../../ui/index.ts';
import { IconPlus } from '../../ui/icons.tsx';
import { InboxPreview } from '../../features/sidebar/index.tsx';

const STEPS = ['discuss', 'spec', 'plan', 'execute'] as const;

export function EmptyColumns() {
  const stores = useStores();
  const commands = useCommands();
  const toast = useToast();
  const canCreate = useCan('session.create');
  const noTopics = useStore(stores.topics, (state) => state.status === 'ready' && state.topics.size === 0);
  const noSessions = useStore(stores.sessions, (state) => state.status === 'ready' && state.sessions.size === 0);
  const firstRun = noTopics && noSessions;

  const start = (what: 'topic' | 'session'): void => {
    const done = what === 'topic' ? commands.dispatch('newTopic', {}) : commands.dispatch('newSession', { kind: 'agent' });
    done.catch((error: unknown) => toast.show({ tone: 'warning', title: error instanceof NoCommandHandlerError ? tWorkbench('empty.unavailable') : describeError(error) }));
  };

  if (firstRun) {
    return (
      <div className="app-empty" data-empty="first-run">
        <h2 className="app-empty__title">{tWorkbench('empty.first.title')}</h2>
        <p className="app-empty__text">{tWorkbench('empty.first.body')}</p>
        <ol className="app-steps">
          {STEPS.map((step, index) => (
            <li key={step}>
              <span className="app-steps__n">{tWorkbench('empty.first.step', { number: index + 1 })}</span>
              <span className="app-steps__t">{tWorkbench(`empty.first.${step}`)}</span>
              <span>{tWorkbench(`empty.first.${step}.body`)}</span>
            </li>
          ))}
        </ol>
        {canCreate ? (
          <>
            <Button variant="primary" icon={<IconPlus />} onClick={() => start('topic')}>
              {tWorkbench('empty.first.new')}
            </Button>
            <button type="button" className="app-empty__link" onClick={() => start('session')}>
              {tWorkbench('empty.first.session')}
            </button>
          </>
        ) : (
          <p className="app-empty__text">{tWorkbench('empty.first.watch')}</p>
        )}
      </div>
    );
  }
  return (
    <div className="app-empty" data-empty="nothing-open">
      <h2 className="app-empty__title">{tWorkbench('empty.open.title')}</h2>
      <p className="app-empty__text">{tWorkbench('empty.open.body')}</p>
      <InboxPreview />
    </div>
  );
}

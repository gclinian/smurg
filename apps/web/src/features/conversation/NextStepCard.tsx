// What to do next, where the agent's work produced something (DESIGN §5.5 "Next-step cards"): the spec draft, the
// plan, a result report. The words and the buttons are smurg's own, from facts; never the model's prose. Only the
// newest pointer of its kind offers the step; an older one is a quiet line that still opens the thing.
import { memo } from 'react';
import type { ColumnTarget, ConversationEventOf } from '@smurg/protocol';
import { formatAnd } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectPlan, selectTopic } from '../../lib/stores/topics.ts';
import { useCapabilities, useCommands, useStores } from '../../lib/workspace/context.tsx';
import { Button } from '../../ui/index.ts';
import { IconFileText, IconPlan, IconReport } from '../../ui/icons.tsx';
import { useAction, useConversationEnv } from './env.tsx';
import { withAgentAccess } from './people.ts';
import { t } from './strings.ts';

export interface NextStepCardProps {
  readonly event: ConversationEventOf<'pointer'>;
  /** The newest pointer of this target in the conversation: the one that offers the next step. */
  readonly latest: boolean;
}

export const NextStepCard = memo(function NextStepCard({ event, latest }: NextStepCardProps) {
  const stores = useStores();
  const commands = useCommands();
  const caps = useCapabilities();
  const { people } = useConversationEnv();
  const { topicId, itemId } = event;
  const topic = useStore(stores.topics, (state) => selectTopic(state, topicId));
  const item = useStore(stores.topics, (state) => (itemId === undefined ? undefined : selectPlan(state, topicId)?.items.find((one) => one.id === itemId)));
  const action = useAction();

  const open = (target: ColumnTarget): void => {
    // A link inside a column opens to the side: the conversation one is reading stays.
    void commands.dispatch('openColumn', { target, side: true }).catch(() => {});
  };

  let icon;
  let text: string;
  let actions;
  if (event.target === 'spec') {
    icon = <IconFileText size={14} />;
    const canGenerate = latest && topic !== undefined && !topic.archived && !topic.plan.exists && !topic.plan.generating;
    const others = withAgentAccess(people).map((person) => person.displayName);
    text = latest ? t('next.spec') : t('next.spec.open');
    actions = (
      <>
        {canGenerate && caps.canDrive ? (
          <Button
            size="sm"
            variant="primary"
            loading={action.busy}
            onClick={() => {
              void action.run(() => stores.topics.generatePlan(topicId)).then((ok) => {
                if (ok) open({ kind: 'plan', topicId });
              });
            }}
          >
            {t('next.spec.generate')}
          </Button>
        ) : null}
        {canGenerate && !caps.canDrive && others.length > 0 ? <span className="conv-next__who">{t('next.spec.who', { names: formatAnd(others) })}</span> : null}
        <Button size="sm" variant={latest ? 'secondary' : 'ghost'} onClick={() => open({ kind: 'spec', topicId })}>
          {t('next.spec.open')}
        </Button>
      </>
    );
  } else if (event.target === 'plan') {
    icon = <IconPlan size={14} />;
    text = latest ? t('next.plan') : t('next.plan.open');
    actions = (
      <Button size="sm" variant={latest ? 'primary' : 'ghost'} onClick={() => open({ kind: 'plan', topicId })}>
        {t('next.plan.open')}
      </Button>
    );
  } else {
    icon = <IconReport size={14} />;
    const reviewers = item?.report?.reviewers ?? [];
    text = item === undefined ? t('next.report') : t('next.report.item', { item: `${item.number} · ${item.title}` });
    actions = (
      <>
        {/* "Mei reviews it." only while it waits for a review: a reviewed report needs nobody. */}
        {latest && item?.report !== undefined && (item.report.state === 'to-review' || item.report.state === 'changed-after-review') ? (
          <span className="conv-next__who">{reviewers.length > 0 ? t('next.report.reviewers', { names: formatAnd(reviewers.map((reviewer) => reviewer.displayName)) }) : t('next.report.anyone')}</span>
        ) : null}
        {itemId !== undefined ? (
          <Button size="sm" variant={latest ? 'primary' : 'ghost'} onClick={() => open({ kind: 'report', topicId, itemId })}>
            {t('next.report.open')}
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <section className="conv-next" data-target={event.target} data-latest={latest ? '' : undefined} aria-label={text}>
      <span className="conv-next__icon">{icon}</span>
      {latest ? <span className="conv-next__text">{text}</span> : null}
      <span className="conv-next__actions">{actions}</span>
      {action.error !== null ? (
        <span className="conv-card__problem" role="alert">
          {t('actionFailed', { message: action.error })}
        </span>
      ) : null}
    </section>
  );
});

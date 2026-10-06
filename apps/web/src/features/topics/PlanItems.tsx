// The work items of a plan as rows (DESIGN §5.12 item 20): number, title, the one badge, the description, who is
// responsible (a chip that opens the menu for members with agent access), the size, what it comes after, and what a
// person can do from here: open its session or its report, start it, try again, continue, ask the agent to resolve a
// merge conflict. The daemon decides what may happen; a refusal is a toast.
import { type AgentSession, type PlanInfo, type PresenceMember, type Topic, type WorkItem } from '@smurg/protocol';
import { itemLabel } from '../../lib/columns/describe.ts';
import { renderWireText } from '../../lib/errors.ts';
import { useCan, useMember, useStores } from '../../lib/workspace/context.tsx';
import { Avatar, Badge, Chip, Menu, type MenuItem } from '../../ui/index.ts';
import { IconUsers } from '../../ui/icons.tsx';
import { topicDialogs } from './dialogs.ts';
import { agentAccessNames, assignHint, assignablePeople, itemActions, itemBadge, itemNumbers, loads } from './model.ts';
import { LinkButton, useAction, useOpenSide } from './shared.tsx';
import { t } from './strings.ts';

export interface PlanItemsProps {
  readonly topic: Topic;
  readonly plan: PlanInfo;
  readonly items: readonly WorkItem[];
  readonly members: readonly PresenceMember[];
  sessionOf(item: WorkItem): AgentSession | undefined;
  /** The list's accessible name. */
  readonly label: string;
}

export function PlanItems({ topic, plan, items, members, sessionOf, label }: PlanItemsProps) {
  return (
    <ol className="plan-items" aria-label={label}>
      {items.map((item) => (
        <PlanItem key={item.id} topic={topic} plan={plan} item={item} members={members} session={sessionOf(item)} />
      ))}
    </ol>
  );
}

function PlanItem({ topic, plan, item, members, session }: { topic: Topic; plan: PlanInfo; item: WorkItem; members: readonly PresenceMember[]; session: AgentSession | undefined }) {
  const stores = useStores();
  const act = useAction();
  const openSide = useOpenSide();
  const canDrive = useCan('session.drive');
  const canStart = useCan('session.create');
  const live = !topic.archived;
  const badge = itemBadge(item, plan, session);
  const actions = itemActions(item, plan);
  const failed = (reason: string): string => t('item.failed', { item: itemLabel(item), reason });
  const responsibleRole = item.responsible === null ? undefined : members.find((member) => member.userId === item.responsible?.userId)?.role;

  return (
    <li className="plan-item" data-state={item.state} data-bar={badge.bar} data-item={item.id}>
      <span className="plan-item__n" aria-hidden="true">
        {item.number > 0 ? item.number : '–'}
      </span>
      <div className="plan-item__main">
        <div className="plan-item__top">
          <span className="plan-item__title" title={item.title}>
            {item.number > 0 ? <span className="ui-visually-hidden">{t('item.prefix', { number: item.number })}</span> : null}
            {item.title}
          </span>
          <Badge tone={badge.tone}>{badge.text}</Badge>
        </div>
        {item.summary.trim() !== '' ? <p className="plan-item__desc">{item.summary}</p> : null}
        {item.startError !== undefined ? <p className="plan-item__error">{t('item.startError', { reason: renderWireText(item.startError.text, item.startError.fallback) })}</p> : null}
        {responsibleRole === 'editor' ? <p className="plan-item__note">{t('assign.editorNote', { name: item.responsible?.displayName ?? '', names: agentAccessNames(members) })}</p> : null}
        <div className="plan-item__row">
          <Responsible topic={topic} plan={plan} item={item} members={members} />
          <span className="plan-item__size" title={t(`size.${item.size}`)}>
            <span aria-hidden="true">{item.size.toUpperCase()}</span>
            <span className="ui-visually-hidden">{t(`size.${item.size}`)}</span>
          </span>
          {item.dependsOn.length > 0 && item.inPlan ? <span className="plan-item__deps">{t('item.after', { items: itemNumbers(plan, item.dependsOn) })}</span> : null}
          {item.attempt > 1 ? <span className="plan-item__deps">{t('item.attempt', { attempt: item.attempt })}</span> : null}
          <span className="plan-item__spacer" />
          {actions.session !== null ? (
            <LinkButton className="plan-item__link" onClick={() => openSide({ kind: 'session', sessionId: actions.session as string })}>
              {t('item.session')}
            </LinkButton>
          ) : null}
          {actions.report ? (
            <LinkButton className="plan-item__link" onClick={() => openSide({ kind: 'report', topicId: topic.id, itemId: item.id })}>
              {t('item.report')}
            </LinkButton>
          ) : null}
          {actions.continue && canDrive && live ? (
            <LinkButton className="plan-item__link" onClick={() => void act(() => stores.topics.continueItem(topic.id, item.id), failed)}>
              {t('item.continue')}
            </LinkButton>
          ) : null}
          {actions.retry && canStart && live ? (
            <LinkButton className="plan-item__link" onClick={() => void act(() => stores.topics.retryItem(topic.id, item.id), failed)}>
              {t('item.retry')}
            </LinkButton>
          ) : null}
          {actions.resolve && canDrive && live ? (
            <LinkButton className="plan-item__link" onClick={() => void act(() => stores.topics.resolveItem(topic.id, item.id), failed)}>
              {t('item.resolve')}
            </LinkButton>
          ) : null}
          {(actions.start || actions.startAgain) && canStart && live && topic.plan.valid ? (
            <LinkButton className="plan-item__link" onClick={() => topicDialogs(stores).open({ kind: 'start', topicId: topic.id, itemIds: [item.id] })}>
              {actions.startAgain ? t('item.startAgain') : t('item.start')}
            </LinkButton>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** Who is responsible for an item: a chip, and for members with agent access the menu that changes it (`plan.assign`). */
function Responsible({ topic, plan, item, members }: { topic: Topic; plan: PlanInfo; item: WorkItem; members: readonly PresenceMember[] }) {
  const stores = useStores();
  const act = useAction();
  const me = useMember();
  const canAssign = useCan('session.drive') && !topic.archived && item.inPlan && item.state !== 'reviewed';
  const responsible = item.responsible;
  const known = responsible === null ? undefined : members.find((member) => member.userId === responsible.userId);
  const offline = known !== undefined && !known.online;
  const name =
    responsible === null
      ? t('assign.nobody')
      : [
          responsible.userId === me?.userId ? t('assign.you', { name: responsible.displayName }) : responsible.displayName,
          responsible.source !== 'chosen' && item.state === 'not-started' ? t('assign.suggested') : null,
          offline ? t('assign.offline') : null,
        ]
          .filter((part): part is string => part !== null)
          .join(t('sep'));
  const lead = responsible === null ? <IconUsers size={14} /> : <Avatar name={responsible.displayName} size="xs" decorative {...(known?.color === undefined ? {} : { color: known.color })} />;

  if (!canAssign) {
    return (
      <Chip lead={lead} title={responsible === null ? t('assign.nobody.title') : t('assign.title', { name: responsible.displayName })} className="plan-who">
        {name}
      </Chip>
    );
  }

  const counts = loads(plan);
  const assign = (userId: string | null): void => {
    void act(
      () => stores.topics.assign(topic.id, item.id, userId),
      (reason) => t('assign.failed', { reason }),
    );
  };
  const items: MenuItem[] = [
    ...assignablePeople(members).map((member) => ({
      id: member.userId,
      label: member.online ? member.displayName : t('assign.person.offline', { name: member.displayName }),
      icon: <Avatar name={member.displayName} size="xs" decorative color={member.color} />,
      hint: assignHint(member, counts.get(member.userId)?.count ?? 0),
      checked: responsible?.userId === member.userId,
      onSelect: () => assign(member.userId),
    })),
    { id: 'nobody', label: t('assign.nobody.option'), icon: <IconUsers size={14} />, checked: responsible === null, onSelect: () => assign(null) },
  ];
  return (
    <Menu
      className="plan-who"
      size="sm"
      align="start"
      label={responsible === null ? t('assign.change.nobody', { number: item.number }) : t('assign.change', { number: item.number, name: responsible.displayName })}
      text={name}
      icon={lead}
      items={items}
    />
  );
}

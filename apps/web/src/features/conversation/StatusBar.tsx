// The bar above the composer (UX §4, DESIGN §5.12 item 12): what the session is doing or waiting for, in one line
// that a screen reader hears (`role="status"`; the conversation itself is silent). It also carries the one action
// the state calls for: show the open card, try again, continue, write the spec, check the login.
//
// Only the sentences are live regions: the state, and beside it the account's state or a refusal. How long the state
// has lasted stands between them, outside both: it changes every second, and a region that changes every second is
// read out every second (DESIGN §5.9: the status speaks when the state changes, as streamed text is not read delta by
// delta).
import { useState, type ReactNode } from 'react';
import type { AgentSession } from '@smurg/protocol';
import { sessionGlyph, statusLabel } from '../../lib/session-status.ts';
import { formatAge, joinSentences } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectOpenCards } from '../../lib/stores/conversations.ts';
import { selectAccount } from '../../lib/stores/host.ts';
import { selectPlan, selectTopic } from '../../lib/stores/topics.ts';
import { useNow } from '../../lib/use-now.ts';
import { useCapabilities, useStores } from '../../lib/workspace/context.tsx';
import { Button, StatusGlyph, cx, useToast } from '../../ui/index.ts';
import { useAction } from './env.tsx';
import { t } from './strings.ts';

/** A discussion this long offers "Start a fresh conversation" (events of the conversation). */
export const FRESH_CONVERSATION_SEQ = 3_000;

export interface StatusBarProps {
  readonly session: AgentSession;
  /** Scrolls to an open card and puts the focus on it. */
  onShowCard(cardId: string): void;
}

export function StatusBar({ session, onShowCard }: StatusBarProps) {
  const stores = useStores();
  const caps = useCapabilities();
  const toast = useToast();
  const sessionId = session.id;
  const catchingUp = useStore(stores.conversations, (state) => state.conversations.get(sessionId)?.catchingUp ?? false);
  const thinking = useStore(stores.conversations, (state) => (state.conversations.get(sessionId)?.thinkingTurnId ?? null) !== null);
  const writing = useStore(stores.conversations, (state) => (state.conversations.get(sessionId)?.streaming.length ?? 0) > 0);
  const openCard = useStore(stores.conversations, (state) => {
    const conversation = state.conversations.get(sessionId);
    return conversation === undefined ? null : (selectOpenCards(conversation)[0]?.id ?? null);
  });
  // Since when that card waits. The wait the bar counts IS the card's: the session's own stamp (`waitingSince`) is
  // written a moment later, and two stamps on two sides of a second would make the bar and the card read "29 sec" and
  // "30 sec" for the whole wait (one wait, one number).
  const openCardSince = useStore(stores.conversations, (state) => {
    const conversation = state.conversations.get(sessionId);
    return conversation === undefined ? undefined : selectOpenCards(conversation)[0]?.askedAt;
  });
  const account = useStore(stores.host, selectAccount);
  const topicPhase = useStore(stores.topics, (state) => (session.topicId === undefined ? undefined : selectTopic(state, session.topicId)?.phase));
  // Why a work item's session stopped without a report, as its plan knows it (when the plan is loaded): the agent
  // itself, a restart of the host's smurg, a person, an error.
  const stalledBy = useStore(stores.topics, (state) => (session.topicId === undefined || session.itemId === undefined ? undefined : selectPlan(state, session.topicId)?.items.find((item) => item.id === session.itemId)?.stalledBy));
  // An age is shown while the agent runs or waits; under a minute the clock redraws it each second by itself.
  const aging = session.status === 'running' || session.status === 'waiting-answer' || session.status === 'waiting-permission';
  const now = useNow(aging ? 30_000 : 3_600_000);
  const action = useAction();
  const [login, setLogin] = useState<AgentSession['login'] | null>(null);

  const run = (request: () => Promise<unknown>): void => {
    void action.run(request);
  };
  const actions: ReactNode[] = [];
  const act = (id: string, label: string, onClick: () => void, title?: string): void => {
    actions.push(
      <Button key={id} size="sm" variant="ghost" disabled={action.busy} title={title} onClick={onClick}>
        {label}
      </Button>,
    );
  };

  let text: string;
  /** Since when the state has lasted, when the bar says how long. */
  let since: number | undefined;
  let wait = false;
  switch (session.status) {
    case 'starting':
      text = t('status.starting');
      break;
    case 'running':
      if (session.doing === 'compacting') text = t('status.compacting');
      else {
        text = t(writing ? 'status.writing' : thinking ? 'status.thinking' : 'status.working');
        since = session.runningSince;
      }
      break;
    case 'waiting-answer':
    case 'waiting-permission':
      wait = true;
      text = t(session.status === 'waiting-answer' ? 'status.question' : 'status.permission');
      since = openCardSince ?? session.waitingSince;
      if (openCard !== null) act('show', t('status.show'), () => onShowCard(openCard));
      break;
    case 'idle':
      text = t('status.idle');
      if (session.purpose === 'discussion' && session.topicId !== undefined) {
        const topicId = session.topicId;
        if (topicPhase === 'discussing' && caps.canDrive) act('spec', t('status.spec'), () => run(() => stores.topics.requestSpec(topicId)), t('status.spec.title'));
        if (session.lastSeq >= FRESH_CONVERSATION_SEQ && caps.canCreateSession) act('fresh', t('status.fresh'), () => run(() => stores.topics.restartDiscussion(topicId)), t('status.fresh.title'));
      }
      break;
    case 'done':
      text = t('status.done');
      break;
    case 'stalled':
      wait = true;
      text = stalledBy === 'restart' ? t('status.stalled.restart') : stalledBy === 'stopped' ? t('status.stalled.stopped') : stalledBy === 'error' ? t('status.stalled.error') : t('status.stalled');
      if (caps.canDrive && session.topicId !== undefined && session.itemId !== undefined) {
        const { topicId, itemId } = session;
        act('continue', t('status.stalled.continue'), () => run(() => stores.topics.continueItem(topicId, itemId)));
      }
      break;
    case 'failed':
      wait = true;
      text = t('status.failed');
      if (caps.canDrive && (session.retryHostOnly !== true || caps.isHost)) {
        const { topicId, itemId } = session;
        // A work item's session is tried again through its plan: the same session starts again AND smurg tells it to go
        // on with the item (`plan.item.retry`). A plain `session.retry` would leave the item "running" with an idle agent.
        act('retry', t('status.failed.retry'), () => run(() => (topicId !== undefined && itemId !== undefined ? stores.topics.retryItem(topicId, itemId) : stores.sessions.retry(sessionId))));
      }
      break;
    case 'ended':
      text = t('status.ended');
      break;
  }
  if (catchingUp) {
    text = t('status.catchingUp');
    since = undefined;
  }

  // The host's Claude account, when it is why nothing moves.
  const loggedOut = session.status !== 'ended' && ((login ?? session.login) === 'logged-out' || account?.state === 'logged-out');
  const usageLimit = session.status !== 'ended' && account?.state === 'usage-limit';
  let accountLine: string | null = null;
  if (usageLimit) accountLine = t('status.account.usage-limit');
  else if (loggedOut) {
    accountLine = t('status.account.logged-out');
    if (caps.canDrive) {
      act('login', t('status.login.check'), () =>
        run(async () => {
          const result = await stores.sessions.loginStatus(sessionId);
          setLogin(result);
          toast.show({ tone: result === 'logged-in' ? 'success' : 'info', title: result === 'logged-in' ? t('status.login.ok') : result === 'logged-out' ? t('status.account.logged-out') : t('status.login.unknown') });
        }),
      );
    }
  }

  const glyph = sessionGlyph(session);
  return (
    // An ended session says so once on screen, in the composer's place ("This session has ended. It takes no more
    // messages."): the bar is only spoken then, not drawn above the same words.
    <div className={cx('conv-status', (wait || accountLine !== null) && 'conv-status--wait', session.status === 'ended' && 'ui-visually-hidden')} data-status={session.status}>
      {glyph !== null ? <StatusGlyph status={glyph} label={statusLabel(glyph)} /> : null}
      <span className="conv-status__line">
        {/* The state and its age are one piece (conversation.css): what follows never takes width from them. */}
        <span className="conv-status__state">
          <span className="conv-status__text" role="status">
            {text}
          </span>{' '}
          {since !== undefined ? <span className="conv-status__age">{t('status.age', { age: formatAge(since, now) })}</span> : null}
        </span>{' '}
        <span className="conv-status__more" role="status">
          {joinSentences([accountLine, action.error === null ? null : t('actionFailed', { message: action.error })])}
        </span>
      </span>
      {/* The buttons are one piece: two of them go below the sentences in a column too narrow for both (conversation.css). */}
      {actions.length === 0 ? null : <span className="conv-status__actions">{actions}</span>}
    </div>
  );
}

// The bar above the composer (UX §4, DESIGN §5.12 item 12): what the session is doing or waiting for, in one line
// that a screen reader hears (`role="status"`; the conversation itself is silent). It also carries the one action
// the state calls for: show the open card, try again, continue, write the spec, check the login.
import { useState, type ReactNode } from 'react';
import type { AgentSession } from '@smurg/protocol';
import { sessionGlyph, statusLabel } from '../../lib/session-status.ts';
import { formatAge } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectOpenCards } from '../../lib/stores/conversations.ts';
import { selectAccount } from '../../lib/stores/host.ts';
import { selectTopic } from '../../lib/stores/topics.ts';
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
  const account = useStore(stores.host, selectAccount);
  const topicPhase = useStore(stores.topics, (state) => (session.topicId === undefined ? undefined : selectTopic(state, session.topicId)?.phase));
  const busy = session.status === 'running' || session.status === 'starting';
  const waiting = session.status === 'waiting-answer' || session.status === 'waiting-permission';
  const now = useNow(busy ? 1_000 : waiting ? 10_000 : 3_600_000);
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
  let wait = false;
  switch (session.status) {
    case 'starting':
      text = t('status.starting');
      break;
    case 'running': {
      const age = formatAge(session.runningSince ?? now, now);
      if (session.doing === 'compacting') text = t('status.compacting');
      else if (writing) text = t('status.writing', { age });
      else if (thinking) text = t('status.thinking', { age });
      else text = t('status.working', { age });
      break;
    }
    case 'waiting-answer':
    case 'waiting-permission':
      wait = true;
      text = t(session.status === 'waiting-answer' ? 'status.question' : 'status.permission', { age: formatAge(session.waitingSince ?? now, now) });
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
      text = t('status.stalled');
      if (caps.canDrive && session.topicId !== undefined && session.itemId !== undefined) {
        const { topicId, itemId } = session;
        act('continue', t('status.stalled.continue'), () => run(() => stores.topics.continueItem(topicId, itemId)));
      }
      break;
    case 'failed':
      wait = true;
      text = t('status.failed');
      if (caps.canDrive && (session.retryHostOnly !== true || caps.isHost)) act('retry', t('status.failed.retry'), () => run(() => stores.sessions.retry(sessionId)));
      break;
    case 'ended':
      text = t('status.ended');
      break;
  }
  if (catchingUp) text = t('status.catchingUp');

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
    <div className={cx('conv-status', (wait || accountLine !== null) && 'conv-status--wait')} role="status" data-status={session.status}>
      {glyph !== null ? <StatusGlyph status={glyph} label={statusLabel(glyph)} /> : null}
      <span className="conv-status__text">
        {text}
        {accountLine !== null ? ` ${accountLine}` : ''}
        {action.error !== null ? ` ${t('actionFailed', { message: action.error })}` : ''}
      </span>
      {actions}
    </div>
  );
}

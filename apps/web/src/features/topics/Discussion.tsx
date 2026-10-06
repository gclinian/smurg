// What the spec and plan columns say and do about the topic's discussion session: the status line at the foot of
// the spec column ("Claude is working · 20 sec", "Claude asks a question · Open the discussion"), the box that
// sends "Ask the agent to revise" there, and "Restart discussion" when the discussion is lost (DESIGN §3.9, §5.4).
import { QUOTE_HEADING_MAX_CHARS, QUOTE_TEXT_MAX_CHARS, isSmurgError, type AgentSession, type Topic } from '@smurg/protocol';
import { formatAge } from '../../lib/format.ts';
import { sessionGlyph, statusLabel } from '../../lib/session-status.ts';
import { useStore } from '../../lib/store.ts';
import { selectSession } from '../../lib/stores/sessions.ts';
import { useNow } from '../../lib/use-now.ts';
import { useCan, useStores } from '../../lib/workspace/context.tsx';
import { Button, StatusGlyph } from '../../ui/index.ts';
import { IconRefresh } from '../../ui/icons.tsx';
import { AskBox } from './AskBox.tsx';
import { topicDialogs } from './dialogs.ts';
import { agentAccessNames } from './model.ts';
import { Foot, LinkButton, useMembers, useOpenSide, useSentNotice } from './shared.tsx';
import { t } from './strings.ts';

/** The topic's discussion session, when the session list knows it. */
export function useDiscussion(topic: Pick<Topic, 'discussionSessionId'>): AgentSession | undefined {
  const id = topic.discussionSessionId;
  const session = useStore(useStores().sessions, (state) => (id === undefined ? undefined : selectSession(state, id)));
  return session?.kind === 'agent' ? session : undefined;
}

/** "Restart discussion": asks first (the dialog says what a new discussion keeps and what it does not know). */
export function RestartDiscussionButton({ topicId, size = 'sm' }: { topicId: string; size?: 'sm' | 'md' }) {
  const stores = useStores();
  if (!useCan('session.create')) return null;
  return (
    <Button size={size} icon={<IconRefresh />} onClick={() => topicDialogs(stores).open({ kind: 'restart', topicId })}>
      {t('discussion.restart')}
    </Button>
  );
}

/** The status line at the foot of a spec or plan column. */
export function DiscussionFoot({ topic }: { topic: Topic }) {
  const session = useDiscussion(topic);
  const openSide = useOpenSide();
  const working = session !== undefined && (session.status === 'running' || session.status === 'starting');
  // "Claude is working · 20 sec": the age the session's own status bar shows, on the same clock.
  const now = useNow(30_000, working);

  if (topic.archived) return <Foot className="topics-foot--status" text={t('archived.note')} />;
  if (topic.discussion === 'lost' || session === undefined || session.status === 'ended') {
    return (
      <Foot className="topics-foot--status" text={t('discussion.closed')}>
        {topic.discussion === 'lost' ? <RestartDiscussionButton topicId={topic.id} /> : null}
      </Foot>
    );
  }
  const glyph = sessionGlyph(session);
  const text =
    session.doing === 'compacting'
      ? t('discussion.compacting')
      : working
        ? session.runningSince === undefined
          ? t('discussion.working')
          : t('discussion.workingFor', { time: formatAge(session.runningSince, now) })
        : session.status === 'waiting-answer'
          ? t('discussion.question')
          : session.status === 'waiting-permission'
            ? t('discussion.permission')
            : session.status === 'failed'
              ? t('discussion.failed')
              : t('discussion.idle');
  return (
    <Foot
      className="topics-foot--status"
      text={
        <>
          {glyph !== null ? <StatusGlyph status={glyph} label={statusLabel(glyph)} size={12} /> : null} {text}
        </>
      }
    >
      <LinkButton onClick={() => openSide({ kind: 'session', sessionId: session.id })}>{t('discussion.open')}</LinkButton>
    </Foot>
  );
}

export interface ReviseQuote {
  /** The section's heading, when the quote is a section of the spec. */
  readonly heading?: string;
  readonly text: string;
}

/** A quote as the wire takes it: the heading and the text within their limits. */
export function clipQuote(quote: ReviseQuote): ReviseQuote {
  const heading = quote.heading?.replace(/\s+/g, ' ').trim().slice(0, QUOTE_HEADING_MAX_CHARS);
  return { ...(heading === undefined || heading === '' ? {} : { heading }), text: quote.text.trim().slice(0, QUOTE_TEXT_MAX_CHARS) };
}

export interface ReviseBoxProps {
  readonly topic: Topic;
  readonly target: 'spec' | 'plan';
  readonly quote: ReviseQuote | null;
  onQuoteRemoved(): void;
  /** Put into the box when it opens empty. */
  readonly initialText?: string;
  onClose(): void;
}

/**
 * "Ask the agent to revise": the text (with the quoted section) goes to the topic's discussion session, as a
 * message from a member with agent access and as a suggestion from anyone else (`topic.revise`).
 */
export function ReviseBox({ topic, target, quote, onQuoteRemoved, initialText, onClose }: ReviseBoxProps) {
  const stores = useStores();
  const members = useMembers();
  const canDrive = useCan('session.drive');
  const sent = useSentNotice('discussion');
  const clipped = quote === null ? null : clipQuote(quote);
  return (
    <AskBox
      draftKey={`revise:${topic.id}:${target}`}
      label={t('revise.label')}
      placeholder={t('revise.placeholder')}
      hint={canDrive ? t('revise.hint') : t('revise.hint.suggestion', { names: agentAccessNames(members) })}
      sendLabel={canDrive ? t('revise.send') : t('revise.send.suggestion')}
      quote={clipped === null ? null : { label: clipped.heading === undefined ? t('revise.quote') : t('revise.quote.section', { heading: clipped.heading }), onRemove: onQuoteRemoved }}
      {...(initialText === undefined ? {} : { initialText })}
      autoFocus
      onClose={onClose}
      onSend={async (text) => {
        const result = await stores.topics.revise({ topicId: topic.id, target, text, ...(clipped === null || clipped.text === '' ? {} : { quote: clipped }) });
        sent(result);
        onClose();
      }}
      errorAction={(error) => (isSmurgError(error) && error.text?.id === 'topic.noDiscussion' ? <RestartDiscussionButton topicId={topic.id} /> : null)}
    />
  );
}

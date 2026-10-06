// The pieces of a conversation as rows (UX §4): people's messages, what smurg told the agent, the agent's text
// (finished and streaming), tool lines, system lines, notices and the end of a turn that did not simply complete.
// Every row is memoised on its render item, which keeps its identity while nothing in it changed
// (lib/stores/conversations.ts), so an arriving event renders one row.
import { memo, useCallback, type ReactNode } from 'react';
import type { ConversationEventOf } from '@smurg/protocol';
import { renderWireText } from '../../lib/errors.ts';
import { formatRole, formatTime } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import type { AgentPiece, LineItem, MessageItem, NoticeItem, RenderItem, SmurgItem, StreamingItem, TextItem, TurnEndItem } from '../../lib/stores/conversations.ts';
import { selectSession } from '../../lib/stores/sessions.ts';
import { useCapabilities, useStores } from '../../lib/workspace/context.tsx';
import { Avatar, Banner, Button, IconButton, cx } from '../../ui/index.ts';
import { IconTrash } from '../../ui/icons.tsx';
import { Markdown, StreamingMarkdown } from '../markdown/index.ts';
import { useAction, useConversationEnv } from './env.tsx';
import { useHostDialogs } from './host-dialogs.ts';
import { NextStepCard } from './NextStepCard.tsx';
import { personOf } from './people.ts';
import { PermissionCard } from './PermissionCard.tsx';
import { QuestionCard } from './QuestionCard.tsx';
import { t } from './strings.ts';
import { SuggestionCard } from './SuggestionCard.tsx';
import { ReadsCard, ToolCard } from './ToolCard.tsx';

function Time({ at }: { at: number }) {
  return <time dateTime={new Date(at).toISOString()}>{formatTime(at)}</time>;
}

/**
 * "Remove this entry": the host replaces ONE event by "The host removed this entry." (DESIGN §2.4; a secret an agent
 * printed, something a person should not have written). Only the host has it; the confirmation is the console's.
 */
function Redact({ seq }: { seq: number }) {
  const caps = useCapabilities();
  const hostDialogs = useHostDialogs();
  const { sessionId } = useConversationEnv();
  if (!caps.can('admin')) return null;
  return <IconButton className="conv-redact" size="sm" label={t('redact')} icon={<IconTrash />} onClick={() => hostDialogs.redact(sessionId, seq)} />;
}

// ---- people and smurg

const MessageRow = memo(function MessageRow({ item }: { item: MessageItem }) {
  const { self, people, mentionNames, paths } = useConversationEnv();
  const { event, delivery } = item;
  const mine = event.from.userId === self?.userId;
  const marks: string[] = [];
  if (event.suggestion !== undefined) marks.push(t(event.suggestion.modified ? 'message.suggestionEdited' : 'message.suggestion', { name: event.suggestion.acceptedBy.displayName }));
  if (event.origin !== 'composer') marks.push(t(`message.origin.${event.origin}`));
  if (event.cleaned === true) marks.push(t('message.cleaned'));
  if (delivery === 'queued') marks.push(t('message.delivery.queued'));
  if (delivery === 'cancelled') marks.push(t('message.delivery.cancelled'));
  return (
    <article className={cx('conv-msg', mine && 'conv-msg--me')} data-delivery={delivery ?? undefined}>
      <Avatar name={event.from.displayName} color={personOf(people, event.from.userId)?.color} size="md" decorative />
      <div className="conv-msg__main">
        <div className="conv-msg__head">
          <span className="conv-msg__name">{event.from.displayName}</span>
          <span>{t('message.role', { role: formatRole(event.from.role) })}</span>
          <Time at={event.at} />
          {marks.map((mark) => (
            <span key={mark} className="conv-msg__via">
              {mark}
            </span>
          ))}
          <Redact seq={event.seq} />
        </div>
        <div className="conv-msg__bubble">
          <Markdown text={event.text} breaks mentions={mentionNames} paths={paths} headingBase={4} />
        </div>
      </div>
    </article>
  );
});

const SmurgRow = memo(function SmurgRow({ item }: { item: SmurgItem }) {
  const { event } = item;
  return (
    <details className="conv-smurg" data-purpose={event.purpose}>
      <summary>
        <span>{event.by === undefined ? t('smurg.own') : t('smurg.by', { name: event.by.displayName })}</span>
        <Time at={event.at} />
        <Redact seq={event.seq} />
      </summary>
      <pre className="conv-smurg__text" aria-label={t('smurg.show')}>
        {event.text}
      </pre>
    </details>
  );
});

// ---- the agent

function AgentHead({ at }: { at: number }) {
  return (
    <div className="conv-agent__head">
      <Avatar name={t('agent.name')} status="agent" size="md" decorative />
      <span className="conv-agent__name">{t('agent.name')}</span>
      <Time at={at} />
    </div>
  );
}

const TextBlock = memo(function TextBlock({ block }: { block: ConversationEventOf<'text'> }) {
  const { paths } = useConversationEnv();
  return (
    <div className="conv-agent__text" data-block={block.blockId}>
      <Redact seq={block.seq} />
      <Markdown text={block.text} paths={paths} headingBase={4} />
      {block.aborted === true ? <p className="conv-agent__note">{t('text.aborted')}</p> : null}
      {block.truncated === true ? <p className="conv-agent__note">{t('text.truncated')}</p> : null}
    </div>
  );
});

const TextRow = memo(function TextRow({ item, head }: { item: TextItem; head: boolean }) {
  return (
    <article className="conv-agent">
      {head ? <AgentHead at={item.at} /> : null}
      {item.blocks.map((block) => (
        <TextBlock key={block.blockId} block={block} />
      ))}
    </article>
  );
});

/** A block that is being written: its text arrives outside React's state (features/markdown StreamingMarkdown). */
const StreamingRow = memo(function StreamingRow({ item, head }: { item: StreamingItem; head: boolean }) {
  const stores = useStores();
  const { sessionId, paths } = useConversationEnv();
  const { blockId } = item;
  const read = useCallback(() => stores.conversations.streamText(sessionId, blockId), [stores, sessionId, blockId]);
  const subscribe = useCallback(
    (listener: () => void) =>
      stores.conversations.onStream(sessionId, (changed) => {
        if (changed === blockId) listener();
      }),
    [stores, sessionId, blockId],
  );
  return (
    <article className="conv-agent conv-agent--streaming" data-block={blockId}>
      {head ? <AgentHead at={item.at} /> : null}
      <div className="conv-agent__text">
        <StreamingMarkdown read={read} subscribe={subscribe} paths={paths} headingBase={4} />
        <span className="conv-caret" aria-hidden="true" />
      </div>
    </article>
  );
});

/**
 * A piece of the agent. The first piece after something else shows "Claude" and the time; the pieces of a subagent,
 * nested under its tool line, never do.
 */
function renderPiece(piece: AgentPiece, nested = false): ReactNode {
  const head = piece.lead && !nested;
  switch (piece.kind) {
    case 'text':
      return <TextRow key={piece.key} item={piece} head={head} />;
    case 'streaming':
      return <StreamingRow key={piece.key} item={piece} head={head} />;
    case 'tool':
    case 'reads': {
      const line = piece.kind === 'tool' ? <ToolCard key={piece.key} item={piece} renderPiece={renderNested} /> : <ReadsCard key={piece.key} item={piece} />;
      if (!head) return line;
      return (
        <div key={piece.key} className="conv-agent">
          <AgentHead at={piece.at} />
          {line}
        </div>
      );
    }
  }
}

const renderNested = (piece: AgentPiece): ReactNode => renderPiece(piece, true);

// ---- lines, notices, the end of a turn

const LineRow = memo(function LineRow({ item }: { item: LineItem }) {
  return (
    <p className="conv-sys">
      <span>
        {renderWireText(item.event.text, item.event.fallback)} {'·'} <Time at={item.event.at} />
      </span>
    </p>
  );
});

const NoticeRow = memo(function NoticeRow({ item }: { item: NoticeItem }) {
  const stores = useStores();
  const hostDialogs = useHostDialogs();
  const caps = useCapabilities();
  const { sessionId } = useConversationEnv();
  const { event } = item;
  // Only what decides whether the notice's action still makes sense.
  const status = useStore(stores.sessions, (state) => selectSession(state, sessionId)?.status);
  const hostOnly = useStore(stores.sessions, (state) => {
    const session = selectSession(state, sessionId);
    return session?.kind === 'agent' && session.retryHostOnly === true;
  });
  const action = useAction();
  const root = useStore(stores.sessions, (state) => selectSession(state, sessionId)?.root);
  // A work item's session: "Try again" goes through its plan, so that smurg also tells the agent to go on with the item.
  const topicId = useStore(stores.sessions, (state) => {
    const session = selectSession(state, sessionId);
    return session?.kind === 'agent' && session.itemId !== undefined ? session.topicId : undefined;
  });
  const itemId = useStore(stores.sessions, (state) => {
    const session = selectSession(state, sessionId);
    return session?.kind === 'agent' ? session.itemId : undefined;
  });
  let button: ReactNode = null;
  let hint: string | null = null;
  if (event.action === 'retry' && status === 'failed' && caps.canDrive) {
    if (hostOnly && !caps.isHost) hint = t('notice.hostOnly');
    else {
      button = (
        <Button size="sm" loading={action.busy} onClick={() => void action.run(() => (topicId !== undefined && itemId !== undefined ? stores.topics.retryItem(topicId, itemId) : stores.sessions.retry(sessionId)))}>
          {t('notice.retry')}
        </Button>
      );
    }
  } else if (event.action === 'restart-agent' && status !== undefined && status !== 'ended' && caps.canDrive) {
    button = (
      <Button size="sm" loading={action.busy} onClick={() => void action.run(() => stores.sessions.restart(sessionId))}>
        {t('notice.restart')}
      </Button>
    );
  }
  // The folder's Claude Code project settings wait for the host: the host reviews them from here.
  const settings = event.text.id === 'session.projectSettings.untrusted' || event.text.id === 'session.projectSettings.changed';
  if (settings && caps.isHost && root !== undefined && status !== 'ended') {
    button = (
      <>
        <Button size="sm" onClick={() => hostDialogs.projectSettings(root)}>
          {t('notice.review')}
        </Button>
        {button}
      </>
    );
  }
  return (
    <Banner tone={event.level === 'error' ? 'danger' : event.level} live="none" className="conv-notice" actions={button ?? undefined}>
      {renderWireText(event.text, event.fallback)}
      {hint !== null ? <span className="conv-notice__hint"> {hint}</span> : null}
      {action.error !== null ? <span className="conv-notice__hint"> {t('actionFailed', { message: action.error })}</span> : null}
    </Banner>
  );
});

function turnEndText(event: ConversationEventOf<'turn.finished'>): string {
  switch (event.outcome) {
    case 'interrupted':
      return event.stoppedBy === undefined ? t('turn.interrupted') : t('turn.interruptedBy', { name: event.stoppedBy.displayName });
    case 'max-turns':
      return t('turn.max-turns');
    case 'budget':
      return t('turn.budget');
    default:
      return t('turn.error');
  }
}

const TurnEndRow = memo(function TurnEndRow({ item }: { item: TurnEndItem }) {
  return (
    <p className={cx('conv-sys', item.event.outcome !== 'interrupted' && 'conv-sys--problem')} data-outcome={item.event.outcome}>
      <span>
        {turnEndText(item.event)} {'·'} <Time at={item.event.at} />
      </span>
    </p>
  );
});

/** One item of the folded list as its row. `latestPointers`: the `seq` of the newest pointer of each target. */
export function renderRow(item: RenderItem, latestPointers: ReadonlySet<number>): ReactNode {
  switch (item.kind) {
    case 'message':
      return <MessageRow item={item} />;
    case 'smurg':
      return <SmurgRow item={item} />;
    case 'text':
    case 'streaming':
    case 'tool':
    case 'reads':
      return renderPiece(item);
    case 'card':
      if (item.card === 'question') return <QuestionCard questionId={item.id} />;
      if (item.card === 'permission') return <PermissionCard requestId={item.id} />;
      return <SuggestionCard suggestionId={item.id} />;
    case 'pointer':
      return <NextStepCard event={item.event} latest={latestPointers.has(item.seq)} />;
    case 'line':
      return <LineRow item={item} />;
    case 'notice':
      return <NoticeRow item={item} />;
    case 'turn-end':
      return <TurnEndRow item={item} />;
  }
}

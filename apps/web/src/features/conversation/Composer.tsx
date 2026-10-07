// The composer of a conversation column (UX §4, DESIGN §5.12 item 11). It follows the role of whoever looks:
//   host, Agent access → a message to the agent (`session.message.send`);
//   Editor             → the same box sends a suggestion (`suggest.create`), with the line saying whom it goes to;
//   Viewer             → no box, one sentence.
// Enter sends, never while an input method is composing; "@" offers the members; a text that could not be sent stays
// in the box with the reason under it; unsent text is kept per session in this browser (drafts.ts).
import { useEffect, useId, useRef, useState } from 'react';
import { MESSAGE_TEXT_MAX_CHARS, SUGGESTION_TEXT_MAX_CHARS, type AgentSession } from '@smurg/protocol';
import { useColumn } from '../../lib/columns/context.tsx';
import { describeError } from '../../lib/errors.ts';
import { formatAnd, formatRole } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { sessionTitle } from '../../lib/stores/sessions.ts';
import { useCapabilities, useCommands, useConnectionState, useStores, useWorkspaceSession } from '../../lib/workspace/context.tsx';
import { Button, IconButton, cx } from '../../ui/index.ts';
import { IconClose, IconEye, IconInfo, IconLightbulb, IconSend } from '../../ui/icons.tsx';
import { EMPTY_DRAFT, draftsOf } from './drafts.ts';
import { useConversationEnv } from './env.tsx';
import { MentionField } from './MentionField.tsx';
import { mentionsIn, personOf, withAgentAccess } from './people.ts';
import { t } from './strings.ts';
import { lineRange } from './text.ts';

/** The width below which a column shortens what it shows (features/columns/columns.css: `@container column (max-width: 430px)`). */
const NARROW_COLUMN_PX = 430;

/**
 * Whether the column `node` stands in is narrow. A placeholder is an attribute, so the container query that shortens
 * the column's header cannot shorten it: the composer measures. False where nothing is laid out or measured.
 */
function useNarrowColumn(node: HTMLElement | null): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (node === null || typeof ResizeObserver === 'undefined') {
      setNarrow(false);
      return;
    }
    const column = node.closest<HTMLElement>('.col') ?? node;
    const measure = (): void => setNarrow(column.clientWidth > 0 && column.clientWidth <= NARROW_COLUMN_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, [node]);
  return narrow;
}

export interface ComposerProps {
  readonly session: AgentSession;
}

export function Composer({ session }: ComposerProps) {
  const stores = useStores();
  const caps = useCapabilities();
  const commands = useCommands();
  const column = useColumn();
  const workspace = useWorkspaceSession();
  const connection = useConnectionState();
  const { self, role, people } = useConversationEnv();
  const sessionId = session.id;
  const drafts = draftsOf(workspace, workspace.workspaceId);
  const draft = useStore(drafts, (state) => state.get(sessionId)) ?? EMPTY_DRAFT;
  const box = useRef<HTMLTextAreaElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const narrow = useNarrowColumn(root);
  const hintId = useId();
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  // Something outside put text here ("Send to agent" from the editor): the box takes the focus.
  const focusToken = draft.focusToken;
  useEffect(() => {
    if (focusToken > 0) box.current?.focus();
  }, [focusToken]);

  if (session.status === 'ended') {
    return (
      <div className="conv-composer conv-composer--off">
        <IconInfo size={14} />
        <span>{t('composer.ended')}</span>
      </div>
    );
  }
  const drive = caps.canDrive;
  const suggest = !drive && caps.can('suggest.create');
  if (!drive && !suggest) {
    return (
      <div className="conv-composer conv-composer--off">
        <IconEye size={14} />
        <span>{t('composer.viewer')}</span>
      </div>
    );
  }

  const offline = connection.kind !== 'online';
  // The box names the session one writes to (DESIGN §5.12 item 11). "Discussion" is the same word in every topic:
  // a discussion is named with its topic, as its column is. In a narrow column the header of a discussion keeps the
  // topic's name and drops the word; the box shows the same, so the name that tells two discussions apart is not the
  // part that is cut. The box's accessible name stays whole.
  const name = sessionTitle(session);
  const inTopic = session.purpose === 'discussion' && session.topicName !== undefined ? session.topicName : null;
  const sentence = (title: string): string => (drive ? t('composer.message', { title }) : t('composer.suggest', { title }));
  const label = sentence(inTopic === null ? name : t('composer.inTopic', { title: name, topic: inTopic }));
  const placeholder = inTopic !== null && narrow ? sentence(inTopic) : label;
  const max = drive ? MESSAGE_TEXT_MAX_CHARS : SUGGESTION_TEXT_MAX_CHARS;
  const text = draft.text;

  const send = (): void => {
    if (sending || offline) return;
    setSaid(null);
    if (text.trim() === '') {
      setProblem(t('composer.blank'));
      return;
    }
    if (text.length > max) {
      setProblem(t('composer.tooLong', { max }));
      return;
    }
    setProblem(null);
    setSending(true);
    const mentions = mentionsIn(text, people);
    const request = drive
      ? stores.conversations.send(sessionId, text, { mentions, ...(draft.source === null ? {} : { origin: 'selection' as const }) })
      : stores.suggestions.create({ sessionId, text, ...(draft.source === null ? {} : { source: draft.source }), ...(mentions.length > 0 ? { mentions } : {}) });
    request.then(
      () => {
        // Only what was sent goes: text typed while the request was on its way stays.
        if (drafts.get(sessionId).text === text) drafts.clear(sessionId);
        if (!drive) setSaid(t('composer.suggested'));
        setSending(false);
      },
      (error: unknown) => {
        setProblem(t('composer.failed', { message: describeError(error) }));
        setSending(false);
      },
    );
  };

  // Where a suggestion goes, in words.
  let hint: string;
  if (offline) hint = t('composer.offline');
  else if (drive) {
    if (session.status === 'waiting-answer') hint = t('composer.hint.question');
    else if (session.status === 'running' || session.status === 'starting') hint = t('composer.hint.working');
    else hint = t('composer.hint');
  } else {
    const helpers = withAgentAccess(people);
    const responsible = personOf(people, session.responsible?.userId);
    const names = formatAnd(helpers.map((person) => person.displayName));
    if (session.responsible !== null && session.responsible.userId === self?.userId) hint = helpers.length > 0 ? t('composer.goes.responsible', { names }) : t('composer.goes.nobody');
    else if (session.responsible !== null && (responsible === undefined || withAgentAccess([responsible]).length > 0)) hint = t('composer.goes.one', { name: session.responsible.displayName });
    else if (helpers.length === 1) hint = t('composer.goes.one', { name: (helpers[0] as { displayName: string }).displayName });
    else if (helpers.length > 1) hint = t('composer.goes.many', { names });
    else hint = t('composer.goes.nobody');
  }

  const source = draft.source;
  return (
    <div ref={setRoot} className={cx('conv-composer', column.focused && 'conv-composer--focused')} data-mode={drive ? 'message' : 'suggestion'}>
      {source !== null ? (
        <div className="conv-composer__quote">
          <button
            type="button"
            className="conv-link"
            title={t('composer.source.open', { path: source.file.path, line: source.startLine })}
            onClick={() => {
              void commands.dispatch('openInCodeMode', { root: source.file.root, file: source.file.path, line: source.startLine, sessionId }).catch(() => {});
            }}
          >
            {source.startLine === source.endLine
              ? t('composer.sourceLine', { path: source.file.path, line: source.startLine })
              : t('composer.source', { path: source.file.path, range: lineRange(source.startLine, source.endLine) })}
          </button>
          <IconButton size="sm" label={t('composer.source.remove')} icon={<IconClose />} onClick={() => drafts.setSource(sessionId, null)} />
        </div>
      ) : null}
      <div className="conv-composer__box">
        <MentionField
          ref={box}
          className="conv-composer__input"
          value={text}
          onChange={(value) => {
            drafts.setText(sessionId, value);
            if (problem !== null) setProblem(null);
          }}
          onSubmit={send}
          label={label}
          placeholder={placeholder}
          disabled={offline}
          describedBy={hintId}
        />
        {drive ? (
          <IconButton className="conv-composer__send" variant="secondary" label={t('composer.send')} icon={<IconSend />} disabled={offline || sending} onClick={send} />
        ) : (
          // In a narrow column only its icon shows (conversation.css): the row belongs to the box, whose placeholder
          // names the session one is about to write to (DESIGN §5.12 item 11). The label stays its name.
          <Button className="conv-composer__suggest" variant="primary" icon={<IconLightbulb />} loading={sending} disabled={offline} title={t('composer.sendSuggestion')} onClick={send}>
            {t('composer.sendSuggestion')}
          </Button>
        )}
      </div>
      <div className="conv-composer__hint">
        <span id={hintId}>{hint}</span>
        {drive || role === null ? null : <span>{formatRole(role)}</span>}
      </div>
      {problem !== null ? (
        <p className="conv-card__problem" role="alert">
          {problem}
        </p>
      ) : null}
      {said !== null ? (
        <p className="conv-composer__said" role="status">
          {said}
        </p>
      ) : null}
    </div>
  );
}

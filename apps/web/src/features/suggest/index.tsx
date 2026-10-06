// The suggestions panel under the agents panel (SPEC R6). It follows the session the agents panel shows
// (sessions.focusedId). Protocol v2: the host and members with agent access type into ANY session and decide on its
// suggestions (`session.drive`); editors suggest; viewers watch.
//  - a member who may type → the queue of pending suggestions of that session, to accept / edit then accept / reject;
//  - an editor → the composer (the terminal above is read-only for them);
//  - always → what you proposed, with edit / withdraw while pending and the outcome afterwards.
// It also handles the editor's `sendSelectionAsSuggestion`: into a session the member may type into, the selection is
// pasted as input (bracketed paste, no Enter); otherwise it becomes a suggestion draft. Nothing here, or anywhere,
// accepts a suggestion automatically.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EXEC_INPUT_MAX_BYTES, type SessionInfo } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { sessionTitle } from '../../lib/stores/sessions.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { useCan, useCapabilities, useCommandHandler, useCommands, useStores } from '../../lib/workspace/context.tsx';
import { useWorkbenchLayout } from '../../lib/workspace/layout.tsx';
import { Badge, EmptyState, IconButton, Panel, useToast } from '../../ui/index.ts';
import { IconChevronDown, IconChevronUp, IconLightbulb } from '../../ui/icons.tsx';
import { AuthoredList } from './AuthoredList.tsx';
import { Composer, EMPTY_DRAFT, type ComposerDraft } from './Composer.tsx';
import { OwnerQueue } from './OwnerQueue.tsx';
import { SendSelectionDialog } from './SendSelectionDialog.tsx';
import { t } from './strings.ts';
import { bracketedPaste, quoteSelection, sourceOf, type SelectionPayload } from './text.ts';
import { useResolutionNotices } from './use-resolution-notices.ts';
import './suggest.css';

export type SuggestionsPanelProps = Record<never, never>;

/** Relative times refresh this often. */
const CLOCK_TICK_MS = 30_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function SuggestionsPanel(_props: SuggestionsPanelProps) {
  const stores = useStores();
  const commands = useCommands();
  const toast = useToast();
  const canSuggest = useCan('suggest.create');
  const canDrive = useCapabilities().canDrive;
  const userId = useStore(stores.workspace, selectUserId);
  const sessionsState = useStore(stores.sessions);
  const suggestionsState = useStore(stores.suggestions);
  const now = useNow();
  const layout = useWorkbenchLayout();
  useResolutionNotices(userId);

  const sessions = sessionsState.sessions;
  const focused: SessionInfo | null = (sessionsState.focusedId !== null ? sessions.get(sessionsState.focusedId) : undefined) ?? null;

  const [drafts, setDrafts] = useState<ReadonlyMap<string, ComposerDraft>>(new Map());
  /** The composer of `sessionId` takes focus once (a selection was just put into its draft). */
  const [focusRequest, setFocusRequest] = useState<{ readonly sessionId: string; readonly token: number } | null>(null);
  const [choosing, setChoosing] = useState<SelectionPayload | null>(null);

  const setDraft = useCallback((sessionId: string, draft: ComposerDraft) => {
    setDrafts((previous) => {
      const next = new Map(previous);
      if (draft.text === '' && draft.source === null) next.delete(sessionId);
      else next.set(sessionId, draft);
      return next;
    });
  }, []);

  // Pending suggestions this member decides on (any session, for the host and members with agent access): the focused session's are
  // the queue, the others are pointed to.
  const pendingMine = useMemo(() => {
    const counts = new Map<string, number>();
    if (!canDrive) return counts;
    for (const suggestion of suggestionsState.suggestions.values()) {
      if (suggestion.status !== 'pending' || !sessions.has(suggestion.sessionId)) continue;
      counts.set(suggestion.sessionId, (counts.get(suggestion.sessionId) ?? 0) + 1);
    }
    return counts;
  }, [suggestionsState, sessions, canDrive]);
  const pendingTotal = [...pendingMine.values()].reduce((sum, n) => sum + n, 0);
  const othersPending = pendingTotal - (focused !== null ? (pendingMine.get(focused.id) ?? 0) : 0);

  const running = useMemo(
    () =>
      [...sessions.values()]
        .filter((session) => session.status !== 'exited')
        .sort((a, b) => Number(b.openedBy.userId === userId) - Number(a.openedBy.userId === userId) || a.createdAt - b.createdAt),
    [sessions, userId],
  );

  const showPanel = (panel: 'agents' | 'suggestions'): void => {
    commands.dispatch('showPanel', { panel }).catch(() => {
      // no layout (tests)
    });
  };

  const deliver = (selection: SelectionPayload, sessionId: string, mode: 'send' | 'draft' = 'draft'): void => {
    const session = stores.sessions.getState().sessions.get(sessionId);
    if (!session) {
      toast.show({ tone: 'warning', title: t('send.missing') });
      return;
    }
    if (session.status === 'exited') {
      toast.show({ tone: 'warning', title: t('send.exited') });
      return;
    }
    if (canDrive) {
      // A session this member may type into (any, for the host and members with agent access): typed in as a paste, like a terminal
      // would; they review it and press Enter.
      const bytes = bracketedPaste(selection.text);
      if (bytes.byteLength > EXEC_INPUT_MAX_BYTES) {
        toast.show({ tone: 'warning', title: t('send.tooLong') });
        return;
      }
      try {
        stores.sessions.input(session.id, bytes);
      } catch (error) {
        toast.show({ tone: 'danger', title: t('send.failed', { message: describeError(error) }) });
        return;
      }
      stores.sessions.focus(session.id);
      showPanel('agents');
      toast.show({ tone: 'info', title: t('send.pasted', { title: sessionTitle(session) }) });
      return;
    }
    if (!canSuggest) {
      toast.show({ tone: 'warning', title: t('send.viewer') });
      return;
    }
    const quote = quoteSelection(selection);
    if (mode === 'send') {
      // One click: the quoted selection becomes a pending suggestion (the owner still decides).
      const source = sourceOf(selection);
      stores.suggestions.create({ sessionId: session.id, text: quote, ...(source ? { source } : {}) }).then(
        () => toast.show({ tone: 'success', title: t('composer.sent') }),
        (error: unknown) => toast.show({ tone: 'danger', title: t('send.suggestFailed', { message: describeError(error) }) }),
      );
      stores.sessions.focus(session.id);
      return;
    }
    // A session this member may not type into: a draft to complete and send (the host or a member with agent access decides).
    const previous = drafts.get(session.id) ?? EMPTY_DRAFT;
    setDraft(session.id, {
      text: previous.text.trim() === '' ? quote : `${previous.text.replace(/\s*$/u, '')}\n\n${quote}`,
      source: sourceOf(selection) ?? previous.source,
    });
    stores.sessions.focus(session.id);
    showPanel('suggestions');
    setFocusRequest((previous) => ({ sessionId: session.id, token: (previous?.token ?? 0) + 1 }));
  };

  useCommandHandler('sendSelectionAsSuggestion', (payload) => {
    const selection: SelectionPayload = { file: payload.file, startLine: payload.startLine, endLine: payload.endLine, text: payload.text };
    if (payload.sessionId === undefined) setChoosing(selection);
    else deliver(selection, payload.sessionId, payload.mode ?? 'draft');
  });

  let main;
  if (focused === null) {
    main = <EmptyState compact icon={<IconLightbulb />} title={t('empty.noSession')} />;
  } else if (canDrive) {
    main = (
      <OwnerQueue
        session={focused}
        now={now}
        othersPending={othersPending}
        onShowOthers={() => {
          const next = [...pendingMine.keys()].find((id) => id !== focused.id);
          if (next !== undefined) stores.sessions.focus(next);
        }}
      />
    );
  } else if (canSuggest) {
    main = (
      <Composer
        key={focused.id}
        session={focused}
        draft={drafts.get(focused.id) ?? EMPTY_DRAFT}
        onChange={(draft) => setDraft(focused.id, draft)}
        focusToken={focusRequest?.sessionId === focused.id ? focusRequest.token : 0}
        onFocused={() => setFocusRequest(null)}
      />
    );
  } else {
    main = <p className="suggest-note">{t('composer.viewer')}</p>;
  }

  return (
    <Panel
      title={t('title')}
      icon={<IconLightbulb />}
      className="suggest-panel"
      actions={
        pendingTotal > 0 || layout !== null ? (
          <>
            {pendingTotal > 0 ? <Badge tone="info">{pendingTotal}</Badge> : null}
            {layout !== null ? (
              <IconButton
                size="sm"
                label={layout.suggestions ? t('layout.collapse') : t('layout.expand')}
                icon={layout.suggestions ? <IconChevronDown /> : <IconChevronUp />}
                aria-expanded={layout.suggestions}
                onClick={() => layout.toggle('suggestions')}
              />
            ) : null}
          </>
        ) : undefined
      }
    >
      <div className="suggest-body">
        {main}
        {userId !== null ? <AuthoredList userId={userId} sessions={sessions} now={now} /> : null}
      </div>
      <SendSelectionDialog
        selection={choosing}
        sessions={running}
        canDrive={canDrive}
        canSuggest={canSuggest}
        onClose={() => setChoosing(null)}
        onChoose={(sessionId) => {
          const selection = choosing;
          setChoosing(null);
          if (selection) deliver(selection, sessionId);
        }}
      />
    </Panel>
  );
}

// "Changed by this session" above the file tree (DESIGN §5.6, UX §8): the files the agent session beside the editor
// changed with its edit tools, newest change first; a click opens the file in the editor. Which session that is comes
// from the columns store (`code.sessionId`: the selector of code mode's side column, or "Open in editor" from a
// conversation); the files come from the session's conversation (`selectChangedFiles`: its edit tool cards inside the
// loaded window).
//
// The list holds its own watch of the conversation (not live: it needs no streaming text), so it also fills in while
// the side column is closed. Nothing is shown for a terminal or while no session is chosen.
import { fileRefKey, rootRefEquals, type FileRef, type RootRef } from '@smurg/protocol';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../lib/store.ts';
import { selectChangedFiles, selectConversation } from '../../lib/stores/conversations.ts';
import { selectSession, sessionTitle } from '../../lib/stores/sessions.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { IconChevronDown, IconChevronRight, IconFileText } from '../../ui/icons.tsx';
import { t } from './strings.ts';

export interface ChangedBySessionProps {
  /** The root the tree shows: a file of another root says so. */
  readonly root: RootRef;
  /** The file the editor shows, for the current mark. */
  readonly activeFile: FileRef | undefined;
  onOpen(file: FileRef): void;
}

export function ChangedBySession({ root, activeFile, onOpen }: ChangedBySessionProps) {
  const stores = useStores();
  const sessionId = useStore(stores.columns, (state) => state.code.sessionId);
  const session = useStore(stores.sessions, (state) => (sessionId === null ? undefined : selectSession(state, sessionId)));
  const agentSessionId = session?.kind === 'agent' ? session.id : null;
  const conversation = useStore(stores.conversations, (state) => (agentSessionId === null ? undefined : selectConversation(state, agentSessionId)));
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (agentSessionId === null) return;
    return stores.conversations.watch(agentSessionId, { live: false });
  }, [stores.conversations, agentSessionId]);

  const changed = useMemo(() => (conversation === undefined ? [] : selectChangedFiles(conversation)), [conversation]);

  if (session === undefined || agentSessionId === null) return null;

  const title = sessionTitle(session);
  return (
    <section className="files-changed" aria-label={t('changed.label', { session: title })}>
      <button type="button" className="files-changed__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span aria-hidden="true">{open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
        <span className="files-changed__title">{t('changed.title')}</span>
        <span className="files-changed__count">{changed.length}</span>
      </button>
      {open ? (
        <>
          <p className="files-changed__session" title={title}>
            {title}
          </p>
          {changed.length === 0 ? (
            <p className="files-changed__empty">{t('changed.empty')}</p>
          ) : (
            <ul className="files-changed__list">
              {changed.map((file) => {
                const elsewhere = !rootRefEquals(file.root, root);
                return (
                  <li key={fileRefKey(file)}>
                    <button
                      type="button"
                      className="files-changed__file"
                      aria-current={activeFile !== undefined && fileRefKey(activeFile) === fileRefKey(file) ? 'true' : undefined}
                      title={elsewhere ? t('changed.otherRoot', { path: file.path }) : file.path}
                      onClick={() => onOpen(file)}
                    >
                      <IconFileText size={12} aria-hidden="true" />
                      <span className="files-changed__path">{file.path}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

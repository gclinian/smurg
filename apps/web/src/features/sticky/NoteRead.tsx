// The open sticky note (DESIGN 0.8.0 D7.5, D7.6): the note in the address, drawn as one sticky note and read as
// Markdown with its wiki links, or the page of a note that is not written yet, or the first page while there is no
// Home. Only a note the index lists is held as a shared document (a name typed into the address never asks the host
// to open a file that is not there), keyed by its folded name, so a quick switch from one note to the next releases
// each one as it goes. A line says when Claude holds the note's lock.
import { NOTES_HOME, fileRefKey, type NoteInfo } from '@smurg/protocol';
import { useEffect, useId, useMemo } from 'react';
import { useAppServices } from '../../app/services.tsx';
import { routePath } from '../../lib/router.ts';
import { useStore } from '../../lib/store.ts';
import { selectNote, type StickyState } from '../../lib/stores/sticky.ts';
import { useStores, useWorkspaceSession } from '../../lib/workspace/context.tsx';
import { Button, Spinner } from '../../ui/index.ts';
import { IconAgent } from '../../ui/icons.tsx';
import { useDocumentText, useHeldDocument } from '../editor/standalone.tsx';
import { Markdown, type MarkdownWikiLinks } from '../markdown/index.ts';
import { HOME_KEY, findWikiLinks, noteFile, noteKey } from './model.ts';
import { NoPage } from './NoPage.tsx';
import { t } from './strings.ts';
import './sticky.css';

/** The index of the sticky notes: asked for when the first part of the notes view mounts (D7.3), then kept current. */
export function useStickyIndex(): StickyState {
  const stores = useStores();
  useEffect(() => {
    // A failure is kept in the store (its `error`), where the view shows it with "Try again".
    stores.sticky.want().catch(() => {});
  }, [stores]);
  return useStore(stores.sticky);
}

/** Where a sticky note's page is, and a way there that does not load the page again. */
export function useNoteNavigation(): { href(name: string): string; open(name: string, options?: { replace?: boolean }): void } {
  const { router } = useAppServices();
  const { workspaceId } = useWorkspaceSession();
  return useMemo(() => {
    const href = (name: string): string => routePath({ name: 'notes', workspaceId, note: name });
    return { href, open: (name, options) => router.navigate(href(name), options) };
  }, [router, workspaceId]);
}

/** The renderer's wiki links: a new object whenever the set of notes changes, so that every link is drawn again. */
function useWikiLinks(): MarkdownWikiLinks {
  const stores = useStores();
  const notes = useStore(stores.sticky, (state) => state.notes);
  const navigation = useNoteNavigation();
  return useMemo(() => {
    const onDisk = (name: string): string => notes.get(noteKey(name))?.name ?? name;
    return {
      find: findWikiLinks,
      exists: (name) => notes.has(noteKey(name)),
      href: (name) => navigation.href(onDisk(name)),
      open: (name) => navigation.open(onDisk(name)),
    };
  }, [notes, navigation]);
}

export interface OpenNoteProps {
  /** The note in the address; undefined: Home. */
  readonly note: string | undefined;
}

/** The middle of the notes view: the note in the address, or the page that stands in for it. */
export function OpenNote({ note }: OpenNoteProps) {
  const stores = useStores();
  const index = useStickyIndex();
  const navigation = useNoteNavigation();
  const name = note ?? NOTES_HOME;
  const info = selectNote(index, name);
  const onDisk = info?.name;

  // The address takes the name as it is on disk: `/notes/home` shows Home, and says Home.
  useEffect(() => {
    if (note !== undefined && onDisk !== undefined && onDisk !== note) navigation.open(onDisk, { replace: true });
  }, [note, onDisk, navigation]);

  if (index.status === 'error') {
    return (
      <div className="sticky-page">
        <p className="sticky-page__line" role="alert">
          {t('load.failed', { reason: index.error ?? '' })}
        </p>
        <Button size="sm" onClick={() => void stores.sticky.reload().catch(() => {})}>
          {t('load.retry')}
        </Button>
      </div>
    );
  }
  if (index.status !== 'ready') {
    return (
      <div className="sticky-page">
        <p className="sticky-page__line">
          <Spinner size={14} decorative />
          <span>{t('loading')}</span>
        </p>
      </div>
    );
  }
  if (info === undefined) return noteKey(name) === HOME_KEY ? <NoPage kind="first" name={NOTES_HOME} /> : <NoPage kind="missing" name={name} />;
  return <NoteRead key={noteKey(info.name)} note={info} />;
}

/** A sticky note the index lists, read: its text as Markdown with its links, live as people and Claude write it. */
export function NoteRead({ note }: { note: NoteInfo }) {
  const stores = useStores();
  const headingId = useId();
  const file = useMemo(() => noteFile(note.name), [note.name]);
  // A file the index could not read as a member without rights is not asked for (D2.2).
  const held = useHeldDocument(note.unreadable === true ? null : file);
  const text = useDocumentText(held?.session);
  const agentWriting = useStore(stores.locks, (state) => state.locks.get(fileRefKey(file))?.kind === 'agent');
  const wikiLinks = useWikiLinks();

  let body;
  if (note.unreadable === true) body = <p className="sticky-card__quiet">{t('note.unreadable')}</p>;
  else if (text === null) {
    body =
      held?.doc?.status === 'error' ? (
        <p className="sticky-card__quiet" role="alert">
          {t('note.openFailed')}
        </p>
      ) : (
        <p className="sticky-card__quiet">
          <Spinner size={14} decorative />
          <span>{t('note.loading')}</span>
        </p>
      );
  } else if (text.trim() === '') body = <p className="sticky-card__quiet">{t('note.empty')}</p>;
  else body = <Markdown text={text} headingBase={3} wikiLinks={wikiLinks} className="sticky-card__text" />;

  return (
    <article className="sticky-page" aria-labelledby={headingId}>
      <div className="sticky-card" data-note={note.name}>
        <h2 id={headingId} className="sticky-card__name" tabIndex={-1} data-region-focus>
          {note.name}
        </h2>
        {agentWriting ? (
          <p className="sticky-card__lock" role="status">
            <IconAgent size={14} />
            <span>{t('note.agentWriting')}</span>
          </p>
        ) : null}
        <div className="sticky-card__body">{body}</div>
      </div>
      {note.oversized === true ? <p className="sticky-page__aside">{t('note.oversized')}</p> : null}
    </article>
  );
}

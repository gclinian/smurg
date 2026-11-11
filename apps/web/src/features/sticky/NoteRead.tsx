// The open sticky note (DESIGN 0.8.0 D7.5, D7.6): the note in the address, drawn as one sticky note and read as
// Markdown with its wiki links, or the page of a note that is not written yet, or the first page while there is no
// Home. Only a note the index lists is held as a shared document (a name typed into the address never asks the host
// to open a file that is not there), keyed by its folded name, so a quick switch from one note to the next releases
// each one as it goes. A line says when Claude holds the note's lock.
//
// Above the text, for a member who may write: Read / Edit (the shared editor of that one note, NoteEdit.tsx) and
// "Add a sticky note" (AddNote.tsx, only while the note takes a change); for a member with a box in Claude's
// conversation, "Ask Claude about this sticky note" (the notes view puts the link into that box, D7.7); for a member
// who may start sessions, "Build this" (BuildDialog.tsx, D5.3), held while Claude writes the note or a change to it is
// not saved yet (the daemon reads the file on disk), and the topics already made from the note, each a way to its plan
// (D2.4 `builds`). A Viewer reads, and has none of them. Under the note, for everyone: its feedback and the box "Give
// feedback" (Feedback.tsx, D7.8).
import { NOTES_HOME, fileRefKey, type NoteInfo } from '@smurg/protocol';
import { useEffect, useId, useMemo, useState } from 'react';
import { useAppServices } from '../../app/services.tsx';
import { describeError } from '../../lib/errors.ts';
import { routePath } from '../../lib/router.ts';
import { useStore } from '../../lib/store.ts';
import { selectNote, type StickyState } from '../../lib/stores/sticky.ts';
import { selectTopic } from '../../lib/stores/topics.ts';
import { useCan, useCommand, useStores, useWorkspaceSession } from '../../lib/workspace/context.tsx';
import { Button, Segmented, Spinner } from '../../ui/index.ts';
import { IconAgent, IconComment, IconEdit, IconEye, IconPlan } from '../../ui/icons.tsx';
import { useDocumentText, useHeldDocument, useHeldDocumentWritable, type HeldDocument } from '../editor/standalone.tsx';
import { Markdown, type MarkdownWikiLinks } from '../markdown/index.ts';
import { AddNote } from './AddNote.tsx';
import { BuildDialog } from './BuildDialog.tsx';
import { NoteFeedback } from './Feedback.tsx';
import { HOME_KEY, findWikiLinks, noteFile, noteKey } from './model.ts';
import { NoteEdit } from './NoteEdit.tsx';
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
  /** The note in the address (hidden: the note it showed last); undefined: Home. */
  readonly note: string | undefined;
  /** The notes view is on screen: the address is its own. */
  readonly shown: boolean;
  /**
   * "Ask Claude about this sticky note": the view puts the note's link into the box of Claude's conversation (D7.7).
   * Absent: no button (Claude for the sticky notes is not running, or this member has no box there).
   */
  readonly onAskClaude?: (name: string) => void;
}

/** The middle of the notes view: the note in the address, or the page that stands in for it. */
export function OpenNote({ note, shown, onAskClaude }: OpenNoteProps) {
  const stores = useStores();
  const index = useStickyIndex();
  const navigation = useNoteNavigation();
  const name = note ?? NOTES_HOME;
  const info = selectNote(index, name);
  const onDisk = info?.name;

  // The address takes the name as it is on disk: `/notes/home` shows Home, and says Home. While another view is on
  // screen the address is that view's: only the note to come back to takes the name on disk (review S3-R2).
  useEffect(() => {
    if (note === undefined || onDisk === undefined || onDisk === note) return;
    if (shown) navigation.open(onDisk, { replace: true });
    else stores.sticky.setLastOpen(onDisk);
  }, [note, onDisk, shown, navigation, stores]);

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
  return <NoteRead key={noteKey(info.name)} note={info} {...(onAskClaude === undefined ? {} : { onAskClaude })} />;
}

type View = 'read' | 'edit';

const NO_SESSION = { getState: (): { readonly pendingSave: boolean } | undefined => undefined, subscribe: () => () => {} };

/**
 * Whether "Build this" waits (D5.3 in the plan's words: held while the note is agent-locked or has an unsaved change):
 * Claude holds the note's lock, a person's typing holds it (their change is not on the host's disk yet), or this
 * page's own change is not saved. The daemon builds from the file on disk, so the text shown would not be the text
 * typed.
 */
function useBuildHeld(held: HeldDocument | null, lockKey: string): boolean {
  const stores = useStores();
  const locked = useStore(stores.locks, (state) => state.locks.get(lockKey) !== undefined);
  const unsaved = useStore(held?.session ?? NO_SESSION, (state) => state?.pendingSave === true);
  return locked || unsaved;
}

/**
 * The topics made from this note (D2.4), newest first, each a way to its plan. The host names only topics that are
 * there, open or archived (D5.4); the page holds the archived ones only once they are shown ("Show archived topics",
 * the sessions list's own), so while it holds every open topic, one it does not hold is archived: counted here, with
 * the way to show them, never left out without a word. Before the topics are loaded nothing is known, and nothing said.
 */
function NoteBuilds({ builds }: { builds: readonly string[] }) {
  const stores = useStores();
  const openColumn = useCommand('openColumn');
  const titleId = useId();
  const topics = useStore(stores.topics, (state) => state);
  const [archive, setArchive] = useState<{ readonly loading: boolean; readonly error: string | null }>({ loading: false, error: null });
  const known = builds.flatMap((topicId) => {
    const topic = selectTopic(topics, topicId);
    return topic === undefined ? [] : [topic];
  });
  const notShown = topics.status === 'ready' && topics.archived === null ? builds.length - known.length : 0;
  if (known.length === 0 && notShown === 0) return null;
  const showArchived = (): void => {
    setArchive({ loading: true, error: null });
    stores.topics.loadArchived().then(
      () => setArchive({ loading: false, error: null }),
      (error: unknown) => setArchive({ loading: false, error: describeError(error) }),
    );
  };
  return (
    <section className="sticky-card__builds" aria-labelledby={titleId}>
      <h3 id={titleId} className="sticky-card__builds-title">
        {t('builds.title')}
      </h3>
      {known.length > 0 ? (
        <ul className="sticky-card__builds-list">
          {known.map((topic) => (
            <li key={topic.id}>
              <IconPlan size={14} />
              <button type="button" className="sticky-card__topic" title={t('builds.open', { name: topic.name })} onClick={() => void openColumn({ target: { kind: 'plan', topicId: topic.id } })}>
                {topic.name}
              </button>
              <span className="sticky-card__builds-folder">{`specs/${topic.slug}`}</span>
              {topic.archived ? <span className="sticky-card__builds-archived">{t('builds.archivedMark')}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {notShown > 0 ? (
        <div className="sticky-card__builds-more">
          <span className="sticky-card__quiet">{t('builds.archived', { count: notShown })}</span>
          <button type="button" className="sticky-card__topic" disabled={archive.loading} onClick={showArchived}>
            {t('builds.showArchived')}
          </button>
          {archive.loading ? <Spinner size={14} decorative /> : null}
        </div>
      ) : null}
      {notShown > 0 && archive.error !== null ? (
        <p className="sticky-card__problem" role="alert">
          {t('builds.archivedFailed', { reason: archive.error })}
        </p>
      ) : null}
    </section>
  );
}

/** A sticky note the index lists, read: its text as Markdown with its links, live as people and Claude write it. */
export function NoteRead({ note, onAskClaude }: { note: NoteInfo; onAskClaude?: (name: string) => void }) {
  const stores = useStores();
  const headingId = useId();
  const canWrite = useCan('file.write');
  const canBuild = useCan('session.create');
  const file = useMemo(() => noteFile(note.name), [note.name]);
  // A file the index could not read as a member without rights is not asked for (D2.2).
  const held = useHeldDocument(note.unreadable === true ? null : file);
  const text = useDocumentText(held?.session);
  const writable = useHeldDocumentWritable(held);
  const agentWriting = useStore(stores.locks, (state) => state.locks.get(fileRefKey(file))?.kind === 'agent');
  const buildHeld = useBuildHeld(held, fileRefKey(file));
  const [building, setBuilding] = useState(false);
  const heldId = useId();
  const wikiLinks = useWikiLinks();
  const [view, setView] = useState<View>('read');
  const [edited, setEdited] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  // The editor is made the first time Edit is chosen, then kept (hidden) like a tab's.
  useEffect(() => {
    if (view === 'edit') setEdited(true);
  }, [view]);
  // A member who can no longer write (made a Viewer while editing) goes back to reading.
  const editing = view === 'edit' && canWrite && held !== null;
  useEffect(() => {
    if (view === 'edit' && !editing) setView('read');
  }, [view, editing]);

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

  const buildable = canBuild && held !== null;
  const tools =
    (canWrite && held !== null) || onAskClaude !== undefined || buildable ? (
      <div className="sticky-card__tools" role="group" aria-label={t('note.actions')}>
        {canWrite && held !== null ? (
          <Segmented<View>
            label={t('note.view')}
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { id: 'read', label: t('note.read'), icon: <IconEye size={14} /> },
              { id: 'edit', label: t('note.edit'), icon: <IconEdit size={14} /> },
            ]}
          />
        ) : null}
        {canWrite && held !== null ? <AddNote held={held} from={note.name} available={writable} onSaid={setSaid} /> : null}
        {onAskClaude !== undefined ? (
          <Button size="sm" variant="ghost" icon={<IconComment size={14} />} onClick={() => onAskClaude(note.name)}>
            {t('note.ask')}
          </Button>
        ) : null}
        {buildable ? (
          <Button size="sm" icon={<IconPlan size={14} />} disabled={buildHeld} aria-describedby={buildHeld ? heldId : undefined} onClick={() => setBuilding(true)}>
            {t('build.button')}
          </Button>
        ) : null}
      </div>
    ) : null;

  return (
    <article className="sticky-page" aria-labelledby={headingId}>
      <div className="sticky-card" data-note={note.name}>
        <h2 id={headingId} className="sticky-card__name" tabIndex={-1} data-region-focus>
          {note.name}
        </h2>
        {tools}
        {buildable && buildHeld ? (
          <p id={heldId} className="sticky-card__held">
            {t('build.held')}
          </p>
        ) : null}
        {note.builds !== undefined && note.builds.length > 0 ? <NoteBuilds builds={note.builds} /> : null}
        {agentWriting ? (
          <p className="sticky-card__lock" role="status">
            <IconAgent size={14} />
            <span>{t('note.agentWriting')}</span>
          </p>
        ) : null}
        <div className="sticky-card__body" hidden={editing}>
          {body}
        </div>
        {held !== null && edited && canWrite ? <NoteEdit held={held} active={editing} /> : null}
        {said !== null ? (
          <p className="sticky-card__said" role="status">
            {said}
          </p>
        ) : null}
      </div>
      {note.oversized === true ? <p className="sticky-page__aside">{t('note.oversized')}</p> : null}
      {buildable ? <BuildDialog note={note.name} open={building} onClose={() => setBuilding(false)} /> : null}
      <NoteFeedback note={note.name} box />
    </article>
  );
}

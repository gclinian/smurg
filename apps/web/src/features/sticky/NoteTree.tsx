// The list of sticky notes on the left of the notes view (DESIGN 0.8.0 D7.4): the tree grown from Home by the links
// (Home first, each note under the note that reached it first), then "Not linked", the notes Home does not reach, by
// name. A row with notes below opens its note like any row; its twisty only folds it. Which rows are unfolded lives
// in memory only (the view stays mounted); the open note's row is marked and the rows above it unfold. The open note's
// own row unfolds when "Add a sticky note" just linked a new note from it (model.ts unfoldRequestsOf).
//
// For a member who can decide feedback (`session.drive`, D7.8): each row says how much feedback waits on its note (a
// small count, and in the row's name), and a last group, "Feedback on sticky notes that are gone", lists the names
// with waiting feedback that the index does not hold (a note renamed, or its file gone); a row there opens that name's
// page, where the feedback can still be decided. Nobody else sees a count.
import { NOTES_HOME, NOTES_MAX } from '@smurg/protocol';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../../lib/store.ts';
import { INITIAL_STICKY_STATE, selectGoneNotes, selectNoteTree, selectWaitingCount, type GoneNote } from '../../lib/stores/sticky.ts';
import { useCapabilities, useStores } from '../../lib/workspace/context.tsx';
import { Button, Spinner, Tree, type TreeNode } from '../../ui/index.ts';
import { IconChevronRight } from '../../ui/icons.tsx';
import { HOME_KEY, ancestorsOf, homeRows, noteKey, notLinkedRows, unfoldRequestsOf, type NoteRow } from './model.ts';
import { useNoteNavigation, useStickyIndex } from './NoteRead.tsx';
import { t } from './strings.ts';
import './sticky.css';

/** How much feedback waits on a note, by name; null: this member sees no count. */
type WaitingOf = ((name: string) => number) | null;

function rowLabel(row: NoteRow): string {
  if (row.twinOf !== undefined) return t('row.shadowed', { name: row.name, note: row.twinOf });
  return row.unreadable ? t('row.unreadable', { name: row.name }) : row.name;
}

/** A row's name, with what waits on its note when there is some. */
const withWaiting = (label: string, count: number): string => (count > 0 ? t('row.waiting', { name: label, count }) : label);

function Count({ count }: { count: number }) {
  return count > 0 ? (
    <span className="sticky-row__count" aria-hidden="true">
      {count}
    </span>
  ) : null;
}

function toNode(row: NoteRow, selected: string, waitingOf: WaitingOf): TreeNode {
  const group = row.children !== undefined;
  // A fold twin is not read: what waits on its name is its note's.
  const waiting = waitingOf === null || row.twinOf !== undefined ? 0 : waitingOf(row.name);
  return {
    id: row.id,
    label: withWaiting(rowLabel(row), waiting),
    selected: row.id === selected,
    content: (
      <span className="sticky-row" style={{ '--sticky-depth': row.depth } as CSSProperties}>
        {group ? (
          <span className="sticky-row__twisty" data-tree-twisty aria-hidden="true">
            <IconChevronRight size={12} />
          </span>
        ) : (
          <span className="sticky-row__dot" aria-hidden="true" />
        )}
        <span className="sticky-row__name">{row.name}</span>
        {row.twinOf !== undefined ? <span className="sticky-row__mark">{t('row.shadowed.mark', { note: row.twinOf })}</span> : null}
        <Count count={waiting} />
      </span>
    ),
    ...(row.unreadable || row.twinOf !== undefined ? { data: { 'data-quiet': '' } } : {}),
    ...(group ? { children: (row.children ?? []).map((child) => toNode(child, selected, waitingOf)) } : {}),
  };
}

/** The key of a row of the group of names that are gone (never a note's key: the trees share their unfolded rows). */
const goneId = (name: string): string => `gone:${noteKey(name)}`;

function goneNode(gone: GoneNote, selected: string): TreeNode {
  return {
    id: goneId(gone.name),
    label: withWaiting(gone.name, gone.waiting),
    selected: noteKey(gone.name) === selected,
    content: (
      <span className="sticky-row" style={{ '--sticky-depth': 0 } as CSSProperties}>
        <span className="sticky-row__dot sticky-row__dot--gone" aria-hidden="true" />
        <span className="sticky-row__name">{gone.name}</span>
        <Count count={gone.waiting} />
      </span>
    ),
    data: { 'data-quiet': '' },
  };
}

export interface NoteTreeProps {
  /** The note in the address; undefined: Home. */
  readonly open: string | undefined;
}

export function NoteTree({ open }: NoteTreeProps) {
  const stores = useStores();
  const index = useStickyIndex();
  const tree = useStore(stores.sticky, selectNoteTree);
  const navigation = useNoteNavigation();
  const notLinkedId = useId();
  const goneHeadingId = useId();
  const openKey = noteKey(open ?? NOTES_HOME);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([HOME_KEY]));
  // Only a member who can decide feedback sees what waits (D7.8).
  const canDecide = useCapabilities().canDrive;
  const gone = useStore(stores.sticky, selectGoneNotes);
  // The counts read only the feedback: the rows are drawn again when it changes, not with every change of the store.
  const feedback = index.feedback;
  const waitingOf = useMemo<WaitingOf>(() => (canDecide ? (name: string) => selectWaitingCount({ ...INITIAL_STICKY_STATE, feedback }, name) : null), [canDecide, feedback]);

  // The rows above the open note unfold once for each note opened (a link followed from the note, an address typed
  // in), as soon as its row is in the tree. Afterwards the rows are the person's: a row folded above the open note
  // stays folded whatever else changes in the index (review S3-R3).
  const unfoldedFor = useRef<string | null>(null);
  useEffect(() => {
    if (unfoldedFor.current === openKey) return;
    const above = ancestorsOf(tree.home, open ?? NOTES_HOME);
    const inTree = openKey === HOME_KEY ? tree.home !== null : above.length > 0;
    if (!inTree) return;
    unfoldedFor.current = openKey;
    setExpanded((previous) => (above.every((key) => previous.has(key)) ? previous : new Set([...previous, ...above])));
  }, [tree.home, open, openKey]);

  // A row asked for from the open note (a sticky note just linked from it): unfolded, so the new row shows below it.
  useEffect(() => {
    const requests = unfoldRequestsOf(stores.sticky);
    return requests.subscribe(() => {
      const request = requests.getState();
      if (request !== null) setExpanded((previous) => (previous.has(request.key) ? previous : new Set([...previous, request.key])));
    });
  }, [stores]);

  const rows = useMemo(() => ({ home: homeRows(tree.home, index.notes), notLinked: notLinkedRows(tree.notLinked, index.notes) }), [tree, index.notes]);
  const names = useMemo(() => {
    const byId = new Map<string, string>();
    const visit = (row: NoteRow): void => {
      byId.set(row.id, row.name);
      for (const child of row.children ?? []) visit(child);
    };
    for (const row of [...rows.home, ...rows.notLinked]) visit(row);
    if (canDecide) for (const name of gone) byId.set(goneId(name.name), name.name);
    return byId;
  }, [rows, gone, canDecide]);
  const homeNodes = useMemo(() => rows.home.map((row) => toNode(row, openKey, waitingOf)), [rows, openKey, waitingOf]);
  const notLinkedNodes = useMemo(() => rows.notLinked.map((row) => toNode(row, openKey, waitingOf)), [rows, openKey, waitingOf]);
  const goneNodes = useMemo(() => (canDecide ? gone.map((name) => goneNode(name, openKey)) : []), [canDecide, gone, openKey]);

  const toggle = (id: string, on: boolean): void =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const openRow = (id: string): void => {
    const name = names.get(id);
    if (name !== undefined) navigation.open(name);
  };

  if (index.status === 'error') {
    return (
      <div className="sticky-tree">
        <p className="sticky-tree__line" role="alert">
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
      <div className="sticky-tree">
        <p className="sticky-tree__line">
          <Spinner size={14} label={t('loading')} />
        </p>
      </div>
    );
  }
  return (
    <div className="sticky-tree">
      {homeNodes.length > 0 ? (
        <Tree label={t('tree.label')} nodes={homeNodes} expanded={expanded} onToggle={toggle} onActivate={openRow} activatesGroups className="sticky-tree__tree" />
      ) : notLinkedNodes.length === 0 ? (
        <p className="sticky-tree__line">{t('tree.empty')}</p>
      ) : null}
      {notLinkedNodes.length > 0 ? (
        <div className="sticky-tree__group">
          <h2 id={notLinkedId} className="sticky-tree__heading" title={t('tree.notLinked.hint')}>
            {t('tree.notLinked')}
          </h2>
          <Tree labelledBy={notLinkedId} nodes={notLinkedNodes} expanded={expanded} onToggle={toggle} onActivate={openRow} className="sticky-tree__tree" />
        </div>
      ) : null}
      {goneNodes.length > 0 ? (
        <div className="sticky-tree__group">
          <h2 id={goneHeadingId} className="sticky-tree__heading" title={t('tree.gone.hint')}>
            {t('tree.gone')}
          </h2>
          <Tree labelledBy={goneHeadingId} nodes={goneNodes} expanded={expanded} onToggle={toggle} onActivate={openRow} className="sticky-tree__tree" />
        </div>
      ) : null}
      {index.truncated ? <p className="sticky-tree__line">{t('tree.truncated', { max: NOTES_MAX })}</p> : null}
    </div>
  );
}

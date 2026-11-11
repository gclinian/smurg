// "Add a sticky note" on the open note (DESIGN 0.8.0 D7.5): a name, then `sticky.create` (a new, empty note, written
// by the daemon as this member), then the line `- [[Name]]` at the end of the open note, in ONE local transaction of
// its shared document, as if typed: everyone who has the note open sees the link at once, and the autosave writes it.
// "exists" is no failure: the note is there, and the link is added all the same. The button is there only while the
// open note takes a change (the role may write, the replica has the daemon's text, no agent holds its lock); when the
// note stopped taking one while the name was on its way, nothing is written into it, and the page says so, and says
// that the new note is under "Not linked" only when the list has it there (a note another one already linked to is
// under that one; one that was there may be anywhere). One press makes one note: a second press while the first is on
// its way does nothing.
import { errorReasonOf, isSmurgError } from '@smurg/protocol';
import { useId, useRef, useState, type FormEvent } from 'react';
import { describeError } from '../../lib/errors.ts';
import { joinSentences } from '../../lib/format.ts';
import { selectNote, selectNoteTree } from '../../lib/stores/sticky.ts';
import { useMember, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Button, Dialog, Input } from '../../ui/index.ts';
import { IconPlus } from '../../ui/icons.tsx';
import { heldDocumentWritable, type HeldDocument } from '../editor/standalone.tsx';
import { linkLineAfter, noteKey, unfoldRequestsOf } from './model.ts';
import { t } from './strings.ts';
import './sticky.css';

export interface AddNoteProps {
  /** The open note's shared document: the new note's link goes at its end. */
  readonly held: HeldDocument;
  /** The open note's name on disk. */
  readonly from: string;
  /** The open note takes a change right now: the button is there (an open dialog stays when this turns false). */
  readonly available: boolean;
  /** What became of the last add, said under the note (the open note's page keeps it until it goes). */
  onSaid(text: string): void;
}

export function AddNote({ held, from, available, onSaid }: AddNoteProps) {
  const stores = useStores();
  const userId = useMember()?.userId ?? null;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A press while one is on its way does nothing (state alone would let two presses of one render through).
  const running = useRef(false);
  const formId = useId();

  const close = (): void => {
    setOpen(false);
    setName('');
    setProblem(null);
  };

  const add = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (running.current || name.trim() === '') return;
    running.current = true;
    setBusy(true);
    setProblem(null);
    try {
      let linked = name;
      try {
        linked = (await stores.sticky.create(name)).name;
      } catch (error) {
        if (!(isSmurgError(error) && error.code === 'conflict' && errorReasonOf(error) === 'exists')) {
          setProblem(t('create.failed', { reason: describeError(error) }));
          return;
        }
        // Somebody wrote it a moment ago, or it was there: the link names it as the index spells it on disk.
        linked = selectNote(stores.sticky.getState(), name)?.name ?? name;
      }
      const session = held.session;
      if (session === undefined || !heldDocumentWritable(held, stores, userId)) {
        // The list decides where the note is: under "Not linked" only when no note Home reaches links to it.
        const key = noteKey(linked);
        const notLinked = selectNoteTree(stores.sticky.getState()).notLinked.some((note) => note.shadowed !== true && noteKey(note.name) === key);
        onSaid(joinSentences([t('add.readOnly', { name: linked, note: from }), notLinked ? t('add.notLinked', { name: linked }) : null]));
        close();
        return;
      }
      const ytext = session.ytext;
      session.doc.transact(() => ytext.insert(ytext.length, linkLineAfter(ytext.toString(), linked)));
      // The new note will show under the open one: its row unfolds.
      unfoldRequestsOf(stores.sticky).setState({ key: noteKey(from) });
      onSaid(t('add.done', { name: linked, note: from }));
      close();
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      {available ? (
        <Button size="sm" icon={<IconPlus size={14} />} onClick={() => setOpen(true)}>
          {t('add.title')}
        </Button>
      ) : null}
      <Dialog
        open={open}
        onClose={() => {
          if (!running.current) close();
        }}
        size="sm"
        title={t('add.title')}
        description={t('add.body', { note: from })}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {tApp('common.cancel')}
            </Button>
            <Button variant="primary" type="submit" form={formId} loading={busy} disabled={name.trim() === ''}>
              {t('add.confirm')}
            </Button>
          </>
        }
      >
        <form id={formId} className="sticky-form" onSubmit={(event) => void add(event)}>
          <Input label={t('add.name')} value={name} autoComplete="off" spellCheck={false} onChange={(event) => setName(event.currentTarget.value)} />
          {problem !== null ? (
            <p className="sticky-card__problem" role="alert">
              {problem}
            </p>
          ) : null}
        </form>
      </Dialog>
    </>
  );
}

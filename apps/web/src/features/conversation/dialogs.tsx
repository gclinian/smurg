// The two dialogs about an agent session itself: rename it, end it. They open from a column's "More actions" and
// from a session row's context menu in the list (slots.tsx), so they are mounted once per workspace (Overlays.tsx)
// and asked for through a small store.
import { useEffect, useState } from 'react';
import { mayEndSession, type AgentSession, type Member } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { createStore, useStore, type WritableStore } from '../../lib/store.ts';
import { selectSession, sessionTitle } from '../../lib/stores/sessions.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, Dialog, Input } from '../../ui/index.ts';
import { t } from './strings.ts';

/** A session's title on the wire is a display text of at most this many characters. */
const TITLE_MAX_CHARS = 256;

export type SessionDialogRequest = { readonly kind: 'rename' | 'end'; readonly sessionId: string } | null;

const requests = new WeakMap<object, WritableStore<SessionDialogRequest>>();

/** The dialog request of one workspace (keyed by its stores object: what both a component and a slot function have). */
export function sessionDialogs(owner: object): WritableStore<SessionDialogRequest> {
  let store = requests.get(owner);
  if (store === undefined) {
    store = createStore<SessionDialogRequest>(null);
    requests.set(owner, store);
  }
  return store;
}

/** May `member` end `session` (never a topic's discussion, never an ended one)? For hiding the menu item only. */
export function mayEnd(member: Pick<Member, 'userId' | 'role'> | null, session: AgentSession): boolean {
  if (member === null || session.status === 'ended') return false;
  return mayEndSession(
    { userId: member.userId, role: member.role },
    { kind: 'agent', purpose: session.purpose, openedBy: session.openedBy.userId, responsible: session.responsible?.userId ?? null },
  );
}

function RenameDialog({ session, onClose }: { session: AgentSession; onClose(): void }) {
  const stores = useStores();
  const [title, setTitle] = useState(session.title ?? sessionTitle(session));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = title.trim();
  const save = (): void => {
    if (trimmed === '' || busy) return;
    setBusy(true);
    stores.sessions.rename(session.id, trimmed).then(onClose, (failure: unknown) => {
      setError(describeError(failure));
      setBusy(false);
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('rename.title')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={trimmed === ''} onClick={save}>
            {t('rename.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Input label={t('rename.label')} hint={t('rename.hint')} value={title} maxLength={TITLE_MAX_CHARS} onChange={(event) => setTitle(event.currentTarget.value)} />
      </form>
      {error !== null ? <Banner tone="danger">{t('actionFailed', { message: error })}</Banner> : null}
    </Dialog>
  );
}

function EndDialog({ session, onClose }: { session: AgentSession; onClose(): void }) {
  const stores = useStores();
  // A free session in a worktree of its own: the worktree goes with it unless the member keeps it.
  const ownsWorktree = session.purpose === 'free' && session.root.kind === 'worktree';
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = (): void => {
    setBusy(true);
    stores.sessions.end(session.id, ownsWorktree ? { keepWorktree: keep } : {}).then(onClose, (failure: unknown) => {
      setError(describeError(failure));
      setBusy(false);
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      title={t('end.title', { title: sessionTitle(session) })}
      description={t('end.body')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={end}>
            {t('end.confirm')}
          </Button>
        </>
      }
    >
      {session.purpose === 'item' ? <p>{t('end.item')}</p> : null}
      {ownsWorktree ? (
        <label className="conv-end__keep">
          <input type="checkbox" checked={keep} onChange={(event) => setKeep(event.currentTarget.checked)} /> <span>{t('end.keep')}</span>
          <span className="conv-end__hint">{t('end.keepHint')}</span>
        </label>
      ) : null}
      {error !== null ? <Banner tone="danger">{t('actionFailed', { message: error })}</Banner> : null}
    </Dialog>
  );
}

/** Mounted once per workspace: shows the dialog that was asked for. */
export function SessionDialogs() {
  const stores = useStores();
  const store = sessionDialogs(stores);
  const request = useStore(store);
  const session = useStore(stores.sessions, (state) => (request === null ? undefined : selectSession(state, request.sessionId)));
  const close = (): void => store.setState(null);
  // The session went while its dialog was open: nothing is left to rename or end.
  const gone = request !== null && (session === undefined || session.kind !== 'agent');
  useEffect(() => {
    if (gone) store.setState(null);
  }, [gone, store]);
  if (request === null || session === undefined || session.kind !== 'agent') return null;
  return request.kind === 'rename' ? <RenameDialog key={session.id} session={session} onClose={close} /> : <EndDialog key={session.id} session={session} onClose={close} />;
}

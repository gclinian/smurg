// One open document: its header (path, who else is here, autosave state, "Send to agent"), the notices the view-model
// asks for (agent lock, human edit lock with "Let the agent go first", a rejected change, mixed line endings) and the Monaco
// view — or, for a file the editor refuses, the reason and a download offer.
//
// Shown as the panel of an editor tab (EditorArea), or on its own inside a column of the sessions view (a topic's
// SPEC.md or PLAN.md: StandaloneDocument in standalone.tsx). On its own it has no tab to close and no other tab to
// move to, so `tabId` / `panelId` / `onClose` are absent and the pane is a labelled group.
import { baseNameOfRelPath, type FileRef, type LockInfo } from '@smurg/protocol';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { describeError } from '../../lib/errors.ts';
import { formatTime } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import type { DocRemoval, OpenDoc } from '../../lib/stores/docs.ts';
import { useCapabilities, useCommands, useMember, useStores } from '../../lib/workspace/context.tsx';
import { Avatar, Badge, Banner, Button, Spinner, useToast } from '../../ui/index.ts';
import { IconAlertTriangle, IconCheck, IconDownload, IconEye, IconRefresh } from '../../ui/icons.tsx';
import type { DocSession, DocSessionState } from './doc-session.ts';
import { ForceReleaseDialog, useCanForceRelease } from '../files/ForceReleaseDialog.tsx';
import { DocumentView, type RevealRequest } from './DocumentView.tsx';
import type { EditorHandle } from './engine.ts';
import { editorPresenceCss, participantsOf, type Participant } from './presence.ts';
import { isEmptySelection, type EditorSelection } from './selection.ts';
import { SendToAgentMenu, useCanSendToAgent, type SendToAgentMenuHandle } from './SendToAgentMenu.tsx';
import { t } from './strings.ts';
import { useNow } from './use-now.ts';
import {
  classifyOpenFailure,
  droppedMessage,
  editorView,
  encodeDocText,
  eolLabel,
  liveLockOf,
  joinNames,
  offersDownload,
  refusalTitle,
  rejectionMessage,
  removedTitle,
  saveIndicator,
  type EditorView,
} from './view-model.ts';

export interface DocumentPaneProps {
  readonly doc: OpenDoc;
  readonly session: DocSession | undefined;
  readonly active: boolean;
  /** The tab this pane is the panel of; absent when the pane stands on its own (a column). */
  readonly tabId?: string;
  readonly panelId?: string;
  readonly rootLabel: string;
  readonly reveal: RevealRequest | null;
  onRevealed(seq: number): void;
  /** Closes the tab; absent when the pane stands on its own (its column closes it). */
  onClose?(): void;
  /** Opens the document again (after a refusal); records a new failure on the session. */
  onReopen(): void;
}

const IDLE_SESSION: DocSessionState | undefined = undefined;

/** Awareness participants of the current replica, and the <style> with their cursor colours and names. */
function usePresence(session: DocSession | undefined, selfUserId: string | null): Participant[] {
  const replica = useStore(session ?? NULL_STORE, (state) => state?.replica ?? -1);
  const [participants, setParticipants] = useState<Participant[]>([]);
  useEffect(() => {
    if (!session) return;
    const awareness = session.awareness;
    const style = document.createElement('style');
    style.dataset['smurgPresence'] = session.key;
    document.head.appendChild(style);
    // Per remote client, how often its state changed: a change shows its caret's name again (presence-css.ts).
    const changes = new Map<number, number>();
    const render = (): void => {
      const states = awareness.getStates() as ReadonlyMap<number, Readonly<Record<string, unknown>>>;
      // textContent: the CSS is never parsed as HTML; names are escaped inside it (presence.ts).
      style.textContent = editorPresenceCss(states, awareness.clientID, changes);
      setParticipants(participantsOf(states, awareness.clientID, selfUserId));
    };
    const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
      for (const id of [...added, ...updated]) changes.set(id, (changes.get(id) ?? 0) + 1);
      for (const id of removed) changes.delete(id);
      render();
    };
    render();
    awareness.on('change', onChange);
    return () => {
      awareness.off('change', onChange);
      style.remove();
      setParticipants([]);
    };
  }, [session, replica, selfUserId]);
  return participants;
}

const NULL_STORE = { getState: (): DocSessionState | undefined => undefined, subscribe: () => () => {} };

export function DocumentPane({ doc, session, active, tabId, panelId, rootLabel, reveal, onRevealed, onClose, onReopen }: DocumentPaneProps) {
  const stores = useStores();
  const member = useMember();
  const userId = member?.userId ?? null;
  const sessionState = useStore(session ?? NULL_STORE, (state) => state ?? IDLE_SESSION);
  const liveLock = useStore(stores.locks, (state) => liveLockOf(state, doc.file));
  const view = editorView({ doc, session: sessionState, userId, lock: liveLock });
  const participants = usePresence(session, userId);
  const editorRef = useRef<EditorHandle | null>(null);
  const menuRef = useRef<SendToAgentMenuHandle | null>(null);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [everActive, setEverActive] = useState(active);
  const canSend = useCanSendToAgent();
  if (active && !everActive) setEverActive(true);

  const body =
    doc.status === 'error' ? (
      <RefusedFile doc={doc} failure={sessionState?.openFailure ?? null} onClose={onClose} onReopen={onReopen} />
    ) : doc.status === 'opening' || session === undefined ? (
      <div className="editor-doc__overlay">
        <Spinner label={t('doc.loading')} />
      </div>
    ) : everActive ? (
      // Mounted on first view, then kept (hidden) so switching tabs keeps scroll position, selection and undo.
      <DocumentView
        session={session}
        file={doc.file}
        readOnly={view.readOnly}
        readOnlyMessage={view.message}
        reveal={reveal}
        onRevealed={onRevealed}
        onSelection={setSelection}
        editorRef={editorRef}
        {...(canSend ? { onSendToAgent: () => menuRef.current?.open() } : {})}
      />
    ) : null;

  const frame = tabId === undefined ? { role: 'group', 'aria-label': t('doc.editorLabel', { path: doc.file.path }) } : { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId };
  return (
    <div {...frame} hidden={!active} className="editor-doc" data-doc-key={doc.key}>
      <header className="editor-doc__header">
        <div className="editor-doc__path" title={doc.file.path}>
          <span className="editor-doc__root">{rootLabel}</span>
          <span className="editor-doc__sep" aria-hidden="true">
            /
          </span>
          <span className="editor-doc__file">{doc.file.path}</span>
        </div>
        <div className="editor-doc__meta">
          {participants.length > 0 ? <Participants participants={participants} /> : null}
          {doc.status === 'open' || doc.status === 'reopening' ? <DocInfo doc={doc} view={view} session={sessionState} /> : null}
          {canSend && doc.status !== 'error' ? (
            <SendToAgentMenu ref={menuRef} file={doc.file} hasSelection={!isEmptySelection(selection)} editorRef={editorRef} />
          ) : null}
        </div>
      </header>
      {doc.removed !== null ? <RemovedNotice doc={doc} removed={doc.removed} session={session} userId={userId} onClose={onClose} onReopen={onReopen} /> : null}
      <DocNotices doc={doc} view={view} lock={liveLock === undefined ? doc.lock : liveLock} session={sessionState} onRelease={() => releaseLock(doc.file)} />
      {session && sessionState?.recovery ? <RecoveryNotice session={session} recovery={sessionState.recovery} canApply={!view.readOnly} /> : null}
      <div className="editor-doc__body">{body}</div>
    </div>
  );

  function releaseLock(file: FileRef): Promise<void> {
    return stores.locks.release(file);
  }
}

function Participants({ participants }: { participants: readonly Participant[] }) {
  return (
    <ul className="editor-doc__participants" aria-label={t('presence.label')}>
      {participants.slice(0, 6).map((p) => (
        <li key={p.clientId} title={p.name}>
          <Avatar name={p.name} color={p.color} size="sm" status={p.kind === 'agent' ? 'agent' : 'online'} />
        </li>
      ))}
    </ul>
  );
}

function DocInfo({ doc, view, session }: { doc: OpenDoc; view: EditorView; session: DocSessionState | undefined }) {
  const now = useNow(1_000, session?.pendingSave === true);
  // Nothing more will be saved to a file that is gone: the removed notice says so, not "waiting for the host's computer".
  const indicator = doc.removed !== null ? ({ kind: 'idle' } as const) : saveIndicator(session, now);
  return (
    <div className="editor-doc__info" aria-label={t('doc.infoLabel')} role="group">
      {view.reason === 'no-permission' ? (
        <Badge tone="neutral">
          <IconEye size={12} /> {t('readOnly.badge')}
        </Badge>
      ) : null}
      {doc.meta && doc.meta.eol !== 'LF' ? <span className="editor-doc__eol">{t('eol.info', { eol: eolLabel(doc.meta.eol) })}</span> : null}
      {doc.meta?.bom ? <span className="editor-doc__eol">{t('bom.info')}</span> : null}
      <span className="editor-doc__save" role="status" aria-label={t('save.label')} data-save={indicator.kind}>
        {indicator.kind === 'saving' ? (
          <>
            <Spinner size={12} decorative /> {t('save.saving')}
          </>
        ) : indicator.kind === 'stale' ? (
          <>
            <IconAlertTriangle size={12} /> {t('save.stale')}
          </>
        ) : indicator.kind === 'saved' ? (
          <>
            <IconCheck size={12} /> {t('save.saved', { time: formatTime(indicator.at) })}
          </>
        ) : null}
      </span>
    </div>
  );
}

/** The notices above the editor; each one-shot notice is dismissed per occurrence. */
function DocNotices({ doc, view, lock, session, onRelease }: { doc: OpenDoc; view: EditorView; lock: LockInfo | null; session: DocSessionState | undefined; onRelease(): Promise<void> }) {
  const toast = useToast();
  // The host may break any lock (SPEC R8), always through a confirmation that names the holder.
  const canForce = useCanForceRelease();
  const [forcing, setForcing] = useState<LockInfo | null>(null);
  const forceButton = (current: LockInfo | null): ReactNode =>
    canForce && current !== null ? (
      <Button size="sm" variant="secondary" onClick={() => setForcing(current)}>
        {t('lock.forceRelease')}
      </Button>
    ) : null;
  const [dismissedRejection, setDismissedRejection] = useState<OpenDoc['rejected']>(null);
  const [dismissedDrop, setDismissedDrop] = useState<DocSessionState['dropped']>(null);
  const [eolDismissed, setEolDismissed] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const notices = [];

  if (view.reason === 'agent-lock' && view.message !== null) {
    notices.push(
      <Banner key="agent-lock" tone="warning" title={view.message} className="editor-doc__lock" actions={forceButton(lock?.kind === 'agent' ? lock : null)}>
        {t('lock.agentDetail')}
      </Banner>,
    );
  } else if (view.humanLock !== null) {
    const { iHold, others } = view.humanLock;
    const text = iHold ? (others.length > 0 ? t('lock.mineShared', { others: joinNames(others) }) : t('lock.mine')) : t('lock.others', { others: joinNames(others) });
    notices.push(
      <Banner
        key="human-lock"
        tone="info"
        live="none"
        className="editor-doc__lock editor-doc__lock--human"
        actions={
          iHold ? (
            <Button
              size="sm"
              loading={releasing}
              title={t('lock.releaseHint')}
              onClick={() => {
                setReleasing(true);
                onRelease()
                  .catch((error: unknown) => toast.show({ tone: 'danger', title: t('lock.releaseFailed', { message: describeError(error) }) }))
                  .finally(() => setReleasing(false));
              }}
            >
              {t('lock.release')}
            </Button>
          ) : (
            forceButton(lock?.kind === 'human' ? lock : null) ?? undefined
          )
        }
      >
        {text}
      </Banner>,
    );
  }

  const rejected = doc.rejected;
  // A file that is gone is explained by the removed notice (the daemon refuses edits of it as 'file-unavailable').
  if (rejected !== null && rejected !== dismissedRejection && doc.removed === null) {
    // The lock that refused it may be over already; doc.rejected carried it into doc.lock.
    const agentName = view.agentName ?? (doc.lock?.kind === 'agent' ? doc.lock.agentName : null);
    notices.push(
      <Banner
        key="rejected"
        tone="warning"
        live="alert"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setDismissedRejection(rejected)}>
            {t('notice.dismiss')}
          </Button>
        }
      >
        {rejectionMessage(rejected.reason, agentName)}
      </Banner>,
    );
  }

  const dropped = session?.dropped ?? null;
  const droppedText = dropped === null ? null : droppedMessage(dropped);
  if (dropped !== null && droppedText !== null && dropped !== dismissedDrop) {
    notices.push(
      <Banner
        key="dropped"
        tone="info"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setDismissedDrop(dropped)}>
            {t('notice.dismiss')}
          </Button>
        }
      >
        {droppedText}
      </Banner>,
    );
  }

  if (doc.meta?.mixedEol && !eolDismissed && view.reason !== 'no-permission') {
    notices.push(
      <Banner
        key="eol"
        tone="info"
        live="none"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setEolDismissed(true)}>
            {t('notice.dismiss')}
          </Button>
        }
      >
        {t('eol.mixed', { eol: eolLabel(doc.meta.eol) })}
      </Banner>,
    );
  }

  if (doc.status === 'reopening') {
    notices.push(
      <Banner key="reopening" tone="neutral" live="none">
        {t('doc.reopening')}
      </Banner>,
    );
  }

  const dialog = forcing !== null ? <ForceReleaseDialog file={doc.file} lock={forcing} onClose={() => setForcing(null)} /> : null;
  return notices.length > 0 || dialog !== null ? (
    <div className="editor-doc__notices">
      {notices}
      {dialog}
    </div>
  ) : null;
}

/** The open file was deleted or moved away: read-only, with what can still be done with the text. */
function RemovedNotice({
  doc,
  removed,
  session,
  userId,
  onClose,
  onReopen,
}: {
  doc: OpenDoc;
  removed: DocRemoval;
  session: DocSession | undefined;
  userId: string | null;
  /** Absent: the pane stands on its own (a column): no tab to close, and the file belongs at this path. */
  onClose: (() => void) | undefined;
  onReopen(): void;
}) {
  const stores = useStores();
  const commands = useCommands();
  const toast = useToast();
  // The role, not doc.editableBase: the daemon refuses edits of a vanished file as 'file-unavailable', which clears it.
  const mayWrite = useCapabilities().can('file.write');
  const [busy, setBusy] = useState(false);
  const name = baseNameOfRelPath(doc.file.path);
  const openMoved = (): void => {
    if (removed.movedTo === null) return;
    const file: FileRef = { root: doc.file.root, path: removed.movedTo };
    stores.docs.close(doc.key);
    commands.dispatch('openFile', { file }).catch(() => {});
  };
  // Never write a replica that has not received the daemon's text yet (after a drop it starts empty).
  const synced = useStore(session ?? NULL_STORE, (state) => state?.replicaSynced === true);
  const recreate = async (): Promise<void> => {
    if (!session || !session.getState().replicaSynced) return;
    setBusy(true);
    try {
      // file.create refuses to replace a file someone put there meanwhile (noClobber).
      await stores.files.create(doc.file, 'file');
      await stores.files.write(doc.file, encodeDocText(session.ytext.toString(), doc.meta));
      toast.show({ tone: 'success', title: t('removed.recreated', { name }) });
      if (onClose === undefined) {
        // On its own in a column: the column keeps the document; the watcher's 'add' clears the mark, and a doc.open
        // the daemon refused meanwhile is asked again.
        onReopen();
        setBusy(false);
        return;
      }
      // A fresh doc.open: the daemon's old room refused edits once the file was gone.
      stores.docs.close(doc.key);
      await reopenSoon(
        () => stores.docs.open(doc.file),
        () => commands.dispatch('openFile', { file: doc.file }),
      );
    } catch (error) {
      toast.show({ tone: 'danger', title: t('removed.recreateFailed', { message: describeError(error) }) });
      setBusy(false);
    }
  };
  return (
    <div className="editor-doc__notices">
      <Banner
        tone="warning"
        live="alert"
        title={removedTitle(removed, userId)}
        className="editor-doc__removed"
        actions={
          <>
            {removed.movedTo !== null && onClose !== undefined ? (
              <Button size="sm" variant="primary" onClick={openMoved}>
                {t('removed.openMoved')}
              </Button>
            ) : null}
            {session && mayWrite && (removed.movedTo === null || onClose === undefined) ? (
              <Button size="sm" loading={busy} disabled={!synced} onClick={() => void recreate()}>
                {t('removed.recreate')}
              </Button>
            ) : null}
            {onClose !== undefined ? (
              <Button size="sm" variant="ghost" onClick={onClose}>
                {t('removed.close')}
              </Button>
            ) : null}
          </>
        }
      >
        {onClose === undefined ? t('removed.detailStandalone') : removed.movedTo !== null ? t('removed.detailMoved') : t('removed.detail')}
      </Banner>
    </div>
  );
}

/** Opens again; once more after a moment (through the editor, which explains a failure) if the daemon has not noticed yet that the file is back. */
async function reopenSoon(open: () => Promise<unknown>, openExplained: () => Promise<unknown>): Promise<void> {
  try {
    await open();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await openExplained();
  }
}

/**
 * Local text a dropped replica held that could not be merged into the daemon's new text: kept until the user
 * copies it, puts it back or discards it.
 */
function RecoveryNotice({ session, recovery, canApply }: { session: DocSession; recovery: NonNullable<DocSessionState['recovery']>; canApply: boolean }) {
  const toast = useToast();
  const copy = (): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) {
      toast.show({ tone: 'danger', title: t('recovery.copyFailed', { message: t('recovery.noClipboard') }) });
      return;
    }
    clipboard.writeText(recovery.text).then(
      () => toast.show({ tone: 'success', title: t('recovery.copied') }),
      (error: unknown) => toast.show({ tone: 'danger', title: t('recovery.copyFailed', { message: describeError(error) }) }),
    );
  };
  return (
    <div className="editor-doc__notices">
      <Banner
        tone="warning"
        live="alert"
        title={t('recovery.title')}
        className="editor-doc__recovery"
        actions={
          <>
            <Button size="sm" variant="primary" disabled={!canApply} title={canApply ? undefined : t('recovery.applyUnavailable')} onClick={() => session.applyRecovery()}>
              {t('recovery.apply')}
            </Button>
            <Button size="sm" onClick={copy}>
              {t('recovery.copy')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => session.discardRecovery()}>
              {t('recovery.discard')}
            </Button>
          </>
        }
      >
        <p>{t('recovery.body')}</p>
        <details className="editor-doc__recovery-text">
          <summary>{t('recovery.show', { count: recovery.text.length })}</summary>
          <pre>{recovery.text}</pre>
        </details>
      </Banner>
    </div>
  );
}

function RefusedFile({ doc, failure, onClose, onReopen }: { doc: OpenDoc; failure: DocSessionState['openFailure']; onClose: (() => void) | undefined; onReopen(): void }) {
  const commands = useCommands();
  const toast = useToast();
  const refusal = classifyOpenFailure(failure);
  const name = baseNameOfRelPath(doc.file.path);
  const download = (): void => {
    commands.dispatch('download', { file: doc.file }).catch((error: unknown) => toast.show({ tone: 'danger', title: t('download.failed', { message: describeError(error) }) }));
  };
  return (
    <div className="editor-doc__refused" role="alert" data-refusal={refusal}>
      <IconAlertTriangle size={24} />
      <p className="editor-doc__refused-title">{refusalTitle(refusal)}</p>
      <p className="editor-doc__refused-file">{name}</p>
      {refusal === 'other' && doc.error ? <p className="editor-doc__refused-detail">{doc.error}</p> : null}
      {offersDownload(refusal) ? <p className="editor-doc__refused-hint">{t('refused.hint')}</p> : null}
      <div className="editor-doc__refused-actions">
        {offersDownload(refusal) ? (
          <Button variant="primary" icon={<IconDownload />} onClick={download}>
            {t('refused.download')}
          </Button>
        ) : null}
        {refusal === 'other' || refusal === 'not-found' ? (
          <Button icon={<IconRefresh />} onClick={onReopen}>
            {t('refused.retry')}
          </Button>
        ) : null}
        {onClose !== undefined ? (
          <Button variant="ghost" onClick={onClose}>
            {t('refused.close')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

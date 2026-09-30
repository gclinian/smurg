// What the editor chrome shows for one document, as pure functions of the stores (tested without Monaco): whether
// the local user may type, why not (the banner and Monaco's readOnlyMessage), the human edit lock, the autosave
// indicator and the refusal of files the editor cannot open. The daemon enforces all of it; this is display only.
import { fileRefKey, foldPathName, rootRefEquals, type Actor, type FileRef, type LockInfo } from '@smurg/protocol';
import type { DocMeta, DocRejectReason, DocRemoval, OpenDoc } from '../../lib/stores/docs.ts';
import type { LocksState } from '../../lib/stores/locks.ts';
import type { DocSessionState, OpenFailure } from './doc-session.ts';
import { t } from './strings.ts';

export type ReadOnlyReason =
  /** doc.open in flight, or the replica has not received the daemon's text yet. */
  | 'loading'
  /** Reconnecting: typing now would only be merged later, and could land on stale text. */
  | 'offline'
  /** An agent holds the lock (SPEC R8): 「Claude（Ian）正在修改，暫時無法輸入」. */
  | 'agent-lock'
  /** The member's role cannot write (viewer), or the file is read-only for them (shared dir, host-only path). */
  | 'no-permission'
  /** The file was deleted or moved away while open (WEB-01): nothing typed here could be saved. */
  | 'removed'
  | 'error';

export interface HumanLockView {
  /** The local user shares the lock (then 「讓 agent 先改」 is offered). */
  readonly iHold: boolean;
  /** Everyone holding it, local user included, in the daemon's order. */
  readonly holders: readonly { readonly userId: string; readonly displayName: string }[];
  /** Holders other than the local user. */
  readonly others: readonly string[];
}

export interface EditorView {
  readonly readOnly: boolean;
  readonly reason: ReadOnlyReason | null;
  /** zh-TW, for the banner / Monaco's readOnlyMessage; null when editable. */
  readonly message: string | null;
  /** The agent holding the file, when there is one. */
  readonly agentName: string | null;
  readonly humanLock: HumanLockView | null;
}

export interface EditorViewInput {
  readonly doc: OpenDoc;
  readonly session: DocSessionState | undefined;
  readonly userId: string | null;
  /** The live lock of the file (locks store), which is fresher than the entry of doc.open; falls back to doc.lock. */
  readonly lock?: LockInfo | null;
}

/**
 * The live lock of an open document from the locks store (lock.list, then every lock.state), or undefined until
 * lock.list has answered (the view then uses what doc.open / doc.rejected reported). A lock is announced under the
 * spelling that created it, which on a case-insensitive host can differ from the spelling the document was opened with
 * (「README.md」 / 「readme.md」, e.g. a path clicked in agent output): the daemon keys locks by the folded name, so the
 * folded path matches too — otherwise the editor would never leave read-only after the agent's lock.state null.
 */
export function liveLockOf(state: LocksState, file: FileRef): LockInfo | null | undefined {
  if (state.status !== 'ready') return undefined;
  const exact = state.locks.get(fileRefKey(file));
  if (exact) return exact;
  const folded = foldPathName(file.path);
  for (const lock of state.locks.values()) {
    if (rootRefEquals(lock.file.root, file.root) && foldPathName(lock.file.path) === folded) return lock;
  }
  return null;
}

export function editorView({ doc, session, userId, lock: liveLock }: EditorViewInput): EditorView {
  const lock = liveLock === undefined ? doc.lock : liveLock;
  const agentName = lock?.kind === 'agent' ? lock.agentName : null;
  const humanLock = lock?.kind === 'human' ? humanLockView(lock, userId) : null;
  const reason = readOnlyReason(doc, session, lock);
  return { readOnly: reason !== null, reason, message: reason === null ? null : readOnlyMessage(reason, agentName), agentName, humanLock };
}

function readOnlyReason(doc: OpenDoc, session: DocSessionState | undefined, lock: LockInfo | null): ReadOnlyReason | null {
  if (doc.status === 'error') return 'error';
  if (doc.removed !== null) return 'removed';
  // Permission first: a viewer stays read-only whatever else happens (and sees no misleading "loading" reason).
  if ((doc.status === 'open' || doc.status === 'reopening') && !doc.editableBase) return 'no-permission';
  if (lock?.kind === 'agent') return 'agent-lock';
  if (doc.status === 'opening' || session === undefined || !session.replicaSynced) return 'loading';
  if (doc.status === 'reopening' || !session.live) return 'offline';
  return null;
}

function readOnlyMessage(reason: ReadOnlyReason, agentName: string | null): string {
  switch (reason) {
    case 'agent-lock':
      return t('lock.agent', { agent: agentName ?? t('lock.someAgent') });
    case 'no-permission':
      return t('readOnly.noPermission');
    case 'removed':
      return t('readOnly.removed');
    case 'offline':
      return t('readOnly.offline');
    case 'loading':
      return t('readOnly.loading');
    case 'error':
      return t('readOnly.error');
  }
}

export function humanLockView(lock: Extract<LockInfo, { kind: 'human' }>, userId: string | null): HumanLockView {
  const iHold = userId !== null && lock.holders.some((holder) => holder.userId === userId);
  const others = lock.holders.filter((holder) => holder.userId !== userId).map((holder) => holder.displayName);
  return { iHold, holders: lock.holders.map(({ userId: id, displayName }) => ({ userId: id, displayName })), others };
}

/** 「Amy、Bob」 */
export function joinNames(names: readonly string[]): string {
  return names.join(t('list.separator'));
}

// ---- autosave (D13: there is no save button)

export type SaveIndicator =
  | { readonly kind: 'idle' }
  /** A local edit is on its way; the daemon debounces writes (300 ms, at most 2 s). */
  | { readonly kind: 'saving' }
  /** Nothing confirmed for a while: the host may be unreachable. */
  | { readonly kind: 'stale' }
  | { readonly kind: 'saved'; readonly at: number };

/** After this long without doc.saved following a local edit, the indicator warns. */
export const SAVE_STALE_MS = 10_000;

export function saveIndicator(session: DocSessionState | undefined, now: number): SaveIndicator {
  if (!session) return { kind: 'idle' };
  if (session.pendingSave) {
    const since = session.lastLocalEditAt ?? now;
    return now - since >= SAVE_STALE_MS ? { kind: 'stale' } : { kind: 'saving' };
  }
  if (session.lastSavedAt !== null) return { kind: 'saved', at: session.lastSavedAt };
  return { kind: 'idle' };
}

// ---- doc.rejected and dropped replicas

export function rejectionMessage(reason: DocRejectReason, agentName: string | null): string {
  switch (reason) {
    case 'agent-locked':
      return t('rejected.agentLocked', { agent: agentName ?? t('lock.someAgent') });
    case 'read-only':
      return t('rejected.readOnly');
    case 'forbidden':
      return t('rejected.forbidden');
    case 'file-unavailable':
      return t('rejected.fileUnavailable');
  }
}

export function droppedMessage({ reason, outcome }: Pick<NonNullable<DocSessionState['dropped']>, 'reason' | 'outcome'>): string | null {
  // doc.rejected already explains a rejection; the recovery notice explains text that could not be merged; the
  // outcome is not known before the new replica synced.
  if (reason === 'rejected' || outcome === 'recovery' || outcome === 'checking') return null;
  const restored = outcome === 'restored';
  switch (reason) {
    case 'epoch':
      return t(restored ? 'dropped.epochRestored' : 'dropped.epoch');
    case 'diverged':
      return t(restored ? 'dropped.divergedRestored' : 'dropped.diverged');
  }
}

// ---- files the editor refuses (doc.open answers too_large / bad_request)

export type OpenRefusal = 'too-large' | 'binary' | 'encoding' | 'not-a-file' | 'not-found' | 'other';

/** Classifies a failed doc.open by its structured error (when the open was ours) — never by message text. */
export function classifyOpenFailure(failure: OpenFailure | null): OpenRefusal {
  if (failure === null) return 'other';
  if (failure.code === 'too_large' || failure.reason === 'too-large') return 'too-large';
  if (failure.code === 'not_found') return 'not-found';
  switch (failure.reason) {
    case 'binary':
      return 'binary';
    case 'invalid-utf8':
    case 'utf16-or-utf32-bom':
      return 'encoding';
    case 'not-a-file':
      return 'not-a-file';
    default:
      return 'other';
  }
}

/** Whether offering the download makes sense (the file exists, the editor just cannot show it). */
export function offersDownload(refusal: OpenRefusal): boolean {
  return refusal === 'too-large' || refusal === 'binary' || refusal === 'encoding' || refusal === 'other';
}

export function refusalTitle(refusal: OpenRefusal): string {
  switch (refusal) {
    case 'too-large':
      return t('refused.tooLarge');
    case 'binary':
      return t('refused.binary');
    case 'encoding':
      return t('refused.encoding');
    case 'not-a-file':
      return t('refused.notAFile');
    case 'not-found':
      return t('refused.notFound');
    case 'other':
      return t('refused.other');
  }
}

// ---- a removed file (WEB-01)

/** Who removed the file, for 「這個檔案已被{who}刪除」 (null: not attributed). */
export function removerName(by: Actor | null, selfUserId: string | null): string | null {
  if (by === null) return null;
  switch (by.kind) {
    case 'user':
      return by.userId === selfUserId ? t('removed.you') : by.displayName;
    case 'agent':
      return by.displayName;
    case 'system':
      return t('removed.system');
  }
}

export function removedTitle(removed: DocRemoval, selfUserId: string | null): string {
  const who = removerName(removed.by, selfUserId);
  if (removed.movedTo !== null) return who === null ? t('removed.moved', { to: removed.movedTo }) : t('removed.movedBy', { who, to: removed.movedTo });
  return who === null ? t('removed.deleted') : t('removed.deletedBy', { who });
}

/** The bytes of `text` as the daemon writes them (text-codec encodeText): the file's EOL style and BOM re-applied. */
export function encodeDocText(text: string, meta: Pick<DocMeta, 'eol' | 'bom'> | null): Uint8Array {
  const eol = meta?.eol ?? 'LF';
  const withEol = eol === 'CRLF' ? text.replace(/\n/g, '\r\n') : eol === 'CR' ? text.replace(/\n/g, '\r') : text;
  const body = new TextEncoder().encode(withEol);
  if (!meta?.bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}

// ---- end of line

export function eolLabel(eol: 'LF' | 'CRLF' | 'CR'): string {
  switch (eol) {
    case 'LF':
      return t('eol.lf');
    case 'CRLF':
      return t('eol.crlf');
    case 'CR':
      return t('eol.cr');
  }
}

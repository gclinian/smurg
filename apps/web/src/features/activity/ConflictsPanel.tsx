// The conflict panel (SPEC R8: 「重疊部分出現在衝突面板」). When a process outside the edit tools (Bash `sed`, a formatter,
// `git checkout`) changed a file someone was typing in, the daemon kept the human text and recorded the other side's
// text here. For each conflict: the file, who was involved, and each overlapping hunk side by side (human text kept on
// the left, the other version on the right, diff-view.ts). Members who can write may keep the human text (dismiss) or
// replace the whole file with the other side's full version (apply-agent-version, after a confirmation); everyone can
// read the full version (doc.conflict.get). The daemon enforces every rule; hiding is cosmetic.
import { isHostOnlyPath, isSmurgError, lockOfError, type ConflictHunk, type ConflictRecord, type FileRef } from '@smurg/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { NoCommandHandlerError } from '../../lib/commands.ts';
import { describeError } from '../../lib/errors.ts';
import { formatBytes, formatDateTime } from '../../lib/format.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectConflictList } from '../../lib/stores/conflicts.ts';
import { useCapabilities, useCommands, useStores } from '../../lib/workspace/context.tsx';
import { Badge, Banner, Button, Dialog, EmptyState, Spinner, cx, useToast } from '../../ui/index.ts';
import { IconAlertTriangle, IconCheck, IconEye, IconFileText } from '../../ui/icons.tsx';
import { sideBySide } from './diff-view.ts';
import { actorLabel } from './feed-model.ts';
import { t } from './strings.ts';

/** What the full-version dialog shows at most (the version itself can be 5 MiB). */
export const FULL_VERSION_MAX_CHARS = 200_000;

export function ConflictList() {
  const { conflicts } = useStores();
  const list = useStore(conflicts, selectConflictList, shallowEqual);
  const status = useStore(conflicts, (state) => ({ status: state.status, error: state.error }), shallowEqual);
  const open = list.filter((conflict) => conflict.status === 'open');
  const resolved = list.filter((conflict) => conflict.status !== 'open');

  if (list.length === 0) {
    if (status.status === 'loading' || status.status === 'idle') {
      return (
        <div className="activity-status">
          <Spinner label={t('conflicts.loading')} />
        </div>
      );
    }
    if (status.status === 'error') {
      return (
        <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={() => void conflicts.reload().catch(() => {})}>{t('conflicts.retry')}</Button>}>
          {t('conflicts.error', { message: status.error ?? '' })}
        </Banner>
      );
    }
  }

  return (
    <div className="conflicts-panel" aria-label={t('conflicts.label')} role="region">
      {open.length === 0 ? <EmptyState compact icon={<IconCheck size={20} />} title={t('conflicts.empty')} description={t('conflicts.emptyHint')} /> : null}
      {open.map((conflict) => (
        <ConflictCard key={conflict.id} conflict={conflict} />
      ))}
      {resolved.length > 0 ? (
        <details className="conflicts-resolved">
          <summary>{t('conflicts.resolved', { count: resolved.length })}</summary>
          {resolved.map((conflict) => (
            <ConflictCard key={conflict.id} conflict={conflict} />
          ))}
        </details>
      ) : null}
    </div>
  );
}

function statusLabel(status: ConflictRecord['status']): string {
  switch (status) {
    case 'open':
      return t('conflict.status.open');
    case 'dismissed':
      return t('conflict.status.dismissed');
    case 'applied':
      return t('conflict.status.applied');
  }
}

function ConflictCard({ conflict }: { conflict: ConflictRecord }) {
  const { conflicts } = useStores();
  const caps = useCapabilities();
  const commands = useCommands();
  const toast = useToast();
  const headingId = useId();
  const [busy, setBusy] = useState<null | 'dismiss' | 'apply'>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const source = actorLabel(conflict.source);
  const humans = conflict.humans.map((human) => human.displayName).join(t('list.separator'));
  // Writing is needed to resolve (both actions); host-only files are the host's alone (ARCHITECTURE §5.2).
  const hostOnly = !caps.isHost && isHostOnlyPath(conflict.file.path);
  const mayResolve = conflict.status === 'open' && caps.can('file.write') && !hostOnly;

  const resolve = async (action: 'dismiss' | 'apply-agent-version'): Promise<void> => {
    setBusy(action === 'dismiss' ? 'dismiss' : 'apply');
    try {
      await conflicts.resolve(conflict.id, action);
    } catch (error) {
      const lock = isSmurgError(error) ? lockOfError(error) : null;
      toast.show({
        tone: 'danger',
        title: lock?.kind === 'agent' ? t('conflict.agentLocked', { agent: lock.agentName }) : t('conflict.failed', { message: describeError(error) }),
      });
    } finally {
      setBusy(null);
    }
  };

  const openFile = (file: FileRef): void => {
    commands.dispatch('openFile', { file }).catch((error: unknown) => {
      if (!(error instanceof NoCommandHandlerError)) toast.show({ tone: 'danger', title: describeError(error) });
    });
  };

  return (
    <article className={cx('conflict', `conflict--${conflict.status}`)} aria-labelledby={headingId} data-conflict-id={conflict.id}>
      <header className="conflict__header">
        <IconAlertTriangle size={14} aria-hidden="true" />
        <h3 id={headingId} className="conflict__file" title={conflict.file.path}>
          {conflict.file.path}
        </h3>
        <Badge tone={conflict.status === 'open' ? 'warning' : 'neutral'}>{statusLabel(conflict.status)}</Badge>
        <Button size="sm" variant="ghost" icon={<IconFileText />} onClick={() => openFile(conflict.file)}>
          {t('conflict.openFile')}
        </Button>
      </header>
      <p className="conflict__summary">
        {humans === ''
          ? t('conflict.summaryNobody', { source, time: formatDateTime(conflict.createdAt) })
          : t('conflict.summary', { source, time: formatDateTime(conflict.createdAt), humans })}{' '}
        {conflict.status === 'open' ? t('conflict.kept', { source }) : null}
      </p>
      {conflict.hunks.map((hunk, index) => (
        <HunkView key={index} hunk={hunk} source={source} />
      ))}
      {conflict.hunksOmitted ? <p className="conflict__note">{t('conflict.omitted', { count: conflict.hunksOmitted })}</p> : null}
      {conflict.status === 'open' && hostOnly && caps.can('file.write') ? <p className="conflict__note">{t('conflict.hostOnly')}</p> : null}
      <div className="conflict__actions">
        {mayResolve ? (
          <Button size="sm" variant="primary" loading={busy === 'dismiss'} disabled={busy !== null} title={t('conflict.dismissHint')} onClick={() => void resolve('dismiss')}>
            {t('conflict.dismiss')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" icon={<IconEye />} onClick={() => setShowFull(true)}>
          {t('conflict.viewFull')}
        </Button>
        {mayResolve ? (
          <Button size="sm" variant="secondary" loading={busy === 'apply'} disabled={busy !== null} title={t('conflict.applyHint', { source })} onClick={() => setConfirmApply(true)}>
            {t('conflict.apply')}
          </Button>
        ) : null}
      </div>
      {confirmApply ? (
        <ApplyDialog
          conflict={conflict}
          source={source}
          onClose={() => setConfirmApply(false)}
          onConfirm={() => {
            setConfirmApply(false);
            void resolve('apply-agent-version');
          }}
        />
      ) : null}
      {showFull ? <FullVersionDialog conflict={conflict} source={source} onClose={() => setShowFull(false)} /> : null}
    </article>
  );
}

function HunkView({ hunk, source }: { hunk: ConflictHunk; source: string }) {
  const rows = sideBySide(hunk.humanText, hunk.agentText, hunk.startLine);
  return (
    <div className="conflict__hunk">
      <table className="conflict-diff">
        <caption>{t('conflict.hunk', { line: hunk.startLine })}</caption>
        <thead>
          <tr>
            <th scope="col" className="conflict-diff__no">
              <span className="ui-visually-hidden">{t('conflict.lineNumber')}</span>
            </th>
            <th scope="col">{t('conflict.human')}</th>
            <th scope="col">{t('conflict.agent', { source })}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="conflict-diff__no" />
              <td className="conflict-diff__cell conflict-diff__cell--empty">{t('conflict.noLines')}</td>
              <td className="conflict-diff__cell conflict-diff__cell--empty">{t('conflict.noLines')}</td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={index}>
                <td className="conflict-diff__no">{row.human?.line ?? ''}</td>
                <td className="conflict-diff__cell conflict-diff__cell--human" data-changed={row.human?.changed || undefined} data-empty={row.human === null || undefined}>
                  {row.human?.text ?? ''}
                </td>
                <td className="conflict-diff__cell conflict-diff__cell--agent" data-changed={row.agent?.changed || undefined} data-empty={row.agent === null || undefined}>
                  {row.agent?.text ?? ''}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {hunk.truncated ? <p className="conflict__note">{t('conflict.truncated')}</p> : null}
      {hunk.baseText !== '' ? (
        <details className="conflict__base">
          <summary>{t('conflict.base')}</summary>
          <pre>{hunk.baseText}</pre>
        </details>
      ) : null}
    </div>
  );
}

function ApplyDialog({ conflict, source, onConfirm, onClose }: { conflict: ConflictRecord; source: string; onConfirm(): void; onClose(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      title={t('conflict.applyTitle', { source })}
      description={t('conflict.applyText', { source, size: formatBytes(conflict.agentVersionBytes) })}
      initialFocus={cancel}
      size="sm"
      footer={
        <>
          <Button ref={cancel} variant="ghost" onClick={onClose}>
            {t('conflict.cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {t('conflict.applyConfirm')}
          </Button>
        </>
      }
    />
  );
}

type FullState = { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly text: string; readonly cut: boolean };

function FullVersionDialog({ conflict, source, onClose }: { conflict: ConflictRecord; source: string; onClose(): void }) {
  const { conflicts } = useStores();
  const [state, setState] = useState<FullState>({ kind: 'loading' });
  const conflictId = conflict.id;
  useEffect(() => {
    let cancelled = false;
    conflicts.get(conflictId).then(
      ({ agentVersion }) => {
        if (cancelled) return;
        // Not fatal: this is only for reading; a broken byte shows as U+FFFD instead of hiding the rest.
        const text = new TextDecoder('utf-8').decode(agentVersion);
        setState({ kind: 'ready', text: text.slice(0, FULL_VERSION_MAX_CHARS), cut: text.length > FULL_VERSION_MAX_CHARS });
      },
      (error: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: describeError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [conflicts, conflictId]);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('conflict.fullTitle', { source })}
      description={t('conflict.fullDescription', { path: conflict.file.path, size: formatBytes(conflict.agentVersionBytes) })}
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t('conflict.close')}
        </Button>
      }
    >
      {state.kind === 'loading' ? (
        <Spinner label={t('conflict.fullLoading')} />
      ) : state.kind === 'error' ? (
        <Banner tone="danger" live="alert">
          {t('conflict.fullError', { message: state.message })}
        </Banner>
      ) : (
        <>
          {state.cut ? <p className="conflict__note">{t('conflict.fullTruncated', { shown: FULL_VERSION_MAX_CHARS.toLocaleString('zh-Hant-TW') })}</p> : null}
          <pre className="conflict__full">{state.text}</pre>
        </>
      )}
    </Dialog>
  );
}

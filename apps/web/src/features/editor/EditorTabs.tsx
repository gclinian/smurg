// The editor's tab strip (WAI-ARIA tabs, automatic activation): Left/Right move and activate, Home/End jump, Delete
// closes the focused tab, a middle click closes. Each tab shows the file name (plus its folder when two open files
// share a name) and small state marks: an agent is editing, unsaved changes, read-only, refused.
import { baseNameOfRelPath, parentRelPath } from '@smurg/protocol';
import { useRef, type KeyboardEvent } from 'react';
import { useStore } from '../../lib/store.ts';
import type { OpenDoc } from '../../lib/stores/docs.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { cx } from '../../ui/index.ts';
import { IconAgent, IconAlertCircle, IconClose, IconEye, IconGitBranch } from '../../ui/icons.tsx';
import type { DocSession, DocSessionState } from './doc-session.ts';
import { t } from './strings.ts';
import { liveLockOf } from './view-model.ts';

export interface EditorTabsProps {
  readonly docs: readonly OpenDoc[];
  readonly activeKey: string | null;
  sessionOf(key: string): DocSession | undefined;
  idsOf(key: string): { tabId: string; panelId: string };
  onActivate(key: string): void;
  onClose(key: string): void;
}

const NO_SESSION = { getState: (): DocSessionState | undefined => undefined, subscribe: () => () => {} };

export function EditorTabs({ docs, activeKey, sessionOf, idsOf, onActivate, onClose }: EditorTabsProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const names = new Map<string, number>();
  for (const doc of docs) {
    const name = baseNameOfRelPath(doc.file.path);
    names.set(name, (names.get(name) ?? 0) + 1);
  }

  const focusTab = (key: string | undefined): void => {
    if (key === undefined) return;
    onActivate(key);
    refs.current.get(key)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, key: string): void => {
    switch (event.key) {
      case 'ArrowRight':
        focusTab(docs[(index + 1) % docs.length]?.key);
        break;
      case 'ArrowLeft':
        focusTab(docs[(index - 1 + docs.length) % docs.length]?.key);
        break;
      case 'Home':
        focusTab(docs[0]?.key);
        break;
      case 'End':
        focusTab(docs[docs.length - 1]?.key);
        break;
      case 'Delete': {
        const next = docs[index + 1] ?? docs[index - 1];
        onClose(key);
        if (next) refs.current.get(next.key)?.focus();
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div role="tablist" aria-label={t('tabs.label')} className="editor-tabs">
      {docs.map((doc, index) => {
        const name = baseNameOfRelPath(doc.file.path);
        const folder = (names.get(name) ?? 0) > 1 ? parentRelPath(doc.file.path) : null;
        const { tabId, panelId } = idsOf(doc.key);
        const selected = doc.key === activeKey;
        return (
          <div key={doc.key} role="presentation" className={cx('editor-tab', selected && 'editor-tab--active')}>
            <button
              ref={(node) => {
                if (node) refs.current.set(doc.key, node);
                else refs.current.delete(doc.key);
              }}
              type="button"
              role="tab"
              id={tabId}
              aria-selected={selected}
              aria-controls={panelId}
              aria-keyshortcuts="Delete"
              aria-description={t('tabs.closeHint')}
              tabIndex={selected || (activeKey === null && index === 0) ? 0 : -1}
              title={doc.file.path}
              className="editor-tab__button"
              onClick={() => onActivate(doc.key)}
              onKeyDown={(event) => onKeyDown(event, index, doc.key)}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(doc.key);
              }}
            >
              {doc.file.root.kind === 'worktree' ? <IconGitBranch size={12} aria-hidden="true" /> : null}
              <span className={cx('editor-tab__name', doc.removed !== null && 'editor-tab__name--removed')}>{name}</span>
              {folder ? <span className="editor-tab__folder">{folder === '' ? '/' : folder}</span> : null}
              <TabMarks doc={doc} session={sessionOf(doc.key)} />
            </button>
            <button type="button" tabIndex={-1} className="editor-tab__close" aria-label={t('tabs.close', { name })} title={t('tabs.close', { name })} onClick={() => onClose(doc.key)}>
              <IconClose size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function TabMarks({ doc, session }: { doc: OpenDoc; session: DocSession | undefined }) {
  const pendingSave = useStore(session ?? NO_SESSION, (state) => state?.pendingSave === true);
  const liveLock = useStore(useStores().locks, (state) => liveLockOf(state, doc.file));
  const lock = liveLock === undefined ? doc.lock : liveLock;
  if (doc.status === 'error') {
    return (
      <span className="editor-tab__mark editor-tab__mark--error" role="img" aria-label={t('tabs.error')}>
        <IconAlertCircle size={12} />
      </span>
    );
  }
  if (doc.removed !== null) {
    return (
      <span className="editor-tab__mark editor-tab__mark--error" role="img" aria-label={t('tabs.removed')}>
        <IconAlertCircle size={12} />
      </span>
    );
  }
  if (lock?.kind === 'agent') {
    return (
      <span className="editor-tab__mark editor-tab__mark--agent" role="img" aria-label={t('tabs.agentLocked', { agent: lock.agentName })}>
        <IconAgent size={12} />
      </span>
    );
  }
  if (doc.status === 'open' && !doc.editableBase) {
    return (
      <span className="editor-tab__mark" role="img" aria-label={t('tabs.readOnly')}>
        <IconEye size={12} />
      </span>
    );
  }
  if (pendingSave) return <span className="editor-tab__mark editor-tab__mark--unsaved" role="img" aria-label={t('tabs.unsaved')} />;
  return null;
}

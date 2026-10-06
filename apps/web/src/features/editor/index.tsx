// The editor area (SPEC R7 editor + presence, R8 lock UI, R6 selection → agent): tabs over the docs store's open
// documents, one DocumentPane each. The Yjs side lives in doc-session.ts (one replica + provider per open document,
// kept even while this area is not mounted); Monaco is loaded lazily through engine.ts → lib/lazy.ts.
//
// Handles the `openFile` command (file tree, activity feed, clickable paths in agent output).
//
// A document that only a column of the sessions view holds (a topic's SPEC.md in its spec column: doc-holds.ts) is in
// the same registry but is not a tab here until someone opens it in the editor too.
import { fileRefKey } from '@smurg/protocol';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectWorktreeList, worktreeLabel } from '../../lib/stores/worktrees.ts';
import { useCommandHandler, useStores } from '../../lib/workspace/context.tsx';
import { EmptyState } from '../../ui/index.ts';
import { IconFileText } from '../../ui/icons.tsx';
import { docHoldsFor, selectEditorDocs } from './doc-holds.ts';
import { docSessionsFor } from './doc-session.ts';
import { DocumentPane } from './DocumentPane.tsx';
import type { RevealRequest } from './DocumentView.tsx';
import { EditorTabs } from './EditorTabs.tsx';
import { t } from './strings.ts';
import './editor.css';

export type EditorAreaProps = Record<never, never>;

export function EditorArea(_props: EditorAreaProps) {
  const stores = useStores();
  const registry = useMemo(() => docSessionsFor({ docs: stores.docs, connection: stores.connection }), [stores]);
  const columnOnly = useStore(useMemo(() => docHoldsFor(stores.docs), [stores]));
  const docs = useStore(stores.docs, (state) => selectEditorDocs(state, columnOnly), shallowEqual);
  const activeKey = useStore(stores.docs, (state) => state.activeKey);
  const worktrees = useStore(stores.worktrees, selectWorktreeList, shallowEqual);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const revealSeq = useRef(0);
  const base = useId();
  const domIds = useRef(new Map<string, number>());

  const idsOf = useCallback(
    (key: string) => {
      let n = domIds.current.get(key);
      if (n === undefined) {
        n = domIds.current.size + 1;
        domIds.current.set(key, n);
      }
      return { tabId: `${base}-tab-${n}`, panelId: `${base}-panel-${n}` };
    },
    [base],
  );

  const open = useCallback(
    (file: Parameters<typeof stores.docs.open>[0]): Promise<void> =>
      stores.docs.open(file).then(
        () => undefined,
        // The tab shows why (too large, binary, not UTF-8, …) with a download offer: nothing to rethrow.
        (error: unknown) => registry.get(fileRefKey(file))?.setOpenFailure(error),
      ),
    [stores, registry],
  );

  useCommandHandler('openFile', async ({ file, line, column }) => {
    if (line !== undefined) {
      revealSeq.current++;
      setReveal({ key: fileRefKey(file), line, ...(column === undefined ? {} : { column }), seq: revealSeq.current });
    }
    await open(file);
  });

  const rootLabel = (key: string): string => {
    const doc = docs.find((d) => d.key === key);
    if (!doc || doc.file.root.kind === 'main') return t('root.main');
    const { worktreeId } = doc.file.root;
    const worktree = worktrees.find((w) => w.id === worktreeId);
    return worktree ? worktreeLabel(worktree, { selfUserId: stores.workspace.getState().member?.userId ?? null, sessions: stores.sessions.getState().sessions }) : t('root.worktree', { name: worktreeId });
  };

  if (docs.length === 0) {
    return (
      <section className="editor-area editor-area--empty" aria-label={t('title')}>
        <EmptyState icon={<IconFileText size={24} />} title={t('empty.title')} description={t('empty.hint')} />
      </section>
    );
  }

  return (
    <section className="editor-area" aria-label={t('title')}>
      <EditorTabs
        docs={docs}
        activeKey={activeKey}
        sessionOf={(key) => registry.get(key)}
        idsOf={idsOf}
        onActivate={(key) => stores.docs.activate(key)}
        onClose={(key) => stores.docs.close(key)}
      />
      <div className="editor-area__panes">
        {docs.map((doc) => {
          const { tabId, panelId } = idsOf(doc.key);
          return (
            <DocumentPane
              key={doc.key}
              doc={doc}
              session={registry.get(doc.key)}
              active={doc.key === activeKey}
              tabId={tabId}
              panelId={panelId}
              rootLabel={rootLabel(doc.key)}
              reveal={reveal !== null && reveal.key === doc.key ? reveal : null}
              onRevealed={(seq) => setReveal((current) => (current?.seq === seq ? null : current))}
              onClose={() => stores.docs.close(doc.key)}
              onReopen={() => void open(doc.file)}
            />
          );
        })}
      </div>
    </section>
  );
}

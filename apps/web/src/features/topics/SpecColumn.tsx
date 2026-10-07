// The spec column (DESIGN §5.4, §5.12 item 19): a topic's `specs/<slug>/SPEC.md`.
//
//   Read   the rendered Markdown of the document's live text, cut at its `##` headings so each section can be sent to
//          the agent ("Ask the agent to revise 'Payments'"); "Changed by Claude at 14:05, asked by Mei · Show in the
//          discussion" from `spec.lastAgentChange`.
//   Edit   the collaborative editor on the same document (features/editor: cursors, the lock banner, the deleted-file
//          state come with it). Viewers read.
//
// At the foot: the discussion's status line, or the revise box. "Generate plan" asks first only when something is odd
// (someone is typing in the spec, the spec lists open questions, a question is open in the discussion), then opens the
// plan column beside this one at once.
import { fileRefKey, type Topic } from '@smurg/protocol';
import { useEffect, useMemo, useState } from 'react';
import { formatAnd } from '../../lib/format.ts';
import { ColumnMenuItems } from '../../lib/columns/context.tsx';
import { useStore } from '../../lib/store.ts';
import { useCan, useCommand, useMember, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Button, Dialog, EmptyState, IconButton, Segmented, Spinner, type MenuItem } from '../../ui/index.ts';
import { IconAgent, IconCode, IconEdit, IconEye, IconFileText, IconPlan, IconWand } from '../../ui/icons.tsx';
import { StandaloneDocument, useDocumentText, useHeldDocument } from '../editor/standalone.tsx';
import { MarkdownPieces } from '../markdown/index.ts';
import { DiscussionFoot, ReviseBox, useDiscussion, type ReviseQuote } from './Discussion.tsx';
import { oneOrMany, specFile, specOpenQuestions, specSections } from './model.ts';
import { Foot, LinkButton, Note, Scroll, Toolbar, ToolbarPath, formatClock, useAction, useOpenSide, useTopic } from './shared.tsx';
import { t } from './strings.ts';
import './topics.css';

type View = 'read' | 'edit';

export default function SpecColumn({ topicId }: { topicId: string }) {
  const topic = useTopic(topicId);
  if (topic === undefined) {
    return (
      <Note>
        <Spinner size={16} decorative /> {t('loading')}
      </Note>
    );
  }
  return <Spec key={topic.id} topic={topic} />;
}

function Spec({ topic }: { topic: Topic }) {
  const stores = useStores();
  const act = useAction();
  const openSide = useOpenSide();
  const openInCodeMode = useCommand('openInCodeMode');
  const member = useMember();
  const canWrite = useCan('file.write');
  const canSuggest = useCan('suggest.create');
  const canDrive = useCan('session.drive');
  const file = useMemo(() => specFile(topic), [topic.slug]);
  const held = useHeldDocument(topic.spec.exists ? file : null);
  const text = useDocumentText(held?.session);
  const discussion = useDiscussion(topic);
  const lock = useStore(stores.locks, (state) => state.locks.get(fileRefKey(file)));
  const [view, setView] = useState<View>('read');
  const [edited, setEdited] = useState(false);
  const [revise, setRevise] = useState<{ quote: ReviseQuote | null } | null>(null);
  const [confirm, setConfirm] = useState<readonly string[] | null>(null);
  const [asking, setAsking] = useState(false);
  const live = !topic.archived;

  // The editor is created the first time "Edit" is shown, then kept (hidden) like a tab's.
  useEffect(() => {
    if (view === 'edit') setEdited(true);
  }, [view]);
  // A viewer who was demoted while editing goes back to reading.
  useEffect(() => {
    if (!canWrite && view === 'edit') setView('read');
  }, [canWrite, view]);

  const sections = useMemo(() => (text === null ? [] : specSections(text)), [text]);
  const sectionTexts = useMemo(() => sections.map((section) => section.text), [sections]);

  const generate = async (): Promise<void> => {
    setConfirm(null);
    const sent = await act(
      () => stores.topics.generatePlan(topic.id),
      (reason) => t('spec.generate.failed', { reason }),
    );
    if (sent) openSide({ kind: 'plan', topicId: topic.id });
  };

  /** What is odd right now, as sentences; empty: generate without asking. */
  const oddities = (): string[] => {
    const lines: string[] = [];
    const typing = lock?.kind === 'human' ? lock.holders.filter((holder) => holder.userId !== member?.userId) : [];
    if (typing.length > 0) lines.push(t(`spec.odd.editing.${oneOrMany(typing.length)}`, { names: formatAnd(typing.map((holder) => holder.displayName)) }));
    const open = text === null ? 0 : specOpenQuestions(text);
    if (open > 0) lines.push(t('spec.odd.openQuestions', { count: open }));
    if (discussion?.status === 'waiting-answer') lines.push(t('spec.odd.question'));
    return lines;
  };

  const onGenerate = (): void => {
    const lines = oddities();
    if (lines.length > 0) setConfirm(lines);
    else void generate();
  };

  const menu = useMemo<MenuItem[]>(
    () =>
      topic.spec.exists
        ? [{ id: 'spec-code', label: t('menu.openInCode'), icon: <IconCode />, onSelect: () => void openInCodeMode({ root: file.root, file: file.path }).catch(() => {}) }]
        : [],
    [topic.spec.exists, file, openInCodeMode],
  );

  if (!topic.spec.exists) {
    return (
      <>
        <Scroll>
          <EmptyState
            icon={<IconFileText size={24} />}
            title={t('spec.empty.title')}
            description={t('spec.empty.body')}
            action={
              <div className="topics-actions">
                {canDrive && live && topic.discussion === 'live' ? (
                  <Button
                    variant="primary"
                    icon={<IconWand />}
                    loading={asking}
                    onClick={() => {
                      setAsking(true);
                      void act(
                        () => stores.topics.requestSpec(topic.id),
                        (reason) => t('spec.request.failed', { reason }),
                      ).finally(() => setAsking(false));
                    }}
                  >
                    {t('spec.request')}
                  </Button>
                ) : null}
                {topic.discussionSessionId !== undefined ? (
                  <Button onClick={() => openSide({ kind: 'session', sessionId: topic.discussionSessionId as string })}>{t('discussion.open')}</Button>
                ) : null}
              </div>
            }
          />
        </Scroll>
        <DiscussionFoot topic={topic} />
      </>
    );
  }

  const change = topic.spec.lastAgentChange;
  return (
    <>
      <ColumnMenuItems items={menu} />
      <Toolbar>
        {/* A viewer has nothing to switch to: no greyed "Edit" (whose reason only a pointer could reach), and a
            sentence at the foot that says who can edit (UX §10). */}
        {canWrite ? (
          <Segmented<View>
            label={t('spec.view')}
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { id: 'read', label: t('view.read'), icon: <IconEye size={14} /> },
              { id: 'edit', label: t('view.edit'), icon: <IconEdit size={14} />, disabled: !live },
            ]}
          />
        ) : null}
        <ToolbarPath path={file.path} />
        {canSuggest && live ? (
          <Button size="sm" icon={<IconWand />} onClick={() => setRevise({ quote: null })}>
            {t('revise.open')}
          </Button>
        ) : null}
        {canDrive && live ? (
          <Button size="sm" variant={topic.plan.exists ? 'secondary' : 'primary'} icon={<IconPlan />} disabled={topic.plan.generating} onClick={onGenerate}>
            {topic.plan.exists ? t('plan.update') : t('plan.generate')}
          </Button>
        ) : null}
      </Toolbar>
      <Scroll hidden={view !== 'read'}>
        <article className="spec col-measure" aria-label={t('spec.read.label')}>
          {change !== undefined ? (
            <p className="spec__meta">
              <IconAgent size={12} />{' '}
              {change.askedBy === undefined ? t('spec.changed', { time: formatClock(change.at) }) : t('spec.changedAsked', { time: formatClock(change.at), name: change.askedBy.displayName })}
              {t('sep')}
              <LinkButton onClick={() => openSide({ kind: 'session', sessionId: change.sessionId }, { seq: change.seq })}>{t('spec.showInDiscussion')}</LinkButton>
            </p>
          ) : null}
          {text === null ? (
            held?.doc?.status === 'error' ? (
              <p className="spec__meta">{t('spec.unreadable')}</p>
            ) : (
              <p className="spec__meta">
                <Spinner size={14} decorative /> {t('loading')}
              </p>
            )
          ) : text.trim() === '' ? (
            <p className="spec__meta">{t('spec.blank')}</p>
          ) : (
            // One text to the renderer's bounds, however many sections it is cut into (features/markdown lex.ts).
            <MarkdownPieces text={text} pieces={sectionTexts} headingBase={3}>
              {(body, index) => {
                const section = sections[index];
                return (
                  <div key={index} className="spec-block">
                    {section !== undefined && section.heading !== null && canSuggest && live ? (
                      <span className="spec-block__actions">
                        <IconButton
                          size="sm"
                          label={t('revise.section', { heading: section.heading })}
                          icon={<IconWand />}
                          onClick={() => setRevise({ quote: { heading: section.heading as string, text: section.text } })}
                        />
                      </span>
                    ) : null}
                    {body}
                  </div>
                );
              }}
            </MarkdownPieces>
          )}
        </article>
      </Scroll>
      {held !== null && edited ? (
        <div className="topics-editor" hidden={view !== 'edit'}>
          <StandaloneDocument held={held} active={view === 'edit'} />
        </div>
      ) : null}
      {canWrite ? null : <Foot className="topics-foot--status" text={t('view.edit.viewer')} />}
      {revise !== null && live ? (
        <ReviseBox topic={topic} target="spec" quote={revise.quote} onQuoteRemoved={() => setRevise({ quote: null })} onClose={() => setRevise(null)} />
      ) : (
        <DiscussionFoot topic={topic} />
      )}
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        role="alertdialog"
        size="sm"
        title={topic.plan.exists ? t('spec.confirm.titleUpdate') : t('spec.confirm.title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {tApp('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void generate()}>
              {topic.plan.exists ? t('spec.confirm.goUpdate') : t('spec.confirm.go')}
            </Button>
          </>
        }
      >
        <ul className="topics-list">{confirm?.map((line) => <li key={line}>{line}</li>)}</ul>
      </Dialog>
    </>
  );
}

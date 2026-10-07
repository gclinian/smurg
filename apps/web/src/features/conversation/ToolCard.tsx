// Tool actions of the agent (UX §4): one compact line each, a native <details> that opens to the diff, the output
// or the list. The body is built when the line is first opened, so a conversation with a thousand tool cards mounts a
// thousand short lines. A subagent's (Task) own pieces nest under its line.
import { memo, useMemo, useState, type ReactNode } from 'react';
import { fileRefEquals, type FileRef, type PermissionRequest, type ToolResultView, type ToolView } from '@smurg/protocol';
import { formatDuration } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { INITIAL_CONVERSATIONS_STATE, type AgentPiece, type ConversationsState, type ReadsItem, type ToolItem } from '../../lib/stores/conversations.ts';
import { useCapabilities, useCommands, useStores } from '../../lib/workspace/context.tsx';
import { Button } from '../../ui/index.ts';
import { IconAgent, IconCheck, IconChevronRight, IconEdit, IconFile, IconFileText, IconGlobe, IconSearch, IconShield, IconTerminal, IconWand, type IconComponent } from '../../ui/icons.tsx';
import { parseDiff, type DiffLine } from './diff.ts';
import { useConversationEnv } from './env.tsx';
import { useHostDialogs } from './host-dialogs.ts';
import { t } from './strings.ts';
import { commonDir } from './text.ts';

// ---- the diff view (also the permission card's: a person never allows an edit they cannot see)

const SIGN: Readonly<Record<DiffLine['kind'], string>> = { add: '+', del: '-', context: ' ', hunk: '', meta: '' };

export function DiffView({ diff, path }: { diff: string; path?: string }) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  return (
    <pre className="conv-diff" tabIndex={0} aria-label={path === undefined ? t('diff.labelPlain') : t('diff.label', { path })}>
      {lines.map((line, index) => (
        <span key={index} className={`conv-diff__line conv-diff__line--${line.kind}`}>
          <span className="conv-diff__num" aria-hidden="true">
            {line.number ?? ''}
          </span>
          <span className="conv-diff__text">
            {line.kind === 'add' ? <span className="ui-visually-hidden">{t('diff.added')} </span> : null}
            {line.kind === 'del' ? <span className="ui-visually-hidden">{t('diff.removed')} </span> : null}
            {line.kind === 'hunk' || line.kind === 'meta' ? line.text : `${SIGN[line.kind]} ${line.text}`}
          </span>
        </span>
      ))}
    </pre>
  );
}

// ---- one tool

const ICONS: Readonly<Record<ToolView['verb'], IconComponent>> = {
  read: IconFileText,
  edit: IconEdit,
  create: IconFile,
  run: IconTerminal,
  search: IconSearch,
  fetch: IconGlobe,
  task: IconAgent,
  smurg: IconShield,
  todo: IconCheck,
  other: IconWand,
};

/**
 * What became of a tool call, as its line says it:
 * - `running`: it runs now ("Running pnpm test");
 * - `done`: it had its effect ("Edited src/app.ts", "Ran pnpm test · exit 1": a command that ran and failed did run);
 * - `call`: it has not had its effect, or never will, and the line must not read as if it had ("Command pnpm test"
 *   beside "waiting", "Edit of SPEC.md" beside "failed", "Command pnpm build" beside "not finished").
 */
export type ToolLineState = 'running' | 'done' | 'call';

/** "Edited", "Running", "Edit of", "Used WebSearch": how a tool line starts, by what became of the call. */
export function toolVerbLabel(tool: ToolView, state: ToolLineState): string {
  const form = state === 'done' ? '' : (`.${state}` as const);
  if (tool.verb === 'other') return t(`tool.other${form}`, { name: tool.name });
  return t(`tool.${tool.verb}${form}`);
}

/**
 * Whether `request` is the open permission request of this call. A request does not name its call; it carries the
 * same tool, and the same file, command or address (the daemon builds both from one call).
 *
 * `outside` means two things: on a call it says that the file it reads or writes lies outside the workspace (and
 * nothing else of it is shown); on a request it also marks a COMMAND that names a path out there, whose call is an
 * ordinary "run" with its command. So a command is told by its text, whatever else the card says, and `outside`
 * decides only where neither side names a file inside the workspace or a command.
 */
export function asksFor(request: PermissionRequest, tool: ToolView): boolean {
  if (request.status !== 'open' || request.tool !== tool.name) return false;
  if (request.file !== undefined || tool.file !== undefined) return request.file !== undefined && tool.file !== undefined && fileRefEquals(request.file, tool.file);
  const named = request.command ?? request.url;
  if (named !== undefined) return named === tool.target;
  if (request.outside === true || tool.outside === true) return request.outside === true && tool.outside === true;
  return true;
}

/** What the line names: the path, the command, the pattern; an outside path is never shown. */
export function toolTarget(tool: ToolView): string {
  if (tool.outside === true && tool.target === undefined) return t('tool.outside');
  return tool.target ?? tool.file?.path ?? '';
}

function ResultMeta({ result, ok }: { result: ToolResultView; ok: boolean }) {
  const parts: ReactNode[] = [];
  if (result.additions !== undefined || result.deletions !== undefined) {
    parts.push(
      <span key="adds" className="conv-tool__adds">
        +{result.additions ?? 0}
      </span>,
      <span key="dels" className="conv-tool__dels">
        {'−'}
        {result.deletions ?? 0}
      </span>,
    );
  }
  if (result.matches !== undefined) parts.push(<span key="matches">{t('tool.matches', { count: result.matches })}</span>);
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    parts.push(
      <span key="exit" className="conv-tool__fail">
        {t('tool.exit', { code: result.exitCode })}
      </span>,
    );
  } else if (!ok) {
    parts.push(
      <span key="failed" className="conv-tool__fail">
        {t('tool.failed')}
      </span>,
    );
  }
  if (result.durationMs !== undefined && result.durationMs >= 1_000) parts.push(<span key="time">{formatDuration(result.durationMs / 1_000)}</span>);
  return <>{parts}</>;
}

function ToolBody({ tool, result }: { tool: ToolView; result: ToolResultView | null }) {
  const body = result?.body;
  if (body === undefined) return result === null ? null : <p className="conv-tool__note">{t('tool.noDetails')}</p>;
  let content: ReactNode;
  if (body.kind === 'diff') {
    content = <DiffView diff={body.text} {...(tool.file === undefined ? {} : { path: tool.file.path })} />;
  } else if (body.kind === 'list') {
    content = (
      <ul className="conv-tool__list">
        {body.text
          .split('\n')
          .filter((line) => line !== '')
          .map((line, index) => (
            <li key={index}>{line}</li>
          ))}
      </ul>
    );
  } else {
    content = (
      <pre className="conv-tool__out" tabIndex={0}>
        {body.text}
      </pre>
    );
  }
  return (
    <>
      {content}
      {body.truncated ? <p className="conv-tool__note">{t('tool.truncated')}</p> : null}
    </>
  );
}

function OpenInEditor({ file }: { file: FileRef }) {
  const commands = useCommands();
  const { sessionId } = useConversationEnv();
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<IconFileText />}
      onClick={() => {
        void commands.dispatch('openInCodeMode', { root: file.root, file: file.path, sessionId }).catch(() => {});
      }}
    >
      {t('tool.open')}
    </Button>
  );
}

/** Under an opened tool line: open its file; for the host, remove the call or its result from the conversation. */
function ToolActions({ item, file }: { item: ToolItem; file: FileRef | undefined }) {
  const hostDialogs = useHostDialogs();
  const caps = useCapabilities();
  const { sessionId } = useConversationEnv();
  const host = caps.can('admin');
  if (file === undefined && !host) return null;
  return (
    <div className="conv-tool__actions">
      {file !== undefined ? <OpenInEditor file={file} /> : null}
      {host ? (
        <Button size="sm" variant="ghost" onClick={() => hostDialogs.redact(sessionId, item.started.seq)}>
          {t('redact')}
        </Button>
      ) : null}
      {host && item.finished !== null && item.finished.result.body !== undefined ? (
        <Button size="sm" variant="ghost" onClick={() => hostDialogs.redact(sessionId, (item.finished as NonNullable<ToolItem['finished']>).seq)}>
          {t('redact.result')}
        </Button>
      ) : null}
    </div>
  );
}

const NO_CONVERSATIONS = { getState: (): ConversationsState => INITIAL_CONVERSATIONS_STATE, subscribe: () => () => {} };

export interface ToolCardProps {
  readonly item: ToolItem;
  /** How the nested pieces of a subagent are drawn (the event list's own renderer). */
  renderPiece(piece: AgentPiece): ReactNode;
}

export const ToolCard = memo(function ToolCard({ item, renderPiece }: ToolCardProps) {
  const { tool, finished, running } = item;
  const stores = useStores();
  const { sessionId } = useConversationEnv();
  // The daemon says a call has started before its permission is decided: until then the call does not run, it waits.
  // Only a call without a result listens (a long conversation mounts a thousand finished lines).
  const waiting = useStore(running ? stores.conversations : NO_CONVERSATIONS, (state) => {
    for (const request of state.conversations.get(sessionId)?.permissions.values() ?? []) if (asksFor(request, tool)) return true;
    return false;
  });
  const isTask = tool.verb === 'task';
  // A subagent at work shows what it does; everything else opens when asked.
  const [open, setOpen] = useState(isTask && running);
  const [built, setBuilt] = useState(open);
  const Icon = ICONS[tool.verb];
  const target = toolTarget(tool);
  const exited = finished?.result.exitCode !== undefined;
  const failed = finished !== null && (!finished.ok || (exited && finished.result.exitCode !== 0));
  // The turn ended without this call's result (it was stopped, or its process died, often while a permission request
  // was open): the line must not read as if the command ran or the file was changed.
  const unfinished = finished === null && !running;
  // A call that failed without an exit code did not do what its verb says (the edit was refused, the command was
  // denied): only a command that ran and came back with a code reads as run.
  const state: ToolLineState = running ? (waiting ? 'call' : 'running') : unfinished || (failed && !exited) ? 'call' : 'done';
  const canOpenFile = tool.file !== undefined && tool.outside !== true && tool.verb !== 'run';
  return (
    <details
      className="conv-tool"
      data-tool={tool.name}
      data-state={waiting ? 'waiting' : running ? 'running' : unfinished ? 'unfinished' : failed ? 'failed' : 'done'}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next) setBuilt(true);
      }}
    >
      <summary>
        <span className="conv-tool__icon">
          <Icon size={14} />
        </span>
        <span className="conv-tool__verb">{toolVerbLabel(tool, state)}</span>
        <span className="conv-tool__target" title={target}>
          {target}
        </span>
        <span className="conv-tool__meta">
          {running ? <span>{t(waiting ? 'tool.waiting' : 'tool.running')}</span> : null}
          {unfinished ? <span>{t('tool.unfinished')}</span> : null}
          {finished !== null ? <ResultMeta result={finished.result} ok={finished.ok} /> : null}
          {isTask && item.children.length > 0 ? <span>{t('tool.steps', { count: item.children.length })}</span> : null}
        </span>
        <span className="conv-tool__chev">
          <IconChevronRight size={12} />
        </span>
      </summary>
      {built ? (
        <>
          {item.children.length > 0 ? <div className="conv-tool__children">{item.children.map((piece) => renderPiece(piece))}</div> : null}
          <div className="conv-tool__body">
            <ToolBody tool={tool} result={finished?.result ?? null} />
          </div>
          <ToolActions item={item} file={canOpenFile ? tool.file : undefined} />
        </>
      ) : null}
    </details>
  );
});

/** What became of one read of a group. */
type ReadState = 'done' | 'running' | 'waiting' | 'failed' | 'unfinished';

/** The word beside a read that did not simply go through, in the list and (for the whole group) on the line. */
const READ_WORD: Readonly<Record<Exclude<ReadState, 'done'>, 'tool.running' | 'tool.waiting' | 'tool.failed' | 'tool.unfinished'>> = {
  running: 'tool.running',
  waiting: 'tool.waiting',
  failed: 'tool.failed',
  unfinished: 'tool.unfinished',
};

/**
 * Two or more file reads in a row: "Read 4 files in src/cart", opening to the list. The line says what became of
 * them, like a single tool line does: "Reading … running" only while one of them really reads, "Read of … waiting"
 * while one waits at its permission card (a read outside the workspace asks), and how many were refused or never
 * finished. The list marks each such read.
 */
export const ReadsCard = memo(function ReadsCard({ item }: { item: ReadsItem }) {
  const commands = useCommands();
  const stores = useStores();
  const { sessionId } = useConversationEnv();
  const [built, setBuilt] = useState(false);
  const running = item.tools.some((tool) => tool.running);
  // Which of the reads without a result wait at an open permission card (only a group with such a read listens).
  const waitingKeys = useStore(running ? stores.conversations : NO_CONVERSATIONS, (state) => {
    const open = [...(state.conversations.get(sessionId)?.permissions.values() ?? [])].filter((request) => request.status === 'open');
    if (open.length === 0) return '';
    return item.tools
      .filter((tool) => tool.running && open.some((request) => asksFor(request, tool.tool)))
      .map((tool) => tool.key)
      .join('\n');
  });
  const waits = new Set(waitingKeys === '' ? [] : waitingKeys.split('\n'));
  const stateOf = (tool: ToolItem): ReadState => (tool.finished !== null ? (tool.finished.ok ? 'done' : 'failed') : !tool.running ? 'unfinished' : waits.has(tool.key) ? 'waiting' : 'running');
  const states = item.tools.map(stateOf);
  const countOf = (state: ReadState): number => states.filter((one) => one === state).length;
  const group: ReadState = countOf('waiting') > 0 ? 'waiting' : countOf('running') > 0 ? 'running' : countOf('failed') > 0 ? 'failed' : countOf('unfinished') > 0 ? 'unfinished' : 'done';
  // "Read" is true as soon as one of them was read; with none read, or while one waits, the line names the calls.
  const verb = group === 'running' ? t('tool.read.running') : group === 'waiting' || countOf('done') === 0 ? t('tool.read.call') : t('tool.read');
  const paths = item.tools.map((tool) => tool.tool.file?.path ?? toolTarget(tool.tool));
  const dir = item.tools.every((tool) => tool.tool.file !== undefined) ? commonDir(paths) : null;
  const count = item.tools.length;
  return (
    <details className="conv-tool" data-tool="Read" data-state={group} onToggle={(event) => event.currentTarget.open && setBuilt(true)}>
      <summary>
        <span className="conv-tool__icon">
          <IconFileText size={14} />
        </span>
        <span className="conv-tool__verb">{verb}</span>
        <span className="conv-tool__target conv-tool__target--plain">{dir === null ? t('tool.reads', { count }) : t('tool.readsIn', { count, dir })}</span>
        <span className="conv-tool__meta">
          {group === 'waiting' || group === 'running' ? <span>{t(READ_WORD[group])}</span> : null}
          {group !== 'waiting' && group !== 'running' && countOf('failed') > 0 ? <span className="conv-tool__fail">{t('tool.reads.failed', { count: countOf('failed') })}</span> : null}
          {group !== 'waiting' && group !== 'running' && countOf('unfinished') > 0 ? <span>{t('tool.reads.unfinished', { count: countOf('unfinished') })}</span> : null}
        </span>
        <span className="conv-tool__chev">
          <IconChevronRight size={12} />
        </span>
      </summary>
      {built ? (
        <ul className="conv-tool__list">
          {item.tools.map((tool, index) => {
            const file = tool.tool.file;
            const label = toolTarget(tool.tool);
            const state = states[index] as ReadState;
            return (
              <li key={tool.key} data-state={state}>
                {file !== undefined && tool.tool.outside !== true ? (
                  <button
                    type="button"
                    className="conv-link"
                    title={t('tool.open')}
                    onClick={() => {
                      void commands.dispatch('openInCodeMode', { root: file.root, file: file.path, sessionId }).catch(() => {});
                    }}
                  >
                    {label}
                  </button>
                ) : (
                  label
                )}
                {state === 'done' ? null : <span className={state === 'failed' ? 'conv-tool__fail' : undefined}>{` \u00b7 ${t(READ_WORD[state])}`}</span>}
              </li>
            );
          })}
        </ul>
      ) : null}
    </details>
  );
});

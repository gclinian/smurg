// The sticky notes (/w/:workspaceId/notes[/:name]; DESIGN 0.8.0 D7.2, D7.7):
//
//   ┌ all sticky notes ─┬ the open sticky note ─────────────┬ Claude for the sticky notes ┐
//   │ Home              │  ┌─────────────────────────────┐  │ Sticky notes                │
//   │   Checkout        │  │ Home                        │  │ the conversation            │
//   │   Payment form    │  │ ...                         │  │ ...                         │
//   │ Not linked        │  └─────────────────────────────┘  │ [ Message Claude ]          │
//   └───────────────────┴───────────────────────────────────┴─────────────────────────────┘
//
// The list and Claude's pane are resizable (their widths under smurg.pane.notes-tree and smurg.pane.notes-chat; no
// field of smurg.layout, no layout toggles). The open note is in the address; the unfolded rows live in memory only.
// Landmarks: `complementary` "All sticky notes", `main` "Open sticky note", and Claude's pane, a region. F6 / Shift+F6
// move between the list, the note and Claude's pane.
//
// Claude's pane (D7.7) is the conversation of the one agent session of purpose `notes` that has not ended (D3.5),
// found in the sessions store: the frame of a column (features/columns ColumnFrame, keyed by the session's id) around
// the conversation feature's body, so its composer is the same as everywhere (a message for a member with agent
// access, a suggestion for an Editor, no box for a Viewer). Before the session list is loaded, a spinner; while there
// is none, or only an ended one: "Start Claude" / "Start Claude again" (sticky.assistant.start) for a member who may
// start sessions, a sentence for the others. "Ask Claude about this sticky note" (for a member with a box) puts the
// note's link and a space into that box's draft (features/conversation/drafts.ts), which takes the focus.
//
// This module is a lazy chunk (WorkspaceShell loads it when the sticky notes are first shown): the feature, its
// renderer and the shared documents it holds come with it, never with the sessions view.
import { isSessionOver, type AgentSession } from '@smurg/protocol';
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { columnId, type ColumnRef } from '../../lib/columns/target.ts';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { selectAgentList } from '../../lib/stores/sessions.ts';
import { useCan, useCapabilities, useStores, useWorkspaceSession } from '../../lib/workspace/context.tsx';
import { tWorkbench } from '../../strings/workbench.ts';
import { Button, Spinner, SplitPane } from '../../ui/index.ts';
import { IconAgent, IconPlay } from '../../ui/icons.tsx';
import { ColumnFrame } from '../../features/columns/index.tsx';
import { draftsOf } from '../../features/conversation/drafts.ts';
import { NoteTree, OpenNote } from '../../features/sticky/index.tsx';
import { MIN_NOTE_PX, MIN_RIGHT_OF_NOTES_TREE, MIN_SIDE_PX, NOTES_CHAT_DEFAULT_PX, NOTES_CHAT_MAX_PX, NOTES_TREE_DEFAULT_PX, NOTES_TREE_MAX_PX, NOTES_TREE_MIN_PX } from './layout-limits.ts';

export interface NotesViewProps {
  /** The sticky notes are the mode on screen. */
  shown: boolean;
  /** The note in the address; undefined: Home. */
  note?: string;
}

/** Where F6 lands, in order: the list (its first row with the tab stop, or its button), the open note's name, Claude's pane's title. */
function regionStops(root: HTMLElement): HTMLElement[] {
  const list = root.querySelector<HTMLElement>('.app-notes__tree [role="treeitem"][tabindex="0"]') ?? root.querySelector<HTMLElement>('.app-notes__tree button');
  return [list, ...root.querySelectorAll<HTMLElement>('[data-region-focus]')].filter((element): element is HTMLElement => element !== null && element.closest('[hidden]') === null);
}

/** Claude for the sticky notes as this page knows it (D3.5): the session list is loaded, the one that has not ended, whether one ended. */
interface NotesAssistant {
  readonly loaded: boolean;
  readonly live: AgentSession | null;
  readonly ended: boolean;
}

function useNotesAssistant(): NotesAssistant {
  const stores = useStores();
  const loaded = useStore(stores.sessions, (state) => state.status === 'ready');
  const live = useStore(stores.sessions, (state) => selectAgentList(state).find((session) => session.purpose === 'notes' && !isSessionOver(session)) ?? null);
  const ended = useStore(stores.sessions, (state) => selectAgentList(state).some((session) => session.purpose === 'notes' && isSessionOver(session)));
  return { loaded, live, ended };
}

const NO_ANCHOR = (): void => {};

/** The right of the notes view: Claude's conversation, or what stands in for it. */
function NotesChat({ shown, assistant }: { shown: boolean; assistant: NotesAssistant }) {
  const stores = useStores();
  const canStart = useCan('session.create');
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const liveId = assistant.live?.id ?? null;
  const target = useMemo<ColumnRef | null>(() => (liveId === null ? null : { kind: 'session', sessionId: liveId }), [liveId]);

  if (!assistant.loaded) {
    return (
      <div className="app-notes__claude app-notes__claude--waiting">
        <Spinner label={tWorkbench('notes.chat.loading')} />
      </div>
    );
  }
  if (target !== null) {
    return <ColumnFrame key={liveId} target={target} id={columnId(target)} place="notes" focused visible={shown} anchor={null} onAnchorShown={NO_ANCHOR} />;
  }
  const start = (): void => {
    setBusy(true);
    setProblem(null);
    stores.sessions
      .startNotesAssistant()
      .catch((error: unknown) => setProblem(tWorkbench('notes.chat.failed', { reason: describeError(error) })))
      .finally(() => setBusy(false));
  };
  return (
    <section className="app-notes__claude" aria-labelledby={headingId} data-region="">
      <span className="app-notes__claude-icon" aria-hidden="true">
        <IconAgent size={24} />
      </span>
      <h2 id={headingId} className="app-notes__claude-title" tabIndex={-1} data-region-focus="">
        {tWorkbench('region.notesChat')}
      </h2>
      <p className="app-notes__claude-line">{assistant.ended ? tWorkbench('notes.chat.ended') : tWorkbench('notes.chat.none')}</p>
      {canStart ? (
        <Button variant="primary" icon={<IconPlay size={14} />} loading={busy} onClick={start}>
          {assistant.ended ? tWorkbench('notes.chat.again') : tWorkbench('notes.chat.start')}
        </Button>
      ) : (
        <p className="app-notes__claude-line">{tWorkbench('notes.chat.others')}</p>
      )}
      {problem !== null ? (
        <p className="app-notes__claude-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

export default function NotesView({ shown, note }: NotesViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const workspace = useWorkspaceSession();
  const caps = useCapabilities();
  const assistant = useNotesAssistant();
  const liveId = assistant.live?.id ?? null;
  // A member with a box in Claude's conversation: a message (agent access) or a suggestion (an Editor).
  const hasBox = liveId !== null && (caps.canDrive || caps.can('suggest.create'));
  // The link and a space, on the line the question goes on: a line that is only `[[Name]]` would look like the header
  // of a message, and the daemon puts `> ` in front of such a line (agentText, @smurg/protocol), so everyone would see
  // the person's own message quoted.
  const askClaude = useCallback(
    (name: string): void => {
      if (liveId !== null) draftsOf(workspace, workspace.workspaceId).append(liveId, `[[${name}]] `, null);
    },
    [liveId, workspace],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey || !root.current) return;
    const stops = regionStops(root.current);
    if (stops.length === 0) return;
    event.preventDefault();
    const active = document.activeElement;
    // The region the focus is in: the last stop at or before the focused element in document order.
    let current = -1;
    stops.forEach((stop, index) => {
      if (active !== null && (stop === active || (stop.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)) current = index;
    });
    const next = event.shiftKey ? (current <= 0 ? stops.length - 1 : current - 1) : (current + 1) % stops.length;
    stops[next]?.focus();
  };

  return (
    <div ref={root} className="app-notes" onKeyDown={onKeyDown}>
      <a className="ui-skip-link" href="#notes-main">
        {tWorkbench('skip.note')}
      </a>
      <div className="app-notes__body">
        <SplitPane
          orientation="horizontal"
          fixed="start"
          defaultSize={NOTES_TREE_DEFAULT_PX}
          minSize={NOTES_TREE_MIN_PX}
          maxSize={NOTES_TREE_MAX_PX}
          minOtherSize={MIN_RIGHT_OF_NOTES_TREE}
          storageKey="notes-tree"
          label={tWorkbench('region.notesTree')}
          start={
            <aside className="app-notes__tree" aria-label={tWorkbench('region.notesTree')}>
              <NoteTree open={note} />
            </aside>
          }
          end={
            <SplitPane
              orientation="horizontal"
              fixed="end"
              defaultSize={NOTES_CHAT_DEFAULT_PX}
              minSize={MIN_SIDE_PX}
              maxSize={NOTES_CHAT_MAX_PX}
              minOtherSize={MIN_NOTE_PX}
              storageKey="notes-chat"
              label={tWorkbench('region.notesChat')}
              start={
                <main id="notes-main" className="app-notes__main" aria-label={tWorkbench('region.note')} tabIndex={-1}>
                  <OpenNote note={note} shown={shown} {...(hasBox ? { onAskClaude: askClaude } : {})} />
                </main>
              }
              end={
                <div className="app-notes__chat">
                  <NotesChat shown={shown} assistant={assistant} />
                </div>
              }
            />
          }
        />
      </div>
    </div>
  );
}

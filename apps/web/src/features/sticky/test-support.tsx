// TEST ONLY. The sticky notes on a FakeConnection: the list of notes and the open note as the notes view composes them,
// with the address of a memory router, the index the test gives (sticky.list), and the notes' files in test rooms
// (bridgeDocs answers doc.open and moves the Yjs traffic). The editor of "Edit" runs on the fake engine (no Monaco in
// jsdom): `fake` records what it was asked. The feedback the host answers with (sticky.feedback.list) is the test's
// `feedback`; the members' presence (whose roles "What Claude gets" names) is `members`.
import { fileRefKey, type Feedback, type Member, type NoteInfo, type ResultOf, type Role } from '@smurg/protocol';
import { act, render } from '@testing-library/react';
import { useRoute } from '../../app/navigation.tsx';
import { HOST_USER, WORKSPACE_ID, makeMember, presenceOf } from '../../testing/fixtures.ts';
import { answerLoads } from '../../testing/stores.ts';
import { createTestServices, createTestWorkspace, WorkspaceTestProviders } from '../../testing/services.tsx';
import { EditorEngineContext } from '../editor/engine.ts';
import { createFakeEngine } from '../editor/testing/fake-engine.ts';
import { bridgeDocs, testUser } from '../editor/testing/test-room.ts';
import { NoteTree, OpenNote } from './index.tsx';
import { noteFile } from './model.ts';

export const NOTES_PATH = `/w/${WORKSPACE_ID}/notes`;
export const notePath = (name: string): string => `${NOTES_PATH}/${encodeURIComponent(name)}`;

/** Home → Checkout → Payment form, Home → Ideas; Apple and Zebra are linked from nowhere. */
export const NOTES: readonly NoteInfo[] = [
  { name: 'Apple', links: [] },
  { name: 'Checkout', links: ['Payment form', 'Home'] },
  { name: 'Home', links: ['Checkout', 'Ideas'] },
  { name: 'Ideas', links: ['Checkout'] },
  { name: 'Payment form', links: [] },
  { name: 'Zebra', links: [] },
];

export const TEXTS: Readonly<Record<string, string>> = {
  Apple: 'An apple.',
  Checkout: '# Checkout\n\nPay with [[Payment form]]. Back to [[home]].',
  Home: '# Welcome\n\nStart at [[Checkout]], or read [[Ideas]]. Later: [[Refunds]].\n\n- `[[Not a link]]`',
  Ideas: 'More about [[Checkout]].',
  'Payment form': 'Card and invoice.',
  Zebra: '',
};

/** The notes view's two parts, at the note of the address, on screen. */
function Notes({ onAskClaude }: { onAskClaude?: (name: string) => void }) {
  const route = useRoute();
  const note = route.name === 'notes' ? route.note : undefined;
  return (
    <>
      <aside aria-label="All sticky notes">
        <NoteTree open={note} />
      </aside>
      <main aria-label="Open sticky note">
        <OpenNote note={note} shown {...(onAskClaude === undefined ? {} : { onAskClaude })} />
      </main>
    </>
  );
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface NotesOptions {
  readonly role?: Role;
  readonly path?: string;
  readonly notes?: readonly NoteInfo[];
  readonly texts?: Readonly<Record<string, string>>;
  /** What the host answers to sticky.list, instead of `notes` (a refusal, a cut index). */
  readonly list?: () => ResultOf<'sticky.list'>;
  /** The notes view's "Ask Claude about this sticky note" (absent: no button). */
  readonly onAskClaude?: (name: string) => void;
  /** The feedback the host answers with (sticky.feedback.list); default none. */
  readonly feedback?: readonly Feedback[];
  /** The host refuses sticky.feedback.list with this (until the test hands it another answer). */
  readonly feedbackError?: unknown;
  /** The members of the presence (default: MEMBERS, Amy with the test's role); null: no presence came. */
  readonly members?: readonly Member[] | null;
}

/** The members: Ian the host, Amy (the test's own member: her role is the test's), Mei with agent access, Vic a Viewer. */
export function membersFor(role: Role): Member[] {
  return [
    makeMember({ userId: HOST_USER, displayName: 'Ian', role: 'host' }),
    makeMember({ userId: 'dev:amy', displayName: 'Amy', role }),
    makeMember({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' }),
    makeMember({ userId: 'dev:vic', displayName: 'Vic', role: 'viewer' }),
  ];
}

export function openNotes(options: NotesOptions = {}) {
  const services = createTestServices({ path: options.path ?? NOTES_PATH });
  const role = options.role ?? 'editor';
  const context = createTestWorkspace({ role, services, userId: 'dev:amy', displayName: 'Amy' });
  const notes = [...(options.notes ?? NOTES)];
  const feedback = [...(options.feedback ?? [])];
  const feedbackList = (): ResultOf<'sticky.feedback.list'> => ({ feedback: [...feedback], hasMore: false });
  context.conn.handle('sticky.list', options.list ?? (() => ({ notes, hasMore: false, truncated: false, sources: [] })));
  const bridge = bridgeDocs(context.conn, testUser('Amy', 'dev:amy'), undefined, { canWrite: role !== 'viewer' });
  for (const [name, text] of Object.entries(options.texts ?? TEXTS)) bridge.addFile(noteFile(name), text);
  const fake = createFakeEngine();
  const view = render(
    <WorkspaceTestProviders context={context}>
      <EditorEngineContext.Provider value={fake.loader}>
        <Notes {...(options.onAskClaude === undefined ? {} : { onAskClaude: options.onAskClaude })} />
      </EditorEngineContext.Provider>
    </WorkspaceTestProviders>,
  );
  // The channel's first loads (the locks among them: who holds a note's lock is known from here on), the feedback among
  // them (with the channel for a member with session.drive, with the notes view for the others); the members' presence.
  act(() => {
    if (options.feedbackError !== undefined) {
      const error = options.feedbackError;
      while (context.conn.pendingOf('sticky.feedback.list').length > 0) context.conn.fail('sticky.feedback.list', error);
      context.conn.handle('sticky.feedback.list', () => {
        throw error;
      });
    }
    answerLoads(context.conn, { 'sticky.feedback.list': feedbackList() });
    if (options.feedbackError === undefined) context.conn.handle('sticky.feedback.list', feedbackList);
    const members = options.members === undefined ? membersFor(role) : options.members;
    if (members !== null) context.conn.emit('presence.state', { members: members.map((member) => presenceOf(member)), agents: [] });
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await flush();
        bridge.pump();
      });
    }
  };
  return {
    ...view,
    ...context,
    bridge,
    fake,
    settle,
    /** The index the host answers with from now on (the next sticky.list). */
    notes,
    /** The feedback the host answers with from now on (the next sticky.feedback.list). */
    feedback,
    path: () => services.router.getState().pathname,
    navigate: (path: string) => act(() => services.router.navigate(path)),
    /** The notes' files the page asked the host to open, in order. */
    opened: () => context.conn.requestsOf('doc.open').map((request) => request.payload.file.path),
    /** The documents the page holds right now. */
    held: () => [...context.stores.docs.getState().docs.values()].map((doc) => doc.file.path).sort(),
    keyOf: (name: string) => fileRefKey(noteFile(name)),
  };
}

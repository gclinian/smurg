// TEST ONLY. The sticky notes on a FakeConnection: the list of notes and the open note as the notes view composes them,
// with the address of a memory router, the index the test gives (sticky.list), and the notes' files in test rooms
// (bridgeDocs answers doc.open and moves the Yjs traffic). The editor of "Edit" runs on the fake engine (no Monaco in
// jsdom): `fake` records what it was asked.
import { fileRefKey, type NoteInfo, type ResultOf, type Role } from '@smurg/protocol';
import { act, render } from '@testing-library/react';
import { useRoute } from '../../app/navigation.tsx';
import { WORKSPACE_ID } from '../../testing/fixtures.ts';
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
}

export function openNotes(options: NotesOptions = {}) {
  const services = createTestServices({ path: options.path ?? NOTES_PATH });
  const role = options.role ?? 'editor';
  const context = createTestWorkspace({ role, services, userId: 'dev:amy', displayName: 'Amy' });
  const notes = [...(options.notes ?? NOTES)];
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
  // The channel's first loads (the locks among them: who holds a note's lock is known from here on).
  act(() => answerLoads(context.conn));
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
    path: () => services.router.getState().pathname,
    navigate: (path: string) => act(() => services.router.navigate(path)),
    /** The notes' files the page asked the host to open, in order. */
    opened: () => context.conn.requestsOf('doc.open').map((request) => request.payload.file.path),
    /** The documents the page holds right now. */
    held: () => [...context.stores.docs.getState().docs.values()].map((doc) => doc.file.path).sort(),
    keyOf: (name: string) => fileRefKey(noteFile(name)),
  };
}

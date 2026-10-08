// What a person folded and unfolded in the two views of a workspace, remembered per browser (`smurg.layout`):
// the left column of the sessions view and its two sections; code mode's file tree, session column and drawer.
// (Which columns are open, and how wide, is per workspace: the columns store.)
//
// A browser that ran smurg 0.4.0 holds the same key in another shape, and pane widths under names that are gone.
// What still means something is carried (readLayout, carryOldPanelSettings); the rest is removed once it was read.
import { browserLocalStorage, readJson, writeJson, type PreferenceStorage } from '../../lib/preferences.ts';
import { paneStorageKey, storedSize } from '../../ui/split-resize.ts';

export type DrawerTab = 'activity' | 'conflicts' | 'transfers' | 'terminal';
export const DRAWER_TABS: readonly DrawerTab[] = ['activity', 'conflicts', 'transfers', 'terminal'];

export interface ShellLayout {
  /** Sessions view: the left column is shown (false: folded to its rail). */
  readonly left: boolean;
  readonly inbox: boolean;
  readonly sessions: boolean;
  /** Code mode: the file tree. */
  readonly files: boolean;
  /** Code mode: the session column beside the editor. */
  readonly side: boolean;
  /** Code mode: the bottom drawer is unfolded. */
  readonly drawer: boolean;
  readonly drawerTab: DrawerTab;
}

export type LayoutSwitch = 'left' | 'inbox' | 'sessions' | 'files' | 'side' | 'drawer';

const LAYOUT_KEY = 'smurg.layout';

/**
 * The editor gets the room by default: the drawer starts folded (it unfolds itself for conflicts and transfers
 * through showPanel) and the session column shows once a session is chosen for it.
 */
export const DEFAULT_LAYOUT: ShellLayout = { left: true, inbox: true, sessions: true, files: true, side: true, drawer: false, drawerTab: 'activity' };

/**
 * `smurg.layout` as smurg 0.4.0 wrote it (its Workbench.tsx): `{ sidebar, right, drawer, drawerTab: 'activity' |
 * 'conflicts' | 'transfers' | 'merge-requests', suggestions, agentsWide }`. Two of its switches are panels that still
 * exist under another name: `sidebar` is the file tree (`files`), `right` the column beside the editor (`side`).
 * `drawer` kept its name and its meaning. `suggestions` and `agentsWide` are panels that are gone: not carried.
 */
const NAMES_OF_040 = { files: 'sidebar', side: 'right' } as const;
/** The keys only 0.4.0 wrote: a stored value that has one is rewritten once in the names of today. */
const KEYS_ONLY_040_WROTE: readonly string[] = ['sidebar', 'right', 'suggestions', 'agentsWide'];

/**
 * Tolerant, field by field (it runs in a state initializer: a throw here is a blank workspace): a switch that is not
 * a boolean is the default. A switch 0.4.0 stored under its old name is read from there when today's name is absent.
 * A drawer tab that is not one of today's is the activity tab: 0.4.0's 'merge-requests' tab is gone (merge requests
 * are in the inbox).
 */
export function readLayout(storage: PreferenceStorage | null = browserLocalStorage()): ShellLayout {
  const stored = readJson(storage, LAYOUT_KEY);
  if (typeof stored !== 'object' || stored === null) return DEFAULT_LAYOUT;
  const s = stored as Readonly<Record<string, unknown>>;
  const flag = (key: Exclude<keyof ShellLayout, 'drawerTab'>): boolean => {
    if (typeof s[key] === 'boolean') return s[key];
    const old = (NAMES_OF_040 as Readonly<Record<string, string | undefined>>)[key];
    const before = old === undefined ? undefined : s[old];
    return typeof before === 'boolean' ? before : DEFAULT_LAYOUT[key];
  };
  return {
    left: flag('left'),
    inbox: flag('inbox'),
    sessions: flag('sessions'),
    files: flag('files'),
    side: flag('side'),
    drawer: flag('drawer'),
    drawerTab: DRAWER_TABS.includes(s['drawerTab'] as DrawerTab) ? (s['drawerTab'] as DrawerTab) : DEFAULT_LAYOUT.drawerTab,
  };
}

export function writeLayout(layout: ShellLayout, storage: PreferenceStorage | null = browserLocalStorage()): void {
  writeJson(storage, LAYOUT_KEY, layout);
}

/** The width of 0.4.0's agents column: the session column of code mode remembers its own under `side`. */
const PANE_RIGHT_OF_040 = 'right';
/**
 * Keys only 0.4.0 used, with nothing left to carry: the height of the suggestions pane (the pane is gone) and the
 * ended sessions whose tab this person closed (there are no session tabs; it also named workspaces by their id).
 */
const DEAD_KEYS_OF_040: readonly string[] = [paneStorageKey('suggestions'), 'smurg.agents.closedSessions'];

/**
 * Once, when the page starts (app/services.tsx), before anything reads a panel setting: what a browser that ran
 * smurg 0.4.0 still holds is carried into the names of today and the keys nothing reads any more are removed.
 *   - `smurg.layout` in 0.4.0's shape is rewritten in today's (readLayout carries what still has a meaning);
 *   - `smurg.pane.right`, the width of the column beside the editor, becomes `smurg.pane.side` unless this version
 *     already remembers a width of its own; then it is removed;
 *   - `smurg.pane.suggestions` and `smurg.agents.closedSessions` are removed.
 * Nothing is removed before what replaces it is in the storage (a full storage keeps the old value for the next
 * start), a second run changes nothing, and a blocked storage is no error: these are conveniences.
 */
export function carryOldPanelSettings(storage: PreferenceStorage | null = browserLocalStorage()): void {
  if (storage === null) return;
  const remove = (key: string): void => {
    try {
      storage.removeItem(key);
    } catch {
      // blocked storage: the key stays, nothing reads it
    }
  };

  const layout = readJson(storage, LAYOUT_KEY);
  if (typeof layout === 'object' && layout !== null && !Array.isArray(layout) && KEYS_ONLY_040_WROTE.some((key) => Object.hasOwn(layout, key))) {
    writeLayout(readLayout(storage), storage);
  }

  const rightKey = paneStorageKey(PANE_RIGHT_OF_040);
  const sideKey = paneStorageKey('side');
  const right = readJson(storage, rightKey);
  if (right !== undefined || hasKey(storage, rightKey)) {
    const width = storedSize(right);
    const side = storedSize(readJson(storage, sideKey));
    if (width !== null && side === null) writeJson(storage, sideKey, width);
    // Gone only when it is not needed any more: carried, superseded by a width of today, or not a width at all.
    if (width === null || storedSize(readJson(storage, sideKey)) !== null) remove(rightKey);
  }

  for (const key of DEAD_KEYS_OF_040) remove(key);
}

/** The key holds something, readable as JSON or not. */
function hasKey(storage: PreferenceStorage, key: string): boolean {
  try {
    return storage.getItem(key) !== null;
  } catch {
    return false;
  }
}

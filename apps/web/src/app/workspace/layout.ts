// What a person folded and unfolded in the two views of a workspace, remembered per browser (`smurg.layout`):
// the left column of the sessions view and its two sections; code mode's file tree, session column and drawer.
// (Which columns are open, and how wide, is per workspace: the columns store.)
import { browserLocalStorage, readJson, writeJson, type PreferenceStorage } from '../../lib/preferences.ts';

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

export function readLayout(storage: PreferenceStorage | null = browserLocalStorage()): ShellLayout {
  const stored = readJson(storage, LAYOUT_KEY);
  if (typeof stored !== 'object' || stored === null) return DEFAULT_LAYOUT;
  const s = stored as Partial<Record<keyof ShellLayout, unknown>>;
  const flag = (key: Exclude<keyof ShellLayout, 'drawerTab'>): boolean => (typeof s[key] === 'boolean' ? (s[key] as boolean) : DEFAULT_LAYOUT[key]);
  return {
    left: flag('left'),
    inbox: flag('inbox'),
    sessions: flag('sessions'),
    files: flag('files'),
    side: flag('side'),
    drawer: flag('drawer'),
    drawerTab: DRAWER_TABS.includes(s.drawerTab as DrawerTab) ? (s.drawerTab as DrawerTab) : DEFAULT_LAYOUT.drawerTab,
  };
}

export function writeLayout(layout: ShellLayout, storage: PreferenceStorage | null = browserLocalStorage()): void {
  writeJson(storage, LAYOUT_KEY, layout);
}

// Per-browser conveniences kept in localStorage: the recently opened workspaces, the theme, pane sizes. Nothing here
// is a secret or a source of truth; every read tolerates a missing, corrupt or blocked storage.
import { isWorkspaceId } from '@smurg/protocol/relay';
import { createStore, type ReadableStore } from './store.ts';

export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function browserLocalStorage(): PreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readJson(storage: PreferenceStorage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw === null || raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export function writeJson(storage: PreferenceStorage | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or blocked storage: a convenience is lost, nothing else.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Recent workspaces
// ---------------------------------------------------------------------------------------------------------------

export interface RecentWorkspace {
  readonly id: string;
  /** The shared folder's name, from the last Welcome. */
  readonly name: string | null;
  readonly hostName: string | null;
  readonly lastOpenedAt: number;
}

const RECENT_KEY = 'smurg.recentWorkspaces';
const RECENT_MAX = 10;

function parseRecent(value: unknown): RecentWorkspace[] {
  if (!Array.isArray(value)) return [];
  const out: RecentWorkspace[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, name, hostName, lastOpenedAt } = item as Record<string, unknown>;
    if (!isWorkspaceId(id) || typeof lastOpenedAt !== 'number') continue;
    out.push({
      id,
      name: typeof name === 'string' ? name.slice(0, 200) : null,
      hostName: typeof hostName === 'string' ? hostName.slice(0, 200) : null,
      lastOpenedAt,
    });
  }
  return out.slice(0, RECENT_MAX);
}

export interface RecentWorkspaces extends ReadableStore<readonly RecentWorkspace[]> {
  remember(entry: { id: string; name?: string | null; hostName?: string | null }, at?: number): void;
  forget(id: string): void;
}

export function createRecentWorkspaces(storage: PreferenceStorage | null): RecentWorkspaces {
  const state = createStore<readonly RecentWorkspace[]>(parseRecent(readJson(storage, RECENT_KEY)));
  const save = (list: readonly RecentWorkspace[]): void => {
    state.setState(list);
    writeJson(storage, RECENT_KEY, list);
  };
  return {
    getState: state.getState,
    subscribe: state.subscribe,
    remember(entry, at = Date.now()) {
      if (!isWorkspaceId(entry.id)) return;
      const previous = state.getState().find((item) => item.id === entry.id);
      const next: RecentWorkspace = {
        id: entry.id,
        name: entry.name ?? previous?.name ?? null,
        hostName: entry.hostName ?? previous?.hostName ?? null,
        lastOpenedAt: at,
      };
      save([next, ...state.getState().filter((item) => item.id !== entry.id)].slice(0, RECENT_MAX));
    },
    forget(id) {
      save(state.getState().filter((item) => item.id !== id));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------------------------

export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

const THEME_KEY = 'smurg.theme';

export interface ThemeState {
  readonly preference: ThemePreference;
  /** What is shown: dark is the default; 'system' follows prefers-color-scheme. */
  readonly resolved: ResolvedTheme;
}

export interface ThemeController extends ReadableStore<ThemeState> {
  setPreference(preference: ThemePreference): void;
  dispose(): void;
}

/**
 * Applies the theme as `data-theme` on <html> (tokens.css reads it). 'system' removes the attribute so the
 * prefers-color-scheme media query decides.
 */
export function createThemeController(options: { storage?: PreferenceStorage | null; root?: HTMLElement; media?: MediaQueryList | null } = {}): ThemeController {
  const storage = options.storage === undefined ? browserLocalStorage() : options.storage;
  const root = options.root ?? document.documentElement;
  const media =
    options.media === undefined ? (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null) : options.media;
  const stored = readJson(storage, THEME_KEY);
  const initial: ThemePreference = stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system';
  const resolve = (preference: ThemePreference): ResolvedTheme => (preference === 'system' ? (media?.matches ? 'light' : 'dark') : preference);
  const state = createStore<ThemeState>({ preference: initial, resolved: resolve(initial) });
  const apply = (): void => {
    const { preference } = state.getState();
    if (preference === 'system') delete root.dataset['theme'];
    else root.dataset['theme'] = preference;
    root.style.colorScheme = resolve(preference);
  };
  const onMedia = (): void => {
    state.setState((previous) => ({ ...previous, resolved: resolve(previous.preference) }));
    apply();
  };
  media?.addEventListener('change', onMedia);
  apply();
  return {
    getState: state.getState,
    subscribe: state.subscribe,
    setPreference(preference) {
      writeJson(storage, THEME_KEY, preference);
      state.setState({ preference, resolved: resolve(preference) });
      apply();
    },
    dispose() {
      media?.removeEventListener('change', onMedia);
    },
  };
}

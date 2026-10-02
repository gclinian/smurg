// One session's terminal (SPEC R4, R7 agent panel; ARCHITECTURE §7.6 "PTY"): xterm.js loaded lazily the first time
// the terminal is shown; attach while shown (snapshot or delta, then live output placed by offset — TerminalFeed),
// detach when hidden, attach again after a full resync from the last rendered offset.
//
// Rules this component keeps:
//  - the viewer never answers terminal queries (createViewerTerminal registers the full swallow set; the terminal of
//    someone who may not type additionally has stdin disabled, so xterm emits nothing at all);
//  - it renders at exactly the PTY's size (session.attach / exec.resize), never at the panel's, and never reflows;
//  - the panel of the member who OPENED the session drives the PTY size (policy `owner`, review LEAD-01; the daemon
//    would take a resize from any driver, the web sends it from the opener only, so panels never fight over it):
//    columns AND rows fitted to the visible
//    area (terminal-fit.ts), sent with session.attach and then as exec.resize (debounced) whenever the panel is
//    resized, a pane or the drawer is toggled, a font finished loading or the browser tab becomes visible again; the
//    daemon's exec.resize echo is applied in stream order (F18). Below the program's floor (Claude Code: 80 × 24) the
//    terminal keeps the floor and a hint says the panel scrolls — nothing is clipped silently;
//  - everyone else (and the owner's second window, while the other one drives) sees the PTY's size: when it is bigger
//    than the panel, the terminal area scrolls both ways with visible scrollbars, a hint says so, and "Scale to fit the width"
//    draws it smaller (never reflowed);
//  - input is sent by whoever may type (the host and members with agent access, into any session: `session.drive`), resize by the
//    session's owner only, both only while it runs;
//  - file paths in the output become links when they exist in the session's root (path-links.ts);
//  - the daemon forgets an ENDED session after a while (ARCHITECTURE §7.6 "After the end"), and a panel that stayed
//    open is not told: showing such a tab again finds no session to attach to. That is said as what it is (the
//    content is no longer kept; the tab can be closed), not as a failure to retry.
import { useEffect, useMemo, useRef, useState } from 'react';
import { EXEC_INPUT_MAX_BYTES, isSmurgError, parentRelPath, type FileEntry, type FileRef, type SessionInfo } from '@smurg/protocol';
import { isClientRequestError } from '@smurg/protocol/client';
import { NoCommandHandlerError } from '../../lib/commands.ts';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { selectDir, type FilesState } from '../../lib/stores/files.ts';
import { useCommand, useConnection, useStores } from '../../lib/workspace/context.tsx';
import { useAppServices } from '../../app/services.tsx';
import { Banner, Button, Spinner, useToast } from '../../ui/index.ts';
import { createPathExistence, createPathLinkProvider } from './path-links.ts';
import { t } from './strings.ts';
import { TerminalFeed } from './terminal-feed.ts';
import { OWNER_SIZE_FLOOR, OwnerResizer, PTY_SIZE_MIN, planOwnerSize, sameSize, type OwnerSizePlan, type TerminalSize } from './terminal-fit.ts';
import { useOnScreen } from './use-on-screen.ts';
import { useViewerFactory, type TerminalViewer } from './viewer.ts';
import { plainSessionTitle } from '../../lib/stores/sessions.ts';

const encoder = new TextEncoder();
/** Height of the one-line size hint above the terminal (agents.css `.agents-term__hint`): the owner's plan leaves room. */
export const TERMINAL_HINT_PX = 24;

/** The entry from a loaded, complete listing; null when the folder is loaded and it is not there; undefined: unknown. */
export function lookupLoadedEntry(state: FilesState, ref: FileRef): FileEntry | null | undefined {
  const parent = parentRelPath(ref.path);
  if (parent === null) return undefined;
  const listing = selectDir(state, ref.root, parent);
  if (!listing || listing.status !== 'ready' || listing.truncated) return undefined;
  return listing.entries.find((entry) => entry.path === ref.path) ?? null;
}

/** Keystrokes / pastes as exec.input, split under the per-message cap. */
function sendInput(send: (bytes: Uint8Array) => void, data: string): void {
  const bytes = encoder.encode(data);
  for (let start = 0; start < bytes.byteLength; start += EXEC_INPUT_MAX_BYTES) {
    send(bytes.subarray(start, Math.min(bytes.byteLength, start + EXEC_INPUT_MAX_BYTES)));
  }
}

function quietFailure(error: unknown): boolean {
  // The channel was replaced (the next Welcome attaches again) or closed for good (the workspace screen says why).
  return isClientRequestError(error, 'connection-lost') || isClientRequestError(error, 'closed');
}

type Phase = 'waiting' | 'loading' | 'connecting' | 'live' | 'error';

export interface SessionTerminalProps {
  readonly session: SessionInfo;
  /** The member who opened it: their panel drives the PTY size. */
  readonly isOwner: boolean;
  /** Keystrokes go to the session (host and members with agent access, any running session). */
  readonly canType: boolean;
  /** The session's tab is the selected one. */
  readonly active: boolean;
  /** Draw the PTY-sized terminal smaller so it fits the panel's width (never reflows; the PTY keeps its size). */
  readonly scaled: boolean;
}

export function SessionTerminal({ session, isOwner, canType, active, scaled }: SessionTerminalProps) {
  const stores = useStores();
  const conn = useConnection();
  const factory = useViewerFactory();
  const { theme } = useAppServices();
  const resolvedTheme = useStore(theme, (state) => state.resolved);
  const generation = useStore(stores.workspace, (state) => state.generation);
  const openFile = useCommand('openFile');
  const revealFile = useCommand('revealFile');
  const toast = useToast();

  const frameRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(viewportRef, active);
  const visible = active && onScreen;

  const [viewer, setViewer] = useState<TerminalViewer | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>('waiting');
  const [errorText, setErrorText] = useState<string | null>(null);
  /** The attach found no such session, and the session had ended: the daemon no longer keeps it. */
  const [gone, setGone] = useState(false);
  const [retry, setRetry] = useState(0);

  const readOnly = !canType || session.status === 'exited';
  const latest = useRef({ session, isOwner, readOnly, resolvedTheme });
  latest.current = { session, isOwner, readOnly, resolvedTheme };
  // The size the terminal renders (the PTY's, known once the daemon sent it: snapshot, delta or exec.resize, applied in
  // stream order), and what this panel fits (for everyone; only the owner sends it).
  const [rendered, setRendered] = useState<TerminalSize | null>(null);
  const [fit, setFit] = useState<OwnerSizePlan | null>(null);
  const resizerRef = useRef<OwnerResizer | null>(null);

  /** The plan for this panel: the owner's floor for the owner, the protocol's minimum for everyone else. */
  const planFor = (target: TerminalViewer): OwnerSizePlan | null => {
    const frame = frameRef.current;
    if (!frame) return null;
    const geometry = target.measure(frame);
    if (!geometry) return null;
    const floor = latest.current.isOwner ? (OWNER_SIZE_FLOOR[latest.current.session.kind] ?? PTY_SIZE_MIN) : PTY_SIZE_MIN;
    const plain = planOwnerSize(geometry, floor);
    // Below the floor the one-line hint is shown above the terminal: the rows are fitted to what is left of the panel.
    return plain && (plain.narrow || plain.short) ? planOwnerSize({ ...geometry, height: geometry.height - TERMINAL_HINT_PX }, floor) : plain;
  };
  const planRef = useRef(planFor);
  planRef.current = planFor;

  // xterm.js is created the first time the terminal is shown (the chunk is fetched then), and disposed on unmount.
  useEffect(() => {
    if (!visible || viewer !== null || loadFailed) return;
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    setPhase('loading');
    factory(host, { theme: latest.current.resolvedTheme, readOnly: latest.current.readOnly }).then(
      (created) => {
        if (cancelled) created.dispose();
        else setViewer(created);
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visible, viewer, loadFailed, factory]);

  useEffect(() => {
    if (!viewer) return;
    return () => viewer.dispose();
  }, [viewer]);

  const feed = useMemo(() => {
    if (!viewer) return null;
    const sessionId = session.id;
    return new TerminalFeed(
      {
        // The rendered size follows in stream order too: it is known once the resize before it was applied.
        snapshot: (data, cols, rows) => {
          viewer.applySnapshot(data, cols, rows);
          viewer.term.write('', () => setRendered({ cols, rows }));
        },
        write: (data) => viewer.write(data),
        resize: (cols, rows) => {
          viewer.resize(cols, rows);
          viewer.term.write('', () => setRendered({ cols, rows }));
        },
      },
      {
        attach: (haveOffset) => {
          const { isOwner: owner, session: current } = latest.current;
          // Only the owner's panel is ever proposed (the daemon ignores it from anyone else anyway).
          const plan = owner && current.status !== 'exited' ? planRef.current(viewer) : null;
          const viewport = plan ? { cols: plan.cols, rows: plan.rows } : null;
          resizerRef.current?.sentWithAttach(viewport);
          return stores.sessions.attach({ sessionId, ...(haveOffset !== undefined ? { haveOffset } : {}), ...(viewport ?? {}) });
        },
        detach: () => stores.sessions.detach(sessionId),
        fence: () => conn.request('session.list', {}),
      },
      {
        onLive: () => {
          setPhase('live');
          // The panel may have changed while the attach was on its way.
          resizerRef.current?.schedule();
        },
        onError: (error) => {
          if (quietFailure(error)) {
            setPhase('connecting');
            return;
          }
          setPhase('error');
          setGone(isSmurgError(error) && error.code === 'not_found' && latest.current.session.status === 'exited');
          setErrorText(describeError(error));
        },
      },
    );
  }, [viewer, session.id, stores, conn]);

  // Subscribe to the stream BEFORE attaching (the store routes exec.output / exec.resize in stream order).
  useEffect(() => {
    if (!feed) return;
    return stores.sessions.stream(session.id, { output: (event) => feed.output(event), resize: (event) => feed.resize(event) });
  }, [feed, stores, session.id]);

  // Attached while shown; detached when hidden; attached again on a new logical channel, from the rendered offset.
  const seenGeneration = useRef(generation);
  useEffect(() => {
    if (!feed || !visible) return;
    if (seenGeneration.current !== generation) {
      seenGeneration.current = generation;
      feed.channelReset();
    }
    setErrorText(null);
    setPhase((previous) => (previous === 'live' ? previous : 'connecting'));
    feed.attach().catch(() => {
      // reported through onError
    });
    return () => feed.detach();
  }, [feed, visible, generation, retry]);

  // Input from whoever may type (session.drive), and only while the session runs.
  useEffect(() => {
    if (!viewer) return;
    viewer.setReadOnly(readOnly);
    if (readOnly) return;
    const sessionId = session.id;
    return viewer.onInput((data) => {
      try {
        sendInput((bytes) => stores.sessions.input(sessionId, bytes), data);
      } catch {
        // the connection is closed for good; the workspace screen explains
      }
    });
  }, [viewer, readOnly, stores, session.id]);

  // What this panel fits, for everyone (hints; the owner also sends it): re-measured whenever the frame around the
  // terminal changes size (the panel, a pane or the drawer), a font finished loading, or the tab became visible.
  useEffect(() => {
    if (!viewer || !visible) return;
    const frame = frameRef.current;
    const measure = (): void => {
      const next = planRef.current(viewer);
      setFit((previous) => (previous && next && JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    measure();
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    const onFonts = (): void => {
      viewer.remeasure();
      measure();
      resizerRef.current?.schedule();
    };
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return;
      measure();
      resizerRef.current?.schedule();
    };
    let observer: ResizeObserver | undefined;
    if (frame && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        measure();
        resizerRef.current?.schedule();
      });
      observer.observe(frame);
    }
    fonts?.addEventListener?.('loadingdone', onFonts);
    let alive = true;
    fonts?.ready?.then(() => {
      if (alive) onFonts();
    }).catch(() => {});
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      observer?.disconnect();
      fonts?.removeEventListener?.('loadingdone', onFonts);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [viewer, visible, isOwner, session.kind]);

  // The owner's panel drives the PTY size (the daemon answers with exec.resize, which the feed applies in order).
  useEffect(() => {
    if (!viewer || !feed || !isOwner || session.status === 'exited') return;
    const sessionId = session.id;
    const resizer = new OwnerResizer({
      measure: () => {
        const plan = planRef.current(viewer);
        return plan ? { cols: plan.cols, rows: plan.rows } : null;
      },
      current: () => ({ cols: viewer.term.cols, rows: viewer.term.rows }),
      send: (size) => {
        try {
          stores.sessions.resize(sessionId, size.cols, size.rows);
        } catch {
          // closed for good; the workspace screen explains
        }
      },
      ready: () => feed.phase === 'live' && (typeof document === 'undefined' || document.visibilityState !== 'hidden'),
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    resizerRef.current = resizer;
    resizer.schedule();
    return () => {
      resizer.dispose();
      if (resizerRef.current === resizer) resizerRef.current = null;
    };
  }, [viewer, feed, isOwner, session.status, session.id, stores]);

  useEffect(() => {
    viewer?.setTheme(resolvedTheme);
  }, [viewer, resolvedTheme]);

  // File paths in the output: links only for paths that exist in the session's root.
  useEffect(() => {
    if (!viewer) return;
    const existence = createPathExistence({
      lookup: (ref) => lookupLoadedEntry(stores.files.getState(), ref),
      stat: (ref) => stores.files.stat(ref),
      now: () => Date.now(),
    });
    const provider = createPathLinkProvider(viewer.term, {
      root: () => latest.current.session.root,
      exists: (ref) => existence.check(ref),
      activate: (target) => {
        const run =
          target.kind === 'file'
            ? openFile({
                file: target.ref,
                ...(target.line !== undefined ? { line: target.line } : {}),
                ...(target.column !== undefined ? { column: target.column } : {}),
              })
            : revealFile({ file: target.ref });
        run.catch((error: unknown) => {
          toast.show({
            tone: 'warning',
            title:
              error instanceof NoCommandHandlerError
                ? t('link.noEditor', { path: target.ref.path })
                : t('link.failed', { path: target.ref.path, message: describeError(error) }),
          });
        });
      },
    });
    return viewer.registerLinkProvider(provider);
  }, [viewer, stores, openFile, revealFile, toast]);

  // Optional scaling for viewers: the terminal keeps the PTY's cols × rows and is only drawn smaller.
  useEffect(() => {
    const viewport = viewportRef.current;
    const host = hostRef.current;
    const element = viewer?.term.element;
    if (!viewer || !viewport || !host || !element) return;
    const reset = (): void => {
      element.style.transform = '';
      element.style.transformOrigin = '';
      host.style.width = '';
      host.style.height = '';
    };
    if (!scaled) {
      reset();
      return;
    }
    const apply = (): void => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      if (width === 0 || height === 0) return;
      const factor = Math.min(1, viewport.clientWidth / width);
      element.style.transformOrigin = '0 0';
      element.style.transform = factor < 1 ? `scale(${factor})` : '';
      host.style.width = `${Math.floor(width * factor)}px`;
      host.style.height = `${Math.floor(height * factor)}px`;
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return reset;
    const observer = new ResizeObserver(apply);
    observer.observe(viewport);
    observer.observe(element);
    return () => {
      observer.disconnect();
      reset();
    };
  }, [viewer, scaled]);

  const label = t('terminal.label', { owner: session.ownerName, title: plainSessionTitle(session) });
  // Which hint, if any (one line, TERMINAL_HINT_PX high): the owner's floor (the panel is smaller than what the
  // program needs: the terminal keeps the floor and scrolls), or a PTY bigger than this panel (drawn at its size).
  const driving = isOwner && fit !== null && sameSize(rendered, fit);
  const floor = OWNER_SIZE_FLOOR[session.kind] ?? PTY_SIZE_MIN;
  const overflowing = rendered !== null && fit !== null && (rendered.cols > fit.fitCols || rendered.rows > fit.fitRows);
  const hint: { short: string; full: string } | null =
    phase !== 'live' || rendered === null
      ? null
      : driving && fit !== null && (fit.narrow || fit.short)
        ? { short: t('terminal.floorHint', { cols: floor.cols, rows: floor.rows }), full: t('terminal.floorHintFull', { cols: floor.cols, rows: floor.rows }) }
        : overflowing && !scaled
          ? { short: t('terminal.overflowHint', { cols: rendered.cols, rows: rendered.rows }), full: t('terminal.overflowHintFull', { cols: rendered.cols, rows: rendered.rows }) }
          : null;
  return (
    <div className="agents-term">
      {loadFailed ? (
        <Banner tone="danger" live="alert">
          {t('terminal.loadFailed')}
        </Banner>
      ) : null}
      {phase === 'error' && errorText !== null ? (
        gone ? (
          <Banner tone="info" live="status">
            {t('terminal.gone')}
          </Banner>
        ) : (
          <Banner
            tone="danger"
            live="alert"
            actions={
              <Button size="sm" onClick={() => setRetry((n) => n + 1)}>
                {t('action.retry')}
              </Button>
            }
          >
            {t('terminal.attachFailed', { message: errorText })}
          </Banner>
        )
      ) : null}
      <div ref={frameRef} className="agents-term__frame">
        {hint ? (
          <p className="agents-term__hint" title={hint.full} data-testid="terminal-size-hint">
            <span aria-hidden="true">{hint.short}</span>
            <span className="ui-visually-hidden">{hint.full}</span>
          </p>
        ) : null}
        <div
          ref={viewportRef}
          className="agents-term__viewport"
          role="region"
          aria-label={label}
          aria-busy={phase !== 'live' || undefined}
          data-phase={phase}
          data-readonly={readOnly || undefined}
          data-cols={rendered?.cols}
          data-rows={rendered?.rows}
          data-fit-cols={fit?.fitCols}
          data-fit-rows={fit?.fitRows}
          data-driving={driving || undefined}
        >
          <div ref={hostRef} className="agents-term__host" />
          {phase === 'loading' || phase === 'connecting' ? (
            <div className="agents-term__overlay" role="status">
              <Spinner size={14} decorative />
              <span>{t('terminal.connecting')}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

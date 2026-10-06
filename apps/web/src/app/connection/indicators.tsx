// Non-blocking connection indicators: the status pill in the top bar and the banner that stays on screen while the
// host is offline or the relay is unreachable. Neither ever blocks the UI (SPEC §9: "Host offline", not a frozen
// screen).
import type { ConnectionState } from '@smurg/protocol/client';
import { describeConnection, secondsUntil, type ConnectionView } from '../../lib/connection/status.ts';
import { useLocalNow } from '../../lib/use-now.ts';
import { tConn } from '../../strings/connection.ts';
import { Banner, Tooltip, cx } from '../../ui/index.ts';
import { IconCloudOff, IconPlugOff } from '../../ui/icons.tsx';

export function ConnectionStatusPill({ state }: { state: ConnectionState }) {
  const view = describeConnection(state);
  return (
    <Tooltip content={view.detail}>
      {/* Focusable so keyboard users can reach the explanation in the tooltip; a polite live region for changes. */}
      <span className={cx('app-status-pill', `app-status-pill--${view.tone}`)} tabIndex={0} role="status" data-connection-view={view.kind}>
        <span className="app-status-pill__dot" aria-hidden="true" />
        <span className="ui-visually-hidden">{tConn('statusPrefix')}</span>
        {view.label}
      </span>
    </Tooltip>
  );
}

/** The explanation, followed by the countdown to the next automatic retry when one is scheduled. */
function detailWithRetry(view: ConnectionView, now: number): string {
  if (view.retryAt === null) return view.detail;
  return tConn('sentences', { first: view.detail, second: tConn('retryIn', { count: secondsUntil(view.retryAt, now) }) });
}

/**
 * Shown under the top bar whenever the connection is not online after it had been: host offline (warning), relay
 * unreachable (danger, different wording), retrying / role change (info). Nothing while online.
 */
export function ConnectionBanner({ state }: { state: ConnectionState }) {
  const view = describeConnection(state);
  // The retry countdown: the clock runs only while one is shown. This browser set the time of the retry, so it is
  // counted on this browser's clock, not the host's.
  const now = useLocalNow(1_000, view.retryAt !== null);
  if (view.blocking || view.kind === 'online' || view.kind === 'idle') return null;
  if (view.kind === 'host-offline') {
    return (
      <Banner tone="warning" title={tConn('pill.hostOffline')} icon={<IconPlugOff />} className="app-connection-banner" live="alert">
        <span data-testid="host-offline-banner" data-connection-view={view.kind}>
          {tConn('sentences', { first: view.detail, second: tConn('detail.hostOffline.consequence') })}
        </span>
      </Banner>
    );
  }
  if (view.kind === 'relay-unreachable') {
    return (
      <Banner tone="danger" title={view.label} icon={<IconCloudOff />} className="app-connection-banner">
        <span data-testid="relay-unreachable-banner" data-connection-view={view.kind}>
          {detailWithRetry(view, now)}
        </span>
      </Banner>
    );
  }
  return (
    <Banner tone="info" title={view.label} className="app-connection-banner">
      <span data-connection-view={view.kind}>
        {detailWithRetry(view, now)}
      </span>
    </Banner>
  );
}

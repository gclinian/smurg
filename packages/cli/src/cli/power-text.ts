// The keep-awake status, the same words in `smurg host`'s notices and in `smurg status`. The daemon reports a reason
// code (POWER_REASONS in @smurg/daemon); the control socket's status keeps it a plain string, so a code this build does
// not know reads as "reason unknown".
import type { PowerReason, PowerStatus } from '@smurg/daemon';
import { m, type MessageId, type Text } from '../i18n/index.ts';

const REASONS: Readonly<Record<PowerReason, MessageId>> = {
  disabled: 'power.off.disabled',
  'not-started': 'power.off.notStarted',
  stopped: 'power.off.stopped',
  'systemd-inhibit-not-found': 'power.off.noSystemdInhibit',
  'unsupported-platform': 'power.off.unsupported',
  'spawn-failed': 'power.off.startFailed',
  'start-failed': 'power.off.startFailed',
  exited: 'power.off.exited',
  // Linux: logind / polkit refused systemd-inhibit's sleep block. Verified on Ubuntu 24.04, where
  // `org.freedesktop.login1.inhibit-block-sleep` is allow_any=no for a session that is not a local one (SSH); other
  // distributions and site polkit rules can refuse a local session too.
  refused: 'power.off.refused',
};

/** "on (caffeinate)" / "off (turned off with --no-keep-awake)" */
export function powerState(status: Pick<PowerStatus, 'active' | 'mechanism'> & { readonly reason: string | null }): Text {
  if (status.active) return m('power.on', { mechanism: status.mechanism });
  const reason = status.reason ?? '';
  return { id: Object.hasOwn(REASONS, reason) ? REASONS[reason as PowerReason] : 'power.off.unknown' };
}

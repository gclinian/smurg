// zh-TW formatting of times, sizes and people, shared by every feature.
import { ROLE_LABELS_ZH_TW, type Actor, type Role } from '@smurg/protocol';
import { tApp } from '../strings/app.ts';

const dateTime = new Intl.DateTimeFormat('zh-Hant-TW', { dateStyle: 'short', timeStyle: 'short', hour12: false });
const time = new Intl.DateTimeFormat('zh-Hant-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const integer = new Intl.NumberFormat('zh-Hant-TW', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('zh-Hant-TW', { maximumFractionDigits: 1 });

/** 「剛剛」「3 分鐘前」…, then an absolute date after a week. */
export function formatRelativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 10) return tApp('common.justNow');
  if (seconds < 60) return tApp('common.secondsAgo', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return tApp('common.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tApp('common.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return tApp('common.daysAgo', { n: days });
  return dateTime.format(at);
}

export function formatDateTime(at: number): string {
  return dateTime.format(at);
}

export function formatTime(at: number): string {
  return time.format(at);
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Binary units, as the host's disk check reports them (5 GB = 5 × 2^30 bytes). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return tApp('common.unknown');
  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${sign}${unit === 0 ? integer.format(value) : oneDecimal.format(value)} ${UNITS[unit]}`;
}

export function formatRole(role: Role): string {
  return ROLE_LABELS_ZH_TW[role];
}

/** The name to show for whoever did something (agents are already named 「Claude（Ian）」 by the daemon). */
export function formatActor(actor: Actor): string {
  return actor.kind === 'system' ? 'smurg' : actor.displayName;
}

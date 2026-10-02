// The host settings form as pure functions: HostSettings ⇄ what the host types, validated with the protocol's own
// schemas and ranges (the daemon validates again; this is for immediate, specific feedback). Only changed fields are
// sent: admin.settings.set takes a Partial<HostSettings>.
import {
  AGENT_LOCK_TIMEOUT_MS_RANGE,
  HUMAN_LOCK_IDLE_MS_RANGE,
  SHARED_DIRS_MAX,
  entryPathSchema,
  type HostSettings,
  type HostSettingsPatch,
} from '@smurg/protocol';
import { t } from './strings.ts';

/** Binary gigabytes, as formatBytes and the daemon's disk check count them (5 GB = 5 × 2^30 bytes). */
export const GIB = 1024 ** 3;
/** Upper bound of the GB field: the largest byte count the protocol carries exactly. */
export const DISK_RESERVE_GB_MAX = Math.floor(Number.MAX_SAFE_INTEGER / GIB);

export interface SettingsDraft {
  /** One path per line. */
  readonly sharedDirs: string;
  readonly humanLockIdleSec: string;
  readonly agentLockTimeoutSec: string;
  readonly diskReserveGb: string;
  readonly diskReservePercent: string;
}

export type SettingsField = keyof SettingsDraft;
export type SettingsErrors = Partial<Record<SettingsField, string>>;

export interface ParsedSettings {
  /** Only the fields that differ from the current settings. */
  readonly patch: HostSettingsPatch;
  readonly errors: SettingsErrors;
}

/** Numbers without float noise: 5.5 GB stays "5.5", 30000 ms is "30". */
function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export function draftFromSettings(settings: HostSettings): SettingsDraft {
  return {
    sharedDirs: settings.sharedDirs.join('\n'),
    humanLockIdleSec: formatNumber(settings.humanLockIdleMs / 1000),
    agentLockTimeoutSec: formatNumber(settings.agentLockTimeoutMs / 1000),
    diskReserveGb: formatNumber(settings.diskReserveBytes / GIB),
    diskReservePercent: formatNumber(settings.diskReservePercent),
  };
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Validates a list field; returns the normalised values or the first problem. */
function parseList(text: string, max: number, normalise: (line: string) => string | null, invalid: (line: string) => string): { values: string[] } | { error: string } {
  const values: string[] = [];
  for (const line of lines(text)) {
    const value = normalise(line);
    if (value === null) return { error: invalid(line) };
    if (values.includes(value)) return { error: t('settings.error.duplicate', { value: line }) };
    values.push(value);
  }
  if (values.length > max) return { error: t('settings.error.tooMany', { max }) };
  return { values };
}

const NUMBER = /^\d+(?:\.\d+)?$/;

/** A non-negative decimal within [min, max], or the problem. */
function parseNumber(text: string, min: number, max: number): { value: number } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { error: t('settings.error.required') };
  // "-5" is a number too: say what IS accepted, not "Enter a number".
  if (/^-\s*\d/.test(trimmed)) return { error: t('settings.error.min', { min }) };
  if (!NUMBER.test(trimmed)) return { error: t('settings.error.number') };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < min || value > max) return { error: t('settings.error.range', { min, max }) };
  return { value };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

export function parseSettingsDraft(draft: SettingsDraft, current: HostSettings): ParsedSettings {
  const errors: { -readonly [K in SettingsField]?: string } = {};
  const patch: { -readonly [K in keyof HostSettingsPatch]: HostSettingsPatch[K] } = {};

  const dirs = parseList(
    draft.sharedDirs,
    SHARED_DIRS_MAX,
    (line) => {
      // "data/" is how people write a folder; the protocol wants "data".
      const parsed = entryPathSchema.safeParse(line.replace(/\/+$/, ''));
      return parsed.success ? parsed.data : null;
    },
    (line) => t('settings.error.dir', { value: line }),
  );
  if ('error' in dirs) errors.sharedDirs = dirs.error;
  else if (!sameList(dirs.values, current.sharedDirs)) patch.sharedDirs = dirs.values;

  const humanIdle = parseNumber(draft.humanLockIdleSec, HUMAN_LOCK_IDLE_MS_RANGE.min / 1000, HUMAN_LOCK_IDLE_MS_RANGE.max / 1000);
  if ('error' in humanIdle) errors.humanLockIdleSec = humanIdle.error;
  else {
    const ms = Math.round(humanIdle.value * 1000);
    if (ms !== current.humanLockIdleMs) patch.humanLockIdleMs = ms;
  }

  const agentTimeout = parseNumber(draft.agentLockTimeoutSec, AGENT_LOCK_TIMEOUT_MS_RANGE.min / 1000, AGENT_LOCK_TIMEOUT_MS_RANGE.max / 1000);
  if ('error' in agentTimeout) errors.agentLockTimeoutSec = agentTimeout.error;
  else {
    const ms = Math.round(agentTimeout.value * 1000);
    if (ms !== current.agentLockTimeoutMs) patch.agentLockTimeoutMs = ms;
  }

  const reserveGb = parseNumber(draft.diskReserveGb, 0, DISK_RESERVE_GB_MAX);
  if ('error' in reserveGb) errors.diskReserveGb = reserveGb.error;
  else {
    const bytes = Math.round(reserveGb.value * GIB);
    // "5" GB shown from 5.0004 GB must not count as a change.
    if (formatNumber(reserveGb.value) !== formatNumber(current.diskReserveBytes / GIB)) patch.diskReserveBytes = bytes;
  }

  const reservePercent = parseNumber(draft.diskReservePercent, 0, 100);
  if ('error' in reservePercent) errors.diskReservePercent = reservePercent.error;
  else if (formatNumber(reservePercent.value) !== formatNumber(current.diskReservePercent)) patch.diskReservePercent = reservePercent.value;

  return { patch, errors };
}

export function hasChanges(parsed: ParsedSettings): boolean {
  return Object.keys(parsed.patch).length > 0;
}

export function errorCount(parsed: ParsedSettings): number {
  return Object.keys(parsed.errors).length;
}

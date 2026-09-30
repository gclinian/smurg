// zh-TW names of the audit vocabulary (ARCHITECTURE §5.8). The map is typed against the protocol's AUDIT_ACTIONS, so
// a new action is a compile error here until it has a label.
import type { AuditAction, AuditEntry } from '@smurg/protocol';
import type { Tone } from '../../ui/index.ts';
import { t } from './strings.ts';

type Key = Parameters<typeof t>[0];

const ACTION_KEY = {
  'auth.join': 'audit.action.auth.join',
  'auth.connect': 'audit.action.auth.connect',
  'auth.disconnect': 'audit.action.auth.disconnect',
  'auth.rejected': 'audit.action.auth.rejected',
  'authz.denied': 'audit.action.authz.denied',
  'path.denied': 'audit.action.path.denied',
  'file.write': 'audit.action.file.write',
  'file.create': 'audit.action.file.create',
  'file.rename': 'audit.action.file.rename',
  'file.delete': 'audit.action.file.delete',
  'file.upload': 'audit.action.file.upload',
  'file.download': 'audit.action.file.download',
  'doc.edit': 'audit.action.doc.edit',
  'agent.edit': 'audit.action.agent.edit',
  'external.change': 'audit.action.external.change',
  'doc.conflict': 'audit.action.doc.conflict',
  'doc.conflict-resolve': 'audit.action.doc.conflict-resolve',
  'lock.acquire': 'audit.action.lock.acquire',
  'lock.release': 'audit.action.lock.release',
  'lock.denied': 'audit.action.lock.denied',
  'lock.force-release': 'audit.action.lock.force-release',
  'session.create': 'audit.action.session.create',
  'session.end': 'audit.action.session.end',
  'session.terminate': 'audit.action.session.terminate',
  'session.import-config': 'audit.action.session.import-config',
  'sandbox.refused': 'audit.action.sandbox.refused',
  'suggest.create': 'audit.action.suggest.create',
  'suggest.edit': 'audit.action.suggest.edit',
  'suggest.accept': 'audit.action.suggest.accept',
  'suggest.reject': 'audit.action.suggest.reject',
  'suggest.withdraw': 'audit.action.suggest.withdraw',
  'worktree.create': 'audit.action.worktree.create',
  'worktree.remove': 'audit.action.worktree.remove',
  'worktree.merge.request': 'audit.action.worktree.merge.request',
  'worktree.merge.approve': 'audit.action.worktree.merge.approve',
  'worktree.merge.reject': 'audit.action.worktree.merge.reject',
  'member.role': 'audit.action.member.role',
  'member.kick': 'audit.action.member.kick',
  'member.leave': 'audit.action.member.leave',
  'invite.create': 'audit.action.invite.create',
  'invite.revoke': 'audit.action.invite.revoke',
  'device.revoke': 'audit.action.device.revoke',
  'settings.change': 'audit.action.settings.change',
} as const satisfies Record<AuditAction, Key>;

export function auditActionLabel(action: AuditAction): string {
  return t(ACTION_KEY[action]);
}

const OUTCOME: Record<AuditEntry['outcome'], { readonly key: Key; readonly tone: Tone }> = {
  ok: { key: 'audit.outcome.ok', tone: 'success' },
  denied: { key: 'audit.outcome.denied', tone: 'danger' },
  error: { key: 'audit.outcome.error', tone: 'warning' },
};

export function auditOutcomeLabel(outcome: AuditEntry['outcome']): string {
  return t(OUTCOME[outcome].key);
}

export function auditOutcomeTone(outcome: AuditEntry['outcome']): Tone {
  return OUTCOME[outcome].tone;
}

const EXACT_TIME = new Intl.DateTimeFormat('zh-Hant-TW', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Audit times to the second (the log is evidence; 「3 分鐘前」 is not enough). */
export function formatAuditTime(at: number): string {
  return EXACT_TIME.format(at);
}

/** The reason code of a refusal, when the daemon recorded one (e.g. `outside-root`), for the outcome cell. */
export function auditReason(entry: AuditEntry): string | null {
  const reason = entry.detail?.['reason'];
  return entry.outcome !== 'ok' && typeof reason === 'string' && reason.length <= 64 ? reason : null;
}

/** Labels for the detail keys the daemon records (suggestions, merges, roles, invites, …); others show their key. */
const DETAIL_LABEL_KEYS: Readonly<Record<string, string>> = {
  authorName: 'audit.detail.authorName',
  text: 'audit.detail.text',
  finalText: 'audit.detail.finalText',
  rejectReason: 'audit.detail.rejectReason',
  outcome: 'audit.detail.outcome',
  conflictFiles: 'audit.detail.conflictFiles',
  from: 'audit.detail.from',
  to: 'audit.detail.to',
  role: 'audit.detail.role',
  reason: 'audit.detail.reason',
  source: 'audit.detail.source',
  branch: 'audit.detail.branch',
  message: 'audit.detail.message',
};

const SUGGESTION_OUTCOME_KEYS: Readonly<Record<string, string>> = {
  accepted: 'audit.detail.accepted',
  'accepted-modified': 'audit.detail.acceptedModified',
  rejected: 'audit.detail.rejected',
  withdrawn: 'audit.detail.withdrawn',
};

/** Keys that are ids or times already shown elsewhere in the row (or of no use to a person reading the log). */
const HIDDEN_DETAIL_KEYS: ReadonlySet<string> = new Set(['suggestionId', 'authorUserId', 'sessionOwnerUserId', 'createdAt', 'resolvedAt', 'editedAt']);

export interface AuditDetailRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Long or multi-line text (a suggestion): shown as a block. */
  readonly block: boolean;
}

/**
 * The sanitised `detail` of an entry as rows a person can read (review SPEC-07: the console dropped every detail, so a
 * suggestion's proposer and text, R6.3, could only be read in audit.jsonl). Values are text: React escapes them.
 */
export function auditDetailRows(entry: AuditEntry): AuditDetailRow[] {
  const detail = entry.detail;
  if (!detail) return [];
  const rows: AuditDetailRow[] = [];
  const shownReason = auditReason(entry);
  for (const [key, raw] of Object.entries(detail)) {
    if (HIDDEN_DETAIL_KEYS.has(key) || raw === undefined || raw === null) continue;
    // A refusal's reason is already in the outcome cell.
    if (key === 'reason' && raw === shownReason) continue;
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) && raw.every((item) => typeof item === 'string') ? raw.join('、') : JSON.stringify(raw);
    const value = key === 'outcome' && typeof raw === 'string' && raw in SUGGESTION_OUTCOME_KEYS ? t(SUGGESTION_OUTCOME_KEYS[raw] as Parameters<typeof t>[0]) : text;
    const labelKey = DETAIL_LABEL_KEYS[key];
    rows.push({ key, label: labelKey ? t(labelKey as Parameters<typeof t>[0]) : key, value, block: value.length > 80 || value.includes('\n') });
  }
  return rows;
}

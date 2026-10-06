// Names of the audit vocabulary, in the viewer's language (ARCHITECTURE §5.8). Every action of the protocol has a
// label: a new action without one is a compile error here (`satisfies Record<AuditAction, Key>`).
import type { AuditAction, AuditEntry } from '@smurg/protocol';
import { formatExactTime, formatList } from '../../lib/format.ts';
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
  'session.message': 'audit.action.session.message',
  'smurg.message': 'audit.action.smurg.message',
  'session.interrupt': 'audit.action.session.interrupt',
  'session.retry': 'audit.action.session.retry',
  'session.restart': 'audit.action.session.restart',
  'session.responsible': 'audit.action.session.responsible',
  'session.mode': 'audit.action.session.mode',
  'session.rule.remove': 'audit.action.session.rule.remove',
  'session.handover': 'audit.action.session.handover',
  'responsible.fallback': 'audit.action.responsible.fallback',
  'question.submit': 'audit.action.question.submit',
  'question.remind': 'audit.action.question.remind',
  'permission.decide': 'audit.action.permission.decide',
  'permission.auto': 'audit.action.permission.auto',
  'permission.auto-deny': 'audit.action.permission.auto-deny',
  'agent.command': 'audit.action.agent.command',
  'topic.create': 'audit.action.topic.create',
  'topic.rename': 'audit.action.topic.rename',
  'topic.archive': 'audit.action.topic.archive',
  'topic.delete': 'audit.action.topic.delete',
  'topic.discussion.restart': 'audit.action.topic.discussion.restart',
  'topic.spec.request': 'audit.action.topic.spec.request',
  'topic.rule.add': 'audit.action.topic.rule.add',
  'topic.rule.remove': 'audit.action.topic.rule.remove',
  'plan.generate': 'audit.action.plan.generate',
  'plan.start': 'audit.action.plan.start',
  'plan.resume': 'audit.action.plan.resume',
  'plan.assign': 'audit.action.plan.assign',
  'plan.mode': 'audit.action.plan.mode',
  'plan.item.retry': 'audit.action.plan.item.retry',
  'plan.item.continue': 'audit.action.plan.item.continue',
  'plan.item.resolve': 'audit.action.plan.item.resolve',
  'scheduler.start': 'audit.action.scheduler.start',
  'scheduler.disarm': 'audit.action.scheduler.disarm',
  'report.register': 'audit.action.report.register',
  'report.review': 'audit.action.report.review',
  'spec.commit': 'audit.action.spec.commit',
  'claude-config.decide': 'audit.action.claude-config.decide',
  'transcript.redact': 'audit.action.transcript.redact',
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

/** Audit times to the second (the log is evidence; "3 minutes ago" is not enough), in the viewer's language. */
export function formatAuditTime(at: number): string {
  return formatExactTime(at);
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
  command: 'audit.detail.command',
  tool: 'audit.detail.tool',
  rule: 'audit.detail.rule',
  decision: 'audit.detail.decision',
  mode: 'audit.detail.mode',
  purpose: 'audit.detail.purpose',
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
 * The sanitised `detail` of an entry as rows a person can read (the console dropped every detail, so a
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
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) && raw.every((item) => typeof item === 'string') ? formatList(raw) : JSON.stringify(raw);
    const value = key === 'outcome' && typeof raw === 'string' && raw in SUGGESTION_OUTCOME_KEYS ? t(SUGGESTION_OUTCOME_KEYS[raw] as Parameters<typeof t>[0]) : text;
    const labelKey = DETAIL_LABEL_KEYS[key];
    rows.push({ key, label: labelKey ? t(labelKey as Parameters<typeof t>[0]) : key, value, block: value.length > 80 || value.includes('\n') });
  }
  return rows;
}

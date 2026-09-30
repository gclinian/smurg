// The audit log (SPEC R11 Prototype 基本版: 「操作紀錄涵蓋檔案修改、agent 修改、建議、權限變更、登入登出，只存在主人電腦上」):
// newest first, paged backwards with admin.audit.query {before}, new entries appear live (admin.audit.entry, merged by
// the admin store). Filters are the launch version ([上線]).
import { useState } from 'react';
import type { AuditEntry } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { formatActor } from '../../lib/format.ts';
import { AUDIT_MAX_ENTRIES } from '../../lib/stores/admin.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Badge, Banner, Button, Table, type TableColumn } from '../../ui/index.ts';
import { auditActionLabel, auditDetailRows, auditOutcomeLabel, auditOutcomeTone, auditReason, formatAuditTime } from './audit-labels.ts';
import { t } from './strings.ts';

const columns: TableColumn<AuditEntry>[] = [
  {
    id: 'time',
    header: t('audit.col.time'),
    width: '11rem',
    cell: (entry) => <time dateTime={new Date(entry.at).toISOString()}>{formatAuditTime(entry.at)}</time>,
  },
  {
    id: 'actor',
    header: t('audit.col.actor'),
    cell: (entry) => <span title={entry.actor.kind === 'system' ? undefined : entry.actor.kind === 'user' ? entry.actor.userId : entry.actor.ownerUserId}>{formatActor(entry.actor)}</span>,
  },
  {
    id: 'action',
    header: t('audit.col.action'),
    cell: (entry) => <span title={entry.action}>{auditActionLabel(entry.action)}</span>,
  },
  {
    id: 'target',
    header: t('audit.col.target'),
    cell: (entry) =>
      entry.target !== undefined ? (
        <code className="console-audit__target" title={entry.target}>
          {entry.target}
        </code>
      ) : null,
  },
  {
    id: 'outcome',
    header: t('audit.col.outcome'),
    cell: (entry) => {
      const reason = auditReason(entry);
      return (
        <span className="console-audit__outcome">
          <Badge tone={auditOutcomeTone(entry.outcome)}>{auditOutcomeLabel(entry.outcome)}</Badge>
          {reason ? <code className="console-muted">{reason}</code> : null}
        </span>
      );
    },
  },
  {
    id: 'detail',
    header: t('audit.col.detail'),
    cell: (entry) => <AuditDetail entry={entry} />,
  },
];

/** Who proposed what, conflict files, role changes, …: the entry's detail, folded (review SPEC-07). */
function AuditDetail({ entry }: { entry: AuditEntry }) {
  const rows = auditDetailRows(entry);
  if (rows.length === 0) return null;
  return (
    <details className="console-audit__detail">
      <summary>{t('audit.detail.show')}</summary>
      <dl aria-label={t('audit.detail.label')}>
        {rows.map((row) => (
          <div key={row.key} className={row.block ? 'console-audit__detail-block' : undefined}>
            <dt>{row.label}</dt>
            <dd>{row.block ? <pre>{row.value}</pre> : row.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function AuditSection() {
  const stores = useStores();
  const { audit, auditHasMore, auditLoadingOlder } = useStore(
    stores.admin,
    (state) => ({ audit: state.audit, auditHasMore: state.auditHasMore, auditLoadingOlder: state.auditLoadingOlder }),
    shallowEqual,
  );
  const [error, setError] = useState<string | null>(null);

  const loadOlder = async (): Promise<void> => {
    setError(null);
    try {
      await stores.admin.loadOlderAudit();
    } catch (failure) {
      setError(t('audit.olderFailed', { message: describeError(failure) }));
    }
  };

  return (
    <>
      <p className="console-hint">{t('audit.lead')}</p>
      <Table caption={t('audit.caption')} hideCaption columns={columns} rows={audit} rowKey={(entry) => entry.id} empty={t('audit.empty')} className="console-audit" />
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
      <div className="console-audit__footer">
        {audit.length > 0 ? <span className="console-muted">{t('audit.count', { count: audit.length })}</span> : null}
        {auditHasMore ? (
          <Button size="sm" loading={auditLoadingOlder} onClick={() => void loadOlder()}>
            {t('audit.loadOlder')}
          </Button>
        ) : audit.length >= AUDIT_MAX_ENTRIES ? (
          <span className="console-muted">{t('audit.limit', { max: AUDIT_MAX_ENTRIES })}</span>
        ) : audit.length > 0 ? (
          <span className="console-muted">{t('audit.end')}</span>
        ) : null}
      </div>
    </>
  );
}

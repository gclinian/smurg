// One suggestion, as its proposer, the session owner or a bystander sees it: who proposed it, when, the text, the code
// it refers to, and (once resolved) the outcome.
import type { ReactNode } from 'react';
import type { Suggestion } from '@smurg/protocol';
import { formatDateTime, formatRelativeTime } from '../../lib/format.ts';
import { useCommand } from '../../lib/workspace/context.tsx';
import { Badge, type Tone } from '../../ui/index.ts';
import { IconFileText } from '../../ui/icons.tsx';
import { t } from './strings.ts';
import { resolutionReason, sourceLabel } from './text.ts';

const STATUS_TONE: Record<Suggestion['status'], Tone> = {
  pending: 'info',
  accepted: 'success',
  'accepted-modified': 'success',
  rejected: 'danger',
  withdrawn: 'neutral',
};

const STATUS_KEY = {
  pending: 'status.pending',
  accepted: 'status.accepted',
  'accepted-modified': 'status.accepted-modified',
  rejected: 'status.rejected',
  withdrawn: 'status.withdrawn',
} as const satisfies Record<Suggestion['status'], Parameters<typeof t>[0]>;

export function statusText(status: Suggestion['status']): string {
  return t(STATUS_KEY[status]);
}

export interface SuggestionCardProps {
  readonly suggestion: Suggestion;
  /** Line above the text ("From Amy", "For Ian's Claude"). */
  readonly heading: ReactNode;
  readonly now: number;
  readonly children?: ReactNode;
  readonly showStatus?: boolean;
}

export function SuggestionCard({ suggestion, heading, now, children, showStatus = true }: SuggestionCardProps) {
  const openFile = useCommand('openFile');
  const source = suggestion.source;
  const resolved = suggestion.status !== 'pending';
  const reason = resolved ? resolutionReason(suggestion) : null;
  return (
    <article className="suggest-card" data-status={suggestion.status} aria-label={typeof heading === 'string' ? heading : undefined}>
      <header className="suggest-card__header">
        <span className="suggest-card__heading">{heading}</span>
        <time className="suggest-card__time" dateTime={new Date(suggestion.createdAt).toISOString()} title={formatDateTime(suggestion.createdAt)}>
          {formatRelativeTime(suggestion.createdAt, now)}
        </time>
        {showStatus ? <Badge tone={STATUS_TONE[suggestion.status]}>{statusText(suggestion.status)}</Badge> : null}
      </header>
      <pre className="suggest-card__text">{suggestion.text}</pre>
      {source ? (
        <button
          type="button"
          className="suggest-source__link"
          onClick={() => {
            openFile({ file: source.file, line: source.startLine }).catch(() => {
              // informational
            });
          }}
          aria-label={t('source.open', { path: source.file.path, line: source.startLine })}
        >
          <IconFileText />
          <span>{sourceLabel(source.file.path, source.startLine, source.endLine)}</span>
        </button>
      ) : null}
      {resolved && suggestion.status === 'accepted-modified' && suggestion.finalText !== undefined ? (
        <div className="suggest-card__final">
          <p>{t('mine.final')}</p>
          <pre className="suggest-card__text">{suggestion.finalText}</pre>
        </div>
      ) : null}
      {reason !== null ? <p className="suggest-card__reason">{t('mine.reason', { reason })}</p> : null}
      {children}
    </article>
  );
}

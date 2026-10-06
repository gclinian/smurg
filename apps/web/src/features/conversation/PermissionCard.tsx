// A permission request of the agent (UX §5.2, DESIGN §5.12 item 14). What the agent wants to do is shown whole:
// a command as it will run, an edit as its diff, any other tool's whole input; nothing is shortened or masked, and
// characters a reader cannot see are made visible. The host and members with agent access answer; everyone else
// reads who can. The focus lands on the card, never on Allow.
import { memo, useId, useRef, useState } from 'react';
import { DENY_MESSAGE_MAX_CHARS, mayAllowForTopic, mayDecidePermission, ruleString, type PermissionRequest } from '@smurg/protocol';
import { formatAge, formatTime } from '../../lib/format.ts';
import { kindLabel } from '../../lib/session-status.ts';
import { useStore } from '../../lib/store.ts';
import { useNow } from '../../lib/use-now.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Button, Card, KindIcon } from '../../ui/index.ts';
import { IconFolder, IconGitBranch } from '../../ui/icons.tsx';
import { lateAnswerText, settledOf } from './cards.ts';
import { useAction, useConversationEnv, useMarkSeen, useSessionFacts } from './env.tsx';
import { t } from './strings.ts';
import { cardDomId, commandHead, showControls } from './text.ts';
import { DiffView } from './ToolCard.tsx';

function titleOf(request: PermissionRequest): string {
  switch (request.what) {
    case 'command':
      return t('perm.title.command');
    case 'edit':
      return t('perm.title.edit');
    case 'fetch':
      return t('perm.title.fetch');
    case 'outside':
      return t('perm.title.outside');
    case 'other':
      return t('perm.title.other', { tool: request.tool });
  }
}

/** Exactly what is asked for: the command, the diff, the address, or the whole input. */
function Asked({ request }: { request: PermissionRequest }) {
  const parts = [];
  if (request.outside === true && request.path === undefined && request.file === undefined) {
    parts.push(
      <p key="outside" className="conv-perm__path">
        {t('perm.outside')}
      </p>,
    );
  }
  const path = request.path ?? request.file?.path;
  if (path !== undefined) {
    parts.push(
      <p key="path" className="conv-perm__path conv-mono">
        {showControls(path)}
      </p>,
    );
  }
  if (request.command !== undefined) {
    parts.push(
      <pre key="command" className="conv-perm__cmd" tabIndex={0}>
        <code>{showControls(request.command)}</code>
      </pre>,
    );
  }
  if (request.change !== undefined) parts.push(<DiffView key="change" diff={showControls(request.change.text)} {...(path === undefined ? {} : { path })} />);
  if (request.url !== undefined) {
    parts.push(
      <pre key="url" className="conv-perm__cmd" tabIndex={0}>
        <code>{showControls(request.url)}</code>
      </pre>,
    );
  }
  if (request.input !== undefined) {
    parts.push(
      <pre key="input" className="conv-perm__cmd conv-perm__cmd--input" tabIndex={0} aria-label={t('perm.input', { tool: request.tool })}>
        <code>{showControls(request.input)}</code>
      </pre>,
    );
  }
  return <>{parts}</>;
}

function settledText(request: PermissionRequest): string {
  const decision = request.decision;
  if (request.status === 'withdrawn' || decision === undefined) {
    switch (request.withdrawn?.reason) {
      case 'stopped':
        return t('card.withdrawn.stopped');
      case 'ended':
        return t('card.withdrawn.ended');
      case 'failed':
        return t('card.withdrawn.failed');
      default:
        return t('card.withdrawn.restarted');
    }
  }
  const who = { name: decision.by.displayName, time: formatTime(decision.at) };
  if (request.status === 'denied') return decision.message === undefined ? t('perm.settled.denied', who) : t('perm.settled.deniedWith', { ...who, message: decision.message });
  if (decision.always !== undefined && request.alwaysRule !== undefined) {
    return t(decision.always === 'topic' ? 'perm.settled.always.topic' : 'perm.settled.always.session', { ...who, rule: ruleString(request.alwaysRule) });
  }
  return t('perm.settled.allowed', who);
}

/** Why "Always allow this kind" is not offered, naming the command the way the rule does. */
function noAlwaysText(request: PermissionRequest): string {
  const command = request.command ?? request.tool;
  switch (request.noAlways) {
    case 'interpreter':
      return t('perm.noAlways.interpreter', { command: commandHead(command, 1) });
    case 'fetches-code':
      return t('perm.noAlways.fetches-code', { command: commandHead(command, 2) });
    case 'one-word':
      return t('perm.noAlways.one-word');
    case 'host-only':
      return t('perm.noAlways.host-only');
    default:
      return t('perm.noAlways.no-suggestion');
  }
}

export const PermissionCard = memo(function PermissionCard({ requestId }: { requestId: string }) {
  const stores = useStores();
  const { sessionId, self, role } = useConversationEnv();
  const request = useStore(stores.conversations, (state) => state.conversations.get(sessionId)?.permissions.get(requestId));
  const facts = useSessionFacts(sessionId);
  const branch = useStore(stores.worktrees, (state) => (request?.root.kind === 'worktree' ? state.worktrees.get(request.root.worktreeId)?.branch : undefined));
  const ref = useRef<HTMLElement>(null);
  const scopeName = useId();
  const open = request?.status === 'open';
  useMarkSeen(ref, { sessionId, cardId: requestId }, open);
  const now = useNow(open ? 10_000 : 3_600_000);

  const [late, setLate] = useState<string | null>(null);
  const action = useAction((error) => {
    const settled = settledOf(error);
    if (settled === null) return false;
    setLate(lateAnswerText(settled));
    return true;
  });
  const [scope, setScope] = useState<'session' | 'topic'>('session');
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState('');

  const icon = <KindIcon kind="permission" label={kindLabel('permission')} />;
  if (request === undefined) {
    return (
      <Card ref={ref} id={cardDomId(requestId)} title={t('perm.title.other', { tool: '…' })} icon={icon} className="conv-card">
        <p className="conv-card__who">{t('card.missing')}</p>
      </Card>
    );
  }

  const where =
    request.root.kind === 'main' ? (
      <p className="conv-perm__facts">
        <IconFolder size={14} />
        <span>{t('perm.where.main')}</span>
      </p>
    ) : (
      <p className="conv-perm__facts">
        <IconGitBranch size={14} />
        <span>{t('perm.where.worktree', { branch: branch ?? facts?.branch ?? request.root.worktreeId })}</span>
      </p>
    );

  if (!open) {
    return (
      <Card ref={ref} id={cardDomId(requestId)} title={titleOf(request)} icon={icon} settled className="conv-card conv-card--permission">
        <p className="conv-card__who">
          <strong>{settledText(request)}</strong>
        </p>
        <Asked request={request} />
      </Card>
    );
  }

  const selfId = self?.userId ?? null;
  const mayDecide = role !== null && selfId !== null && mayDecidePermission({ userId: selfId, role }, { hostOnly: request.hostOnly });
  const topicScope = facts?.topicId !== undefined && mayAllowForTopic(role);
  const decide = (decision: 'allow' | 'allow-always' | 'deny'): void => {
    setLate(null);
    const trimmed = message.trim();
    void action.run(() =>
      stores.conversations.decide(requestId, {
        decision,
        ...(decision === 'allow-always' ? { scope: topicScope ? scope : 'session' } : {}),
        ...(decision === 'deny' && trimmed !== '' ? { message: trimmed } : {}),
      }),
    );
  };

  let whose: string;
  if (request.hostOnly) whose = role === 'host' ? t('perm.hostOnly.mine') : t('perm.hostOnly');
  else if (!mayDecide) whose = facts?.responsibleName != null ? t('perm.waiting.responsible', { name: facts.responsibleName }) : t('perm.waiting.all');
  else if (facts?.responsibleId == null) whose = t('perm.inbox.all');
  else if (facts.responsibleId === selfId) whose = t('perm.inbox.mine');
  else whose = t('perm.inbox.theirs', { name: facts.responsibleName ?? '' });

  const rule = request.alwaysRule;
  const footer = (
    <>
      {mayDecide ? (
        <>
          <div className="conv-card__actions">
            <Button variant="primary" disabled={action.busy} onClick={() => decide('allow')}>
              {t('perm.allow')}
            </Button>
            {rule !== undefined ? (
              <Button disabled={action.busy} onClick={() => decide('allow-always')}>
                {t('perm.always')}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={action.busy} aria-expanded={denying} onClick={() => (denying ? decide('deny') : setDenying(true))}>
              {denying ? t('perm.deny.confirm') : t('perm.deny')}
            </Button>
          </div>
          {denying ? (
            <input
              className="ui-input"
              type="text"
              // The line appears because Deny was pressed: the person continues there.
              autoFocus
              aria-label={t('perm.deny.label')}
              placeholder={t('perm.deny.label')}
              maxLength={DENY_MESSAGE_MAX_CHARS}
              value={message}
              onChange={(event) => setMessage(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault();
                  decide('deny');
                } else if (event.key === 'Escape') {
                  event.stopPropagation();
                  setDenying(false);
                }
              }}
            />
          ) : null}
          {rule !== undefined ? (
            <>
              {/* In words: the rule `pnpm test *` is "commands that start with pnpm test" (the star is the rule's own syntax). */}
              <p className="conv-perm__rule">{rule.tool === 'Bash' ? t('perm.kind.bash', { pattern: rule.pattern.replace(/\s*\*$/u, '') }) : t('perm.kind.fetch', { host: rule.pattern.replace(/^domain:/, '') })}</p>
              {topicScope ? (
                <div className="conv-perm__scope" role="radiogroup" aria-label={t('perm.scope')}>
                  <label>
                    <input type="radio" name={scopeName} checked={scope === 'session'} onChange={() => setScope('session')} /> {t('perm.scope.session')}
                  </label>
                  <label>
                    <input type="radio" name={scopeName} checked={scope === 'topic'} onChange={() => setScope('topic')} /> {t('perm.scope.topic')}
                  </label>
                </div>
              ) : null}
            </>
          ) : (
            <p className="conv-perm__rule">{noAlwaysText(request)}</p>
          )}
        </>
      ) : null}
      <p className="conv-card__who">{whose}</p>
      {request.escalatedAt !== undefined && facts?.responsibleName != null ? (
        <p className="conv-card__who conv-card__who--warn">{t('card.escalated', { name: facts.responsibleName, age: formatAge(request.askedAt, now) })}</p>
      ) : null}
      {late !== null ? (
        <p className="conv-card__who" role="status">
          {late}
        </p>
      ) : null}
      {action.error !== null ? (
        <p className="conv-card__problem" role="alert">
          {t('actionFailed', { message: action.error })}
        </p>
      ) : null}
    </>
  );

  return (
    <Card
      ref={ref}
      id={cardDomId(requestId)}
      title={titleOf(request)}
      icon={icon}
      tone="warning"
      meta={t('card.waiting', { age: formatAge(request.askedAt, now) })}
      className="conv-card conv-card--permission"
      footer={footer}
    >
      <Asked request={request} />
      {where}
      {request.reason !== undefined ? <p className="conv-card__who">{t('perm.reason', { reason: request.reason })}</p> : null}
    </Card>
  );
});

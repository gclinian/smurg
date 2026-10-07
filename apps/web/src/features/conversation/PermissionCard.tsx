// A permission request of the agent (UX §5.2, DESIGN §5.12 item 14). What the agent wants to do is shown whole:
// a command as it will run, an edit as its diff, any other tool's whole input; nothing is shortened or masked, and
// characters a reader cannot see are made visible. The host and members with agent access answer; everyone else
// reads who can. The focus lands on the card, never on Allow.
//
// A long part scrolls inside its box (UX §5.2). A box that does not show all of its part says so, with the number of
// lines, and "Allow once" and "Always allow this kind" wait until the end of every such box has been on screen: a
// command of `pnpm test`, a dozen empty lines and then something else is otherwise allowed unseen (DESIGN S6: a
// person never allows what they cannot see). Nothing scrolls sideways: the command wraps, and in this card the diff
// wraps too (conversation.css).
import { memo, useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
import { cardDomId, commandHead, commandsOfRule, showControls } from './text.ts';
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

const lineCount = (text: string): number => text.replace(/\n$/, '').split('\n').length;
const ROUNDING_PX = 2;

type PartName = 'command' | 'change' | 'url' | 'input';
/** Tells the card that a part's box does not show all of it and its end has not been on screen yet (or that this is over). */
type ReportUnread = (part: PartName, unread: boolean) => void;

/**
 * One part of what is asked, in its own box (the element given as `children`, which scrolls when the part is long).
 * While the box does not show all of the part, the line under it says how long the part is; `onUnread` hears whether
 * its end still has to be scrolled to. A box that was at its end once stays read: the reader had all of it on screen.
 */
function Part({ name, lines, onUnread, children }: { name: PartName; lines: number; onUnread: ReportUnread | undefined; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'whole' | 'more' | 'read'>('whole');
  // Layout effects: a card that is drawn for the first time with a long part never shows Allow as available.
  useLayoutEffect(() => {
    const box = ref.current?.firstElementChild;
    if (!(box instanceof HTMLElement)) return;
    let reachedEnd = false;
    // A box without a size (a column that is not on screen) scrolls nothing: it is measured again when it gets one.
    // The browser rounds the three numbers each by itself: two pixels are no line of text.
    const measure = (): void => {
      const hidden = box.scrollHeight - box.clientHeight;
      if (hidden > ROUNDING_PX && box.scrollTop >= hidden - ROUNDING_PX) reachedEnd = true;
      setState(hidden <= ROUNDING_PX ? 'whole' : reachedEnd ? 'read' : 'more');
    };
    measure();
    box.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(box);
    return () => {
      box.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, []);
  const unread = state === 'more';
  useLayoutEffect(() => {
    if (onUnread === undefined || !unread) return;
    onUnread(name, true);
    return () => onUnread(name, false);
  }, [onUnread, name, unread]);
  return (
    <div ref={ref} className="conv-perm__part">
      {children}
      {state === 'whole' ? null : <p className="conv-perm__more">{t('perm.more', { count: lines })}</p>}
    </div>
  );
}

/** Exactly what is asked for: the command, the diff, the address, or the whole input. */
function Asked({ request, onUnread }: { request: PermissionRequest; onUnread?: ReportUnread }) {
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
      <Part key="command" name="command" lines={lineCount(request.command)} onUnread={onUnread}>
        <pre className="conv-perm__cmd" tabIndex={0}>
          <code>{showControls(request.command)}</code>
        </pre>
      </Part>,
    );
  }
  if (request.change !== undefined) {
    parts.push(
      <Part key="change" name="change" lines={lineCount(request.change.text)} onUnread={onUnread}>
        <DiffView diff={showControls(request.change.text)} {...(path === undefined ? {} : { path })} />
      </Part>,
    );
  }
  if (request.url !== undefined) {
    parts.push(
      <Part key="url" name="url" lines={lineCount(request.url)} onUnread={onUnread}>
        <pre className="conv-perm__cmd" tabIndex={0}>
          <code>{showControls(request.url)}</code>
        </pre>
      </Part>,
    );
  }
  if (request.input !== undefined) {
    parts.push(
      <Part key="input" name="input" lines={lineCount(request.input)} onUnread={onUnread}>
        <pre className="conv-perm__cmd conv-perm__cmd--input" tabIndex={0} aria-label={t('perm.input', { tool: request.tool })}>
          <code>{showControls(request.input)}</code>
        </pre>
      </Part>,
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
  /** The parts whose box does not show all of them and whose end has not been on screen yet. */
  const [unread, setUnread] = useState<readonly PartName[]>([]);
  const reportUnread = useCallback<ReportUnread>((part, more) => {
    setUnread((previous) => (more === previous.includes(part) ? previous : more ? [...previous, part] : previous.filter((one) => one !== part)));
  }, []);

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
  const mustRead = unread.length > 0;
  const decide = (decision: 'allow' | 'allow-always' | 'deny'): void => {
    if (decision !== 'deny' && mustRead) return;
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
            <Button variant="primary" disabled={action.busy || mustRead} onClick={() => decide('allow')}>
              {t('perm.allow')}
            </Button>
            {rule !== undefined ? (
              <Button disabled={action.busy || mustRead} onClick={() => decide('allow-always')}>
                {t('perm.always')}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={action.busy} aria-expanded={denying} onClick={() => (denying ? decide('deny') : setDenying(true))}>
              {denying ? t('perm.deny.confirm') : t('perm.deny')}
            </Button>
          </div>
          {mustRead ? <p className="conv-perm__more">{t('perm.readFirst')}</p> : null}
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
              <p className="conv-perm__rule">{rule.tool === 'Bash' ? t('perm.kind.bash', { pattern: commandsOfRule(rule.pattern) }) : t('perm.kind.fetch', { host: rule.pattern.replace(/^domain:/, '') })}</p>
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
      <Asked request={request} onUnread={reportUnread} />
      {where}
      {request.reason !== undefined ? <p className="conv-card__who">{t('perm.reason', { reason: request.reason })}</p> : null}
    </Card>
  );
});

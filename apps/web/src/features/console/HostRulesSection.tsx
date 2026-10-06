// "My own Claude Code rules" (console section `host-rules`, and the body of the dialog in the sessions view): which
// allow rules of the host's own Claude Code settings apply to agents here. INFORMATION ONLY (OWNER-DECISIONS Q7 = B):
// there is nothing to decide and no button to press; once the list has been on the host's screen the daemon is told
// (`admin.hostRules.seen`) and the inbox item leaves.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { msg, renderEnglish } from '@smurg/protocol/i18n';
import { renderWireText } from '../../lib/errors.ts';
import { Banner, Button, Spinner } from '../../ui/index.ts';
import { groupHostRules, useHostRules, type HostRuleSource, type HostRulesApi } from './host-rules.ts';
import { t } from './strings.ts';

type Key = Parameters<typeof t>[0];

const SOURCE_LABEL: Readonly<Record<HostRuleSource, Key>> = {
  user: 'hostRules.source.user',
  project: 'hostRules.source.project',
  local: 'hostRules.source.local',
  managed: 'hostRules.source.managed',
};

/** Whether `ref` is in the viewport (false where the browser cannot tell: then only an explicit request counts). */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

/** "Your own Claude Code settings allow 12 kinds of commands without asking. Agents here run them without asking too." */
export function foundSentence(count: number): string {
  const ref = msg('hostRules.found', { count });
  return renderWireText(ref, renderEnglish(ref));
}

export interface HostRulesViewProps {
  readonly rules: HostRulesApi;
  /** The list was asked for (the route's section, an open dialog): it counts as seen without scrolling to it. */
  readonly shown: boolean;
}

export function HostRulesView({ rules, shown }: HostRulesViewProps) {
  const list = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(list);
  const { markSeen } = rules;
  const ready = rules.status === 'ready';

  useEffect(() => {
    if (ready && (shown || onScreen)) markSeen();
  }, [ready, shown, onScreen, markSeen]);

  const groups = groupHostRules(rules.rules);

  return (
    <div ref={list} className="console-host-rules">
      {rules.status === 'error' && rules.error ? (
        <Banner
          tone="danger"
          live="alert"
          actions={
            <Button size="sm" onClick={() => void rules.reload()}>
              {t('load.retry')}
            </Button>
          }
        >
          {t('hostRules.loadFailed', { message: rules.error })}
        </Banner>
      ) : null}
      {rules.status === 'loading' || rules.status === 'idle' ? (
        <p className="console-loading">
          <Spinner size={14} decorative /> {t('hostRules.loading')}
        </p>
      ) : null}
      {ready && groups.length === 0 ? <p className="console-hint">{t('hostRules.none')}</p> : null}
      {ready && groups.length > 0 ? (
        <>
          {/* The daemon's own sentence, so the inbox row, the notification and this page say the same. */}
          <p className="console-host-rules__found">{foundSentence(rules.rules.length)}</p>
          <p className="console-hint">{t('hostRules.explain')}</p>
          {groups.map((group) => (
            <section key={group.source} className="console-host-rules__group" aria-label={t(SOURCE_LABEL[group.source])}>
              <h3 className="console-host-rules__source">{t(SOURCE_LABEL[group.source])}</h3>
              <ul className="console-trust__list console-trust__list--mono">
                {group.rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </section>
          ))}
          <p className="console-hint">{t('hostRules.change')}</p>
        </>
      ) : null}
    </div>
  );
}

export function HostRulesSection({ targeted }: { targeted: boolean }) {
  const rules = useHostRules();
  return <HostRulesView rules={rules} shown={targeted} />;
}

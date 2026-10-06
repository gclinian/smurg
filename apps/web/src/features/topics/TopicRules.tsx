// "Allowed in this topic": the kinds of commands every session of a topic runs without asking (`Topic.rules`), with
// add and remove for the host and members with agent access (DESIGN §5.12 item 20; also a line of the Start dialog).
// Only the two checked forms can be added (`checkRememberableRule`): the form says so before the daemon refuses.
import { checkRememberableRule, mayAllowForTopic, ruleString, type RuleRefusal, type Topic } from '@smurg/protocol';
import { useState, type FormEvent } from 'react';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { selectRole } from '../../lib/stores/workspace.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Button, IconButton, Input, Select } from '../../ui/index.ts';
import { IconClose } from '../../ui/icons.tsx';
import { LinkButton, useAction } from './shared.tsx';
import { t } from './strings.ts';

type RuleTool = 'Bash' | 'WebFetch';

/** Why a typed rule cannot be remembered, in words; null when it can. */
export function ruleProblem(tool: RuleTool, pattern: string): string | null {
  const check = checkRememberableRule(tool, pattern);
  if (check.ok) return null;
  const reason: RuleRefusal = check.reason;
  if (reason === 'form') return tool === 'Bash' ? t('rules.refused.form.bash') : t('rules.refused.form.web');
  return t(`rules.refused.${reason}`);
}

export function TopicRules({ topic }: { topic: Topic }) {
  const stores = useStores();
  const act = useAction();
  const mayChange = mayAllowForTopic(useStore(stores.workspace, selectRole)) && !topic.archived;
  const [adding, setAdding] = useState(false);
  const [tool, setTool] = useState<RuleTool>('Bash');
  const [pattern, setPattern] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const typed = tool === 'WebFetch' && pattern.trim() !== '' && !pattern.trim().startsWith('domain:') ? `domain:${pattern.trim()}` : pattern.trim();
  const problem = typed === '' ? null : ruleProblem(tool, typed);

  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (typed === '' || problem !== null) return;
    setBusy(true);
    setFailure(null);
    try {
      await stores.topics.addRule(topic.id, { tool, pattern: typed });
      setPattern('');
      setAdding(false);
    } catch (error) {
      setFailure(t('rules.failed', { reason: describeError(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="topics-rules">
      <div className="topics-rules__row">
        <span className="topics-rules__label">{t('rules.label')}</span>
        {topic.rules.length === 0 ? (
          <span className="topics-rules__none">{t('rules.none')}</span>
        ) : (
          <ul className="topics-rules__list" aria-label={t('rules.label')}>
            {topic.rules.map((rule) => (
              <li key={rule.id} className="topics-rules__rule">
                <code>{rule.tool === 'Bash' ? rule.pattern : ruleString(rule)}</code>
                {mayChange ? (
                  <IconButton
                    size="sm"
                    label={t('rules.remove', { rule: rule.pattern })}
                    icon={<IconClose size={12} />}
                    onClick={() => void act(() => stores.topics.removeRule(topic.id, rule.id), (reason) => t('rules.failed', { reason }))}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {mayChange && !adding ? <LinkButton onClick={() => setAdding(true)}>{t('rules.add')}</LinkButton> : null}
      </div>
      {adding ? (
        <form className="topics-rules__form" onSubmit={(event) => void add(event)}>
          <Select<RuleTool>
            label={t('rules.tool')}
            value={tool}
            options={[
              { value: 'Bash', label: t('rules.tool.bash') },
              { value: 'WebFetch', label: t('rules.tool.web') },
            ]}
            onChange={setTool}
          />
          <Input
            label={tool === 'Bash' ? t('rules.pattern.bash') : t('rules.pattern.web')}
            value={pattern}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            hint={tool === 'Bash' ? t('rules.hint.bash') : t('rules.hint.web')}
            error={problem ?? failure ?? undefined}
            onChange={(event) => setPattern(event.currentTarget.value)}
          />
          <div className="topics-rules__actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setFailure(null);
              }}
            >
              {tApp('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" type="submit" loading={busy} disabled={typed === '' || problem !== null}>
              {t('rules.save')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

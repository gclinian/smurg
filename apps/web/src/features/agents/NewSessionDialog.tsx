// 「新增 session」 (SPEC R4, R9): kind, where (shared main workspace / my worktree: a new one or one of my kept ones),
// what the role allows, and the daemon's refusal in plain zh-TW — a sandbox refusal with its actionable message.
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import type { SessionInfo } from '@smurg/protocol';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectRole, selectUserId, selectWorkspaceInfo } from '../../lib/stores/workspace.ts';
import { selectWorktreeList } from '../../lib/stores/worktrees.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, Input, useToast } from '../../ui/index.ts';
import { IconShield } from '../../ui/icons.tsx';
import {
  DEFAULT_TERMINAL_SIZE,
  apiKeyApplies,
  apiKeyProblem,
  buildCreatePayload,
  newSessionOptions,
  type NewSessionForm,
  type SessionKind,
  type WhereChoice,
} from './new-session.ts';
import { describeSessionError, kindLabel, type SessionErrorView } from './session-info.ts';
import { t } from './strings.ts';

const INITIAL_FORM: NewSessionForm = { kind: 'agent', where: 'main', title: '', apiKey: '' };

export interface NewSessionDialogProps {
  readonly open: boolean;
  onClose(): void;
  onCreated(session: SessionInfo): void;
}

export function NewSessionDialog({ open, onClose, onCreated }: NewSessionDialogProps) {
  const stores = useStores();
  const toast = useToast();
  const formId = useId();
  const role = useStore(stores.workspace, selectRole);
  const userId = useStore(stores.workspace, selectUserId);
  const workspace = useStore(stores.workspace, selectWorkspaceInfo);
  const worktreeList = useStore(stores.worktrees, selectWorktreeList, shallowEqual);
  const sessionMap = useStore(stores.sessions, (state) => state.sessions);
  const options = useMemo(
    () => newSessionOptions({ role, userId, workspace, worktrees: worktreeList, sessions: sessionMap }),
    [role, userId, workspace, worktreeList, sessionMap],
  );

  const [form, setForm] = useState<NewSessionForm>(INITIAL_FORM);
  const [useKey, setUseKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SessionErrorView | null>(null);

  // Closing forgets everything typed, the API key first of all.
  useEffect(() => {
    if (open) return;
    setForm(INITIAL_FORM);
    setUseKey(false);
    setError(null);
    setSubmitting(false);
  }, [open]);

  const keptChoices = options.worktree.kept.map((worktree) => ({ worktree, value: `worktree:${worktree.id}` as WhereChoice }));
  const whereValid =
    form.where === 'main' || (options.worktree.available && (form.where === 'worktree:new' || keptChoices.some((choice) => choice.value === form.where)));
  const where: WhereChoice = whereValid ? form.where : 'main';
  const keyApplies = apiKeyApplies(options, form.kind);
  const keyInUse = keyApplies && useKey;
  const keyProblem = keyInUse ? apiKeyProblem(form.apiKey.trim()) : null;

  const update = (patch: Partial<NewSessionForm>): void => setForm((previous) => ({ ...previous, ...patch }));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!options.canCreate || submitting || keyProblem !== null) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = buildCreatePayload(options, { ...form, where, apiKey: keyInUse ? form.apiKey : '' }, DEFAULT_TERMINAL_SIZE);
      const session = await stores.sessions.create(payload);
      setForm(INITIAL_FORM);
      setUseKey(false);
      toast.show({ tone: 'success', title: t('new.created', { title: session.title }) });
      onCreated(session);
    } catch (failure) {
      setError(describeSessionError(failure));
    } finally {
      setSubmitting(false);
    }
  };

  const blockedText =
    options.blockedBy === 'role-editor' ? t('new.role.editor') : options.blockedBy === 'role-viewer' ? t('new.role.viewer') : t('new.role.unknown');

  const kindOption = (kind: SessionKind, hint: string) => (
    <label className="agents-choice">
      <input type="radio" name={`${formId}-kind`} value={kind} checked={form.kind === kind} onChange={() => update({ kind })} />
      <span className="agents-choice__text">
        <span className="agents-choice__label">{kind === 'agent' ? kindLabel({ kind }) : t('new.kind.terminal')}</span>
        <span className="agents-choice__hint">{hint}</span>
      </span>
    </label>
  );

  const whereOption = (value: WhereChoice, label: string, hint: string | null, disabled: boolean) => (
    <label className="agents-choice" data-disabled={disabled || undefined}>
      <input type="radio" name={`${formId}-where`} value={value} checked={where === value} disabled={disabled} onChange={() => update({ where: value })} />
      <span className="agents-choice__text">
        <span className="agents-choice__label">{label}</span>
        {hint ? <span className="agents-choice__hint">{hint}</span> : null}
      </span>
    </label>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('new.title')}
      size="md"
      footer={
        options.canCreate ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {tApp('common.cancel')}
            </Button>
            <Button variant="primary" type="submit" form={formId} loading={submitting} disabled={keyProblem !== null}>
              {t('new.submit')}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>{tApp('common.close')}</Button>
        )
      }
    >
      {!options.canCreate ? (
        <Banner tone="info" live="none">
          {blockedText}
        </Banner>
      ) : (
        <form id={formId} className="agents-form" onSubmit={(event) => void submit(event)} autoComplete="off">
          <Banner tone="neutral" live="none" icon={<IconShield />}>
            {options.sandboxed ? t('new.sandbox.guest') : t('new.sandbox.host')}
          </Banner>

          <fieldset className="agents-fieldset">
            <legend>{t('new.kind')}</legend>
            {kindOption('agent', t('new.kind.agentHint'))}
            {kindOption('terminal', t('new.kind.terminalHint'))}
          </fieldset>

          <fieldset className="agents-fieldset">
            <legend>{t('new.where')}</legend>
            {whereOption('main', t('new.where.main'), t('new.where.mainHint'), false)}
            {whereOption('worktree:new', t('new.where.worktreeNew'), options.worktree.available ? t(role === 'host' ? 'new.where.worktreeHintHost' : 'new.where.worktreeHint') : null, !options.worktree.available)}
            {keptChoices.map(({ worktree, value }) => (
              <div key={worktree.id}>{whereOption(value, t('new.where.worktreeKept', { branch: worktree.branch }), null, false)}</div>
            ))}
            {!options.worktree.available ? <p className="agents-fieldset__note">{t('new.where.notGit')}</p> : null}
          </fieldset>

          <Input label={t('new.name')} hint={t('new.nameHint')} maxLength={256} value={form.title} onChange={(event) => update({ title: event.currentTarget.value })} />

          {keyApplies ? (
            <div className="agents-form__key">
              <label className="agents-check">
                <input type="checkbox" checked={useKey} onChange={(event) => setUseKey(event.currentTarget.checked)} />
                <span>{t('new.apiKey.toggle')}</span>
              </label>
              {useKey ? (
                <>
                  <Input
                    label={t('new.apiKey.label')}
                    type="password"
                    name="smurg-session-api-key"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    data-1p-ignore=""
                    data-lpignore="true"
                    data-bwignore=""
                    data-form-type="other"
                    value={form.apiKey}
                    onChange={(event) => update({ apiKey: event.currentTarget.value })}
                    hint={t('new.apiKey.hint')}
                    error={keyProblem !== null ? t('new.apiKey.invalid') : undefined}
                  />
                  <p className="agents-fieldset__note">{t('login.key.limit')}</p>
                  <p className="agents-fieldset__note">{t('login.warning.host')}</p>
                </>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <Banner tone="danger" live="alert" title={error.title}>
              <p>{error.message}</p>
              {error.hint ? <p>{error.hint}</p> : null}
            </Banner>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}

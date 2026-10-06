// "New session" and "New terminal" (the "New" control of the session list; the Terminal drawer of code mode): where
// to work (the shared main workspace / a worktree of my own: a new one or one I kept), a name, for an agent session
// what it should do first; what the role allows, and the daemon's refusal in plain words. One line says where the
// session runs: on the host's computer, and an agent with the host's Claude account. An agent session opened here
// has no topic; a topic's sessions are opened by the topic (features/topics).
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import type { SessionInfo } from '@smurg/protocol';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { sessionTitle } from '../../lib/stores/sessions.ts';
import { selectRole, selectUserId, selectWorkspaceInfo } from '../../lib/stores/workspace.ts';
import { selectWorktreeList } from '../../lib/stores/worktrees.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { MESSAGE_TEXT_MAX_CHARS } from '@smurg/protocol';
import { Banner, Button, Dialog, Input, TextArea, useToast } from '../../ui/index.ts';
import { IconInfo } from '../../ui/icons.tsx';
import { DEFAULT_TERMINAL_SIZE, buildCreatePayload, effectiveWhere, newSessionOptions, type NewSessionForm, type SessionKind, type WhereChoice } from './new-session.ts';
import { describeSessionError, type SessionErrorView } from './session-info.ts';
import { t } from './strings.ts';

const INITIAL_FORM: Omit<NewSessionForm, 'kind'> = { where: 'main', title: '', firstMessage: '' };

export interface NewSessionDialogProps {
  /** What is opened: a conversation with an agent, or a plain terminal. */
  readonly kind: SessionKind;
  readonly open: boolean;
  onClose(): void;
  onCreated(session: SessionInfo): void;
}

export function NewSessionDialog({ kind, open, onClose, onCreated }: NewSessionDialogProps) {
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

  const [form, setForm] = useState(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SessionErrorView | null>(null);

  // Closing forgets everything typed.
  useEffect(() => {
    if (open) return;
    setForm(INITIAL_FORM);
    setError(null);
    setSubmitting(false);
  }, [open]);

  const keptChoices = options.worktree.kept.map((worktree) => ({ worktree, value: `worktree:${worktree.id}` as WhereChoice }));
  // The form starts at "Shared main workspace" (and so does a choice that is gone).
  const where: WhereChoice = effectiveWhere(options, form.where);

  const update = (patch: Partial<typeof INITIAL_FORM>): void => setForm((previous) => ({ ...previous, ...patch }));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!options.canCreate || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await stores.sessions.create(buildCreatePayload(options, { ...form, kind, where }, DEFAULT_TERMINAL_SIZE));
      setForm(INITIAL_FORM);
      toast.show({ tone: 'success', title: t('new.created', { title: sessionTitle(session) }) });
      onCreated(session);
    } catch (failure) {
      setError(describeSessionError(failure));
    } finally {
      setSubmitting(false);
    }
  };

  const blockedText =
    options.blockedBy === 'role-editor' ? t('new.role.editor') : options.blockedBy === 'role-viewer' ? t('new.role.viewer') : t('new.role.unknown');

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
      title={kind === 'agent' ? t('new.title') : t('new.title.terminal')}
      size="md"
      footer={
        options.canCreate ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {tApp('common.cancel')}
            </Button>
            <Button variant="primary" type="submit" form={formId} loading={submitting}>
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
          {/* One short line: whoever opens it, a session runs on the host's computer with the host's Claude account. */}
          <p className="agents-form__runs-as" data-testid="new-session-runs-as">
            <IconInfo size={14} />
            <span>{kind === 'terminal' ? t('new.runsAs.terminal') : role === 'host' ? t('new.runsAs.host') : t('new.runsAs.member')}</span>
          </p>

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
          {kind === 'agent' ? (
            <TextArea
              label={t('new.first')}
              hint={t('new.firstHint')}
              rows={3}
              maxLength={MESSAGE_TEXT_MAX_CHARS}
              value={form.firstMessage}
              onChange={(event) => update({ firstMessage: event.currentTarget.value })}
            />
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

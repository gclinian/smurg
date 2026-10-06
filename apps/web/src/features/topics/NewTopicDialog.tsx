// "New topic" (UX §6, DESIGN §5.12 item 18): a name, optionally what to build (the first message of the discussion)
// and the folder `specs/<slug>/`, which is filled from the name and stays editable ("topic-3" for a name without
// Latin letters). For the host the dialog contains the Claude Code project settings confirmation when the folder is
// undecided (TrustBlock.tsx); for anyone else it says that the session runs without the project's CLAUDE.md until the
// host confirms. Editors and Viewers get the explanation instead of the form (UX §10).
import { MESSAGE_TEXT_MAX_CHARS, TOPIC_NAME_MAX_CHARS, TOPIC_SLUG_PATTERN, isSmurgError, slugFromName, topicNameSchema, topicSpecPath } from '@smurg/protocol';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { describeError } from '../../lib/errors.ts';
import { formatRole } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectHostState } from '../../lib/stores/host.ts';
import { useCan, useCommand, useConnection, useConnectionState, useMember, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, Input, TextArea } from '../../ui/index.ts';
import { useMembers } from './shared.tsx';
import { t } from './strings.ts';
import { TrustBlock, decidePayload, trustReady, type TrustState } from './TrustBlock.tsx';

/** The refusals that are about the folder: shown under its field. */
const FOLDER_ERRORS: ReadonlySet<string> = new Set(['topic.slugTaken', 'topic.folderExists', 'topic.badSlug']);

export function NewTopicDialog({ onClose }: { onClose(): void }) {
  const stores = useStores();
  const conn = useConnection();
  const online = useConnectionState().kind === 'online';
  const openColumn = useCommand('openColumn');
  const member = useMember();
  const members = useMembers();
  const canCreate = useCan('session.create');
  const isHost = useCan('admin');
  const host = useStore(stores.host, selectHostState);
  const taken = useStore(stores.topics, (state) => [...state.topics.values(), ...(state.archived?.values() ?? [])].map((topic) => topic.slug).join(' '));
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  /** Null: the folder follows the name. */
  const [typedSlug, setTypedSlug] = useState<string | null>(null);
  const [trust, setTrust] = useState<TrustState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ folder: boolean; text: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const derived = useMemo(() => (name.trim() === '' ? '' : slugFromName(name, taken.split(' '))), [name, taken]);
  const slug = typedSlug ?? derived;

  if (!canCreate) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={t('new.title')}
        footer={
          <Button variant="primary" onClick={onClose}>
            {tApp('common.close')}
          </Button>
        }
      >
        <Banner tone="info" live="none">
          {member?.role === 'viewer' ? t('new.cannot.viewer', { role: formatRole('viewer') }) : t('new.cannot.editor', { role: formatRole(member?.role ?? 'editor') })}
        </Banner>
      </Dialog>
    );
  }

  const trimmed = name.trim();
  const nameProblem = trimmed === '' ? null : trimmed.length > TOPIC_NAME_MAX_CHARS ? t('new.name.tooLong', { max: TOPIC_NAME_MAX_CHARS }) : topicNameSchema.safeParse(trimmed).success ? null : t('new.name.invalid');
  const slugProblem = slug === '' || TOPIC_SLUG_PATTERN.test(slug) ? null : t('new.folder.invalid');
  const messageProblem = message.length > MESSAGE_TEXT_MAX_CHARS ? t('ask.tooLong', { max: MESSAGE_TEXT_MAX_CHARS }) : null;
  const ready = online && trimmed !== '' && nameProblem === null && slug !== '' && slugProblem === null && messageProblem === null && (trust === null || trustReady(trust));
  const hostName = members.find((person) => person.role === 'host')?.displayName ?? t('people.host');
  // Whether the name gives no Latin folder name (a Chinese name): the folder is "topic-<n>" and the hint says why.
  const numbered = typedSlug === null && /^topic-\d+$/.test(derived) && !/^topic-\d+$/i.test(trimmed);

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      if (trust !== null) {
        try {
          await conn.request('admin.claudeConfig.decide', decidePayload(trust));
        } catch (error) {
          setFailure({ folder: false, text: t('new.trustFailed', { reason: describeError(error) }) });
          return;
        }
        setTrust(null);
      }
      const result = await stores.topics.create({ name: trimmed, slug, ...(message.trim() === '' ? {} : { firstMessage: message }) });
      onClose();
      await openColumn({ target: { kind: 'session', sessionId: result.session.id } }).catch(() => {});
    } catch (error) {
      const id = isSmurgError(error) ? error.text?.id : undefined;
      const folder = id !== undefined && FOLDER_ERRORS.has(id);
      setFailure({ folder, text: folder ? describeError(error) : t('new.failed', { reason: describeError(error) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('new.title')}
      initialFocus={nameRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void submit()}>
            {t('new.submit')}
          </Button>
        </>
      }
    >
      <form className="topics-form" onSubmit={(event) => void submit(event)}>
        <Input ref={nameRef} label={t('new.name')} value={name} maxLength={TOPIC_NAME_MAX_CHARS * 2} hint={t('new.name.hint')} error={nameProblem ?? undefined} onChange={(event) => setName(event.currentTarget.value)} />
        <TextArea label={t('new.message')} rows={3} value={message} hint={t('new.message.hint')} error={messageProblem ?? undefined} onChange={(event) => setMessage(event.currentTarget.value)} />
        <Input
          label={t('new.folder')}
          className="topics-form__folder"
          value={slug}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          hint={
            <>
              {slug === '' ? t('new.folder.hint.empty') : t('new.folder.hint', { path: topicSpecPath(slug).replace(/[^/]+$/, '') })} {numbered ? t('new.folder.hint.latin') : null}
            </>
          }
          error={slugProblem ?? (failure?.folder ? failure.text : undefined)}
          onChange={(event) => {
            setTypedSlug(event.currentTarget.value === '' ? null : event.currentTarget.value);
            if (failure?.folder) setFailure(null);
          }}
        />
        {isHost && host?.mainProjectSettings === 'ignored' ? <TrustBlock state={trust} onChange={setTrust} /> : null}
        {!isHost && host?.mainProjectSettings === 'ignored' ? (
          <Banner tone="warning" live="none">
            {t('new.settings.unconfirmed', { host: hostName })}
          </Banner>
        ) : null}
        <Banner tone="info" live="none">
          {t('new.info')}
        </Banner>
        {failure !== null && !failure.folder ? (
          <Banner tone="danger" live="alert">
            {failure.text}
          </Banner>
        ) : null}
        {/* Enter in a field starts the discussion, as the button does. */}
        <button type="submit" hidden disabled={!ready} />
      </form>
    </Dialog>
  );
}

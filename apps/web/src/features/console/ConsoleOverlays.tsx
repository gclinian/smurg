// The console feature's dialogs outside the console page (features/console/slots.tsx → `overlays`): mounted once by
// the workspace shell, in the sessions view and in code mode, they render nothing until one of the three commands
// asks (`reviewProjectSettings`, `showHostRules`, `redactEvent`: slots.tsx puts the request into dialogs.ts). All
// three are the host's; for anyone else nothing is rendered and nothing is asked of the daemon.
//
//   claude-config   the trust gate of a root's Claude Code project settings (DESIGN §2.9)
//   host-rules      which of the host's own Claude Code allow rules apply (information only, OWNER-DECISIONS Q7)
//   redact          the confirmation before one conversation entry is removed (`admin.transcript.redact`, §2.4)
import { useRef, useState } from 'react';
import { msg, renderEnglish } from '@smurg/protocol/i18n';
import { describeError, renderWireText } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { selectSession, sessionTitle } from '../../lib/stores/sessions.ts';
import { useCan, useConnection, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, useToast } from '../../ui/index.ts';
import { useClaudeConfig } from './claude-config.ts';
import { ProjectSettingsList } from './ClaudeConfigSection.tsx';
import { consoleDialogs, type ConsoleDialog } from './dialogs.ts';
import { useHostRules } from './host-rules.ts';
import { HostRulesView } from './HostRulesSection.tsx';
import { t } from './strings.ts';
import './console.css';

type DialogOf<K extends ConsoleDialog['kind']> = Extract<ConsoleDialog, { kind: K }>;

/** What stands in a removed entry's place: the daemon's own sentence, so the dialog and the conversation agree. */
const REDACTED = msg('conversation.redacted');

function ClaudeConfigDialog({ dialog, onClose }: { dialog: DialogOf<'claude-config'>; onClose(): void }) {
  const config = useClaudeConfig();
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('claudeConfig.title')}
      description={t('claudeConfig.lead')}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {tApp('common.close')}
        </Button>
      }
    >
      <ProjectSettingsList config={config} headingLevel={3} {...(dialog.root === undefined ? {} : { only: dialog.root })} />
    </Dialog>
  );
}

function HostRulesDialog({ onClose }: { onClose(): void }) {
  const rules = useHostRules();
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('hostRules.title')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {tApp('common.close')}
        </Button>
      }
    >
      <HostRulesView rules={rules} shown />
    </Dialog>
  );
}

function RedactDialog({ dialog, onClose }: { dialog: DialogOf<'redact'>; onClose(): void }) {
  const conn = useConnection();
  const stores = useStores();
  const toast = useToast();
  const session = useStore(stores.sessions, (state) => selectSession(state, dialog.sessionId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Focus starts on "Cancel": removing cannot be undone.
  const cancel = useRef<HTMLButtonElement>(null);

  const redact = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await conn.request('admin.transcript.redact', { sessionId: dialog.sessionId, seq: dialog.seq });
      toast.show({ tone: 'success', title: t('redact.done') });
      onClose();
    } catch (failure) {
      setError(t('redact.failed', { message: describeError(failure) }));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      initialFocus={cancel}
      title={t('redact.title')}
      description={session ? t('redact.where', { title: sessionTitle(session) }) : undefined}
      footer={
        <>
          <Button ref={cancel} variant="ghost" onClick={onClose} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void redact()}>
            {t('redact.confirm')}
          </Button>
        </>
      }
    >
      <div className="console-kick">
        <ul>
          <li>{t('redact.replaced', { text: renderWireText(REDACTED, renderEnglish(REDACTED)) })}</li>
          <li>{t('redact.memory')}</li>
        </ul>
        <p className="console-kick__final">{t('redact.irreversible')}</p>
        {error ? (
          <Banner tone="danger" live="alert">
            {error}
          </Banner>
        ) : null}
      </div>
    </Dialog>
  );
}

export default function ConsoleOverlays() {
  const stores = useStores();
  const dialogs = consoleDialogs(stores);
  const dialog = useStore(dialogs);
  const isHost = useCan('admin');
  if (!isHost || dialog === null) return null;
  const close = (): void => dialogs.close(dialog);
  switch (dialog.kind) {
    case 'claude-config':
      return <ClaudeConfigDialog dialog={dialog} onClose={close} />;
    case 'host-rules':
      return <HostRulesDialog onClose={close} />;
    case 'redact':
      // Keyed: another entry is another confirmation (its error and busy state do not carry over).
      return <RedactDialog key={`${dialog.sessionId}:${dialog.seq}`} dialog={dialog} onClose={close} />;
  }
}

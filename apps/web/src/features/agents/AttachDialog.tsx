// "Attach from your own terminal" (SPEC §6 `smurg attach`, R4): the exact commands to take a session over in the
// member's own terminal. A guest's CLI is a new device of the same member, so its first join needs an invite link
// of the same role from the host (the one the browser used is spent); the dialog says so instead of leaving guests to
// guess. The host's own sessions attach through the local daemon without any of that.
import type { SessionInfo } from '@smurg/protocol';
import { useWorkspaceSession } from '../../lib/workspace/context.tsx';
import { Button, CopyButton, Dialog } from '../../ui/index.ts';
import { t } from './strings.ts';

export interface AttachDialogProps {
  readonly session: SessionInfo;
  readonly isHost: boolean;
  /** The relay origin the CLI must use: the one this page (and the invite links) came from. */
  readonly relayOrigin: string;
  onClose(): void;
}

/** The commands shown, in order (pure, for the tests). */
export function attachCommands(session: Pick<SessionInfo, 'id'>, workspaceId: string, relayOrigin: string, isHost: boolean): { readonly first: readonly string[]; readonly attach: string } {
  if (isHost) return { first: [], attach: `smurg attach ${session.id}` };
  return {
    first: [`smurg login --relay ${relayOrigin}`, `smurg attach --invite - --relay ${relayOrigin}`],
    attach: `smurg attach ${session.id} --workspace ${workspaceId} --relay ${relayOrigin}`,
  };
}

export function AttachDialog({ session, isHost, relayOrigin, onClose }: AttachDialogProps) {
  const { workspaceId } = useWorkspaceSession();
  const commands = attachCommands(session, workspaceId, relayOrigin, isHost);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('attach.title')}
      description={isHost ? t('attach.leadHost') : t('attach.lead')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('attach.close')}
        </Button>
      }
    >
      <div className="agents-attach">
        {commands.first.length > 0 ? (
          <section>
            <h4 className="agents-attach__heading">{t('attach.firstTitle')}</h4>
            <p className="agents-attach__note">{t('attach.firstNote')}</p>
            {commands.first.map((command) => (
              <CommandLine key={command} command={command} />
            ))}
          </section>
        ) : null}
        <section>
          <h4 className="agents-attach__heading">{commands.first.length > 0 ? t('attach.thenTitle') : t('attach.hostTitle')}</h4>
          <CommandLine command={commands.attach} />
          <p className="agents-attach__note">{t('attach.detachNote')}</p>
        </section>
      </div>
    </Dialog>
  );
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="agents-attach__command">
      <code>{command}</code>
      <CopyButton text={command} label={t('attach.copy')} />
    </div>
  );
}

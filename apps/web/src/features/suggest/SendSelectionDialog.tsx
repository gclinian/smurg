// "After selecting code in the editor, one click sends it as a suggestion into someone else's session (or straight
// into one's own)" (SPEC R6), when the
// editor did not say which session: pick one. A member who may type into sessions (the host, members with agent access) gets the
// code pasted (no Enter); an editor gets a suggestion draft to complete and send.
import { useEffect, useId, useState } from 'react';
import type { SessionInfo } from '@smurg/protocol';
import { tApp } from '../../strings/app.ts';
import { Button, Dialog } from '../../ui/index.ts';
import { t } from './strings.ts';
import { lineRange, type SelectionPayload } from './text.ts';
import { plainSessionTitle, sessionTitle } from '../../lib/stores/sessions.ts';

export interface SendSelectionDialogProps {
  readonly selection: SelectionPayload | null;
  /** Running sessions, the member's own first. */
  readonly sessions: readonly SessionInfo[];
  /** Types into any session (session.drive): every choice is a paste. */
  readonly canDrive: boolean;
  readonly canSuggest: boolean;
  onChoose(sessionId: string): void;
  onClose(): void;
}

export function SendSelectionDialog({ selection, sessions, canDrive, canSuggest, onChoose, onClose }: SendSelectionDialogProps) {
  const name = useId();
  const choices = canDrive || canSuggest ? sessions : [];
  const [chosen, setChosen] = useState<string | null>(null);
  const open = selection !== null;

  useEffect(() => {
    setChosen(open ? (choices[0]?.id ?? null) : null);
    // the first choice when the dialog opens
  }, [open]);

  if (!selection) return null;
  const current = chosen !== null && choices.some((session) => session.id === chosen) ? chosen : (choices[0]?.id ?? null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('send.title')}
      description={
        selection.startLine === selection.endLine
          ? t('send.leadLine', { path: selection.file.path, line: selection.startLine })
          : t('send.lead', { path: selection.file.path, range: lineRange(selection.startLine, selection.endLine) })
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="primary" disabled={current === null} onClick={() => current !== null && onChoose(current)}>
            {t('send.confirm')}
          </Button>
        </>
      }
    >
      {choices.length === 0 ? (
        <p className="suggest-note">{t('send.none')}</p>
      ) : (
        <fieldset className="suggest-choices">
          <legend>{t('send.target')}</legend>
          {choices.map((session) => (
            <label key={session.id} className="suggest-choice">
              <input type="radio" name={name} checked={current === session.id} onChange={() => setChosen(session.id)} />
              <span>
                {canDrive
                  ? t('send.own', { title: sessionTitle(session) })
                  : t('send.other', { owner: session.ownerName, title: plainSessionTitle(session) })}
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </Dialog>
  );
}

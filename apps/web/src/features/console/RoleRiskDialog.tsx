// The confirmation step before the host hands out agent access (owner decision 2026-10-01, protocol v2): a member
// with that role opens sessions that run as the host — any command on the host's computer, the files of the host's home
// directory, the host's Claude account. Shown before an invite of that role is created and before a member is set to
// it; nothing is sent until the host confirms. Not a tooltip: an alert dialog with the risk in plain words.
import { useRef } from 'react';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog } from '../../ui/index.ts';
import { IconShieldAlert } from '../../ui/icons.tsx';
import { t } from './strings.ts';

export interface RoleRiskDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly confirmLabel: string;
  onConfirm(): void;
  onCancel(): void;
}

export function RoleRiskDialog({ open, title, confirmLabel, onConfirm, onCancel }: RoleRiskDialogProps) {
  // Focus starts on "Cancel": the safe answer is the default one.
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      role="alertdialog"
      onClose={onCancel}
      title={title}
      initialFocus={cancel}
      footer={
        <>
          <Button ref={cancel} variant="ghost" onClick={onCancel}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Banner tone="warning" live="none" icon={<IconShieldAlert />}>
        <p data-testid="role-risk-text">{t('roleRisk.text')}</p>
      </Banner>
    </Dialog>
  );
}

// What the host must know (SPEC §11 threat table, D3): their own agent runs without a sandbox, files written by guests
// can carry instructions for it (prompt injection), and Claude Code's permission prompts are the remaining guard.
// Always visible at the top of the console: not dismissible.
import { Banner } from '../../ui/index.ts';
import { IconShieldAlert } from '../../ui/icons.tsx';
import { t } from './strings.ts';

export function SecurityNotes() {
  return (
    <Banner tone="warning" live="none" icon={<IconShieldAlert />} title={t('security.title')} className="console-security">
      <ul className="console-security__list">
        <li>{t('security.unsandboxed')}</li>
        <li>{t('security.injection')}</li>
        <li>{t('security.prompts')}</li>
        <li>{t('security.invites')}</li>
      </ul>
    </Banner>
  );
}

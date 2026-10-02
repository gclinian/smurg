// What the host must know (SPEC §11 threat table, D3; protocol v2): EVERY session runs as the host without a sandbox —
// also the ones members with agent access open, with the host's Claude account —, so that role is for people the host fully
// trusts; files written by guests can carry instructions for an agent (prompt injection), and Claude Code's permission
// prompts are the remaining guard.
// Always visible at the top of the console: not dismissible.
import { Banner } from '../../ui/index.ts';
import { IconShieldAlert } from '../../ui/icons.tsx';
import { t } from './strings.ts';

export function SecurityNotes() {
  return (
    <Banner tone="warning" live="none" icon={<IconShieldAlert />} title={t('security.title')} className="console-security">
      <ul className="console-security__list">
        <li>{t('security.unsandboxed')}</li>
        <li>{t('security.agentRole')}</li>
        <li>{t('security.injection')}</li>
        <li>{t('security.prompts')}</li>
        <li>{t('security.invites')}</li>
      </ul>
    </Banner>
  );
}

// What the host must know (SPEC §11 threat table, D3; protocol v2): EVERY session runs as the host without a sandbox —
// also the ones members with agent access open, with the host's Claude account —, so that role is for people the host fully
// trusts; files written by guests can carry instructions for an agent (prompt injection), and permission requests
// (with the host's own Claude Code allow rules applying, OWNER-DECISIONS Q7) are the remaining guard.
// v0.5.0 adds two facts: every member reads every conversation (DESIGN §2.4, S9), and whose Claude account a group
// may use (OWNER-DECISIONS Q6: a personal subscription is for the host's own use; the daemon also tells the host once
// when Claude Code reports such a login while other members are present).
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
        <li>{t('security.conversations')}</li>
        <li>{t('security.account')}</li>
      </ul>
    </Banner>
  );
}

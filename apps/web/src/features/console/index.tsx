// The host console, /w/:workspaceId/console (SPEC R2, R9, R11 basic version, §9 "I want to see on one screen what everyone and every agent
// is doing, and remove anyone with one click"). ONE page with everything the host needs:
//   security notes (SPEC §11) · members · every session · pending suggestions · merge requests · invites · audit log ·
//   settings.
// The shell renders this for the host only; the page checks again and explains itself to anyone else (hiding is
// cosmetic: the daemon refuses admin.* from every other role).
import type { ReactNode } from 'react';
import { formatRole } from '../../lib/format.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectSessionList } from '../../lib/stores/sessions.ts';
import { useCapabilities, useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, EmptyState, Spinner } from '../../ui/index.ts';
import { IconShield } from '../../ui/icons.tsx';
import { MergeRequestsSection } from '../worktree/index.tsx';
import { AuditSection } from './AuditSection.tsx';
import { InvitesSection } from './InvitesSection.tsx';
import { MembersSection } from './MembersSection.tsx';
import { SecurityNotes } from './SecurityNotes.tsx';
import { SessionsSection } from './SessionsSection.tsx';
import { SettingsSection } from './SettingsSection.tsx';
import { SuggestionsSection } from './SuggestionsSection.tsx';
import { t } from './strings.ts';
import { useNow } from './use-now.ts';
import './console.css';

export type HostConsolePageProps = Record<never, never>;

export function HostConsolePage(_props: HostConsolePageProps) {
  const capabilities = useCapabilities();
  if (!capabilities.can('admin')) {
    return (
      <EmptyState
        icon={<IconShield size={24} />}
        title={t('page.notHost.title')}
        description={t('page.notHost.body', { role: capabilities.role ? formatRole(capabilities.role) : '' })}
      />
    );
  }
  return <ConsoleBody />;
}

type SectionId = 'members' | 'sessions' | 'suggestions' | 'merges' | 'invites' | 'audit' | 'settings';

const SECTION_DOM_ID = (id: SectionId): string => `console-${id}`;

function ConsoleSection({ id, title, wide = true, children }: { id: SectionId; title: string; wide?: boolean; children: ReactNode }) {
  const headingId = `${SECTION_DOM_ID(id)}-title`;
  return (
    <section id={SECTION_DOM_ID(id)} className={wide ? 'console-section console-section--wide' : 'console-section'} aria-labelledby={headingId}>
      <h2 id={headingId} className="console-section__title" tabIndex={-1}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ConsoleBody() {
  const stores = useStores();
  const now = useNow();
  const admin = useStore(stores.admin, (state) => ({ status: state.status, error: state.error, loaded: state.settings !== null }), shallowEqual);
  const memberCount = useStore(stores.admin, (state) => state.members.length);
  const sessionCount = useStore(stores.sessions, (state) => selectSessionList(state).filter((session) => session.status !== 'exited').length);
  const pendingSuggestions = useStore(stores.suggestions, (state) => [...state.suggestions.values()].filter((s) => s.status === 'pending').length);

  const nav: { id: SectionId; label: string }[] = [
    { id: 'members', label: t('nav.members') },
    { id: 'sessions', label: t('nav.sessions') },
    { id: 'suggestions', label: t('nav.suggestions') },
    { id: 'merges', label: t('nav.merges') },
    { id: 'invites', label: t('nav.invites') },
    { id: 'audit', label: t('nav.audit') },
    { id: 'settings', label: t('nav.settings') },
  ];

  // In-page jumps without touching the URL fragment (the router owns the address; fragments carry invite secrets).
  const jump = (id: SectionId): void => {
    const section = document.getElementById(SECTION_DOM_ID(id));
    section?.scrollIntoView?.({ block: 'start' });
    document.getElementById(`${SECTION_DOM_ID(id)}-title`)?.focus({ preventScroll: true });
  };

  return (
    <div className="console">
      <header className="console__header">
        <h1 className="console__title">{t('page.title')}</h1>
        <p className="console-hint">{t('page.lead')}</p>
      </header>
      <SecurityNotes />
      <nav className="console__nav" aria-label={t('nav.label')}>
        {nav.map((item) => (
          <Button key={item.id} size="sm" variant="ghost" onClick={() => jump(item.id)}>
            {item.label}
          </Button>
        ))}
      </nav>
      {admin.status === 'error' && admin.error ? (
        <Banner
          tone="danger"
          live="alert"
          actions={
            <Button size="sm" onClick={() => void stores.admin.reload().catch(() => undefined)}>
              {t('load.retry')}
            </Button>
          }
        >
          {t('load.failed', { message: admin.error })}
        </Banner>
      ) : null}
      {admin.status === 'loading' && !admin.loaded ? (
        <p className="console-loading">
          <Spinner size={14} decorative /> {t('load.loading')}
        </p>
      ) : null}
      <div className="console__grid">
        <ConsoleSection id="members" title={t('members.title', { count: memberCount })}>
          <MembersSection now={now} />
        </ConsoleSection>
        <ConsoleSection id="sessions" title={t('sessions.title', { count: sessionCount })}>
          <SessionsSection now={now} />
        </ConsoleSection>
        <ConsoleSection id="suggestions" title={t('suggestions.title', { count: pendingSuggestions })} wide={false}>
          <SuggestionsSection now={now} />
        </ConsoleSection>
        <ConsoleSection id="merges" title={t('merges.title')} wide={false}>
          <MergeRequestsSection headingLevel={3} />
        </ConsoleSection>
        <ConsoleSection id="invites" title={t('invites.title')}>
          <InvitesSection now={now} />
        </ConsoleSection>
        <ConsoleSection id="audit" title={t('audit.title')}>
          <AuditSection />
        </ConsoleSection>
        <ConsoleSection id="settings" title={t('settings.title')}>
          <SettingsSection />
        </ConsoleSection>
      </div>
    </div>
  );
}

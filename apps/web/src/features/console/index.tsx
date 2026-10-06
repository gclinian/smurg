// The host console, /w/:workspaceId/console[/:section] (SPEC R2, R9, R11 basic version, §9 "I want to see on one screen what everyone and every agent
// is doing, and remove anyone with one click"; DESIGN §5.7). ONE page with everything the host needs:
//   security notes (SPEC §11) · members · every session (with the state of the host's Claude account) · pending
//   suggestions · merge requests · invites · Claude Code project settings (the trust gate, §2.9) · the host's own
//   Claude Code rules (information, §2.11 with OWNER-DECISIONS Q7) · settings · audit log.
// The sections are the wire's `CONSOLE_SECTIONS`: an inbox item of the host opens one (`ColumnTarget { kind:
// 'console', section }` → the route's `section`), and the page then scrolls there and puts the focus on its heading.
// The shell renders this for the host only; the page checks again and explains itself to anyone else (hiding is
// cosmetic: the daemon refuses admin.* from every other role).
import { CONSOLE_SECTIONS, isSessionOver, type ConsoleSection as ConsoleSectionName } from '@smurg/protocol';
import { useEffect, type ReactNode } from 'react';
import { formatRole } from '../../lib/format.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectSessionList } from '../../lib/stores/sessions.ts';
import { useCapabilities, useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, EmptyState, Spinner } from '../../ui/index.ts';
import { IconShield } from '../../ui/icons.tsx';
import { MergeRequestsSection } from '../worktree/index.tsx';
import { AuditSection } from './AuditSection.tsx';
import { ClaudeConfigSection } from './ClaudeConfigSection.tsx';
import { HostRulesSection } from './HostRulesSection.tsx';
import { InvitesSection } from './InvitesSection.tsx';
import { MembersSection } from './MembersSection.tsx';
import { SecurityNotes } from './SecurityNotes.tsx';
import { SessionsSection } from './SessionsSection.tsx';
import { SettingsSection } from './SettingsSection.tsx';
import { SuggestionsSection } from './SuggestionsSection.tsx';
import { t } from './strings.ts';
import { useNow } from '../../lib/use-now.ts';
import './console.css';

export interface HostConsolePageProps {
  /** The section the route asks for (what an inbox item of the host opens): scrolled to, its heading focused. */
  readonly section?: ConsoleSectionName;
}

export function HostConsolePage({ section }: HostConsolePageProps) {
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
  return <ConsoleBody {...(section === undefined ? {} : { section })} />;
}

/** The order on the page: people and what runs first, the long audit log last. Every wire section is here once. */
export const SECTION_ORDER = ['members', 'sessions', 'suggestions', 'merges', 'invites', 'claude-config', 'host-rules', 'settings', 'audit'] as const satisfies readonly ConsoleSectionName[];

type Key = Parameters<typeof t>[0];

const NAV_LABEL: Readonly<Record<ConsoleSectionName, Key>> = {
  members: 'nav.members',
  sessions: 'nav.sessions',
  suggestions: 'nav.suggestions',
  merges: 'nav.merges',
  invites: 'nav.invites',
  'claude-config': 'nav.claudeConfig',
  'host-rules': 'nav.hostRules',
  settings: 'nav.settings',
  audit: 'nav.audit',
};

const SECTION_DOM_ID = (id: ConsoleSectionName): string => `console-${id}`;

/** Scrolls to a section and focuses its heading, without touching the URL fragment (fragments carry invite secrets). */
function goToSection(id: ConsoleSectionName): void {
  const section = document.getElementById(SECTION_DOM_ID(id));
  section?.scrollIntoView?.({ block: 'start' });
  document.getElementById(`${SECTION_DOM_ID(id)}-title`)?.focus({ preventScroll: true });
}

function ConsoleSection({ id, title, wide, children }: { id: ConsoleSectionName; title: string; wide: boolean; children: ReactNode }) {
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

function ConsoleBody({ section }: { section?: ConsoleSectionName }) {
  const stores = useStores();
  const now = useNow();
  const admin = useStore(stores.admin, (state) => ({ status: state.status, error: state.error, loaded: state.settings !== null }), shallowEqual);
  const memberCount = useStore(stores.admin, (state) => state.members.length);
  const sessionCount = useStore(stores.sessions, (state) => selectSessionList(state).filter((session) => !isSessionOver(session)).length);
  const pendingSuggestions = useStore(stores.suggestions, (state) => [...state.suggestions.values()].filter((s) => s.status === 'pending').length);

  // The route asked for a section (an inbox item of the host): go there once it is on the page, and again when the
  // route names another one.
  useEffect(() => {
    if (section !== undefined && (CONSOLE_SECTIONS as readonly string[]).includes(section)) goToSection(section);
  }, [section]);

  // `wide`: the section takes the whole row of the grid (two narrow ones share a row).
  const sections: Readonly<Record<ConsoleSectionName, { readonly title: string; readonly wide: boolean; readonly body: ReactNode }>> = {
    members: { title: t('members.title', { count: memberCount }), wide: true, body: <MembersSection now={now} /> },
    sessions: { title: t('sessions.title', { count: sessionCount }), wide: true, body: <SessionsSection now={now} /> },
    suggestions: { title: t('suggestions.title', { count: pendingSuggestions }), wide: false, body: <SuggestionsSection now={now} /> },
    merges: { title: t('merges.title'), wide: false, body: <MergeRequestsSection headingLevel={3} /> },
    invites: { title: t('invites.title'), wide: true, body: <InvitesSection now={now} /> },
    'claude-config': { title: t('claudeConfig.title'), wide: true, body: <ClaudeConfigSection /> },
    'host-rules': { title: t('hostRules.title'), wide: true, body: <HostRulesSection targeted={section === 'host-rules'} /> },
    settings: { title: t('settings.title'), wide: true, body: <SettingsSection /> },
    audit: { title: t('audit.title'), wide: true, body: <AuditSection /> },
  };

  return (
    <div className="console">
      <header className="console__header">
        <h1 className="console__title">{t('page.title')}</h1>
        <p className="console-hint">{t('page.lead')}</p>
      </header>
      <SecurityNotes />
      <nav className="console__nav" aria-label={t('nav.label')}>
        {SECTION_ORDER.map((id) => (
          <Button key={id} size="sm" variant="ghost" onClick={() => goToSection(id)}>
            {t(NAV_LABEL[id])}
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
        {SECTION_ORDER.map((id) => (
          <ConsoleSection key={id} id={id} title={sections[id].title} wide={sections[id].wide}>
            {sections[id].body}
          </ConsoleSection>
        ))}
      </div>
    </div>
  );
}

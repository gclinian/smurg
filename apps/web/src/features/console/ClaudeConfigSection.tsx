// "Claude Code project settings" (console section `claude-config`; DESIGN §2.9): every root that has such files (the
// main workspace always), what waits for the host on top. It is what the host's inbox item "Claude Code project
// settings wait for the host" opens. The same list is the body of the dialog in the sessions view (ConsoleOverlays).
import type { RootRef } from '@smurg/protocol';
import { rootRefKey } from '@smurg/protocol';
import { useStore } from '../../lib/store.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Badge, Banner, Button, Spinner } from '../../ui/index.ts';
import { needsDecision, sortRoots, useClaudeConfig, type ClaudeConfigApi, type ClaudeConfigDecision, type ClaudeConfigRoot } from './claude-config.ts';
import { ProjectSettingsReview } from './ProjectSettingsReview.tsx';
import { rootLabel } from './root-label.ts';
import { t } from './strings.ts';

export interface ProjectSettingsListProps {
  readonly config: ClaudeConfigApi;
  /** Only this root (the dialog a topic or a session opened); default: every root. */
  readonly only?: RootRef;
  /** Heading level of a root's name: 3 under the console's `h2`, and in a dialog. */
  readonly headingLevel?: 3 | 4;
  onDecided?(root: ClaudeConfigRoot, decision: ClaudeConfigDecision): void;
}

/** The roots with their reviews; the loading, error and empty states of the list. */
export function ProjectSettingsList({ config, only, headingLevel = 3, onDecided }: ProjectSettingsListProps) {
  const stores = useStores();
  const worktrees = useStore(stores.worktrees, (state) => state.worktrees);
  const sessions = useStore(stores.sessions, (state) => state.sessions);
  const selfUserId = useStore(stores.workspace, selectUserId);
  const Heading = `h${headingLevel}` as 'h3' | 'h4';

  const roots = sortRoots(config.roots).filter((root) => only === undefined || rootRefKey(root.root) === rootRefKey(only));

  return (
    <>
      {config.status === 'error' && config.error ? (
        <Banner
          tone="danger"
          live="alert"
          actions={
            <Button size="sm" onClick={() => void config.reload()}>
              {t('load.retry')}
            </Button>
          }
        >
          {t('claudeConfig.loadFailed', { message: config.error })}
        </Banner>
      ) : null}
      {config.status === 'loading' || config.status === 'idle' ? (
        <p className="console-loading">
          <Spinner size={14} decorative /> {t('claudeConfig.loading')}
        </p>
      ) : null}
      {config.status === 'ready' && roots.length === 0 ? <p className="console-hint">{t('claudeConfig.state.none')}</p> : null}
      <ul className="console-trust-roots">
        {roots.map((root) => (
          <li key={rootRefKey(root.root)} className="console-trust-root">
            <Heading className="console-trust-root__title">
              {rootLabel(root.root, { worktrees, sessions, selfUserId })}
              {needsDecision(root) ? <Badge tone="warning">{t('claudeConfig.root.waiting')}</Badge> : null}
            </Heading>
            <ProjectSettingsReview root={root} decide={config.decide} {...(onDecided === undefined ? {} : { onDecided: (decision: ClaudeConfigDecision) => onDecided(root, decision) })} />
          </li>
        ))}
      </ul>
    </>
  );
}

export function ClaudeConfigSection() {
  const config = useClaudeConfig();
  return (
    <>
      <p className="console-hint">{t('claudeConfig.lead')}</p>
      <ProjectSettingsList config={config} />
    </>
  );
}

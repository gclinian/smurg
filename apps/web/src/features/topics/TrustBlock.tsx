// The Claude Code project settings confirmation inside the New topic dialog (DESIGN §2.9, §5.12 item 18): the host
// decides BEFORE the first session starts in a folder whose `.claude/settings.json`, `.claude/settings.local.json` or
// `.mcp.json` would run commands as them. This block shows what the files do (`admin.claudeConfig.get`, the main
// workspace only) and holds the choice; the dialog sends it (`admin.claudeConfig.decide`) before it creates the topic.
// The full dialog with every root is the host console's ("Claude Code settings").
import { MAIN_ROOT, collectPages, rootRefKey, type PayloadInputOf, type ResultOf } from '@smurg/protocol';
import { useEffect, useState } from 'react';
import { describeError } from '../../lib/errors.ts';
import type { WorkspaceConnection } from '../../lib/connection/types.ts';
import { useConnection } from '../../lib/workspace/context.tsx';
import { Spinner } from '../../ui/index.ts';
import { IconShield } from '../../ui/icons.tsx';
import { t } from './strings.ts';

type ConfigRoot = ResultOf<'admin.claudeConfig.get'>['roots'][number];
export type ConfigFile = ConfigRoot['files'][number];
type Ack = ConfigFile['needsAck'][number];

export type TrustChoice = 'trust' | 'ignore';

export interface TrustState {
  /** The main workspace's files whose content has no decision yet (or changed since); empty: nothing to decide. */
  readonly files: readonly ConfigFile[];
  readonly choice: TrustChoice;
  readonly acknowledged: readonly Ack[];
}

/** The ticks "Use them" needs before it can be sent. */
export function neededAcks(files: readonly ConfigFile[]): Ack[] {
  return [...new Set(files.flatMap((file) => file.needsAck))];
}

/** Whether the choice can be sent as it stands ("Use them" needs every tick). */
export function trustReady(state: TrustState): boolean {
  return state.choice === 'ignore' || neededAcks(state.files).every((ack) => state.acknowledged.includes(ack));
}

/** The files of the main workspace that wait for the host's decision. */
export async function loadUndecided(conn: WorkspaceConnection): Promise<ConfigFile[]> {
  const roots = await collectPages(
    async (after) => {
      const page = await conn.request('admin.claudeConfig.get', after === undefined ? {} : { after });
      return { items: page.roots, hasMore: page.hasMore };
    },
    (root: ConfigRoot) => rootRefKey(root.root),
  );
  const main = roots.find((root) => root.root.kind === 'main');
  return main === undefined ? [] : main.files.filter((file) => file.decision === null || file.changed);
}

/** What the dialog sends before `topic.create`. */
export function decidePayload(state: TrustState): PayloadInputOf<'admin.claudeConfig.decide'> {
  return {
    root: MAIN_ROOT,
    files: state.files.map((file) => ({ path: file.path, hash: file.hash })),
    decision: state.choice,
    acknowledged: state.choice === 'trust' ? [...state.acknowledged] : [],
  };
}

export interface TrustBlockProps {
  /** Null while loading or when there is nothing to decide. */
  readonly state: TrustState | null;
  onChange(state: TrustState | null): void;
}

export function TrustBlock({ state, onChange }: TrustBlockProps) {
  const conn = useConnection();
  const [load, setLoad] = useState<'loading' | 'ready' | { error: string }>('loading');
  const [showFiles, setShowFiles] = useState(false);

  useEffect(() => {
    let current = true;
    loadUndecided(conn).then(
      (files) => {
        if (!current) return;
        setLoad('ready');
        onChange(files.length === 0 ? null : { files, choice: 'ignore', acknowledged: [] });
      },
      (error: unknown) => {
        if (current) setLoad({ error: describeError(error) });
      },
    );
    return () => {
      current = false;
    };
    // Loaded once per dialog; `onChange` is the dialog's setter.
  }, [conn]);

  if (load === 'loading') {
    return (
      <p className="trust__text">
        <Spinner size={14} decorative /> {t('trust.loading')}
      </p>
    );
  }
  if (typeof load === 'object') return <p className="trust__text">{t('trust.loadFailed', { reason: load.error })}</p>;
  if (state === null) return null;

  const runs = state.files.flatMap((file) => file.runs.map((line) => ({ line, path: file.path })));
  const permissions = state.files.flatMap((file) => file.permissions);
  const env = state.files.flatMap((file) => file.env);
  const otherKeys = [...new Set(state.files.flatMap((file) => file.otherKeys))];
  const acks = neededAcks(state.files);
  const toggleAck = (ack: Ack, on: boolean): void => {
    onChange({ ...state, acknowledged: on ? [...state.acknowledged.filter((entry) => entry !== ack), ack] : state.acknowledged.filter((entry) => entry !== ack) });
  };

  return (
    <fieldset className="trust">
      <legend className="trust__title">
        <IconShield size={14} /> {t('trust.title')}
      </legend>
      <ul className="trust__list">
        {runs.map((run, index) => (
          <li key={`run-${index}`}>
            <b>{t('trust.runs')}</b> <code>{run.line}</code> <span className="trust__path">{run.path}</span>
          </li>
        ))}
        {permissions.map((rule, index) => (
          <li key={`perm-${index}`}>
            <b>{t('trust.permissions')}</b> <code>{rule}</code>
          </li>
        ))}
        {env.map((variable, index) => (
          <li key={`env-${index}`}>
            <b>{t('trust.env')}</b> <code>{variable.name}</code> {variable.flagged ? <span className="trust__flag">{t('trust.env.flagged')}</span> : null}
          </li>
        ))}
        {otherKeys.length > 0 ? (
          <li>
            <b>{t('trust.other')}</b>{' '}
            {otherKeys.map((key) => (
              <code key={key}>{key}</code>
            ))}
          </li>
        ) : null}
      </ul>
      <p className="trust__text">{t('trust.text')}</p>
      <div className="trust__choice" role="radiogroup" aria-label={t('trust.title')}>
        <label>
          <input type="radio" name="topics-trust" checked={state.choice === 'trust'} onChange={() => onChange({ ...state, choice: 'trust' })} /> {t('trust.use')}
        </label>
        <label>
          <input type="radio" name="topics-trust" checked={state.choice === 'ignore'} onChange={() => onChange({ ...state, choice: 'ignore' })} /> {t('trust.ignore')}
        </label>
        <button type="button" className="topics-link" aria-expanded={showFiles} onClick={() => setShowFiles((shown) => !shown)}>
          {showFiles ? t('trust.hideFiles') : t('trust.showFiles')}
        </button>
      </div>
      {state.choice === 'trust' && acks.length > 0 ? (
        <div className="trust__acks">
          {acks.map((ack) => (
            <label key={ack}>
              <input type="checkbox" checked={state.acknowledged.includes(ack)} onChange={(event) => toggleAck(ack, event.currentTarget.checked)} /> {t(`trust.ack.${ack}`)}
            </label>
          ))}
        </div>
      ) : null}
      {showFiles
        ? state.files.map((file) => (
            <section key={file.path} className="trust__file" aria-label={file.path}>
              <h4 className="trust__path">{file.path}</h4>
              <pre className="trust__raw" tabIndex={0}>
                {file.text}
              </pre>
            </section>
          ))
        : null}
    </fieldset>
  );
}

// What ONE root's Claude Code project settings do, and the host's two answers (DESIGN §2.9, AD-13). Structured mode
// never shows Claude Code's own trust dialog, so this is the place where the host sees, before any agent session
// loads them: every command the files run, every permission rule, every environment variable (the ones that can send
// the host's login elsewhere are marked), the scripts those commands call, and the raw files one click away.
//
// "Use them" trusts exactly the contents on screen (path + hash): it is enabled only after the ticks the contents
// need. "Run without them" starts sessions with the user's own settings only. The daemon refuses a decision about a
// content that changed meanwhile; the list is then read again and the refusal shown.
//
// Mounted by the console's section, by the dialog of the sessions view (ConsoleOverlays) and, for the host, inside
// the New topic dialog (features/topics): it draws no dialog of its own.
import { useId, useState } from 'react';
import type { ClaudeConfigFile } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { Badge, Banner, Button, type Tone } from '../../ui/index.ts';
import { IconShieldAlert } from '../../ui/icons.tsx';
import { acksNeeded, canTrust, fileStanding, needsDecision, type ClaudeConfigAck, type ClaudeConfigDecision, type ClaudeConfigRoot, type FileStanding } from './claude-config.ts';
import { t } from './strings.ts';

type Key = Parameters<typeof t>[0];

const STANDING: Readonly<Record<FileStanding, { readonly key: Key; readonly tone: Tone }>> = {
  trusted: { key: 'claudeConfig.file.trusted', tone: 'success' },
  ignored: { key: 'claudeConfig.file.ignored', tone: 'neutral' },
  changed: { key: 'claudeConfig.file.changed', tone: 'warning' },
  new: { key: 'claudeConfig.file.new', tone: 'warning' },
};

const ACK_LABEL: Readonly<Record<ClaudeConfigAck, Key>> = {
  credentials: 'claudeConfig.ack.credentials',
  'allows-tools': 'claudeConfig.ack.allowsTools',
};

const STATE_LINE: Readonly<Record<ClaudeConfigRoot['state'], Key>> = {
  used: 'claudeConfig.state.used',
  ignored: 'claudeConfig.state.ignored',
  none: 'claudeConfig.state.none',
};

function Group({ title, entries, mono = true }: { title: string; entries: readonly string[]; mono?: boolean }) {
  if (entries.length === 0) return null;
  return (
    <div className="console-trust__group">
      <h5 className="console-trust__group-title">{title}</h5>
      <ul className={mono ? 'console-trust__list console-trust__list--mono' : 'console-trust__list'}>
        {entries.map((entry, index) => (
          // The same line may appear twice (two hooks running one command): the position is the key.
          <li key={index}>{entry}</li>
        ))}
      </ul>
    </div>
  );
}

function FileView({ file }: { file: ClaudeConfigFile }) {
  const standing = STANDING[fileStanding(file)];
  const nothing = file.runs.length === 0 && file.permissions.length === 0 && file.env.length === 0 && file.otherKeys.length === 0;
  return (
    <li className="console-trust__file">
      <h4 className="console-trust__file-title">
        <code>{file.path}</code>
        <Badge tone={standing.tone}>{t(standing.key)}</Badge>
      </h4>
      <Group title={t('claudeConfig.group.runs')} entries={file.runs} />
      <Group title={t('claudeConfig.group.permissions')} entries={file.permissions} />
      {file.env.length > 0 ? (
        <div className="console-trust__group">
          <h5 className="console-trust__group-title">{t('claudeConfig.group.env')}</h5>
          <ul className="console-trust__list console-trust__list--mono">
            {file.env.map((variable) => (
              <li key={variable.name}>
                {variable.name}
                {variable.flagged ? (
                  <Badge tone="danger" className="console-trust__flag">
                    {t('claudeConfig.env.flagged')}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Group title={t('claudeConfig.group.other')} entries={file.otherKeys} />
      <Group title={t('claudeConfig.group.scripts')} entries={file.scripts.map((script) => script.path)} />
      {nothing ? <p className="console-muted">{t('claudeConfig.file.nothing')}</p> : null}
      <details className="console-trust__raw">
        <summary>{t('claudeConfig.file.show', { path: file.path })}</summary>
        <pre tabIndex={0}>{file.text}</pre>
      </details>
    </li>
  );
}

export interface ProjectSettingsReviewProps {
  readonly root: ClaudeConfigRoot;
  /** Sends the decision (claude-config.ts `decide`); a rejection is shown here. */
  decide(root: ClaudeConfigRoot, decision: ClaudeConfigDecision, ticked: ReadonlySet<ClaudeConfigAck>): Promise<void>;
  /** After a decision was accepted. */
  onDecided?(decision: ClaudeConfigDecision): void;
}

export function ProjectSettingsReview({ root, decide, onDecided }: ProjectSettingsReviewProps) {
  const [ticked, setTicked] = useState<ReadonlySet<ClaudeConfigAck>>(new Set());
  const [busy, setBusy] = useState<ClaudeConfigDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ackName = useId();

  if (root.files.length === 0) return <p className="console-hint">{t('claudeConfig.state.none')}</p>;

  const needed = acksNeeded(root);
  const undecided = needsDecision(root);

  const send = async (decision: ClaudeConfigDecision): Promise<void> => {
    setBusy(decision);
    setError(null);
    try {
      await decide(root, decision, ticked);
      setTicked(new Set());
      onDecided?.(decision);
    } catch (failure) {
      setError(t('claudeConfig.decideFailed', { message: describeError(failure) }));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (ack: ClaudeConfigAck, on: boolean): void => {
    setTicked((previous) => {
      const next = new Set(previous);
      if (on) next.add(ack);
      else next.delete(ack);
      return next;
    });
  };

  return (
    <div className="console-trust">
      <p className={undecided ? 'console-trust__state console-trust__state--waiting' : 'console-trust__state'}>{undecided ? t('claudeConfig.state.undecided') : t(STATE_LINE[root.state])}</p>
      <Banner tone="warning" live="none" icon={<IconShieldAlert />}>
        {t('claudeConfig.warning')}
      </Banner>
      <ul className="console-trust__files">
        {root.files.map((file) => (
          <FileView key={file.path} file={file} />
        ))}
      </ul>
      {needed.length > 0 ? (
        <fieldset className="console-trust__acks">
          <legend>{t('claudeConfig.ack.legend')}</legend>
          {needed.map((ack) => (
            <label key={ack} className="console-check">
              <input type="checkbox" name={`${ackName}-${ack}`} checked={ticked.has(ack)} disabled={busy !== null} onChange={(event) => toggle(ack, event.currentTarget.checked)} />
              <span>{t(ACK_LABEL[ack])}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
      <div className="console-trust__actions">
        <span className="console-muted">{t('claudeConfig.applies')}</span>
        <Button loading={busy === 'ignore'} disabled={busy !== null || (!undecided && root.state === 'ignored')} onClick={() => void send('ignore')}>
          {t('claudeConfig.ignore')}
        </Button>
        <Button variant="primary" loading={busy === 'trust'} disabled={busy !== null || !canTrust(root, ticked) || (!undecided && root.state === 'used')} onClick={() => void send('trust')}>
          {t('claudeConfig.trust')}
        </Button>
      </div>
    </div>
  );
}

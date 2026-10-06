// What ONE root's Claude Code project settings do, and the host's two answers (DESIGN §2.9, AD-13). Structured mode
// never shows Claude Code's own trust dialog, so this is the place where the host sees, before any agent session
// loads them: every command the files run, every permission rule, every environment variable (the ones that can send
// the host's login elsewhere are marked), the scripts those commands call, and the raw files one click away.
//
// "Use them" trusts exactly the contents on screen (path + hash): it is possible only after the ticks the contents
// need. "Run without them" starts sessions with the user's own settings only. The daemon refuses a decision about a
// content that changed meanwhile; the list is then read again and the refusal shown.
//
// This is the ONE review of the app. It draws no dialog of its own and is answered in one of two ways:
//   - `decide`: two buttons that send the decision at once (the console's section, the dialog of the sessions view);
//   - `choice` / `onChoice`: two radios that HOLD the decision for the form around it, which sends it with its own
//     submit (the New topic dialog of features/topics: the host decides before the first session starts, DESIGN
//     §5.12 item 18). The cautious answer is the form's default.
import { useId, useState } from 'react';
import type { ClaudeConfigFile } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { Badge, Banner, Button, type Tone } from '../../ui/index.ts';
import { IconShieldAlert } from '../../ui/icons.tsx';
import { acksNeeded, canTrust, fileStanding, needsDecision, type ClaudeConfigAck, type ClaudeConfigChoice, type ClaudeConfigDecision, type ClaudeConfigRoot, type FileStanding } from './claude-config.ts';
import { t } from './strings.ts';
import './console.css';

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

/** The ticks "Use them" needs, as a group of checkboxes. */
function Acks({ needed, ticked, disabled, onToggle }: { needed: readonly ClaudeConfigAck[]; ticked: ReadonlySet<ClaudeConfigAck>; disabled: boolean; onToggle(ack: ClaudeConfigAck, on: boolean): void }) {
  const ackName = useId();
  if (needed.length === 0) return null;
  return (
    <fieldset className="console-trust__acks">
      <legend>{t('claudeConfig.ack.legend')}</legend>
      {needed.map((ack) => (
        <label key={ack} className="console-check">
          <input type="checkbox" name={`${ackName}-${ack}`} checked={ticked.has(ack)} disabled={disabled} onChange={(event) => onToggle(ack, event.currentTarget.checked)} />
          <span>{t(ACK_LABEL[ack])}</span>
        </label>
      ))}
    </fieldset>
  );
}

const withTick = (ticked: ReadonlySet<ClaudeConfigAck>, ack: ClaudeConfigAck, on: boolean): ReadonlySet<ClaudeConfigAck> => {
  const next = new Set(ticked);
  if (on) next.add(ack);
  else next.delete(ack);
  return next;
};

interface SendsAtOnce {
  /** Sends the decision (claude-config.ts `decide`); a rejection is shown here. */
  decide(root: ClaudeConfigRoot, decision: ClaudeConfigDecision, ticked: ReadonlySet<ClaudeConfigAck>): Promise<void>;
  /** After a decision was accepted. */
  onDecided?(decision: ClaudeConfigDecision): void;
  readonly choice?: undefined;
}

interface HoldsTheChoice {
  /** The decision the form around the review holds (claude-config.ts `choiceReady` says whether it can be sent). */
  readonly choice: ClaudeConfigChoice;
  onChoice(choice: ClaudeConfigChoice): void;
  /** The form is sending. */
  readonly disabled?: boolean;
  readonly decide?: undefined;
}

export type ProjectSettingsReviewProps = { readonly root: ClaudeConfigRoot } & (SendsAtOnce | HoldsTheChoice);

export function ProjectSettingsReview(props: ProjectSettingsReviewProps) {
  return props.choice === undefined ? <ReviewAndDecide root={props.root} decide={props.decide} {...(props.onDecided === undefined ? {} : { onDecided: props.onDecided })} /> : <ReviewAndChoose root={props.root} choice={props.choice} onChoice={props.onChoice} disabled={props.disabled === true} />;
}

/** The files, the warning and the ticks: what both ways of answering show. */
function Files({ root }: { root: ClaudeConfigRoot }) {
  return (
    <>
      <Banner tone="warning" live="none" icon={<IconShieldAlert />}>
        {t('claudeConfig.warning')}
      </Banner>
      <ul className="console-trust__files">
        {root.files.map((file) => (
          <FileView key={file.path} file={file} />
        ))}
      </ul>
    </>
  );
}

function ReviewAndDecide({ root, decide, onDecided }: { root: ClaudeConfigRoot } & Pick<SendsAtOnce, 'decide' | 'onDecided'>) {
  const [ticked, setTicked] = useState<ReadonlySet<ClaudeConfigAck>>(new Set());
  const [busy, setBusy] = useState<ClaudeConfigDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (root.files.length === 0) return <p className="console-hint">{t('claudeConfig.state.none')}</p>;

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

  return (
    <div className="console-trust">
      <p className={undecided ? 'console-trust__state console-trust__state--waiting' : 'console-trust__state'}>{undecided ? t('claudeConfig.state.undecided') : t(STATE_LINE[root.state])}</p>
      <Files root={root} />
      <Acks needed={acksNeeded(root)} ticked={ticked} disabled={busy !== null} onToggle={(ack, on) => setTicked((previous) => withTick(previous, ack, on))} />
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

function ReviewAndChoose({ root, choice, onChoice, disabled }: { root: ClaudeConfigRoot; choice: ClaudeConfigChoice; onChoice(choice: ClaudeConfigChoice): void; disabled: boolean }) {
  const name = useId();
  if (root.files.length === 0) return null;
  const option = (decision: ClaudeConfigDecision, label: string) => (
    <label className="console-check">
      <input type="radio" name={name} checked={choice.decision === decision} disabled={disabled} onChange={() => onChoice({ ...choice, decision })} />
      <span>{label}</span>
    </label>
  );
  return (
    <fieldset className="console-trust console-trust--choice">
      <legend className="console-trust__legend">
        <IconShieldAlert size={14} /> {t('claudeConfig.choice.title')}
      </legend>
      <Files root={root} />
      <div className="console-trust__choice" role="radiogroup" aria-label={t('claudeConfig.choice.title')}>
        {option('trust', t('claudeConfig.trust'))}
        {option('ignore', t('claudeConfig.choice.ignore'))}
      </div>
      {choice.decision === 'trust' ? <Acks needed={acksNeeded(root)} ticked={choice.ticked} disabled={disabled} onToggle={(ack, on) => onChoice({ ...choice, ticked: withTick(choice.ticked, ack, on) })} /> : null}
    </fieldset>
  );
}

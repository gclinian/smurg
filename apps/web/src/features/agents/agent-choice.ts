// What the model and permission mode pickers offer and say (DESIGN 0.6.0 D18), as pure functions so they are tested
// without React. The model list is the host's agent's own (`HostState.agent.models`: what the host's Claude Code
// answered); a session, a topic or a Start names one of its values, or null for "the host's default" (whatever the
// host's own Claude Code settings choose). A mode is one of smurg's three choices, or null: the session follows its
// topic (a work item) and the workspace. "Asks for nothing" is never offered here: it is the host's, for the whole
// workspace, in the console.
import { SESSION_MODE_CHOICES, effectivePermissionMode, type AgentHostState, type AgentModel, type AgentPurpose, type PermissionMode, type SessionModeChoice } from '@smurg/protocol';
import { permissionModeRef, renderEnglish } from '@smurg/protocol/i18n';
import { renderWireText } from '../../lib/errors.ts';
import { t } from './strings.ts';

/** "Auto: runs what a check allows": a permission mode in the viewer's language (the wire catalogue's wording). */
export function modeLabel(mode: PermissionMode): string {
  const ref = permissionModeRef(mode);
  return ref === undefined ? mode : renderWireText(ref, renderEnglish(ref));
}

/** A model id without the `[1m]` a long-context variant carries (the agent names the same model with and without it). */
export function baseModelId(id: string): string {
  return id.endsWith('[1m]') ? id.slice(0, -'[1m]'.length) : id;
}

/** The list entry of a model value; for null, the entry the host's default runs as. Undefined when none is known. */
export function modelEntry(agent: AgentHostState | null, value: string | null): AgentModel | undefined {
  if (agent === null) return undefined;
  if (value !== null) return agent.models.find((model) => model.value === value);
  const host = agent.hostDefault;
  if (host === null) return undefined;
  return agent.models.find((model) => model.resolved !== undefined && baseModelId(model.resolved) === baseModelId(host));
}

/** The list entry an id the agent reported runs as (`modelInUse`): by its resolved id, else by its value. */
export function entryOfRunning(agent: AgentHostState | null, id: string): AgentModel | undefined {
  if (agent === null) return undefined;
  const base = baseModelId(id);
  return agent.models.find((model) => (model.resolved !== undefined && baseModelId(model.resolved) === base) || model.value === id);
}

/** "The host's default", without a name (a session's strip when the agent reported nothing yet). */
export function hostDefaultName(): string {
  return t('model.hostDefault.unknown');
}

/** "Auto mode checks commands with extra requests to Claude, which may count toward the host's usage." ("your usage" for the host) */
export function autoCostText(forHost: boolean): string {
  return t(forHost ? 'cost.auto.host' : 'cost.auto');
}

/** "The host's default (Opus)", or "The host's default" while the list does not name it. */
export function hostDefaultLabel(agent: AgentHostState | null): string {
  const entry = modelEntry(agent, null);
  return entry === undefined ? t('model.hostDefault.unknown') : t('model.hostDefault', { name: entry.name });
}

/** "Opus · Most capable for complex work", or the name alone when the agent says nothing about it. */
export function modelOptionLabel(model: Pick<AgentModel, 'name' | 'description'>): string {
  return model.description.trim() === '' ? model.name : t('model.option', { name: model.name, description: model.description });
}

/** A chosen model's name: the list's, else the value itself (a model the list no longer holds). */
export function modelName(agent: AgentHostState | null, value: string): string {
  return modelEntry(agent, value)?.name ?? value;
}

/** The model may bill usage credits without asking (its list entry says so). */
export function billsUsageCredits(agent: AgentHostState | null, value: string | null): boolean {
  return modelEntry(agent, value)?.billing === 'usage-credits';
}

/** The Select's value for the host's default (a model id never is empty). */
export const HOST_DEFAULT_VALUE = '';

export interface ModelOption {
  readonly value: string;
  readonly label: string;
  /** `AGENT_WORDS_CLASS` on an option made of the agent's own words (its model's name and line). */
  readonly className?: string;
}

/** The class of a picker option whose text is the host's agent's own (a model's name and its line, as the agent lists them). */
export const AGENT_WORDS_CLASS = 'agents-model__listed';

/**
 * The picker's options: the host's default first, then every listed model while the list is known. A chosen model
 * the list does not hold (any more) is offered too, under its own value, so the picker never shows another one.
 */
export function modelOptions(agent: AgentHostState | null, chosen: string | null): ModelOption[] {
  const options: ModelOption[] = [{ value: HOST_DEFAULT_VALUE, label: hostDefaultLabel(agent) }];
  const known = agent?.modelsKnown === true ? agent.models : [];
  for (const model of known) options.push({ value: model.value, label: modelOptionLabel(model), className: AGENT_WORDS_CLASS });
  if (chosen !== null && !options.some((option) => option.value === chosen)) options.push({ value: chosen, label: chosen, className: AGENT_WORDS_CLASS });
  return options;
}

/** Which follow option a mode picker offers first: the workspace's, or (a work item's session) its topic's setting. */
export type ModeFollows = 'workspace' | 'topic';

/** The Select's value for "follow" (a mode is never empty). */
export const FOLLOW_VALUE = '';

export interface ModeOption {
  readonly value: SessionModeChoice | typeof FOLLOW_VALUE;
  readonly label: string;
}

/** "Workspace default (Auto: runs what a check allows)", or "This topic's setting (…)", then the three choices. */
export function modeOptions(follows: ModeFollows, followed: PermissionMode): ModeOption[] {
  const followLabel = follows === 'topic' ? t('mode.follow.topic', { mode: modeLabel(followed) }) : t('mode.follow.workspace', { mode: modeLabel(followed) });
  return [{ value: FOLLOW_VALUE, label: followLabel }, ...SESSION_MODE_CHOICES.map((mode) => ({ value: mode, label: modeLabel(mode) }))];
}

/** The mode a choice results in: the choice itself, else what it follows. */
export function resultingMode(choice: SessionModeChoice | null, followed: PermissionMode): PermissionMode {
  return choice ?? followed;
}

/** What a work item's or a session's choice follows: for a work item its topic's setting, then the workspace's. */
export function followedMode(input: { readonly purpose: AgentPurpose; readonly topic: SessionModeChoice | null; readonly workspace: PermissionMode }): PermissionMode {
  return effectivePermissionMode({ purpose: input.purpose, session: null, topic: input.topic, workspace: input.workspace });
}

/** Whether the models are still being asked for, or the host's agent could not be asked (after `waited`). */
export function modelsNote(agent: AgentHostState | null, waited: boolean): string | null {
  if (agent?.modelsKnown === true) return null;
  return waited ? t('model.unavailable') : t('model.loading');
}

/** "Model: Sonnet", "Model: The host's default (Opus)": a model choice for someone who may not change it. */
export function modelReadOnly(agent: AgentHostState | null, value: string | null): string {
  return t('model.readOnly', { name: value === null ? hostDefaultLabel(agent) : modelName(agent, value) });
}

/** "Permission mode: Workspace default (Auto: …)": a mode choice for someone who may not change it. */
export function modeReadOnly(follows: ModeFollows, choice: SessionModeChoice | null, followed: PermissionMode): string {
  const option = modeOptions(follows, followed).find((entry) => entry.value === (choice ?? FOLLOW_VALUE));
  return t('mode.readOnly', { mode: option?.label ?? modeLabel(resultingMode(choice, followed)) });
}

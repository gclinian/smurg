// The host's own Claude Code allow rules (ARCHITECTURE §7.6 "The host's own Claude Code"; DESIGN §2.11 with
// OWNER-DECISIONS Q7 = B). Every agent session runs as the host, so rules in the host's `~/.claude/settings.json`
// (and in trusted project settings) APPLY: smurg does not ask for what they already allow, and never mirrors them.
// What smurg does: at every process start the runner asks Claude Code which rules are in force
// (`list_permission_rules`) and reports the allow rules that do not come from smurg's own settings file; the set is
// remembered per workspace; the first time rules are found, and whenever the set changes, the host is told once
// (an attention item and one notification: information, no decision).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HOST_RULES_MAX, HOST_RULE_MAX_CHARS, HOST_RULE_SOURCES, mask } from '@smurg/protocol';
import { msg, renderEnglish } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../../core/context.ts';
import type { AttentionFact, HostRules, PersistentDocument, Principal, Res } from '../../core/interfaces.ts';
import { SYSTEM_ACTOR } from '../../core/permissions.ts';
import { isStubService } from '../../core/stubs.ts';

type RuleSource = (typeof HOST_RULE_SOURCES)[number];
export interface HostRule {
  readonly rule: string;
  readonly source: RuleSource;
}

const documentSchema = z.strictObject({
  rules: z.array(z.strictObject({ rule: z.string().min(1).max(HOST_RULE_MAX_CHARS), source: z.enum(HOST_RULE_SOURCES) })).max(HOST_RULES_MAX),
  seen: z.boolean(),
  foundAt: z.int().min(0),
});
type RulesDocument = z.infer<typeof documentSchema>;

/** Claude Code's rule sources that are the host's own (everything else is smurg's settings file, a flag or the session). */
const SOURCES: Readonly<Record<string, RuleSource>> = Object.freeze({ userSettings: 'user', projectSettings: 'project', localSettings: 'local', policySettings: 'managed' });

// eslint-disable-next-line no-control-regex
const NOT_LINE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * The host's own allow rules in the answer to `list_permission_rules` (`{ state: { rules: [{ behavior, source, rule }] } }`).
 * A shape this version does not have yields no rules: nothing is guessed.
 */
export function hostRulesOf(response: unknown): HostRule[] {
  const state = typeof response === 'object' && response !== null ? (response as Record<string, unknown>)['state'] : null;
  const rules = typeof state === 'object' && state !== null ? (state as Record<string, unknown>)['rules'] : null;
  if (!Array.isArray(rules)) return [];
  const out: HostRule[] = [];
  const seen = new Set<string>();
  for (const entry of rules) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { behavior, source, rule } = entry as Record<string, unknown>;
    if (behavior !== 'allow' || typeof source !== 'string' || typeof rule !== 'string') continue;
    const mapped = Object.hasOwn(SOURCES, source) ? (SOURCES[source] as RuleSource) : null;
    if (mapped === null) continue;
    const text = rule.replace(NOT_LINE, ' ').trim().slice(0, HOST_RULE_MAX_CHARS);
    if (text.length === 0 || seen.has(`${mapped}\u0000${text}`)) continue;
    seen.add(`${mapped}\u0000${text}`);
    if (out.length < HOST_RULES_MAX) out.push({ rule: text, source: mapped });
  }
  return out.sort((a, b) => (a.source === b.source ? (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) : a.source < b.source ? -1 : 1));
}

function digest(rules: readonly HostRule[]): string {
  return createHash('sha256').update(JSON.stringify(rules.map((entry) => [entry.source, entry.rule]))).digest('hex');
}

export class HostRulesImpl implements HostRules {
  private readonly ctx: DaemonContext;
  private doc: PersistentDocument<RulesDocument> | null = null;

  constructor(ctx: DaemonContext) {
    this.ctx = ctx;
  }

  async start(): Promise<void> {
    this.doc = await this.ctx.state.document('host-rules', documentSchema, () => ({ rules: [], seen: true, foundAt: 0 }));
  }

  private current(): Readonly<RulesDocument> {
    return this.doc?.get() ?? { rules: [], seen: true, foundAt: 0 };
  }

  /** What an agent process reported at its start. A changed set is stored; new rules put the host's item back. */
  report(rules: readonly HostRule[]): void {
    if (this.doc === null) return;
    const before = this.current();
    if (digest(before.rules) === digest(rules)) return;
    const known = new Set(before.rules.map((entry) => `${entry.source}\u0000${entry.rule}`));
    const added = rules.some((entry) => !known.has(`${entry.source}\u0000${entry.rule}`));
    this.doc.update((draft) => {
      draft.rules = rules.map((entry) => ({ ...entry }));
      if (added) {
        draft.seen = false;
        draft.foundAt = this.ctx.clock.now();
      }
      if (rules.length === 0) draft.seen = true;
    });
    this.ctx.bus.emit('attention.changed', { source: 'host-rules' });
    if (added && !isStubService(this.ctx.services.activity)) {
      // Told once, as information: the rules apply (no decision is asked for).
      const ref = msg('hostRules.found', { count: rules.length });
      try {
        this.ctx.services.activity.notify(this.ctx.members.hostUserId(), { from: SYSTEM_ACTOR, msg: ref, fallback: renderEnglish(ref) });
      } catch (err) {
        this.ctx.log.debug('host rules notification failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
  }

  view(): Res<'admin.hostRules.get'> {
    const doc = this.current();
    return { rules: doc.rules.map((entry) => ({ rule: mask(entry.rule), source: entry.source })), seen: doc.seen };
  }

  async markSeen(_by: Principal): Promise<void> {
    if (this.doc === null || this.current().seen) return;
    this.doc.update((draft) => {
      draft.seen = true;
    });
    this.ctx.bus.emit('attention.changed', { source: 'host-rules' });
  }

  applied(): readonly string[] {
    return this.current().rules.map((entry) => mask(entry.rule));
  }

  attention(): AttentionFact[] {
    const doc = this.current();
    if (doc.seen || doc.rules.length === 0) return [];
    return [
      {
        subject: 'host-rules',
        id: 'workspace',
        at: doc.foundAt,
        recipients: [this.ctx.members.hostUserId()],
        target: { kind: 'console', section: 'host-rules' },
        count: doc.rules.length,
        excerpt: '',
      },
    ];
  }
}

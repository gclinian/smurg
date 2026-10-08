// The host's own Claude Code allow rules (ARCHITECTURE §7.6 "The host's own Claude Code"; DESIGN §2.11 with
// OWNER-DECISIONS Q7 = B). Every agent session runs as the host, so rules in the host's `~/.claude/settings.json`
// (and in trusted project settings) APPLY: smurg does not ask for what they already allow, and never mirrors them.
// What smurg does: at every process start the runner asks Claude Code which rules are in force
// (`list_permission_rules`) and reports the allow rules that do not come from smurg's own settings file. Which rules a
// process sees depends on WHERE it runs: a worktree is a clone of HEAD without the host's `.claude/settings.local.json`,
// and a root whose project settings nobody confirmed starts with the user's settings only. So the last report of each
// kind of root is kept (the main folder, the worktrees) and the workspace's rules are their union; and the host is
// told about a RULE once (an attention item and one notification: information, no decision), whichever root reports
// it and however often sessions of different roots take turns.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HOST_RULES_MAX, HOST_RULE_MAX_CHARS, HOST_RULE_SOURCES, mask, type RootRef } from '@smurg/protocol';
import { msg, renderEnglish } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../../core/context.ts';
import type { AttentionFact, HostRules, PersistentDocument, Principal, Res } from '../../core/interfaces.ts';
import { SYSTEM_ACTOR } from '../../core/permissions.ts';
import { declareDocument } from '../../core/state-store.ts';
import { isStubService } from '../../core/stubs.ts';

type RuleSource = (typeof HOST_RULE_SOURCES)[number];
export interface HostRule {
  readonly rule: string;
  readonly source: RuleSource;
}

const ruleSchema = z.strictObject({ rule: z.string().min(1).max(HOST_RULE_MAX_CHARS), source: z.enum(HOST_RULE_SOURCES) });
/** Rules the host was told about are remembered beyond the sets that hold them now (a rule that returns is not news). */
const TOLD_MAX = 4 * HOST_RULES_MAX;
const documentSchema = z.strictObject({
  /** The last report of a process in the main folder, and of one in a worktree. */
  main: z.array(ruleSchema).max(HOST_RULES_MAX),
  worktree: z.array(ruleSchema).max(HOST_RULES_MAX),
  /** `<source>\u0000<rule>` of every rule the host was told about, oldest first. */
  told: z.array(z.string().min(1).max(HOST_RULE_MAX_CHARS + 16)).max(TOLD_MAX),
  seen: z.boolean(),
  foundAt: z.int().min(0),
  /** Notices the host gets once per workspace and has got (`subscription`). */
  notices: z.array(z.string().min(1).max(64)).max(16),
});
type RulesDocument = z.infer<typeof documentSchema>;
const EMPTY: RulesDocument = Object.freeze({ main: [], worktree: [], told: [], seen: true, foundAt: 0, notices: [] }) as RulesDocument;
/** host-rules.json (no `version` key; new in 0.5.0). Declared by the sessions module. */
export const hostRulesDocument = declareDocument({ name: 'host-rules', schema: documentSchema, init: (): RulesDocument => structuredClone(EMPTY), canSetAside: true });
const keyOf = (entry: HostRule): string => `${entry.source}\u0000${entry.rule}`;
const inOrder = (a: HostRule, b: HostRule): number => (a.source === b.source ? (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) : a.source < b.source ? -1 : 1);

/** The workspace's rules: what the main folder's and the worktrees' processes reported, each rule once. */
function unionOf(doc: Pick<RulesDocument, 'main' | 'worktree'>): HostRule[] {
  const seen = new Set<string>();
  const out: HostRule[] = [];
  for (const entry of [...doc.main, ...doc.worktree]) {
    if (seen.has(keyOf(entry))) continue;
    seen.add(keyOf(entry));
    out.push({ rule: entry.rule, source: entry.source });
  }
  return out.sort(inOrder).slice(0, HOST_RULES_MAX);
}

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
  return out.sort(inOrder);
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
    this.doc = await this.ctx.state.document(hostRulesDocument.name, hostRulesDocument.schema, hostRulesDocument.init);
  }

  private current(): Readonly<RulesDocument> {
    return this.doc?.get() ?? EMPTY;
  }

  /**
   * What an agent process reported at its start, and the root it runs in. The report replaces the set of that kind of
   * root; only a rule the host was never told about puts the host's item back and notifies them.
   */
  report(rules: readonly HostRule[], root: RootRef): void {
    if (this.doc === null) return;
    const before = this.current();
    const kind = root.kind === 'main' ? 'main' : 'worktree';
    if (digest(before[kind]) === digest(rules)) return;
    const told = new Set(before.told);
    const fresh = rules.filter((entry) => !told.has(keyOf(entry)));
    let count = 0;
    this.doc.update((draft) => {
      draft[kind] = rules.slice(0, HOST_RULES_MAX).map((entry) => ({ rule: entry.rule, source: entry.source }));
      if (fresh.length > 0) {
        draft.told = [...draft.told, ...fresh.map(keyOf)].slice(-TOLD_MAX);
        draft.seen = false;
        draft.foundAt = this.ctx.clock.now();
      }
      count = unionOf(draft).length;
      if (count === 0) draft.seen = true;
    });
    this.ctx.bus.emit('attention.changed', { source: 'host-rules' });
    if (fresh.length > 0 && !isStubService(this.ctx.services.activity)) {
      // Told once, as information: the rules apply (no decision is asked for).
      const ref = msg('hostRules.found', { count });
      try {
        this.ctx.services.activity.notify(this.ctx.members.hostUserId(), { from: SYSTEM_ACTOR, msg: ref, fallback: renderEnglish(ref) });
      } catch (err) {
        this.ctx.log.debug('host rules notification failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
  }

  view(): Res<'admin.hostRules.get'> {
    const doc = this.current();
    return { rules: unionOf(doc).map((entry) => ({ rule: mask(entry.rule), source: entry.source })), seen: doc.seen };
  }

  async markSeen(_by: Principal): Promise<void> {
    if (this.doc === null || this.current().seen) return;
    this.doc.update((draft) => {
      draft.seen = true;
    });
    this.ctx.bus.emit('attention.changed', { source: 'host-rules' });
  }

  applied(): readonly string[] {
    return unionOf(this.current()).map((entry) => mask(entry.rule));
  }

  /** A notice the host gets once per workspace: whether it was delivered already, and that it now was. */
  wasTold(notice: string): boolean {
    return this.current().notices.includes(notice);
  }

  markTold(notice: string): void {
    if (this.doc === null || this.wasTold(notice)) return;
    this.doc.update((draft) => {
      draft.notices = [...draft.notices, notice].slice(-16);
    });
  }

  attention(): AttentionFact[] {
    const doc = this.current();
    const count = unionOf(doc).length;
    if (doc.seen || count === 0) return [];
    return [
      {
        subject: 'host-rules',
        id: 'workspace',
        at: doc.foundAt,
        recipients: [this.ctx.members.hostUserId()],
        target: { kind: 'console', section: 'host-rules' },
        count,
        excerpt: '',
      },
    ];
  }
}

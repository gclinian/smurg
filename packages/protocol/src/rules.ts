// "Always allow this kind" (ARCHITECTURE §5.9 "Remembered rules"): which rules may be remembered at all. A POSITIVE
// check: a rule is rememberable only when it has one of exactly two forms. It runs when a permission card is built,
// when a member types a rule for a topic, and again on every rule read back from disk.
//
//   Bash(<w1> <w2>[ <w3>] *)       two or three literal words, then ` *`
//   WebFetch(domain:<hostname>)
//
// A rule here is `{ tool, pattern }` where `pattern` is the inside of the parentheses (`pnpm test *`,
// `domain:example.com`). The client never sends a rule with a permission decision: it sends `allow-always` and the
// daemon uses the rule the card showed.
import type { NoAlwaysReason, OfferedRule } from './schema/conversation.ts';
import { RULE_PATTERN_MAX_CHARS } from './schema/limits.ts';

const WORD = /^[A-Za-z0-9._:@=/+-]+$/;

/** Shells, interpreters and wrappers that run whatever follows; programs with an exec option. */
const RUNS_ANYTHING: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'env', 'sudo', 'doas', 'xargs', 'eval', 'exec', 'command', 'time', 'nice', 'nohup', 'timeout',
  'caffeinate', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'osascript',
  'find', 'awk', 'sed', 'tar', 'rsync', 'git',
]);
/** Programs that fetch or build and then run code. */
const FETCHES_CODE: ReadonlySet<string> = new Set(['npx', 'bunx', 'uvx', 'pipx', 'make', 'docker', 'podman', 'ssh', 'scp', 'curl', 'wget']);
/** Package managers: remembered only for a subcommand (second word) that neither installs nor runs arbitrary scripts. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'cargo', 'go']);
const PACKAGE_MANAGER_REFUSED_WORDS: ReadonlySet<string> = new Set(['add', 'install', 'i', 'exec', 'dlx', 'run-script', 'create', 'init', 'x', 'run']);

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Why a rule cannot be remembered. `form`: it is none of the two forms at all. */
export type RuleRefusal = 'interpreter' | 'fetches-code' | 'one-word' | 'form';
export type RuleCheck = { readonly ok: true; readonly rule: OfferedRule } | { readonly ok: false; readonly reason: RuleRefusal };

function refused(reason: RuleRefusal): RuleCheck {
  return { ok: false, reason };
}

function isPython(word: string): boolean {
  return /^python[0-9.]*$/.test(word);
}

function checkBash(pattern: string): RuleCheck {
  const words = pattern.split(' ');
  if (words.some((word) => word === '')) return refused('form');
  // Claude Code also writes a one-word prefix as `ls:*`.
  if (words.length === 1 && /^[A-Za-z0-9._@+-]+:\*$/.test(pattern)) return refused('one-word');
  if (words[words.length - 1] !== '*') return refused('form');
  const literal = words.slice(0, -1);
  if (literal.length === 0) return refused('form');
  if (!literal.every((word) => WORD.test(word))) return refused('form');
  const first = literal[0] as string;
  // A path to a program or an environment assignment in front: any program at all.
  if (first.includes('/') || first.includes('=')) return refused('interpreter');
  if (RUNS_ANYTHING.has(first) || isPython(first)) return refused('interpreter');
  if (FETCHES_CODE.has(first)) return refused('fetches-code');
  if (literal.length === 1) return refused('one-word');
  if (literal.length > 3) return refused('form');
  // A package manager is remembered per subcommand: an option in front (`pnpm --filter x *`) would leave the
  // subcommand to the wildcard, `pnpm --filter x dlx …` included.
  const second = literal[1] as string;
  if (PACKAGE_MANAGERS.has(first) && (second.startsWith('-') || PACKAGE_MANAGER_REFUSED_WORDS.has(second))) return refused('fetches-code');
  return { ok: true, rule: { tool: 'Bash', pattern } };
}

function checkWebFetch(pattern: string): RuleCheck {
  if (!pattern.startsWith('domain:')) return refused('form');
  const hostname = pattern.slice('domain:'.length);
  if (!HOSTNAME.test(hostname) || IPV4.test(hostname) || hostname.toLowerCase() === 'localhost') return refused('form');
  // A hostname of digits and dots only is an address in another spelling.
  if (/^[0-9.]+$/.test(hostname)) return refused('form');
  return { ok: true, rule: { tool: 'WebFetch', pattern } };
}

/** The positive check: whether `tool(pattern)` is one of the two rememberable forms. */
export function checkRememberableRule(tool: string, pattern: string): RuleCheck {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > RULE_PATTERN_MAX_CHARS) return refused('form');
  if (tool === 'Bash') return checkBash(pattern);
  if (tool === 'WebFetch') return checkWebFetch(pattern);
  return refused('form');
}

export function isRememberableRule(tool: string, pattern: string): boolean {
  return checkRememberableRule(tool, pattern).ok;
}

/** `Bash(pnpm test *)`: how a rule is written in a settings file and shown on a card. */
export function ruleString(rule: { readonly tool: string; readonly pattern: string }): string {
  return `${rule.tool}(${rule.pattern})`;
}

/** The inverse of ruleString for the two tools; null for anything else. */
export function parseRuleString(text: string): { tool: string; pattern: string } | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/s.exec(text);
  return match === null ? null : { tool: match[1] as string, pattern: match[2] as string };
}

/**
 * What a permission card offers for "Always allow this kind": the rule, or why it is not offered. `suggested`: the
 * rule Claude Code proposed with the request (null: none); `hostOnly`: the request is host-only.
 */
export function offerAlwaysRule(
  suggested: { readonly tool: string; readonly pattern: string } | null | undefined,
  hostOnly: boolean,
): { readonly alwaysRule: OfferedRule } | { readonly noAlways: NoAlwaysReason } {
  if (hostOnly) return { noAlways: 'host-only' };
  if (suggested === null || suggested === undefined) return { noAlways: 'no-suggestion' };
  const check = checkRememberableRule(suggested.tool, suggested.pattern);
  if (check.ok) return { alwaysRule: check.rule };
  return { noAlways: check.reason === 'form' ? 'no-suggestion' : check.reason };
}

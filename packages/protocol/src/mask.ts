// mask(): the ONE function that runs over every text that came from an agent or a tool before it is stored or sent
// (ARCHITECTURE §5.9 "What a conversation never holds"): agent text blocks, diffs, command output, search file lists,
// fetch and other tool results, report sections, follow-up answers, merge diffs, the host's own rules. It hides what
// looks like a credential. Best effort, and the documents say so: whatever an agent reads it may repeat to everyone.
//
// Pure and linear in the input: every pattern is anchored on a literal prefix and bounded.

export const MASKED = '[masked]';

type Rule = readonly [pattern: RegExp, replace: string | ((...groups: string[]) => string)];

const RULES: readonly Rule[] = [
  // PEM private key blocks (the whole block).
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]{0,16384}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, MASKED],
  // Anthropic and OpenAI keys.
  [/\bsk-ant-[A-Za-z0-9_-]{8,512}/g, MASKED],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,512}/g, MASKED],
  // GitHub tokens.
  [/\bgh[pousr]_[A-Za-z0-9]{20,255}/g, MASKED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}/g, MASKED],
  // AWS access key ids.
  [/\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/g, MASKED],
  // Slack tokens.
  [/\bxox[abeprs]-[A-Za-z0-9-]{10,255}/g, MASKED],
  // Google API keys and OAuth access tokens.
  [/\bAIza[0-9A-Za-z_-]{35}/g, MASKED],
  [/\bya29\.[0-9A-Za-z_-]{20,2048}/g, MASKED],
  // `Authorization: <scheme> <credentials>` headers (also inside quoted command lines).
  [/\b(authorization\s*[:=]\s*)(?:(?:basic|bearer|token|digest)\s+)?[^\s"'`,;]{4,4096}/gi, (_whole, prefix) => `${prefix}${MASKED}`],
  // Values after password= / token= / secret= / api_key= (and the usual spellings), `=` or `:`.
  [
    /\b((?:[A-Za-z0-9_.-]{0,64}?(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key))\s*[=:]\s*)(["'`]?)[^\s"'`,;&]{4,4096}\2/gi,
    (_whole, prefix, quote) => `${prefix}${quote}${MASKED}${quote}`,
  ],
];

/** `text` with everything that looks like a credential replaced by MASKED. Never throws; idempotent. */
export function mask(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [pattern, replace] of RULES) out = out.replace(pattern, replace as never);
  return out;
}

/** Whether `mask` would change `text`. */
export function hasMaskable(text: string): boolean {
  return mask(text) !== text;
}

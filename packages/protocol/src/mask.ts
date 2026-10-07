// mask(): the ONE function that runs over every text that came from an agent or a tool before it is stored or sent
// (ARCHITECTURE §5.9 "What a conversation never holds"): agent text blocks, diffs, command output, search file lists,
// fetch and other tool results, report sections, follow-up answers, merge diffs, the host's own rules. It hides what
// looks like a credential. Best effort, and the documents say so: whatever an agent reads it may repeat to everyone.
//
// Pure, and what it costs is in proportion to the text: every pattern is anchored on a literal prefix and bounded,
// and a key block is found in one pass (the protocol's text-cost test measures both).

export const MASKED = '[masked]';

type Rule = readonly [pattern: RegExp, replace: string | ((...groups: string[]) => string)];

const PEM_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const PEM_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
/** The most characters between the two lines of a key block. */
const PEM_BODY_MAX_CHARS = 16_384;

/**
 * PEM private key blocks (the whole block): a BEGIN line, at most PEM_BODY_MAX_CHARS characters, and the nearest END
 * line after it. One pass over the text: the END lines are looked for once, from left to right, whatever number of
 * BEGIN lines stand in front of them (one expression for the whole block looked 16,384 characters ahead from every
 * BEGIN line: 1.3 s for a megabyte of them).
 */
function maskKeyBlocks(text: string): string {
  if (!text.includes('PRIVATE KEY-----')) return text;
  const begin = new RegExp(PEM_BEGIN);
  const end = new RegExp(PEM_END);
  let out = '';
  let copied = 0;
  /** The first END line at or after the body of the last BEGIN line that looked for one; null: none looked yet, or there is none. */
  let footer: RegExpExecArray | null = null;
  let noMore = false;
  for (let header = begin.exec(text); header !== null; header = begin.exec(text)) {
    const bodyFrom = header.index + header[0].length;
    while (!noMore && (footer === null || footer.index < bodyFrom)) {
      end.lastIndex = footer === null ? bodyFrom : Math.max(footer.index + 1, bodyFrom);
      footer = end.exec(text);
      noMore = footer === null;
    }
    if (footer === null) break;
    if (footer.index - bodyFrom > PEM_BODY_MAX_CHARS) {
      // Too far: this is no block. The next BEGIN line may start inside this one's last hyphens.
      begin.lastIndex = header.index + 1;
      continue;
    }
    out += text.slice(copied, header.index) + MASKED;
    copied = footer.index + footer[0].length;
    begin.lastIndex = copied;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

const RULES: readonly Rule[] = [
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
  // Values after password= / token= / secret= / api_key= (and the usual spellings), `=` or `:`. The word may be the
  // end of a longer name (`MY_API_TOKEN=`): at most 64 characters of a name in front of it, from a word boundary.
  // That is looked for BACKWARDS from the word, once it is found (looked for forwards from every word boundary of a
  // text, it cost 64 tries at each of them: 0.8 s for a megabyte of dotted names).
  [
    /((password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)(?<=\b[A-Za-z0-9_.-]{0,64}\2)\s*[=:]\s*)(["'`]?)[^\s"'`,;&]{4,4096}\3/gi,
    (_whole, prefix, _word, quote) => `${prefix}${quote}${MASKED}${quote}`,
  ],
];

/** `text` with everything that looks like a credential replaced by MASKED. Never throws; idempotent. */
export function mask(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = maskKeyBlocks(text);
  for (const [pattern, replace] of RULES) out = out.replace(pattern, replace as never);
  return out;
}

/** Whether `mask` would change `text`. */
export function hasMaskable(text: string): boolean {
  return mask(text) !== text;
}

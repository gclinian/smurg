// Handshake patterns and the psk modifier (Noise rev 34 §7, §9). Production code only needs XX (+psk3); the full
// rev-34 table for the vector tests lives in ./testing/all-patterns.ts and is resolved through the same code.
import { NoiseError } from './errors.ts';

export type NoiseToken = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk';
export type NoisePreToken = 'e' | 's';

export interface HandshakePattern {
  /** Pattern name including modifiers, e.g. "XXpsk3". */
  readonly name: string;
  readonly initiatorPre: readonly NoisePreToken[];
  readonly responderPre: readonly NoisePreToken[];
  /** messages[0] is sent by the initiator, then strictly alternating (one-way patterns have a single message). */
  readonly messages: readonly (readonly NoiseToken[])[];
}

const TOKENS: ReadonlySet<string> = new Set(['e', 's', 'ee', 'es', 'se', 'ss', 'psk']);

/**
 * Parses the notation of the Noise specification, e.g. `"<- s ... -> e, es; <- e, ee"` (pre-messages before
 * `...`, messages separated by `;`).
 */
export function parseHandshakePattern(name: string, notation: string): HandshakePattern {
  const [preRaw, msgRaw] = notation.includes('...') ? notation.split('...') : ['', notation];
  const initiatorPre: NoisePreToken[] = [];
  const responderPre: NoisePreToken[] = [];
  const lines = (raw: string | undefined) =>
    (raw ?? '')
      .split(';')
      .map((l) => l.trim())
      .filter(Boolean);
  const tokensOf = (line: string): string[] => line.slice(2).split(',').map((t) => t.trim());
  for (const line of lines(preRaw)) {
    const toks = tokensOf(line);
    if (!toks.every((t) => t === 'e' || t === 's')) throw new NoiseError('bad-pattern', `bad pre-message in ${name}`);
    (line.startsWith('->') ? initiatorPre : responderPre).push(...(toks as NoisePreToken[]));
  }
  const messages = lines(msgRaw).map((line) => {
    const toks = tokensOf(line);
    if (!toks.every((t) => TOKENS.has(t))) throw new NoiseError('bad-pattern', `bad token in ${name}`);
    return toks as NoiseToken[];
  });
  if (messages.length === 0) throw new NoiseError('bad-pattern', `pattern ${name} has no messages`);
  return { name, initiatorPre, responderPre, messages };
}

/** The only base pattern smurg uses: first contact is XXpsk3, reconnect is XX (ARCHITECTURE §4). */
export const NOISE_BASE_PATTERNS: Readonly<Record<string, HandshakePattern>> = Object.freeze({
  XX: parseHandshakePattern('XX', '-> e; <- e, ee, s, es; -> s, se'),
});

/**
 * Applies psk modifiers (§9.2): "psk0" puts a psk token at the start of the first message, "pskN" (N >= 1) at the
 * end of the N-th message. Several modifiers are joined with "+".
 */
export function applyPskModifiers(base: HandshakePattern, modifiers: string): HandshakePattern {
  if (!modifiers) return base;
  const messages = base.messages.map((m) => [...m]);
  for (const modifier of modifiers.split('+')) {
    const m = /^psk(\d+)$/.exec(modifier);
    if (!m) throw new NoiseError('bad-pattern', `unsupported modifier ${modifier}`);
    const n = Number(m[1]);
    const target = messages[n === 0 ? 0 : n - 1];
    if (!target) throw new NoiseError('bad-pattern', `${modifier} out of range`);
    if (n === 0) target.unshift('psk');
    else target.push('psk');
  }
  return { ...base, name: base.name + modifiers, messages };
}

/** Resolves "XXpsk3" and friends against a table of base patterns. */
export function resolveHandshakePattern(
  name: string,
  table: Readonly<Record<string, HandshakePattern>> = NOISE_BASE_PATTERNS,
): HandshakePattern {
  const m = /^([A-Z0-9]+?)((?:psk\d+\+?)*)$/.exec(name);
  const base = m ? table[m[1] as string] : undefined;
  if (!m || !base || !Object.hasOwn(table, m[1] as string)) throw new NoiseError('bad-pattern', `unknown pattern ${name}`);
  return applyPskModifiers(base, m[2] ?? '');
}

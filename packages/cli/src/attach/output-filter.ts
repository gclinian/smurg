// The output filter of `smurg attach` (ARCHITECTURE §7.6 "PTY"; pty-packaging.md V6): session output is written by
// someone else's process (a guest's agent, possibly prompt-injected), and it goes to the attaching person's REAL
// terminal. That terminal must never answer a query into the session (device attributes, DECRQSS, cursor reports, …),
// never receive OSC 52 (clipboard write / read), DCS (incl. tmux / screen passthrough), APC / PM / SOS, window
// operations or anything else this filter does not know to be harmless.
//
// An ALLOW-LIST, not a deny-list (security review SEC-E-01). A VT parser state machine (the DEC/xterm
// model: ESC, CSI, OSC, DCS, SOS/PM/APC strings, CAN/SUB aborts, ESC inside a string ends it) runs over the decoded
// UTF-8 stream, with the C1 controls U+0080–U+009F treated as their 7-bit ESC forms (xterm.js interprets them), and:
//   - text and the harmless C0 controls pass; invalid UTF-8 becomes U+FFFD (a raw 8-bit C1 byte never passes);
//   - a sequence is emitted only when it is COMPLETE and on the allow-list, re-encoded from its parsed parts in 7-bit
//     form; everything else is dropped whole (and what a string swallows is swallowed until its terminator, across
//     chunks and pauses: nothing is ever emitted half-way, so the terminal is back in its ground state after every
//     piece of output this filter writes);
//   - memory is bounded: an over-long sequence is dropped, never passed through.
// A terminal that is not in UTF-8 mode may read the bytes 0x80–0x9F inside UTF-8 text as 8-bit C1 controls (e.g.
// "ě" = C4 9B, and 9B is CSI): with `utf8: false` (the attaching process's locale is not UTF-8) only ASCII is passed.
// The daemon's own terminal mirror is the only party that answers queries (ARCHITECTURE §7.6).

const GROUND = 0;
const ESCAPE = 1;
const CSI = 2;
const CSI_IGNORE = 3;
const OSC = 4;
const OSC_IGNORE = 5;
const STRING_IGNORE = 6; // DCS, SOS, PM, APC: dropped whole
type State = typeof GROUND | typeof ESCAPE | typeof CSI | typeof CSI_IGNORE | typeof OSC | typeof OSC_IGNORE | typeof STRING_IGNORE;

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const REPLACEMENT = 0xfffd;

/** C0 controls that are passed: BEL, BS, HT, LF, VT, FF, CR, SO, SI. */
const C0_ALLOWED = new Set([0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]);
/** ESC <final> without intermediates: DECSC, DECRC, DECKPAM, DECKPNM, RIS, IND, NEL, HTS, RI, SS2, SS3. */
const ESC_ALLOWED = new Set(['7', '8', '=', '>', 'c', 'D', 'E', 'H', 'M', 'N', 'O']);
/** Charset designations ESC ( ) * + - . / <final>. */
const ESC_CHARSET_INTERMEDIATES = new Set(['(', ')', '*', '+', '-', '.', '/']);

/**
 * CSI sequences that are passed, by `<private prefix><intermediates>` → finals. No query is in this table: DA
 * (`c`), DSR / CPR (`n`), DECRQM (`$p`), XTVERSION (`>q`), kitty flags query (`?u`), XTQMODKEYS (`?m`),
 * XTSMGRAPHICS (`?S`), DECRQCRA (`*y`), DECREQTPARM (`x`), media copy (`i`) and window ops / reports (`t` except the
 * title stack 22 / 23) are all dropped.
 */
const CSI_ALLOWED: ReadonlyMap<string, string> = new Map([
  // ICH CUU CUD CUF CUB CNL CPL CHA CUP CHT ED EL IL DL DCH SU SD ECH CBT HPA HPR REP VPA VPR HVP TBC SM RM SGR
  // DECSTBM SCOSC SCORC (and `t`, checked below)
  ['', '@ABCDEFGHIJKLMPSTXZ`abdefghlmrsut'],
  [' ', 'q'], // DECSCUSR (cursor style)
  ['!', 'p'], // DECSTR (soft reset)
  ['?', 'hlJKsr'], // DECSET / DECRST, DECSED / DECSEL, XTSAVE / XTRESTORE
  ['>', 'mnpu'], // XTMODKEYS set / reset, XTSMPOINTER, kitty keyboard push
  ['<', 'u'], // kitty keyboard pop
  ['=', 'u'], // kitty keyboard set
]);
/** XTWINOPS that are passed: push / pop the title stack. */
const WINOPS_ALLOWED = new Set([22, 23]);

const CSI_MAX = 64;
const OSC_MAX = 2048;
const TITLE_MAX = 256;

function isC1(cp: number): boolean {
  return cp >= 0x80 && cp <= 0x9f;
}

/** Title text: no controls of any kind (C0, DEL, C1), bounded; ASCII only for a terminal that is not UTF-8. */
function cleanTitle(text: string, utf8: boolean): string {
  // eslint-disable-next-line no-control-regex
  const clean = Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')).slice(0, TITLE_MAX).join('');
  return utf8 ? clean : clean.replace(/[^\x20-\x7e]/gu, '?');
}

/** The allow-listed form of a complete OSC body, or null (dropped). */
function allowedOsc(body: string, utf8: boolean): string | null {
  const semi = body.indexOf(';');
  const idText = semi < 0 ? body : body.slice(0, semi);
  if (!/^\d{1,3}$/.test(idText)) return null;
  const id = Number(idText);
  const rest = semi < 0 ? '' : body.slice(semi + 1);
  // 0 / 1 / 2: icon name and window title (text only).
  if (id === 0 || id === 1 || id === 2) return `${id};${cleanTitle(rest, utf8)}`;
  // 8: hyperlink, http(s) only (or the empty URI that ends a link); parameters restricted to a plain id.
  if (id === 8) {
    const parts = /^([A-Za-z0-9=:_.-]{0,128});(|https?:\/\/[\x21-\x7e]{1,2000})$/.exec(rest);
    return parts ? `8;${parts[1] as string};${parts[2] as string}` : null;
  }
  // Colour SETS (palette 4, dynamic colours 10–19) and their resets (104, 110–119); a `?` anywhere is a query.
  if (!/^[\x20-\x7e]*$/.test(rest) || rest.includes('?')) return null;
  if (id === 4 || (id >= 10 && id <= 19) || id === 104 || (id >= 110 && id <= 119)) return semi < 0 ? `${id}` : `${id};${rest}`;
  return null; // 52 (clipboard), 7, 9, 50, 133, 777, 1337, … and everything unknown
}

/** The allow-listed form of a complete CSI, or null (dropped). `body` is parameters + intermediates. */
function allowedCsi(body: string, final: string): string | null {
  const m = /^([<=>?]?)([0-9:;]*)([\x20-\x2f]*)$/.exec(body);
  if (!m) return null;
  const prefix = m[1] as string;
  const params = m[2] as string;
  const intermediates = m[3] as string;
  if (intermediates.length > 1 || (intermediates !== '' && prefix !== '')) return null;
  const finals = CSI_ALLOWED.get(prefix === '' ? intermediates : prefix);
  if (finals === undefined || !finals.includes(final)) return null;
  if (prefix === '' && intermediates === '' && final === 't' && !WINOPS_ALLOWED.has(Number.parseInt(params, 10))) return null;
  return `\x1b[${prefix}${params}${intermediates}${final}`;
}

/** The allow-listed form of a complete non-CSI escape sequence, or null (dropped). */
function allowedEsc(intermediates: string, final: string): string | null {
  if (intermediates === '') return ESC_ALLOWED.has(final) ? `\x1b${final}` : null;
  if (intermediates.length !== 1) return null;
  if (ESC_CHARSET_INTERMEDIATES.has(intermediates)) return `\x1b${intermediates}${final}`;
  if (intermediates === '#' && '34568'.includes(final)) return `\x1b#${final}`; // DECDHL, DECSWL, DECDWL, DECALN
  if (intermediates === '%' && '@G8'.includes(final)) return `\x1b%${final}`; // character set selection (UTF-8)
  return null; // ESC SP F / G (S7C1T / S8C1T: 8-bit REPLIES), ESC Z (DECID: a query), …
}

class Output {
  private readonly parts: Uint8Array[] = [];
  private text = '';

  bytes(b: Uint8Array): void {
    this.flushText();
    this.parts.push(b);
  }

  string(s: string): void {
    this.text += s;
  }

  private flushText(): void {
    if (this.text !== '') {
      this.parts.push(new Uint8Array(Buffer.from(this.text, 'utf8')));
      this.text = '';
    }
  }

  done(): Uint8Array {
    this.flushText();
    if (this.parts.length === 1) return this.parts[0] as Uint8Array;
    return new Uint8Array(Buffer.concat(this.parts));
  }
}

/** Length of a UTF-8 sequence from its lead byte (0: not a valid lead byte). */
function utf8Length(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/** Decodes one complete UTF-8 sequence; -1 when it is invalid (continuation bytes, overlong, surrogate, range). */
function decodeUtf8(bytes: ArrayLike<number>, at: number, length: number): number {
  let cp = (bytes[at] as number) & (length === 2 ? 0x1f : length === 3 ? 0x0f : 0x07);
  for (let k = 1; k < length; k++) {
    const b = bytes[at + k] as number;
    if ((b & 0xc0) !== 0x80) return -1;
    cp = (cp << 6) | (b & 0x3f);
  }
  if (length === 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) return -1;
  if (length === 4 && (cp < 0x10000 || cp > 0x10ffff)) return -1;
  return cp;
}

/** Whether the locale of this process says UTF-8 (unset: assumed, as every current terminal is UTF-8 by default). */
export function localeIsUtf8(env: Readonly<Record<string, string | undefined>>): boolean {
  const locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'];
  return locale === undefined || locale === '' || /utf-?8/i.test(locale);
}

export class OutputFilter {
  private readonly utf8: boolean;
  private state: State = GROUND;
  /** Parameters + intermediates of a CSI, intermediates of an ESC sequence, or the body of an OSC. */
  private seq = '';
  /** Bytes of a UTF-8 sequence split across chunks. */
  private pending: number[] = [];

  constructor(options: { readonly utf8?: boolean } = {}) {
    this.utf8 = options.utf8 ?? true;
  }

  /** Filters one chunk of session output. Never returns part of a sequence; state carries over to the next chunk. */
  push(chunk: Uint8Array): Uint8Array {
    const out = new Output();
    const n = chunk.length;
    let i = 0;
    while (i < n) {
      if (this.pending.length === 0) {
        // Fast path in the ground state: printable ASCII and complete, valid UTF-8 above the C1 range.
        if (this.state === GROUND) {
          let j = i;
          while (j < n) {
            const b = chunk[j] as number;
            if (b >= 0x20 && b < 0x7f) {
              j += 1;
              continue;
            }
            const length = this.utf8 ? utf8Length(b) : 0;
            if (length === 0 || j + length > n) break;
            const cp = decodeUtf8(chunk, j, length);
            if (cp < 0xa0) break;
            j += length;
          }
          if (j > i) {
            out.bytes(chunk.subarray(i, j));
            i = j;
            continue;
          }
        }
        const b = chunk[i] as number;
        i += 1;
        if (b < 0x80) this.feed(b, out);
        else if (utf8Length(b) > 0) this.pending.push(b);
        else this.feed(REPLACEMENT, out);
        continue;
      }
      // Completing a multi-byte sequence.
      const b = chunk[i] as number;
      if ((b & 0xc0) !== 0x80) {
        this.pending = [];
        this.feed(REPLACEMENT, out);
        continue; // `b` is looked at again as a fresh byte
      }
      i += 1;
      this.pending.push(b);
      const length = utf8Length(this.pending[0] as number);
      if (this.pending.length === length) {
        const cp = decodeUtf8(this.pending, 0, length);
        this.pending = [];
        this.feed(cp < 0 ? REPLACEMENT : cp, out);
      }
    }
    return out.done();
  }

  /** One code point through the state machine. */
  private feed(cp: number, out: Output): void {
    // "Anywhere" transitions (DEC / xterm): ESC, CAN, SUB and the C1 controls end whatever was going on.
    if (isC1(cp)) {
      this.feed(ESC, out);
      this.feed(cp - 0x40, out);
      return;
    }
    if (cp === ESC) {
      this.endSequence(out);
      this.state = ESCAPE;
      this.seq = '';
      return;
    }
    if (cp === CAN || cp === SUB) {
      // Aborts a sequence; an aborted OSC is not executed.
      this.state = GROUND;
      this.seq = '';
      return;
    }
    switch (this.state) {
      case GROUND:
        if (cp >= 0x20 && cp !== 0x7f) out.string(cp < 0x80 || this.utf8 ? String.fromCodePoint(cp) : '?');
        else if (C0_ALLOWED.has(cp)) out.string(String.fromCharCode(cp));
        return;
      case ESCAPE:
        if (cp < 0x20) return this.execute(cp, out);
        if (cp >= 0x20 && cp <= 0x2f) {
          this.seq += String.fromCharCode(cp);
          if (this.seq.length > 4) this.state = CSI_IGNORE; // nonsense: drop up to a final byte
          return;
        }
        if (cp >= 0x30 && cp <= 0x7e) return this.escFinal(String.fromCharCode(cp), out);
        if (cp !== 0x7f) this.state = GROUND; // not a sequence at all: drop it
        return;
      case CSI:
        if (cp < 0x20) return this.execute(cp, out);
        if (cp >= 0x20 && cp <= 0x3f) {
          this.seq += String.fromCharCode(cp);
          if (this.seq.length > CSI_MAX) this.state = CSI_IGNORE;
          return;
        }
        if (cp >= 0x40 && cp <= 0x7e) {
          const allowed = allowedCsi(this.seq, String.fromCharCode(cp));
          if (allowed !== null) out.string(allowed);
          this.state = GROUND;
          this.seq = '';
          return;
        }
        if (cp !== 0x7f) this.state = CSI_IGNORE;
        return;
      case CSI_IGNORE:
        if (cp < 0x20) return this.execute(cp, out);
        if (cp >= 0x40 && cp <= 0x7e) {
          this.state = GROUND;
          this.seq = '';
        }
        return;
      case OSC:
        if (cp === BEL) return this.endSequence(out);
        if (cp < 0x20 || cp === 0x7f) return; // ignored inside a string
        this.seq += String.fromCodePoint(cp);
        if (this.seq.length > OSC_MAX) {
          this.state = OSC_IGNORE;
          this.seq = '';
        }
        return;
      case OSC_IGNORE:
        if (cp === BEL) this.state = GROUND;
        return;
      case STRING_IGNORE:
        return; // only ESC (ST or anything else), CAN, SUB or a C1 control ends it: handled above
    }
  }

  /** A C0 control met in the middle of an escape / control sequence is performed right away, as terminals do. */
  private execute(cp: number, out: Output): void {
    if (C0_ALLOWED.has(cp)) out.string(String.fromCharCode(cp));
  }

  private escFinal(final: string, out: Output): void {
    const intermediates = this.seq;
    this.seq = '';
    if (intermediates === '') {
      if (final === '[') {
        this.state = CSI;
        return;
      }
      if (final === ']') {
        this.state = OSC;
        return;
      }
      if (final === 'P' || final === 'X' || final === '^' || final === '_') {
        this.state = STRING_IGNORE; // DCS, SOS, PM, APC
        return;
      }
    }
    this.state = GROUND;
    const allowed = allowedEsc(intermediates, final);
    if (allowed !== null) out.string(allowed);
  }

  /** The current sequence ends here (BEL, or ESC / a C1 control, which terminals treat as its end). */
  private endSequence(out: Output): void {
    if (this.state === OSC) {
      const allowed = allowedOsc(this.seq, this.utf8);
      if (allowed !== null) out.string(`\x1b]${allowed}\x07`);
    }
    // An unfinished CSI / ESC is abandoned; DCS / SOS / PM / APC were never going to be emitted.
    this.state = GROUND;
    this.seq = '';
  }
}

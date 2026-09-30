// What an accepted suggestion may contain when it is pasted into a PTY (SPEC R6, ARCHITECTURE §5.6 / §7.6). It goes
// in as a bracketed paste (ESC [ 200 ~ … ESC [ 201 ~) followed by Enter, so the text itself must not be able to END
// the paste early and turn the rest into keystrokes for the owner's agent or shell: no ESC (7-bit CSI), no C1 control
// (U+009B is an 8-bit CSI), no other C0 control (Ctrl-C, Ctrl-D, Ctrl-Z, BEL, …), no DEL. Tab and newline stay.
// The protocol schema already refuses all of these (suggestionTextSchema); this is the second, independent layer
// right in front of the one function that writes suggestion text into a PTY.

// C0 controls except TAB (U+0009) and LF (U+000A), DEL, and the C1 range.
const PASTE_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Bidi embeddings, overrides and isolates ("Trojan Source"): they make the pasted prompt read differently than it is.
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
// Lone surrogates (not text; a terminal would show U+FFFD at best).
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The bracketed-paste end marker; never present in sanitised text (its ESC is removed). */
export const PASTE_END = '\u001b[201~';

/**
 * The text that may be pasted: CRLF and lone CR become LF (a CR inside a paste is Enter in raw mode), every other
 * control character, bidi control and lone surrogate is removed. Idempotent.
 */
export function sanitizeSuggestionForPaste(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(PASTE_UNSAFE, '').replace(BIDI_CONTROLS, '').replace(LONE_SURROGATE, '');
}

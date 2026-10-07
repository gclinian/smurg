// PURE: a command line read the way a POSIX shell splits it, far enough to say which files it names and where it
// stops being readable. Two callers decide by it, and both fail closed on what it cannot follow:
//   - the trust gate (sessions/agent/project-settings.ts): which files of the folder a confirmed hook command runs;
//   - the tool gate (hooks/bash-guard.ts): whether an agent's shell command stays away from those files.
//
// It is not a shell. It knows quoting, the operators that separate commands, redirections, here-documents, and where
// a variable, a substitution or a wildcard stands; it never guesses what one of those expands to. A word that holds
// one is `dynamic` or `glob`, and only its literal start (`prefix`) is known. Anything it does not read (an open
// quote, nesting deeper than SCAN_DEPTH_MAX, a `case` inside a substitution) sets `unparsed`.
//
// This file imports NOTHING.

/** Stands, in `ShellWord.text`, where an expansion nobody can follow was written. Never part of a file name. */
export const UNKNOWN_PART = '\ufffc';

export interface ShellWord {
  /** The word without its quotes; UNKNOWN_PART where a variable or a substitution stood. */
  readonly text: string;
  /** It holds a variable, a substitution or arithmetic whose value is not known. */
  readonly dynamic: boolean;
  /** It holds an unquoted wildcard, a brace list, or a tilde that is not followed: it names whatever matches. */
  readonly glob: boolean;
  /** The literal start of the word: everything before the first part that is not known (the whole word when all is). */
  readonly prefix: string;
  /** Quotes or a backslash were written in it (it may be a whole command line for another shell). */
  readonly quoted: boolean;
}

export interface SimpleCommand {
  /** The command's words in order. Reserved words (`then`, `do`, `!`, …) are still in front: see programWords. */
  readonly words: readonly ShellWord[];
  /** `NAME=value` in front of the program. */
  readonly assignments: readonly ShellWord[];
  /** Targets of `>`, `>>`, `>|`, `&>`, `<>`: files the shell itself opens for writing. */
  readonly writes: readonly ShellWord[];
  /** Targets of `<`. */
  readonly reads: readonly ShellWord[];
}

export interface ShellScan {
  /** Every simple command in the order it was written, those inside `$( … )`, backticks and `<( … )` included. */
  readonly commands: readonly SimpleCommand[];
  /** Something was not read: what the line does is not known. */
  readonly unparsed: boolean;
}

export interface ScanOptions {
  /** Variables whose value is known (`$NAME`, `${NAME}`, `${NAME:-…}` are then that value). */
  readonly variables?: Readonly<Record<string, string>>;
  /** What an unquoted `~` or `~/…` at the start of a word stands for. Without it such a word is `glob`. */
  readonly home?: string;
}

/** Substitutions nested deeper than this are not read. */
export const SCAN_DEPTH_MAX = 4;
/** A line longer than this is not read. */
export const SCAN_TEXT_MAX_CHARS = 256 * 1024;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const DIGITS = /^[0-9]+$/;
const BREAK = /[\s;&|()<>]/;

class WordBuilder {
  text = '';
  dynamic = false;
  glob = false;
  quoted = false;
  started = false;
  /** The word began with an unquoted character (an assignment needs that). */
  plainStart = true;
  private known: number | null = null;

  literal(chars: string, quoted: boolean): void {
    if (!this.started && quoted) this.plainStart = false;
    this.started = true;
    if (quoted) this.quoted = true;
    this.text += chars;
  }

  unknown(kind: 'dynamic' | 'glob', shown: string): void {
    this.started = true;
    if (this.known === null) this.known = this.text.length;
    if (kind === 'dynamic') this.dynamic = true;
    else this.glob = true;
    this.text += shown;
  }

  done(): ShellWord {
    return { text: this.text, dynamic: this.dynamic, glob: this.glob, prefix: this.known === null ? this.text : this.text.slice(0, this.known), quoted: this.quoted };
  }
}

interface OpenCommand {
  words: ShellWord[];
  assignments: ShellWord[];
  writes: ShellWord[];
  reads: ShellWord[];
}

type Pending = 'write' | 'read' | 'dup-write' | 'dup-read' | 'heredoc' | 'heredoc-tabs' | 'data' | null;

interface Scanned {
  readonly commands: SimpleCommand[];
  readonly unparsed: boolean;
  /** Where reading stopped: the index of the `)` that closes the substitution, or the text's length. */
  readonly end: number;
}

/**
 * Reads from `start`. `inner`: the text is the inside of `$( … )` or `<( … )`, and reading stops at the `)` that
 * closes it (quotes, here-documents and nested parentheses are read as the shell reads them, so a `)` in a commit
 * message does not end it).
 */
function scanFrom(text: string, start: number, options: ScanOptions, depth: number, inner: boolean): Scanned {
  const commands: SimpleCommand[] = [];
  let unparsed = false;
  let command: OpenCommand = { words: [], assignments: [], writes: [], reads: [] };
  let word = new WordBuilder();
  /** What the next finished word is: a redirection's target, a here-document's delimiter, or data. */
  let pending: Pending = null;
  let parens = 0;
  const heredocs: { delimiter: string; quoted: boolean; tabs: boolean }[] = [];

  const endWord = (): void => {
    if (!word.started) return;
    const done = word.done();
    const plainStart = word.plainStart;
    word = new WordBuilder();
    const was = pending;
    pending = null;
    if (was === 'write') command.writes.push(done);
    else if (was === 'read') command.reads.push(done);
    else if (was === 'dup-write' || was === 'dup-read') {
      // `>&2`, `<&-`: a descriptor. Anything else after `>&` is a file.
      const descriptor = (DIGITS.test(done.text) || done.text === '-') && !done.dynamic && !done.glob && !done.quoted;
      if (!descriptor) (was === 'dup-write' ? command.writes : command.reads).push(done);
    } else if (was === 'heredoc' || was === 'heredoc-tabs') heredocs.push({ delimiter: done.text, quoted: done.quoted, tabs: was === 'heredoc-tabs' });
    else if (was === 'data') return;
    else {
      const assigned = command.words.length === 0 && plainStart ? ASSIGNMENT.exec(done.text) : null;
      // `NAME=` itself must be written out, not come from an expansion.
      if (assigned !== null && done.prefix.length >= assigned[0].length) command.assignments.push(done);
      else command.words.push(done);
    }
  };
  const endCommand = (): void => {
    endWord();
    // A redirection or a here-document with nothing after it: not a command line smurg reads.
    if (pending !== null) unparsed = true;
    pending = null;
    if (command.words.length > 0 || command.assignments.length > 0 || command.writes.length > 0 || command.reads.length > 0) commands.push(command);
    command = { words: [], assignments: [], writes: [], reads: [] };
  };
  /** A substitution whose inside starts at `from`: its commands are read, and the index of its `)` is returned. */
  const substitution = (from: number): number => {
    if (depth >= SCAN_DEPTH_MAX) {
      unparsed = true;
      return text.length - 1;
    }
    const scan = scanFrom(text, from, options, depth + 1, true);
    if (scan.unparsed || scan.end >= text.length) unparsed = true;
    commands.push(...scan.commands);
    word.unknown('dynamic', UNKNOWN_PART);
    return Math.min(scan.end, text.length - 1);
  };
  /** `$…` at `i` (the `$`): appends what it stands for and returns the index of its last character. */
  const dollar = (i: number, quoted: boolean): number => {
    const next = text[i + 1];
    if (next === '(') {
      if (text[i + 2] === '(') {
        const end = text.indexOf('))', i + 3);
        if (end === -1) {
          unparsed = true;
          return text.length - 1;
        }
        word.unknown('dynamic', UNKNOWN_PART);
        return end + 1;
      }
      return substitution(i + 2);
    }
    if (next === '{') {
      let level = 1;
      let end = i + 2;
      for (; end < text.length; end++) {
        const char = text[end] as string;
        if (char === '\\') end += 1;
        else if (char === '{') level += 1;
        else if (char === '}' && --level === 0) break;
      }
      if (end >= text.length) {
        unparsed = true;
        return text.length - 1;
      }
      const inside = text.slice(i + 2, end);
      const name = NAME.exec(inside)?.[0];
      const rest = name === undefined ? inside : inside.slice(name.length);
      const value = name === undefined ? undefined : options.variables?.[name];
      // The variable itself, or a form that keeps a set variable's value (`:-`, `-`, `:=`, `=`, `:?`, `?`).
      if (value !== undefined && (rest === '' || /^:?[-=?]/.test(rest))) word.literal(value, quoted);
      else {
        // A substitution inside the braces would run: smurg does not read it there.
        if (inside.includes('$(') || inside.includes('`')) unparsed = true;
        word.unknown('dynamic', UNKNOWN_PART);
      }
      return end;
    }
    const name = NAME.exec(text.slice(i + 1, i + 257))?.[0];
    if (name !== undefined) {
      const value = options.variables?.[name];
      if (value !== undefined) word.literal(value, quoted);
      else word.unknown('dynamic', UNKNOWN_PART);
      return i + name.length;
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      word.unknown('dynamic', UNKNOWN_PART);
      return i + 1;
    }
    if (!quoted && (next === "'" || next === '"')) {
      // `$'…'` and `$"…"`: escapes and translations smurg does not read; the quoted part follows as a quoted part.
      word.unknown('dynamic', UNKNOWN_PART);
      return i;
    }
    word.literal('$', quoted);
    return i;
  };
  const backtick = (i: number): number => {
    let end = i + 1;
    while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length || depth >= SCAN_DEPTH_MAX) {
      unparsed = true;
      return text.length - 1;
    }
    const scan = scanFrom(text.slice(i + 1, end).replace(/\\([`\\$])/g, '$1'), 0, options, depth + 1, false);
    if (scan.unparsed) unparsed = true;
    commands.push(...scan.commands);
    word.unknown('dynamic', UNKNOWN_PART);
    return end;
  };
  /** After a line break: the bodies of the here-documents opened on that line. Returns where reading goes on. */
  const skipHeredocs = (from: number): number => {
    let at = from;
    for (const doc of heredocs.splice(0)) {
      const bodyStart = at;
      let found = false;
      while (at < text.length) {
        const lineEnd = text.indexOf('\n', at);
        const line = text.slice(at, lineEnd === -1 ? text.length : lineEnd);
        at = lineEnd === -1 ? text.length : lineEnd + 1;
        if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) {
          found = true;
          break;
        }
      }
      // An unquoted delimiter: the body is expanded like a double-quoted string, so a substitution in it runs.
      const body = text.slice(bodyStart, at);
      if (!doc.quoted && (body.includes('$(') || body.includes('`'))) unparsed = true;
      // No end line: the shell takes the rest of the text as the body.
      if (!found) at = text.length;
    }
    return at;
  };

  let i = start;
  for (; i < text.length; i++) {
    const char = text[i] as string;
    if (char === '\\') {
      if (i + 1 >= text.length) word.literal('\\', true);
      else if (text[i + 1] === '\n') i += 1;
      else word.literal(text[++i] as string, true);
    } else if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) {
        unparsed = true;
        word.literal(text.slice(i + 1), true);
        i = text.length;
        break;
      }
      word.literal(text.slice(i + 1, end), true);
      i = end;
    } else if (char === '"') {
      word.literal('', true);
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        const within = text[j] as string;
        if (within === '\\' && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1] as string)) {
          j += 1;
          if (text[j] !== '\n') word.literal(text[j] as string, true);
        } else if (within === '$') j = dollar(j, true);
        else if (within === '`') j = backtick(j);
        else word.literal(within, true);
      }
      if (j >= text.length) {
        unparsed = true;
        i = text.length;
        break;
      }
      i = j;
    } else if (char === '$') i = dollar(i, false);
    else if (char === '`') i = backtick(i);
    else if (char === '\n') {
      endCommand();
      if (heredocs.length > 0) i = skipHeredocs(i + 1) - 1;
    } else if (char === ' ' || char === '\t' || char === '\r') endWord();
    else if (char === '#' && !word.started) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end - 1;
    } else if (char === ';') endCommand();
    else if (char === '(') {
      endCommand();
      parens += 1;
    } else if (char === ')') {
      endCommand();
      if (parens === 0 && inner) break;
      if (parens > 0) parens -= 1;
    } else if (char === '|') {
      endCommand();
      if (text[i + 1] === '|' || text[i + 1] === '&') i += 1;
    } else if (char === '&') {
      if (text[i + 1] === '>') {
        // `&>file`, `&>>file`: both streams into a file.
        endWord();
        i += text[i + 2] === '>' ? 2 : 1;
        pending = 'write';
      } else {
        endCommand();
        if (text[i + 1] === '&') i += 1;
      }
    } else if (char === '>' || char === '<') {
      // A number written right before it is the descriptor, not a word.
      if (word.started && DIGITS.test(word.text) && !word.quoted && !word.dynamic && !word.glob) word = new WordBuilder();
      else endWord();
      if (pending !== null) unparsed = true;
      if (text[i + 1] === '(') {
        // `<( … )`, `>( … )`: a command whose output or input stands as a file.
        i = substitution(i + 2);
      } else if (char === '>') {
        if (text[i + 1] === '>' || text[i + 1] === '|') {
          i += 1;
          pending = 'write';
        } else if (text[i + 1] === '&') {
          i += 1;
          pending = 'dup-write';
        } else pending = 'write';
      } else if (text[i + 1] === '<') {
        if (text[i + 2] === '<') {
          i += 2;
          pending = 'data';
        } else if (text[i + 2] === '-') {
          i += 2;
          pending = 'heredoc-tabs';
        } else {
          i += 1;
          pending = 'heredoc';
        }
      } else if (text[i + 1] === '>') {
        i += 1;
        pending = 'write';
      } else if (text[i + 1] === '&') {
        i += 1;
        pending = 'dup-read';
      } else pending = 'read';
    } else if (char === '[' && !word.started && (i + 1 >= text.length || BREAK.test(text[i + 1] as string))) {
      // `[ -f x ]`: the test command, not a character class.
      word.literal('[', false);
    } else if (char === '[' && !word.started && text[i + 1] === '[' && (i + 2 >= text.length || BREAK.test(text[i + 2] as string))) {
      word.literal('[[', false);
      i += 1;
    } else if (char === '*' || char === '?' || char === '[') word.unknown('glob', char);
    else if ((char === '{' || char === '}') && (word.started || (i + 1 < text.length && !BREAK.test(text[i + 1] as string)))) {
      // Part of a word (`a{b,c}`, `{a,b}`): a brace list. Alone it is the shell's own word.
      word.unknown('glob', char);
    } else if (char === '~' && !word.started) {
      const after = text[i + 1];
      if (options.home !== undefined && (after === undefined || after === '/' || BREAK.test(after))) word.literal(options.home, false);
      else word.unknown('glob', char);
    } else word.literal(char, false);
  }
  endCommand();
  // A `case` inside a substitution: its patterns end with `)`, which this reader would take for the substitution's end.
  if (inner && commands.some((entry) => entry.words.some((part) => part.text === 'case' && !part.quoted))) unparsed = true;
  return { commands, unparsed, end: i };
}

/** Reads `text` as a shell would split it. Never throws. */
export function scanShell(text: string, options: ScanOptions = {}): ShellScan {
  if (text.length > SCAN_TEXT_MAX_CHARS) return { commands: [], unparsed: true };
  const scan = scanFrom(text, 0, options, 0, false);
  return { commands: scan.commands, unparsed: scan.unparsed };
}

/** Words the shell itself reads in front of a command (`then rm x`, `! cmd`, `time cmd`): not the program. */
const RESERVED_PREFIX: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', '{', '}', 'fi', 'done', 'esac']);

/** The command's words from its program on: reserved words in front are dropped (`then rm x` is `rm x`). */
export function programWords(command: SimpleCommand): readonly ShellWord[] {
  let start = 0;
  while (start < command.words.length) {
    const word = command.words[start] as ShellWord;
    if (word.quoted || word.dynamic || word.glob || !RESERVED_PREFIX.has(word.text)) break;
    start += 1;
  }
  return command.words.slice(start);
}

/** The last path segment of a program word (`/bin/rm` is `rm`); empty when the word is not known whole. */
export function programName(word: ShellWord | undefined): string {
  if (word === undefined || word.dynamic || word.glob) return '';
  return word.text.slice(word.text.lastIndexOf('/') + 1);
}

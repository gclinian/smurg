// THE TOOL GATE'S LOOK AT A SHELL COMMAND, PURE (ARCHITECTURE §7.7 row G10; DESIGN §2.9). While a root's Claude
// Code project settings are in use, the scripts their commands name run as the host at the next hook event. An
// agent's edit tools never write them (row G3). A shell command can: Claude Code runs a small set of file commands
// by itself in `acceptEdits` (mkdir, touch, rm, rmdir, mv, cp, sed) and whatever a rule allows, and none of those
// has to SPELL the script to replace it (`cp x/lint.sh scripts/`, `mv scripts old; mv new scripts`).
//
// So, in a root that has such scripts, every Bash command is read here before it runs, and a PERSON is asked (the
// hook answers "ask", which Claude Code puts above its mode and above every allow rule) unless the command stays
// away from them:
//
//   - a file the SHELL writes (`> f`, `>> f`, `&> f`) and every operand of a command that changes files
//     (FILE_COMMANDS) is a place the command writes: `writes` when it is a recorded script, lies below one, or is a
//     folder above one (the folder's content is the script);
//   - such a place that is not known (a variable, a substitution), a change of directory that is not known, a line
//     this reader cannot follow: `unsure`;
//   - any other program is Claude Code's own to ask about (it asks unless a person's rule allows it). Here it is
//     only looked at for what it names: a recorded script or a folder above one as a word of its own or as the
//     value glued to an option (`sh scripts/lint.sh`, `curl -o scripts/lint.sh …`, `git diff --output=scripts/lint.sh`,
//     `sort -oscripts/lint.sh`), for an interpreter also inside its quoted argument
//     (`node -e "…"`), and a command line handed to another shell (`sh -c "…"`) is read like the line itself: `unsure`;
//     two programs are known to change files without naming them: `find … -delete / -exec` (the folders it searches
//     are written) and git's commands that take the working tree from elsewhere (`checkout`, `restore`, `reset`,
//     `stash`, `merge`, `pull`, `apply`, `clean`, …: `unsure`);
//   - programs that only read (cat, grep, ls, …) may name anything: reading a script is not what this is about.
//
// What this cannot see: what a program does that names nothing (`npm run build`, a script of the project that
// rewrites another). Such a program asks through Claude Code unless a person allowed its kind; the trust gate's
// watch notices the changed script afterwards, parks the root's sessions and asks the host again.
//
// The paths are judged as the FILE SYSTEM has them: `bashPlaces` gives the places a command names as absolute paths,
// the caller resolves links (hook-events.ts), and `judgePlaces` decides.
import { posix } from 'node:path';
import { foldRelPath, isRelPathWithin, relPathSegments } from '@smurg/protocol';
import { UNKNOWN_PART, programName, programWords, scanShell, type ShellWord, type SimpleCommand } from '../core/shell-scan.ts';

/** What the gate says about one shell command. */
export type BashVerdict = 'clear' | 'writes' | 'unsure';

/**
 * Programs whose operands are files they create, replace, move or remove. The first seven are the ones Claude Code
 * runs without asking in `acceptEdits`; the others ask there, but a person's allow rule can let them run.
 */
export const FILE_COMMANDS: ReadonlySet<string> = new Set([
  ...['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed'],
  ...['ln', 'link', 'unlink', 'tee', 'dd', 'install', 'rsync', 'truncate', 'chmod', 'chown', 'chgrp', 'patch', 'tar', 'unzip', 'gunzip', 'gzip', 'ditto', 'shred'],
]);

/** Programs that only read what their operands name and have no option that writes a file. */
export const READ_COMMANDS: ReadonlySet<string> = new Set([
  ...['cat', 'ls', 'echo', 'printf', 'pwd', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'diff', 'cmp', 'stat', 'which', 'type', 'true', 'false', 'test', '['],
  ...['basename', 'dirname', 'date', 'whoami', 'id', 'uname', 'du', 'df', 'sleep', 'readlink', 'realpath', 'sha256sum', 'shasum', 'md5', 'md5sum', 'cut', 'tr', 'nl', 'rev', 'jq', ':'],
]);

/** Shells, and the words that hand a text to one: a quoted operand with a blank in it is a command line. */
const SHELL_COMMANDS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'source', '.', 'exec', 'watch', 'su']);
/** Programs that run what a quoted operand says in a language of their own: the paths written in it are looked at. */
const INTERPRETERS: ReadonlySet<string> = new Set(['node', 'deno', 'bun', 'python', 'python2', 'python3', 'ruby', 'perl', 'php', 'lua', 'osascript', 'awk', 'gawk', 'make', 'ssh', 'env', 'xargs', 'find', 'parallel', 'sudo', 'doas', 'nice', 'nohup', 'timeout', 'command', 'builtin', 'script']);
/** Programs whose file operands come from somewhere else (their input, a search): never known here. */
const OPERANDS_ELSEWHERE: ReadonlySet<string> = new Set(['xargs', 'find', 'parallel']);
const CD_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'chdir']);
/** `find` actions that change files or run a command on what was found: the folders it searches are written. */
const FIND_WRITES: ReadonlySet<string> = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
/**
 * git commands that rewrite files of the working tree from somewhere else (another commit, a stash, a patch):
 * which files, no word of the command has to say.
 */
const GIT_REWRITES: ReadonlySet<string> = new Set(['checkout', 'switch', 'restore', 'reset', 'stash', 'merge', 'rebase', 'pull', 'cherry-pick', 'revert', 'apply', 'am', 'clean', 'read-tree', 'checkout-index', 'worktree', 'submodule', 'bisect']);

/** One place a command names. `write`: the command itself changes what is there. */
export interface BashPlace {
  /** Absolute, with `.` and `..` taken out; links are not resolved yet. */
  readonly path: string;
  readonly kind: 'write' | 'mention';
  /**
   * A wildcard followed `path` (a folder): what is meant is whatever below it matches. `next`: the pattern of the
   * first name below the folder, as a regular expression source; null when any name may match.
   */
  readonly open?: { readonly next: string | null };
}

export interface BashReading {
  /** The line cannot be followed far enough to say what it changes. */
  readonly unsure: boolean;
  readonly places: readonly BashPlace[];
}

/** Places of one command that are looked at, and directories a line may be in; a command with more is `unsure`. */
export const BASH_PLACES_MAX = 256;
const BASH_DIRS_MAX = 8;

const LOOSE_SPLIT = /[\s;&|()<>=,`'"]+/;

/**
 * Where the value starts that a word carries glued to its name: `--output=x` and `of=x` after the `=`, `-ox` after
 * the letter. 0 when the word carries none. A program that is no file command still names a place this way.
 */
function gluedValueAt(text: string): number {
  if (text.startsWith('--')) return text.indexOf('=') + 1;
  if (text.startsWith('-')) return text.length > 2 ? 2 : 0;
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(text) ? text.indexOf('=') + 1 : 0;
}

/** The pattern of one path name with wildcards, as a regular expression source; null when smurg does not read it. */
function namePattern(name: string): string | null {
  if (name === '' || /[{}~]/.test(name) || name.includes(UNKNOWN_PART) || name.includes('**')) return null;
  let source = '';
  for (let i = 0; i < name.length; i++) {
    const char = name[i] as string;
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else if (char === '[') {
      const end = name.indexOf(']', i + 2);
      if (end === -1) return null;
      source += '.';
      i = end;
    } else source += char.replace(/[\\^$.|+()]/g, '\\$&');
  }
  return `^${source}$`;
}

/**
 * PURE: the places a shell command names, from `cwd` (absolute; where Claude Code says the command starts). `home`:
 * what `~` stands for. A `cd` to a written path is followed (the line may then be in either directory: both are
 * looked at); any other change of directory makes what is written by a relative name `unsure`.
 */
export function bashPlaces(command: string, cwd: string, home?: string): BashReading {
  const scan = scanShell(command, home === undefined ? {} : { home });
  let unsure = scan.unparsed;
  let dirs: string[] = [posix.resolve(cwd)];
  /** A directory change that was not followed: where relative names lead is not known any more. */
  let lost = false;
  const places: BashPlace[] = [];
  const add = (named: string, kind: 'write' | 'mention', open?: BashPlace['open']): void => {
    if (named.startsWith('/')) places.push({ path: posix.resolve(named), kind, ...(open === undefined ? {} : { open }) });
    else {
      if (lost && kind === 'write') unsure = true;
      for (const dir of dirs) places.push({ path: posix.resolve(dir, named), kind, ...(open === undefined ? {} : { open }) });
    }
  };
  const place = (word: ShellWord, kind: 'write' | 'mention'): void => {
    if (word.dynamic) {
      // What a variable or a substitution holds is not known: for a place that is written, that can be anywhere.
      if (kind === 'write') unsure = true;
      return;
    }
    if (!word.glob) {
      if (word.text !== '') add(word.text, kind);
      return;
    }
    if (word.text === '{}') {
      // The placeholder of `find -exec` and `xargs -I{}`: a name that comes from somewhere else.
      if (kind === 'write') unsure = true;
      return;
    }
    // A wildcard: the folder written before it, and the pattern of the first name below that folder.
    const folder = word.prefix.slice(0, word.prefix.lastIndexOf('/') + 1);
    const name = word.text.slice(folder.length).split('/')[0] ?? '';
    add(folder === '' ? '.' : folder, kind, { next: namePattern(name) });
  };
  const looseMentions = (word: ShellWord): void => {
    for (const piece of word.text.split(LOOSE_SPLIT)) {
      if (piece === '' || piece.includes(UNKNOWN_PART)) continue;
      // `-oscripts/lint.sh` inside the text: the part after the letter is the place.
      const named = piece.startsWith('-') ? piece.slice(gluedValueAt(piece) || piece.length) : piece;
      if (named !== '') add(named, 'mention');
    }
  };
  const one = (command: SimpleCommand): void => {
    for (const target of command.writes) place(target, 'write');
    const words = programWords(command);
    if (words.length === 0) return;
    const program = programName(words[0]);
    const rest = words.slice(1);
    if (program === '') {
      // The program itself is a variable or a wildcard: nobody knows what runs.
      unsure = true;
      return;
    }
    if (CD_COMMANDS.has(program)) {
      const operands = rest.filter((word) => word.dynamic || word.glob || !word.text.startsWith('-') || word.text === '-');
      const target = operands[0];
      if (program === 'cd' && operands.length === 1 && target !== undefined && !target.dynamic && !target.glob && target.text !== '-') {
        // Either directory from here on: a `cd` in a subshell, or one that failed, leaves the line where it was.
        const next = new Set([...dirs, ...dirs.map((dir) => posix.resolve(dir, target.text))]);
        if (next.size > BASH_DIRS_MAX) lost = true;
        else dirs = [...next];
      } else lost = true;
      return;
    }
    // The program named by a path of its own (`./scripts/lint.sh`): it runs that file.
    if ((words[0] as ShellWord).text.includes('/')) place(words[0] as ShellWord, 'mention');
    if (READ_COMMANDS.has(program)) return;
    if (program === 'find' && rest.some((word) => !word.dynamic && !word.glob && FIND_WRITES.has(word.text))) {
      // `find <folders> … -delete` / `-exec …`: everything below the folders it searches (none written: the current one).
      const expression = rest.findIndex((word) => !word.dynamic && !word.glob && /^[-(!]/.test(word.text));
      const roots = rest.slice(0, expression === -1 ? rest.length : expression);
      if (roots.length === 0) add('.', 'write', { next: null });
      for (const root of roots) {
        if (root.dynamic) unsure = true;
        else add(root.glob ? root.prefix.slice(0, root.prefix.lastIndexOf('/') + 1) || '.' : root.text, 'write', { next: null });
      }
      return;
    }
    // git taking files of the working tree from another commit, a stash or a patch: it need not name them.
    if (program === 'git' && rest.some((word) => !word.dynamic && !word.glob && !word.quoted && GIT_REWRITES.has(word.text))) unsure = true;
    // A file command anywhere in the words is one (`env cp a b`, `sudo rm x`, `git mv a b`, `find . -exec mv {} x ;`).
    const changesFiles = words.some((word) => !word.dynamic && !word.glob && FILE_COMMANDS.has(programName(word)));
    if (changesFiles) {
      if (OPERANDS_ELSEWHERE.has(program)) unsure = true;
      for (const word of rest) {
        if (word.dynamic || word.glob || !word.text.startsWith('-')) {
          // `of=scripts/lint.sh`: the part after the `=` is the place.
          const at = !word.dynamic && !word.glob && /^[A-Za-z_]+=/.test(word.text) ? word.text.indexOf('=') + 1 : 0;
          place(at === 0 ? word : { ...word, text: word.text.slice(at), prefix: word.prefix.slice(at) }, 'write');
          continue;
        }
        // An option that carries its value: `--target-directory=scripts`, `-tscripts`.
        const value = word.text.startsWith('--') ? (word.text.includes('=') ? word.text.slice(word.text.indexOf('=') + 1) : '') : word.text.slice(2);
        if (value !== '') add(value, 'write');
      }
      return;
    }
    const shell = words.some((word) => !word.dynamic && !word.glob && SHELL_COMMANDS.has(programName(word)));
    const interpreter = shell || INTERPRETERS.has(program);
    for (const word of rest) {
      if (word.dynamic) {
        // A text nobody knows, handed to a shell: it can be any command.
        if (shell) unsure = true;
        continue;
      }
      if (word.glob || !word.quoted || !interpreter) {
        place(word, 'mention');
        // `--output=scripts/lint.sh`, `-Oscripts/lint.sh`: the value glued to an option is a place the program names.
        const at = gluedValueAt(word.text);
        if (at > 0 && at < word.text.length) place({ ...word, text: word.text.slice(at), prefix: word.prefix.slice(at) }, 'mention');
        continue;
      }
      if (shell && /\s/.test(word.text)) {
        // A command line for another shell: read like this one, from every directory this line may be in.
        for (const dir of dirs) {
          const inner = bashPlaces(word.text, dir, home);
          if (inner.unsure) unsure = true;
          places.push(...inner.places);
        }
      }
      looseMentions(word);
    }
  };
  for (const entry of scan.commands) {
    one(entry);
    if (places.length > BASH_PLACES_MAX) return { unsure: true, places: [] };
  }
  return { unsure, places };
}

/** A place as the file system has it: inside the session's root (`rel`, root-relative, `''` the root itself), or not (null). */
export interface ResolvedPlace {
  readonly rel: string | null;
  readonly kind: 'write' | 'mention';
  readonly open?: BashPlace['open'];
}

function matches(pattern: string, name: string): boolean {
  try {
    return new RegExp(pattern, 'iu').test(name);
  } catch {
    return true;
  }
}

/** Whether `place` is at a recorded script, below one, or is (or, for a wildcard, can match) a folder above one. */
function reaches(place: ResolvedPlace & { readonly rel: string }, script: string): boolean {
  const at = foldRelPath(place.rel);
  if (isRelPathWithin(at, script)) return true;
  if (!isRelPathWithin(script, at)) return false;
  if (place.open === undefined || place.open.next === null) return true;
  // The first name of the script's path below the folder: the wildcard has to match it.
  const below = relPathSegments(script)[relPathSegments(at).length];
  return below === undefined || matches(place.open.next, below);
}

/**
 * PURE: the verdict for the places of one command against the root's recorded scripts (root-relative paths).
 *  - a WRITE at a script, below one, or at a folder above one (the root included): `writes`;
 *  - a MENTION of a script, of something below one, or of a folder above one other than the root: `unsure`.
 */
export function judgePlaces(reading: { readonly unsure: boolean; readonly places: readonly ResolvedPlace[] }, recorded: ReadonlySet<string>): BashVerdict {
  const scripts = [...recorded].map(foldRelPath);
  let verdict: BashVerdict = reading.unsure ? 'unsure' : 'clear';
  for (const place of reading.places) {
    const rel = place.rel;
    if (rel === null) continue;
    if (!scripts.some((script) => reaches({ ...place, rel }, script))) continue;
    if (place.kind === 'write') return 'writes';
    if (rel !== '' || place.open !== undefined) verdict = 'unsure';
  }
  return verdict;
}

// Row G10 of the tool gate, PURE (hooks/bash-guard.ts with core/shell-scan.ts): which shell commands of an agent
// make smurg ask a person, in a root whose Claude Code project settings run scripts (review R3-03). The class it
// closes: no command an agent session runs BY ITSELF (Claude Code's `acceptEdits` file commands, a redirection, a
// command a rule allows) replaces what a confirmed hook runs. What it must not do: ask about the ordinary commands
// of a work item that stay away from those scripts.
//
// The file system side (links, another spelling of the root) is hook-server.test.ts and the real-Claude suite.
import { describe, expect, it } from 'vitest';
import { programName, programWords, scanShell, UNKNOWN_PART } from '../../src/core/shell-scan.ts';
import { bashPlaces, judgePlaces, type BashVerdict } from '../../src/hooks/bash-guard.ts';

const ROOT = '/work/item';
const HOME = '/home/host';

/** The verdict with every place taken as written (no links): inside ROOT or not. */
function verdict(command: string, recorded: readonly string[] = ['scripts/lint.sh'], cwd = ROOT): BashVerdict {
  const reading = bashPlaces(command, cwd, HOME);
  const places = reading.places.map((place) => {
    const inside = place.path === ROOT || place.path.startsWith(`${ROOT}/`);
    return { rel: inside ? place.path.slice(ROOT.length + 1) : null, kind: place.kind, ...(place.open === undefined ? {} : { open: place.open }) };
  });
  return judgePlaces({ unsure: reading.unsure, places }, new Set(recorded));
}

describe('the shell reader', () => {
  const words = (text: string): string[][] => scanShell(text, { home: HOME }).commands.map((command) => command.words.map((word) => word.text));

  it('splits as a shell does: quotes group, a backslash keeps the next character, operators separate commands', () => {
    expect(words("node 'tools/my script.js' && ./a.sh|tee out;(./b.sh)")).toEqual([['node', 'tools/my script.js'], ['./a.sh'], ['tee', 'out'], ['./b.sh']]);
    expect(words('./my\\ file.sh "a \\"b\\" c"')).toEqual([['./my file.sh', 'a "b" c']]);
    expect(words('echo one # a comment ; rm x\necho two')).toEqual([['echo', 'one'], ['echo', 'two']]);
    expect(words('a \\\n b')).toEqual([['a', 'b']]);
    expect(words('')).toEqual([]);
  });

  it('knows a redirection from a word, a descriptor from a file, and what `NAME=value` in front of a command is', () => {
    const scan = scanShell('FOO=1 BAR="$X" cmd arg > out.txt 2>&1 < in.txt >> log 2> err &> all');
    expect(scan.unparsed).toBe(false);
    const command = scan.commands[0];
    expect(command?.words.map((word) => word.text)).toEqual(['cmd', 'arg']);
    expect(command?.assignments.map((word) => word.text)).toEqual(['FOO=1', `BAR=${UNKNOWN_PART}`]);
    expect(command?.writes.map((word) => word.text)).toEqual(['out.txt', 'log', 'err', 'all']);
    expect(command?.reads.map((word) => word.text)).toEqual(['in.txt']);
    expect(scanShell('echo x >&2; echo y >& file; exec 3<&-').commands.map((entry) => entry.writes.map((word) => word.text))).toEqual([[], ['file'], []]);
  });

  it('marks what nobody can follow: a variable, a substitution, a wildcard, a brace list, a tilde of another user; known names are values', () => {
    const scan = scanShell('cp $SRC "${DST}/x" a*.sh b{1,2} ~other/x ~/y "$CLAUDE_PROJECT_DIR"/z ${CLAUDE_PROJECT_DIR:-.}/w $(pwd)/v `pwd`/u', { variables: { CLAUDE_PROJECT_DIR: '/p' }, home: HOME });
    const first = scan.commands.find((command) => command.words[0]?.text === 'cp');
    expect(first?.words.map((word) => [word.text, word.dynamic, word.glob, word.prefix])).toEqual([
      ['cp', false, false, 'cp'],
      [UNKNOWN_PART, true, false, ''],
      [`${UNKNOWN_PART}/x`, true, false, ''],
      ['a*.sh', false, true, 'a'],
      ['b{1,2}', false, true, 'b'],
      ['~other/x', false, true, ''],
      [`${HOME}/y`, false, false, `${HOME}/y`],
      ['/p/z', false, false, '/p/z'],
      ['/p/w', false, false, '/p/w'],
      [`${UNKNOWN_PART}/v`, true, false, ''],
      [`${UNKNOWN_PART}/u`, true, false, ''],
    ]);
    // What a substitution runs is a command of the line too.
    expect(scan.commands.filter((command) => command.words[0]?.text === 'pwd')).toHaveLength(2);
  });

  it('reads a here-document as data, and the commit message of the usual `git commit -m "$(cat <<EOF …)"` with its quotes and brackets', () => {
    const commit = 'git commit -m "$(cat <<\'EOF\'\nFix it\'s bug (really) `x` $(y)\n\nCo-authored: a) b)\nEOF\n)" && git status';
    const scan = scanShell(commit);
    expect(scan.unparsed).toBe(false);
    expect(scan.commands.map((command) => command.words.map((word) => word.text))).toEqual([['cat'], ['git', 'commit', '-m', UNKNOWN_PART], ['git', 'status']]);
    // An unquoted delimiter: the body is expanded, so a substitution in it runs and the line is not followed.
    expect(scanShell('cat <<EOF\n$(rm -rf scripts)\nEOF').unparsed).toBe(true);
    expect(scanShell("cat > out.txt <<'EOF'\nrm -rf scripts\nEOF\necho done").commands.map((command) => command.words.map((word) => word.text))).toEqual([['cat'], ['echo', 'done']]);
  });

  it('says so when it cannot read the line: an open quote, a substitution that never closes, a `case` inside one', () => {
    for (const text of ['echo "open', "echo 'open", 'echo $(open', 'echo `open', 'echo ${open', 'x=$(case a in a) rm x;; esac)', 'cat <']) expect(scanShell(text).unparsed, text).toBe(true);
    expect(scanShell('case a in a) echo x;; esac').unparsed).toBe(false);
  });

  it('the program of a command is the first word that is not the shell\'s own', () => {
    const programs = (text: string): string[] => scanShell(text).commands.map((command) => programName(programWords(command)[0]));
    expect(programs('if test -f x; then /bin/rm x; else ! cp a b; fi')).toEqual(['test', 'rm', 'cp', '']);
    expect(programs('while true; do time mv a b; done')).toEqual(['true', 'mv', '']);
    expect(programs('$TOOL x; ./run*.sh')).toEqual(['', '']);
  });
});

describe('a shell command and the scripts the project settings run (tool gate G10)', () => {
  it('the routes onto a recorded script all ask: copy and move INTO its folder, the folder swap, a redirection, tee, sed -i, ln, a path with `..`, another case, after a cd', () => {
    for (const command of [
      'cp s3/lint.sh scripts/',
      'mv s3/lint.sh scripts/',
      'cp s3/lint.sh scripts/lint.sh',
      'mv scripts scripts.old',
      'mv s3 scripts',
      'cp -R s3/. scripts/',
      "printf '#!/bin/sh\\n' > scripts/lint.sh",
      "printf x >> scripts/lint.sh",
      'echo x &> scripts/lint.sh',
      'cat s3/lint.sh | tee scripts/lint.sh',
      "sed -i '' 's/exit 0/exit 1/' scripts/lint.sh",
      'ln -s scripts/lint.sh alias.sh',
      'ln -sf ../s3/lint.sh scripts/lint.sh',
      "printf x > ./scripts/../scripts/lint.sh",
      'printf x > SCRIPTS/LINT.SH',
      'cd scripts && printf x > lint.sh',
      'cd scripts; rm lint.sh',
      '(cd s3 && true); rm scripts/lint.sh',
      'rm -rf scripts',
      'rm scripts/lint.sh',
      'rmdir scripts',
      'mkdir -p scripts/lint.sh/x',
      'touch scripts/lint.sh',
      'chmod +x scripts/lint.sh',
      'dd if=s3/lint.sh of=scripts/lint.sh',
      'install -m 755 s3/lint.sh scripts/lint.sh',
      'cp --target-directory=scripts s3/lint.sh',
      'cp -tscripts s3/lint.sh',
      'rsync -a s3/ scripts/',
      'tar xf x.tar -C scripts',
      'env cp s3/lint.sh scripts/',
      'sudo mv s3 scripts',
      'git mv scripts tools',
      'git rm -r scripts',
      'rm -rf .',
      'cp -R s3/. .',
      `cp s3/lint.sh ${ROOT}/scripts/`,
      'if true; then cp s3/lint.sh scripts/; fi',
      'true && { mv s3/lint.sh scripts/; }',
      'sh -c "cp s3/lint.sh scripts/"',
      "bash -lc 'cd scripts && rm lint.sh'",
      'find . -name lint.sh -delete',
      'find scripts s3 -type f -exec rm {} +',
      'find -name "*.sh" -delete',
      'rm scr*/lint.sh',
      'rm -rf s*',
      'mv scripts/* /tmp/',
      'cp s3/lint.sh scripts/{lint,other}.sh',
    ]) expect(verdict(command), command).toBe('writes');
  });

  it('a place glued to an option of a program that is no file command is still a place it names: it asks', () => {
    const asks = [
      'git diff --output=scripts/lint.sh',
      'wget -Oscripts/lint.sh https://example.com/x',
      'sort -oscripts/lint.sh in.txt',
      'base64 --output=scripts/lint.sh in.b64',
      'curl --output=./scripts/../scripts/lint.sh https://example.com/x',
      'sort -oSCRIPTS/LINT.SH in.txt',
      'sort --output=scripts/*.sh in.txt',
      'curl --output-dir=scripts -O https://example.com/lint.sh',
      'node -e "require(\'fs\').writeFileSync(process.argv[1], 1)" -oscripts/lint.sh',
    ];
    for (const command of asks) expect(verdict(command), command).toBe('unsure');
    const passes = ['git diff --output=out/diff.txt', 'sort -oout.txt in.txt', 'pnpm test --reporter=dot', 'node --max-old-space-size=4096 build.js', 'git log -n5 --format=%H'];
    for (const command of passes) expect(verdict(command), command).toBe('clear');
  });

  it('what the gate cannot follow asks too: a variable or a substitution where a file command writes, a directory nobody knows, a line it cannot read, operands from elsewhere', () => {
    for (const command of [
      'cp s3/lint.sh "$DEST"',
      'X=scripts; mv s3 $X',
      'rm -rf $(cat list.txt)',
      'rm `cat list.txt`',
      'echo x > "$OUT"',
      'cd "$DIR" && rm lint.sh',
      'cd - && rm lint.sh',
      'pushd scripts && rm lint.sh',
      'cd && rm x',
      'find src -name "*.tmp" | xargs rm',
      '$TOOL s3 scripts',
      'echo "open',
      'eval "$CMD"',
      'sh -c "$CMD"',
      'bash "$SCRIPT"',
    ]) expect(verdict(command), command).toBe('unsure');
    // A script or its folder named to a program smurg knows nothing about, or run: a person looks.
    // git taking the working tree from another commit, a stash or a patch names no file at all.
    for (const command of ['git checkout HEAD~3 -- .', 'git reset --hard origin/main', 'git stash pop', 'git pull', 'git clean -fdx', 'git apply fix.patch', 'git -C . checkout other']) expect(verdict(command), command).toBe('unsure');
    for (const command of ['git checkout HEAD~1 -- scripts/lint.sh', 'git restore scripts', 'sh scripts/lint.sh', './scripts/lint.sh --fix', 'node -e "require(\'fs\').renameSync(\'scripts\', \'x\')"', 'python3 fix.py scripts/lint.sh', 'git add scr*']) expect(verdict(command), command).toBe('unsure');
  });

  it('the ordinary commands of a work item pass: files beside the script, other folders, reading the script, programs that name nothing of it', () => {
    for (const command of [
      'echo beside > scripts/other.txt',
      'touch scripts/other.txt',
      'cp README.md docs/README.md',
      'mkdir -p src/new && mv src/a.ts src/new/a.ts',
      'rm -rf dist node_modules/.cache',
      "sed -i '' 's/a/b/' src/app.ts",
      'rm -f *.log',
      'rm -rf dist/*',
      'cp src/*.ts out/',
      'cat scripts/lint.sh',
      'grep -rn exit scripts',
      'ls -la scripts . ..',
      'diff scripts/lint.sh s3/lint.sh',
      'head -3 scripts/lint.sh | wc -l',
      'npm test',
      'pnpm install',
      'make install',
      'git add . && git commit -m "scripts: fix (the) thing"',
      'git commit -m "$(cat <<\'EOF\'\nMove scripts/lint.sh checks (again)\nEOF\n)"',
      'git status && git diff',
      'git log --oneline -5 && git show HEAD --stat',
      'git commit -m "merge the checkout fix"',
      'find src -name "*.ts"',
      'find s3 -name "*.tmp" -delete',
      'find src -name "*.tmp" -exec rm {} \\;',
      'cd src && npm test',
      'cd src && rm a.ts',
      'echo "$HOME" && npm run build -- "$FLAG"',
      'for f in src/a.ts src/b.ts; do echo "$f"; done',
      'npm test > /dev/null 2>&1',
      'npm test > /tmp/out.txt',
      'rm /tmp/scripts/lint.sh',
      'cp ~/notes.txt docs/',
      'curl -s https://example.com/scripts/lint.sh',
    ]) expect(verdict(command), command).toBe('clear');
  });

  it('a path that is named and not there yet is guarded the same way, and so is whatever lies below a recorded path', () => {
    const recorded = ['dist/hooks/check.js', 'tool.sh'];
    for (const command of ['mkdir -p dist/hooks', 'cp x.js dist/hooks/check.js', 'echo x > dist/hooks/check.js', 'mv build dist', 'mkdir -p dist/hooks/check.js', 'cp x dist/hooks/check.js/index.js', 'touch tool.sh', 'rm *.sh']) expect(verdict(command, recorded), command).toBe('writes');
    for (const command of ['mkdir -p src/hooks', 'rm *.log', 'touch tool.txt', 'echo x > dist2/a.js']) expect(verdict(command, recorded), command).toBe('clear');
  });

  it('a script whose own name has a blank, brackets or a wildcard is guarded like any other: written as a name it is that name, written as a pattern it is whatever it can match', () => {
    const recorded = ['scripts/odd (copy).sh', 'scripts/a[1]*.sh'];
    for (const command of ['rm "scripts/odd (copy).sh"', 'rm scripts/odd\\ \\(copy\\).sh', "cp x 'scripts/a[1]*.sh'", 'rm scripts/a*', 'rm scripts/odd*', 'mv scripts old']) expect(verdict(command, recorded), command).toBe('writes');
    for (const command of ['rm "scripts/odd.sh"', 'rm scripts/b*', 'touch "scripts/a[1].txt"']) expect(verdict(command, recorded), command).toBe('clear');
  });

  it('where a relative name leads follows the directory Claude Code reports, and a cd that is written', () => {
    expect(verdict('rm lint.sh', ['scripts/lint.sh'], `${ROOT}/scripts`)).toBe('writes');
    expect(verdict('rm ../scripts/lint.sh', ['scripts/lint.sh'], `${ROOT}/src`)).toBe('writes');
    expect(verdict('rm lint.sh', ['scripts/lint.sh'], `${ROOT}/src`)).toBe('clear');
    expect(verdict('cd ../scripts && rm lint.sh', ['scripts/lint.sh'], `${ROOT}/src`)).toBe('writes');
    // From outside the root altogether.
    expect(verdict(`cp x ${ROOT}/scripts/lint.sh`, ['scripts/lint.sh'], '/tmp')).toBe('writes');
    expect(verdict('cp x scripts/lint.sh', ['scripts/lint.sh'], '/tmp')).toBe('clear');
  });

  it('a command with more places than the gate looks at is not followed', () => {
    const many = `touch ${Array.from({ length: 300 }, (_, index) => `f${index}`).join(' ')}`;
    expect(bashPlaces(many, ROOT)).toEqual({ unsure: true, places: [] });
  });
});

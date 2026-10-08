# What published versions of smurg wrote

Every folder here holds the files one **published** smurg left on a host's computer, written by the real code of that
version. They exist for one rule (docs/ARCHITECTURE.md): everything a published smurg wrote is read by every later
version. A test copies a fixture, lets the current code open it, and fails when something a real installation holds is
refused, reset or lost.

    0.4.0/    written by the published 0.4.0 executable
    0.5.0/    written by the code of tag v0.5.0

Nothing here is edited by hand, with the exceptions each README names (the paths and the name of the machine a fixture
was made on are replaced by placeholders). Every key in these folders was made for the fixture and protects nothing.

## What a fixture holds

    README.md        how it was made, what it holds, its instants, the ids a test needs
    files.json       every folder and file of each variant: mode, size, SHA-256, where the placeholder is
    coverage.json    which schema of that version each file is an instance of, and what of it the files visit
    ledger.json      what the people of the story held: invite links (with their secrets), session and topic ids
    stopped/         the disk after `smurg stop`
    running/         the disk while the host's smurg was running: only the files that differ from `stopped/`

Inside a variant:

    host/            the host's `~/.smurg` (SMURG_HOME): credentials.json, workspaces.json, logs/, run/, sessions/,
                     workspaces/<workspace id>/ (the workspace folder: state documents, the daemon's key, the logs,
                     conflicts/, uploads/, transcripts/, git-home/, git-staging/, git-template/)
    cli-member/      the `~/.smurg` of a member who uses the command: credentials.json, workspaces.json, device.key, pins/
    devices/<name>/  device.key and pins/ of the members who joined with the client library (a browser keeps the
                     same two things in IndexedDB; here they are files in the command's format)

The shared folder itself (a git repository with the worktrees smurg made in it) is **not** part of a fixture: the
state names it by an absolute path, and a worktree records the absolute path of the repository it came from. A test
that starts a whole daemon on a copy gets an empty folder there; what the worktree and topic modules do then (they
drop the records whose folders are gone) is not what an upgrade on a real computer meets. The tests of the stored
documents, of admission and of refusals need no project.

## The copy step

A fixture is never opened where it lies. Git keeps no file modes (smurg refuses a state file or folder that others
can read), no empty folders and no holes in files, and the files must not hold a path of the machine they were made
on. `files.json` has what is missing; this is the whole copy step:

```ts
import { chmodSync, closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface FixtureFile { path: string; mode: string; size: number; sha256: string; placeholder?: true; prefixOf?: string; pieces?: { offset: number; length: number; file: string }[] }
interface FixtureVariant { at: number; overlayOf?: string; absent?: string[]; dirs: { path: string; mode: string }[]; files: FixtureFile[] }
interface FixtureManifest { version: string; placeholder: string; variants: Record<string, FixtureVariant> }

/** Copies one variant of `<…>/fixtures/published/<version>` into the empty folder `to`. */
export function copyPublishedFixture(fixtureDir: string, variantName: 'stopped' | 'running', to: string) {
  const manifest = JSON.parse(readFileSync(join(fixtureDir, 'files.json'), 'utf8')) as FixtureManifest;
  const variant = manifest.variants[variantName];
  if (variant === undefined) throw new Error(`the fixture has no variant ${variantName}`);
  mkdirSync(to, { recursive: true, mode: 0o700 });
  chmodSync(to, 0o700);
  const root = realpathSync(to);
  // The files of the variant: its own, and (an overlay) those of the variant below that it neither replaces nor leaves out.
  const files = new Map<string, FixtureFile & { layer: string }>();
  if (variant.overlayOf !== undefined) {
    const gone = new Set(variant.absent ?? []);
    for (const file of manifest.variants[variant.overlayOf]!.files) if (!gone.has(file.path)) files.set(file.path, { ...file, layer: variant.overlayOf });
  }
  for (const file of variant.files) files.set(file.path, { ...file, layer: variantName });

  // Every folder, the empty ones too, 0700; `project` is where the state says the shared folder is (empty here).
  for (const dir of [...variant.dirs, { path: 'project', mode: '0700' }]) {
    mkdirSync(join(root, dir.path), { recursive: true });
    chmodSync(join(root, dir.path), Number.parseInt(dir.mode, 8));
  }
  for (const file of files.values()) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const mode = Number.parseInt(file.mode, 8);
    if (file.pieces !== undefined) {
      // An upload's part: its size, zeros, and the bytes that arrived at their offsets.
      const fd = openSync(target, 'wx', mode);
      try {
        ftruncateSync(fd, file.size);
        for (const piece of file.pieces) writeSync(fd, readFileSync(join(fixtureDir, file.layer, piece.file)), 0, piece.length, piece.offset);
      } finally {
        closeSync(fd);
      }
    } else {
      // `prefixOf`: this file is the first `size` bytes of the same file of that variant (an append-only log, earlier).
      let bytes = file.prefixOf !== undefined ? readFileSync(join(fixtureDir, file.prefixOf, file.path)).subarray(0, file.size) : readFileSync(join(fixtureDir, file.layer, file.path));
      // latin1 keeps every byte as it is; the placeholder and a temporary folder's path are plain ASCII.
      if (file.placeholder === true) bytes = Buffer.from(bytes.toString('latin1').split(manifest.placeholder).join(root), 'latin1');
      writeFileSync(target, bytes, { mode, flag: 'wx' });
    }
    chmodSync(target, mode); // the mode given to open() is cut by the process's umask
  }
  const hostHome = join(root, 'host');
  const workspaceId = (JSON.parse(readFileSync(join(hostHome, 'workspaces.json'), 'utf8')) as { shared: { workspaceId: string }[] }).shared[0]!.workspaceId;
  return { root, at: variant.at, hostHome, workspaceId, workspaceDir: join(hostHome, 'workspaces', workspaceId), project: join(root, 'project'), cliMemberHome: join(root, 'cli-member'), devices: join(root, 'devices') };
}
```

The folder a test copies into must have a path without `"` and `\` (the placeholder is replaced inside JSON strings as
it is), and a short one when a daemon is started on it (`<hostHome>/run/<12 characters>.hook` must fit the 103 bytes
of a Unix socket path: `createTempRunDir()` of `@smurg/daemon/testing` gives such a folder).

`at` is the instant the variant was taken. A test sets its clock there: the fixture's unused invite links expire a
week (one of them a month) later, and a start prunes dead links after 30 days.

## files.json

    placeholder                        the text that stands for the folder a fixture is copied to
    variants.<name>.at                 epoch milliseconds: the instant of this picture of the disk
    variants.<name>.overlayOf          the variant this one is laid over; `absent`: files of that one this one has not
    variants.<name>.dirs[]             every folder with its mode (as smurg left it)
    variants.<name>.files[]            path, mode, size and sha256 of the file AS STORED HERE (placeholder in place);
                                       `placeholder: true` when it holds the placeholder;
                                       `prefixOf`: not stored: it is the first `size` bytes of that variant's file
                                       (a log that only grew between the two pictures);
                                       `pieces` for an upload's `.part`: where the stored bytes go; the rest is zeros;
                                       `bytesNotKept` when the part's bytes are not in the fixture at all

A test should compare the sha256 of what it reads with files.json before it trusts a fixture: a checkout that
changed line ends, or a file a `.gitignore` rule left out, shows there. (This folder has its own `.gitignore` and
`.gitattributes` for both reasons: the repository ignores `*.log`, and the host log and every upload journal have
that name.)

## coverage.json

For every kind of persisted file: the schema of that version it is an instance of (file and name in the tag's
tree), how many instances the fixture holds, and of that schema's optional keys, arrays, records and union branches
the ones the fixture's files visit and the ones they do not, each of these with a reason. `why: "cannot"` means the
code of that version has no way to write it (the reason names the code); `why: "not-made"` means it can be written
and this fixture does not hold it. Enumerations are listed with the values that occur. Both variants count together.

The paths: `members[].avatarUrl` is a key of every element of an array; `members{}.seen{}` a value of a record;
`notes[]<kind=mention>.anchor` a key inside one branch of a union; `responsible<null>` and `responsible<value>` are
the two sides of a nullable.

## When a version is published

Its fixture is added beside these, written by its own code, and never changed afterwards. How each one here was made
is in its README; in short: `git archive` of the tag into a scratch folder with its own tools and dependencies, a
scratch `HOME` and `SMURG_HOME`, the relay of that tree on this computer with its dev login, the stand-in for Claude
Code of that tree (never a real `claude`, never the built-in relay, never anyone's own `~/.smurg`), a story played by
clients of the client library and by the command, one picture of the disk while the host's smurg runs and one after
`smurg stop`. Then the files are checked by the code that wrote them: its daemon starts on a copy, and every file is
parsed with its own schema.

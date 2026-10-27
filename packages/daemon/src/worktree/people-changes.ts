// Who changed a path on the main workspace's side (DESIGN 0.7.0 D7 "Who changed the other side", R-SAFE S2; D14's
// `changedSince` uses it too). When a work item's trial merge conflicts, whose lines stand on the other side decides
// what follows: other work items' merges only, and smurg brings the item up to date and lets its own agent resolve;
// anything else is a person's change (or one made outside smurg), and a person decides. smurg never lets an agent
// resolve over a person's lines by itself (R-SAFE's resolve-over-person run: the agent kept its own line over Bo's
// saved one, the resolution merged cleanly and unread, and nobody was told).
//
// The main workspace's first-parent history from `from` (the trial's merge base) to `to` (the head the trial was made
// against) is the list of changes that landed on it. A first-parent commit that is a recorded merge of a work item
// (some merged request's merge commit) carries an agent's work. Every other one that touches a path is a change
// outside this plan's work items:
//  - in the folder's own git, by its author: a member when the author's address is smurg's form
//    (`<slug>@users.smurg.invalid`, names.ts), else `outside` (a commit the host or a tool made outside smurg, often the
//    host committing teammates' edits);
//  - in smurg's own history, where every such commit is a snapshot of the folder (its author is whoever made smurg take
//    it), by the activity log's writers of that path between the commit's first parent and the commit (an agent
//    session's write is named by its responsible person; nobody named: `outside`).
// A conflicted path that no commit of the range touches cannot be shown to be only work items' changes: it counts as
// one made outside smurg (the closed side: a person looks).
//
// Only git objects are read (`git log`, nothing of the working tree), with the hardened runner of git.ts.
import { gitCommitSchema, type UserRef } from '@smurg/protocol';
import type { PeopleChange } from '../core/interfaces.ts';
import { requireOk } from './git.ts';
import { decodeGitPath, splitNul } from './git-parse.ts';
import { memberSlugOfEmail, ownerSlug } from './names.ts';
import type { MainRepo } from './review.ts';

export type { PeopleChange };

/** People named per path (the wire's `autoMerge.people[].by` and the undo's `changedSince[].by` hold at most 5). */
export const PEOPLE_PER_PATH_MAX = 5;
/** Paths named to one `git log` (a command line stays short; more paths are looked at in more commands). */
const PATHS_PER_LOOK = 200;
/** Output of one look; beyond it the paths of that look count as changed outside smurg. */
const LOOK_OUTPUT_MAX = 16 * 1024 * 1024;

const isCommitId = (value: string): boolean => gitCommitSchema.safeParse(value).success;

/** Who wrote paths of the main workspace in a span of time (smurg's own history: the activity log). */
export type WritersOf = (paths: readonly string[], fromMs: number, toMs: number) => Promise<ReadonlyMap<string, { readonly by: readonly UserRef[]; readonly outside: boolean }>>;

export interface PeopleChangesInput {
  readonly repo: MainRepo;
  /** The trial's merge base. */
  readonly from: string;
  /** The head the trial was made against. */
  readonly to: string;
  /** The conflicted paths (protocol spelling). */
  readonly paths: readonly string[];
  /** Merge commits of work items' requests (worktrees.json), whoever merged them: an agent's work. */
  readonly workItemMerges: ReadonlySet<string>;
  /** The folder's own git: every member, removed ones too, an author address of smurg's form can name. */
  readonly members: readonly UserRef[];
  /** smurg's own history: who wrote the paths between a snapshot's first parent and the snapshot. */
  readonly writers: WritersOf;
  readonly timeoutMs: number;
}

interface LoggedCommit {
  readonly commit: string;
  readonly firstParent: string | null;
  readonly time: number;
  readonly email: string;
  readonly paths: string[];
}

/** One `git log --first-parent` of `from..to` over `paths`: every first-parent commit that touches one of them. */
async function logOf(input: PeopleChangesInput, paths: readonly string[]): Promise<LoggedCommit[] | null> {
  const result = await input.repo.git.run({
    gitDir: input.repo.gitDir,
    // The header of each commit starts with an empty field: no path is empty, so it cannot be taken for one.
    args: ['log', '--first-parent', '--diff-merges=first-parent', '--no-renames', '--name-only', '-z', '--format=%x00%H%x00%P%x00%ct%x00%ae', `${input.to}`, `^${input.from}`, '--', ...paths],
    readOnly: true,
    maxStdoutBytes: LOOK_OUTPUT_MAX,
    timeoutMs: input.timeoutMs,
  });
  if (result.truncated) return null;
  requireOk(result, 'listChanges');
  const fields = splitNul(result.stdout);
  const commits: LoggedCommit[] = [];
  let at = 0;
  while (at < fields.length) {
    if ((fields[at] as Buffer).length !== 0) return null; // not the start of a header: an output this does not know
    const commit = (fields[at + 1] ?? Buffer.alloc(0)).toString('utf8');
    const parents = (fields[at + 2] ?? Buffer.alloc(0)).toString('utf8').split(' ').filter((id) => id.length > 0);
    const time = Number((fields[at + 3] ?? Buffer.alloc(0)).toString('utf8'));
    const email = (fields[at + 4] ?? Buffer.alloc(0)).toString('utf8');
    if (!isCommitId(commit) || !Number.isSafeInteger(time) || parents.some((id) => !isCommitId(id))) return null;
    at += 5;
    const touched: string[] = [];
    for (let first = true; at < fields.length && (fields[at] as Buffer).length !== 0; at += 1, first = false) {
      let field = fields[at] as Buffer;
      // git puts a line break between a commit's header and its list of names.
      if (first && field[0] === 0x0a) field = field.subarray(1);
      if (field.length === 0) continue;
      try {
        touched.push(decodeGitPath(field).path);
      } catch {
        // A name the protocol cannot spell is none of the conflicted paths (they were spelled by the same rules).
      }
    }
    commits.push({ commit, firstParent: parents[0] ?? null, time, email, paths: touched });
  }
  return commits;
}

/** The commit times of `commits` (seconds), from one `git log --no-walk`. */
async function timesOf(input: PeopleChangesInput, commits: readonly string[]): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  if (commits.length === 0) return times;
  const result = await input.repo.git.run({ gitDir: input.repo.gitDir, args: ['log', '--no-walk=unsorted', '-z', '--format=%H %ct', ...commits], readOnly: true, maxStdoutBytes: 1024 * 1024, timeoutMs: input.timeoutMs });
  if (result.code !== 0 || result.truncated) return times;
  for (const field of splitNul(result.stdout)) {
    const [commit, time] = field.toString('utf8').trim().split(' ');
    if (commit !== undefined && isCommitId(commit) && Number.isSafeInteger(Number(time))) times.set(commit, Number(time));
  }
  return times;
}

/** Adds `by` to a path's list without doubles, at most PEOPLE_PER_PATH_MAX. */
function addPeople(list: UserRef[], by: readonly UserRef[]): void {
  for (const user of by) if (list.length < PEOPLE_PER_PATH_MAX && !list.some((known) => known.userId === user.userId)) list.push({ userId: user.userId, displayName: user.displayName });
}

/**
 * The conflicted paths whose other side is not only work items' merges, in the order given, with who changed them.
 * Empty: every conflicted path's other side is work items' merges (smurg may let the item's agent resolve).
 */
export async function peopleChanges(input: PeopleChangesInput): Promise<PeopleChange[]> {
  const wanted = [...new Set(input.paths)];
  if (wanted.length === 0) return [];
  const found = new Map<string, { by: UserRef[]; outside: boolean; person: boolean; workItem: boolean }>();
  const entry = (path: string): { by: UserRef[]; outside: boolean; person: boolean; workItem: boolean } => {
    let known = found.get(path);
    if (known === undefined) found.set(path, (known = { by: [], outside: false, person: false, workItem: false }));
    return known;
  };
  const wantedSet = new Set(wanted);
  for (let at = 0; at < wanted.length; at += PATHS_PER_LOOK) {
    const group = wanted.slice(at, at + PATHS_PER_LOOK);
    const commits = await logOf(input, group);
    if (commits === null) {
      // Too much, or an output this does not read: nothing of these paths is shown to be only work items' changes.
      for (const path of group) Object.assign(entry(path), { person: true, outside: true });
      continue;
    }
    const others = commits.filter((commit) => !input.workItemMerges.has(commit.commit));
    for (const commit of commits) if (input.workItemMerges.has(commit.commit)) for (const path of commit.paths) if (wantedSet.has(path)) entry(path).workItem = true;
    if (input.repo.kind === 'folder') {
      for (const commit of others) {
        const slug = memberSlugOfEmail(commit.email);
        const members = slug === null ? [] : input.members.filter((member) => ownerSlug(member.userId) === slug);
        for (const path of commit.paths) {
          if (!wantedSet.has(path)) continue;
          const known = entry(path);
          known.person = true;
          if (members.length === 0) known.outside = true;
          else addPeople(known.by, members);
        }
      }
      continue;
    }
    // smurg's own history: each snapshot is named by who wrote its paths while it was the folder's newest state.
    const times = await timesOf(input, [...new Set(others.map((commit) => commit.firstParent).filter((id): id is string => id !== null))]);
    for (const commit of others) {
      const paths = commit.paths.filter((path) => wantedSet.has(path));
      if (paths.length === 0) continue;
      const since = commit.firstParent === null ? 0 : (times.get(commit.firstParent) ?? 0) * 1000;
      const writers = await input.writers(paths, since, (commit.time + 1) * 1000);
      for (const path of paths) {
        const known = entry(path);
        known.person = true;
        const written = writers.get(path);
        if (written === undefined || (written.by.length === 0 && !written.outside)) known.outside = true;
        else {
          addPeople(known.by, written.by);
          if (written.outside) known.outside = true;
        }
      }
    }
  }
  const out: PeopleChange[] = [];
  for (const path of wanted) {
    const known = found.get(path);
    // A work item's merge alone: an agent's work. Nothing at all: not shown to be one, so a person looks.
    if (known !== undefined && !known.person && known.workItem) continue;
    out.push({ path, by: known?.by ?? [], outside: known === undefined ? true : known.outside || known.by.length === 0 });
  }
  return out;
}

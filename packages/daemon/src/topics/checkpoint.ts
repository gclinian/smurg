// The checkpoint commit of a Start (ARCHITECTURE §5.10, §7.8; design §4.7). An item's worktree is a clone checked out
// at the main workspace's HEAD, so SPEC.md and PLAN.md must be committed before an item starts. It happens ONLY
// inside a `plan.start` request, never later by itself:
//
//   git add -- specs/<slug>/SPEC.md specs/<slug>/PLAN.md
//   git commit -m "smurg: spec and plan of <slug>" -m "Edited-by: <safe name>" … -- <the two paths>
//
// exactly these two paths by name (nothing else that lies in the folder), as the member who pressed Start and saw
// the dialog, with one `Edited-by:` trailer per person who edited the files by hand since the last Start. The git
// work itself is the worktree module's (`commitMainPaths`: the hardened runner, serialized with merges).
import { SmurgError, agentSafeName, topicPlanPath, topicSpecPath } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import type { Principal } from '../core/interfaces.ts';
import type { StoredTopic } from './store.ts';

export interface Checkpoint {
  readonly commit: string;
  /** false: HEAD already held this content. */
  readonly created: boolean;
  readonly branch: string;
  readonly specBlob: string | null;
  readonly planBlob: string | null;
}

/** The commit message of a checkpoint. The slug is pattern-checked; nothing people wrote is in it. */
export function checkpointMessage(slug: string): string {
  return `smurg: spec and plan of ${slug}`;
}

/** One trailer per PERSON of the hand edits (a change no member made through smurg has nobody to name). */
export function editedByTrailers(topic: Pick<StoredTopic, 'handEdits'>): string[] {
  const names = new Map<string, string>();
  for (const edit of [...topic.handEdits.spec, ...topic.handEdits.plan]) {
    if (typeof edit.by === 'string') continue;
    names.set(edit.by.userId, agentSafeName(edit.by.displayName, edit.by.userId));
  }
  return [...names.values()].map((name) => `Edited-by: ${name}`);
}

function reasonOf(err: unknown): string {
  const reason = err instanceof SmurgError ? err.detail?.['reason'] : undefined;
  return typeof reason === 'string' ? reason : '';
}

/**
 * Commits the topic's two files as `as`. Refused, with the Start, when the repository is in the middle of a merge or
 * rebase (`plan.start.commit.busy`), when git ignores the folder (`plan.start.commit.ignored`), or on any other git
 * failure (`plan.start.commit.failed`). Audits `spec.commit`.
 */
export async function checkpointCommit(ctx: DaemonContext, topic: StoredTopic, as: Principal): Promise<Checkpoint> {
  const worktrees = ctx.services.worktrees;
  const specPath = topicSpecPath(topic.slug);
  const planPath = topicPlanPath(topic.slug);
  const trailers = editedByTrailers(topic);
  let result: Awaited<ReturnType<typeof worktrees.commitMainPaths>>;
  try {
    result = await worktrees.commitMainPaths({ paths: [specPath, planPath], message: checkpointMessage(topic.slug), trailers, as });
  } catch (err) {
    const reason = reasonOf(err);
    ctx.audit.record({ actor: as.actor, action: 'spec.commit', outcome: 'error', target: topic.id, detail: { topicId: topic.id, slug: topic.slug, reason: reason === '' ? 'git-failed' : reason } });
    if (reason === 'git-busy' || reason === 'busy' || reason === 'merge-in-progress') throw new SmurgError('conflict', msg('plan.start.commit.busy'), { reason: 'git-busy' }, { cause: err });
    if (reason === 'git-ignored' || reason === 'ignored') {
      const path = err instanceof SmurgError && typeof err.detail?.['path'] === 'string' ? err.detail['path'] : specPath;
      throw new SmurgError('conflict', msg('plan.start.commit.ignored', { path }), { reason: 'git-ignored' }, { cause: err });
    }
    // A refusal that is not a git failure (the member may not commit, the paths are not committable) keeps its own words.
    if (err instanceof SmurgError && err.code !== 'internal' && reason !== 'git-failed' && err.text !== undefined) throw err;
    const step = err instanceof SmurgError && typeof err.detail?.['step'] === 'string' ? err.detail['step'] : 'commit';
    throw new SmurgError('conflict', msg('plan.start.commit.failed', { step }), { reason: 'commit-failed' }, { cause: err });
  }
  if (result.created) {
    ctx.audit.record({ actor: as.actor, action: 'spec.commit', outcome: 'ok', target: topic.id, detail: { topicId: topic.id, slug: topic.slug, commit: result.commit, branch: result.branch, files: [specPath, planPath], editedBy: trailers.map((trailer) => trailer.slice('Edited-by: '.length)) } });
  }
  return { commit: result.commit, created: result.created, branch: result.branch, specBlob: result.blobs[specPath] ?? null, planBlob: result.blobs[planPath] ?? null };
}

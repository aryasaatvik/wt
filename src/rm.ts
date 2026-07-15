// wt rm — remove a worktree by branch, slug, or path. Never forces.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { listWorktrees, resolvePrimaryRepo, type WorktreeInfo } from "./git.ts";
import { bold, dim, run, runAsync } from "./term.ts";
import { detail, err, ExitError, info, log } from "./ui.ts";

export interface RmOptions {
  deleteBranch: boolean;
  cwd: string;
}

/**
 * Resolve a removal target, in order: exact branch name, worktree directory
 * slug under <repo>-worktrees/, then a filesystem path. Detached worktrees
 * have no branch, so slug/path is how they are addressed.
 */
export function resolveTarget(target: string, cwd: string): WorktreeInfo | null {
  const repoRoot = resolvePrimaryRepo(cwd);
  const worktrees = listWorktrees(repoRoot).filter((w) => w.path !== repoRoot);

  const byBranch = worktrees.find((w) => w.branch === target);
  if (byBranch) return byBranch;

  const slugDir = join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`, target);
  const bySlug = worktrees.find((w) => w.path === slugDir);
  if (bySlug) return bySlug;

  const asPath = resolve(cwd, target);
  if (existsSync(asPath)) {
    // realpath matches git's canonicalized worktree paths (symlinks, case)
    const abs = realpathSync.native(asPath);
    const byPath = worktrees.find((w) => w.path === abs);
    if (byPath) return byPath;
  }
  return null;
}

function listForError(cwd: string): string {
  const repoRoot = resolvePrimaryRepo(cwd);
  return listWorktrees(repoRoot)
    .filter((w) => w.path !== repoRoot)
    .map((w) => `      ${w.branch ?? `(detached ${w.head.slice(0, 7)} · ${basename(w.path)})`}`)
    .join("\n");
}

export async function cmdRm(target: string, opts: RmOptions): Promise<void> {
  const wt = resolveTarget(target, opts.cwd);
  if (!wt) {
    err(`No worktree found for ${bold(target)}`);
    console.error("    Existing worktrees:");
    console.error(listForError(opts.cwd));
    throw new ExitError(1);
  }

  const dirty = run(["git", "-C", wt.path, "status", "--porcelain"]).trim();
  if (dirty) {
    err(`Worktree ${bold(target)} has uncommitted changes — not removing`);
    detail(dirty);
    console.error(`    Commit or stash them first (wt never uses --force).`);
    throw new ExitError(1);
  }

  info(`Removing worktree ${bold(target)}`);
  const removed = await runAsync(["git", "-C", opts.cwd, "worktree", "remove", wt.path]);
  if (!removed.ok) {
    err("Failed to remove worktree");
    detail(removed.stderr);
    throw new ExitError(1);
  }
  log(`Removed ${dim(wt.path)}`);

  if (opts.deleteBranch) {
    if (!wt.branch) {
      err(`Cannot delete branch: ${bold(target)} was a detached worktree`);
      throw new ExitError(1);
    }
    const deleted = await runAsync(["git", "-C", opts.cwd, "branch", "-D", wt.branch]);
    if (!deleted.ok) {
      err(`Failed to delete branch ${bold(wt.branch)}`);
      detail(deleted.stderr);
      throw new ExitError(1);
    }
    log(`Deleted branch ${bold(wt.branch)}`);
  }
}

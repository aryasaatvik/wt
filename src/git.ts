// Git plumbing shared by wt commands.

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { run } from "./term.ts";

/**
 * Resolve the primary repo root regardless of which worktree cwd is in.
 * --git-common-dir always points at the primary .git; its parent is the root.
 *
 * The result is case-canonicalized via realpath: on case-insensitive
 * filesystems (macOS APFS) `pwd` preserves whatever casing the user typed in
 * `cd`, so deriving `<repo>-worktrees` from it can register worktrees under a
 * path whose case doesn't match the on-disk directory — git then treats them
 * as distinct strings while the filesystem treats them as one.
 */
export function resolvePrimaryRepo(cwd: string): string {
  const common = run(["git", "-C", cwd, "rev-parse", "--git-common-dir"]).trim();
  if (!common) throw new Error("not inside a git repository");
  return realpathSync.native(dirname(resolve(cwd, common)));
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Parse `git worktree list --porcelain` into records. First entry is the primary. */
export function listWorktrees(cwd: string): WorktreeInfo[] {
  const out = run(["git", "-C", cwd, "worktree", "list", "--porcelain"]);
  const entries: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length),
        head: "",
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
      };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  return entries;
}

export function branchExists(cwd: string, branch: string): boolean {
  return (
    Bun.spawnSync(["git", "-C", cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
      .exitCode === 0
  );
}

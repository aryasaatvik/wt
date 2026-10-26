// Git plumbing shared by wt commands.

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { run } from "./term.ts";

/**
 * Resolve the primary repo root regardless of which worktree cwd is in.
 * --git-common-dir points at the primary .git for ordinary worktrees. An
 * initialized submodule keeps it under its superproject's .git/modules and
 * names its checkout with core.worktree, which also covers linked worktrees
 * of that submodule.
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
  const commonDir = realpathSync.native(resolve(cwd, common));
  // Bind config lookup to the primary Git dir: a linked lane's config.worktree
  // may name its own checkout. Git loads the primary config.worktree only when
  // extensions.worktreeConfig enables it.
  const worktree = run(["git", "--git-dir", commonDir, "config", "--get", "core.worktree"]).trim();
  let primary: string;
  try {
    primary = realpathSync.native(worktree ? resolve(commonDir, worktree) : dirname(commonDir));
  } catch {
    throw new Error(`cannot resolve primary checkout for ${commonDir}`);
  }
  const primaryGitDir = run(["git", "-C", primary, "rev-parse", "--absolute-git-dir"]).trim();
  if (!primaryGitDir || realpathSync.native(primaryGitDir) !== commonDir) {
    throw new Error(`invalid primary checkout ${primary} for ${commonDir}`);
  }
  return primary;
}

export interface WorktreeInfo {
  path: string;
  isMain: boolean;
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
        isMain: entries.length === 0,
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
  // Submodules can report their common Git directory as the main path.
  // Probe and display the actual checkout, while retaining its main identity.
  if (entries[0]) {
    try {
      entries[0].path = resolvePrimaryRepo(cwd);
    } catch {
      // Bare repositories and missing primaries can still have usable linked lanes.
    }
  }
  return entries;
}

/** origin's default branch: origin/HEAD if set, else the first remote main/master/dev ref. */
export function originDefault(cwd: string): string | null {
  const ref = run(["git", "-C", cwd, "symbolic-ref", "refs/remotes/origin/HEAD"]).trim();
  if (ref) return ref.replace(/^refs\/remotes\/origin\//, "");
  for (const cand of ["main", "master", "dev"]) {
    if (
      Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--verify", "-q", `origin/${cand}`])
        .exitCode === 0
    )
      return cand;
  }
  return null;
}

/** Resolve the ref used by `wt new` when the caller omitted a base. */
export function defaultBase(cwd: string): string | null {
  const originHead = run(["git", "-C", cwd, "symbolic-ref", "refs/remotes/origin/HEAD"]).trim();
  if (originHead) {
    const name = originHead.replace(/^refs\/remotes\/origin\//, "");
    const remote = `origin/${name}`;
    if (
      Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--verify", "-q", `refs/remotes/${remote}`])
        .exitCode === 0
    ) {
      return `refs/remotes/${remote}`;
    }
  }
  for (const candidate of ["main", "master", "dev"]) {
    if (branchExists(cwd, candidate)) return candidate;
  }
  for (const candidate of ["main", "master", "dev"]) {
    if (
      Bun.spawnSync([
        "git",
        "-C",
        cwd,
        "rev-parse",
        "--verify",
        "-q",
        `refs/remotes/origin/${candidate}`,
      ]).exitCode === 0
    ) {
      return `refs/remotes/origin/${candidate}`;
    }
  }
  return null;
}

export function branchExists(cwd: string, branch: string): boolean {
  return (
    Bun.spawnSync(["git", "-C", cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
      .exitCode === 0
  );
}

export interface CreateSource {
  kind: "local" | "origin" | "base";
  ref: string;
  head: string;
}

/** Select only cached refs; existing branches take precedence over a new branch's base. */
export function resolveCreateSource(cwd: string, branch: string, base?: string): CreateSource {
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  const hasRemote =
    Bun.spawnSync(["git", "-C", cwd, "show-ref", "--verify", "--quiet", remote]).exitCode === 0;
  const kind = branchExists(cwd, branch) ? "local" : hasRemote ? "origin" : "base";
  const ref = kind === "local" ? local : kind === "origin" ? remote : (base ?? defaultBase(cwd));
  if (!ref)
    throw new Error(
      "cannot determine a default base (set origin/HEAD, create main/master/dev, or pass a base explicitly)",
    );
  const head = run(["git", "-C", cwd, "rev-parse", "--verify", `${ref}^{commit}`]).trim();
  if (!head) throw new Error(`cannot resolve worktree source ${ref}`);
  return { kind, ref, head };
}

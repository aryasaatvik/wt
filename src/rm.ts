// wt rm — remove a worktree by branch, slug, or path. Never forces.

import { existsSync, mkdtempSync, realpathSync, renameSync, rmdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { listWorktrees, resolvePrimaryRepo, type WorktreeInfo } from "./git.ts";
import { envDriftResolution, runSafetyPipeline, type SafetyFlag } from "./safety.ts";
import { bold, dim, runAsync } from "./term.ts";
import { detail, err, ExitError, info, log } from "./ui.ts";

export interface RmOptions {
  deleteBranch: boolean;
  cwd: string;
  /** abort if the worktree HEAD no longer matches this sha (reap's TOCTOU guard) */
  expectHead?: string;
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
    try {
      const owner = resolvePrimaryRepo(abs);
      return listWorktrees(owner).find((w) => w.path === abs && w.path !== owner) ?? null;
    } catch {
      return null;
    }
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

function printBlocked(target: string, flags: SafetyFlag[], laneRef: string): void {
  err(`Not removing ${bold(target)}:`);
  for (const flag of flags) detail(`[${flag.kind}] ${flag.detail}`);
  console.error(`    Resolve the flags first (wt never uses --force).`);
  if (flags.some((flag) => flag.kind === "env-drift")) {
    for (const line of envDriftResolution(laneRef)) console.error(`    ${line}`);
  }
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalDirectory(path: string): string | null {
  try {
    return statSync(path).isDirectory() ? realpathSync.native(path) : null;
  } catch {
    return null;
  }
}

async function initializedSubmodules(wtPath: string): Promise<string[]> {
  const listed = await runAsync(["git", "-C", wtPath, "submodule", "status", "--recursive"]);
  if (!listed.ok) throw new Error(`Cannot inspect submodules: ${listed.stderr.trim()}`);
  const paths: string[] = [];
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const match = /^([- +U])[0-9a-f]{40,64} (.+?)(?: \([^)]*\))?$/.exec(line);
    if (!match) throw new Error("Cannot parse submodule status; not removing");
    if (match[1] !== "-") paths.push(match[2]!);
  }
  return paths;
}

export async function cmdRm(target: string, opts: RmOptions): Promise<void> {
  const wt = resolveTarget(target, opts.cwd);
  if (!wt) {
    err(`No worktree found for ${bold(target)}`);
    console.error("    Existing worktrees:");
    console.error(listForError(opts.cwd));
    throw new ExitError(1);
  }

  if (opts.expectHead && !wt.head.startsWith(opts.expectHead)) {
    err(`HEAD of ${bold(target)} moved since it was inspected — not removing`);
    detail(`expected ${opts.expectHead}, found ${wt.head}`);
    throw new ExitError(1);
  }

  const targetPath = realpathSync.native(wt.path);
  const callerPaths = [opts.cwd, process.env.PWD];
  if (callerPaths.some((path) => {
    const canonical = path ? canonicalDirectory(path) : null;
    return canonical !== null && containsPath(targetPath, canonical);
  })) {
    err(`Cannot remove ${bold(target)} from inside that worktree`);
    detail("Run wt rm from the primary checkout or another worktree.");
    throw new ExitError(1);
  }

  const repoRoot = resolvePrimaryRepo(wt.path);
  let submodules: string[];
  try {
    submodules = await initializedSubmodules(wt.path);
  } catch (error) {
    err(`Cannot inspect submodules in ${bold(target)} — not removing`);
    detail(String(error));
    throw new ExitError(1);
  }
  for (const path of submodules) {
    const status = await runAsync(["git", "-C", join(wt.path, path), "status", "--porcelain", "--untracked-files=all", "--ignored"]);
    if (!status.ok || status.stdout.trim()) {
      err(`Submodule ${bold(path)} has changes or cannot be inspected — not removing ${bold(target)}`);
      if (!status.ok) detail(status.stderr.trim());
      throw new ExitError(1);
    }
  }
  // Evaluate read-only first: when removal is blocked, nothing has been
  // copied into the archive. Only a clean preview runs the salvaging pass.
  const preview = await runSafetyPipeline(wt.path, repoRoot, { dryRun: true });
  if (!preview.ok) {
    printBlocked(target, preview.flags, wt.branch ?? wt.path);
    throw new ExitError(1);
  }
  const safety = await runSafetyPipeline(wt.path, repoRoot);
  for (const rel of safety.salvaged) {
    log(`Salvaged ${dim(rel)} to primary .scratchpad archive`);
  }
  if (!safety.ok) {
    // something changed between the preview and the salvaging pass
    printBlocked(target, safety.flags, wt.branch ?? wt.path);
    throw new ExitError(1);
  }

  // -D on a detached worktree can never succeed — fail before removing anything.
  if (opts.deleteBranch && !wt.branch) {
    err(`Cannot delete branch: ${bold(target)} is a detached worktree (drop -D to remove it)`);
    throw new ExitError(1);
  }

  if (submodules.length) {
    const deinitialized = await runAsync(["git", "-C", wt.path, "submodule", "deinit", "--all"]);
    if (!deinitialized.ok) {
      err(`Failed to deinitialize submodules in ${bold(target)}`);
      detail(deinitialized.stderr.trim());
      throw new ExitError(1);
    }
  }

  // Git still rejects a deinitialized worktree while its per-worktree modules directory exists.
  let moduleArchive: { source: string; destination: string; directory: string } | null = null;
  if (submodules.length) {
    const metadata = await runAsync(["git", "-C", wt.path, "rev-parse", "--absolute-git-dir"]);
    if (!metadata.ok || !metadata.stdout.trim()) {
      err(`Cannot locate submodule Git data in ${bold(target)} — not removing`);
      throw new ExitError(1);
    }
    const gitDir = metadata.stdout.trim();
    const source = join(gitDir, "modules");
    if (existsSync(source)) {
      const directory = mkdtempSync(join(dirname(dirname(gitDir)), "wt-submodules-"));
      const destination = join(directory, "modules");
      try {
        renameSync(source, destination);
      } catch (error) {
        rmdirSync(directory);
        err(`Cannot preserve submodule Git data in ${bold(target)} — not removing`);
        detail(String(error));
        throw new ExitError(1);
      }
      moduleArchive = { source, destination, directory };
    }
  }

  info(`Removing worktree ${bold(target)}`);
  const removed = await runAsync(["git", "-C", repoRoot, "worktree", "remove", wt.path]);
  if (!removed.ok) {
    if (moduleArchive) {
      try {
        renameSync(moduleArchive.destination, moduleArchive.source);
        rmdirSync(moduleArchive.directory);
      } catch {
        detail(`Submodule Git data retained at ${moduleArchive.destination}`);
      }
    }
    err("Failed to remove worktree");
    detail(removed.stderr);
    throw new ExitError(1);
  }
  log(`Removed ${dim(wt.path)}`);
  if (moduleArchive) log(`Retained submodule Git data at ${dim(moduleArchive.destination)}`);

  if (opts.deleteBranch && wt.branch) {
    const deleted = await runAsync(["git", "-C", repoRoot, "branch", "-D", wt.branch]);
    if (!deleted.ok) {
      err(`Failed to delete branch ${bold(wt.branch)}`);
      detail(deleted.stderr);
      throw new ExitError(1);
    }
    log(`Deleted branch ${bold(wt.branch)}`);
  }
}

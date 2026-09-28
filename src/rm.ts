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

/**
 * Initialized submodules in a lane, refusing any that is dirty, holds
 * untracked or ignored files, or cannot be inspected.
 */
export async function inspectSubmodules(
  wtPath: string,
): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
  let paths: string[];
  try {
    paths = await initializedSubmodules(wtPath);
  } catch (error) {
    return { ok: false, reason: String(error instanceof Error ? error.message : error) };
  }
  for (const path of paths) {
    const status = await runAsync(["git", "-C", join(wtPath, path), "status", "--porcelain", "--untracked-files=all", "--ignored"]);
    if (!status.ok) return { ok: false, reason: `submodule ${path} cannot be inspected: ${status.stderr.trim()}` };
    if (status.stdout.trim()) return { ok: false, reason: `submodule ${path} has changes, untracked, or ignored files` };
  }
  return { ok: true, paths };
}

async function submoduleConfig(configFile: string): Promise<Array<[string, string]>> {
  const res = await runAsync(["git", "config", "--file", configFile, "--null", "--get-regexp", "^submodule\\."]);
  if (!res.ok) return [];
  return res.stdout.split("\0").filter(Boolean).map((entry) => {
    const at = entry.indexOf("\n");
    return at === -1 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)];
  });
}

async function restoreSubmoduleConfig(configFile: string, entries: Array<[string, string]>): Promise<boolean> {
  const current = new Set((await submoduleConfig(configFile)).map(([key]) => key));
  let ok = true;
  for (const [key, value] of entries) {
    if (current.has(key)) continue;
    ok = (await runAsync(["git", "config", "--file", configFile, "--add", key, value])).ok && ok;
  }
  return ok;
}

/**
 * Remove a lane with `git worktree remove`, never forced. Git refuses a lane
 * with initialized submodules, so clean ones (see inspectSubmodules) are
 * deinitialized first and the lane's submodule Git data is moved under the
 * primary's .git rather than deleted. Deinit also unregisters submodules in
 * the config shared with the primary, so that config is restored. Any failure
 * after deinit reinitializes the lane's submodules at their recorded commits.
 */
export async function removeWorktree(
  wtPath: string,
  repoRoot: string,
  submodules: string[],
): Promise<{ ok: true; retained: string | null } | { ok: false; reason: string }> {
  const remove = () => runAsync(["git", "-C", repoRoot, "worktree", "remove", wtPath]);
  if (submodules.length === 0) {
    const removed = await remove();
    return removed.ok ? { ok: true, retained: null } : { ok: false, reason: removed.stderr.trim() };
  }

  const dirs = await runAsync(["git", "-C", wtPath, "rev-parse", "--absolute-git-dir", "--git-common-dir"]);
  const [gitDir, commonRel] = dirs.stdout.trim().split("\n");
  if (!dirs.ok || !gitDir || !commonRel) return { ok: false, reason: "cannot locate the lane's Git directory" };
  const commonDir = resolve(wtPath, commonRel);
  const configFile = join(commonDir, "config");
  const snapshot = await submoduleConfig(configFile);
  const source = join(gitDir, "modules");
  let archive: string;
  try {
    archive = mkdtempSync(join(commonDir, "wt-submodules-"));
  } catch (error) {
    return { ok: false, reason: `cannot reserve submodule Git data archive: ${error}` };
  }
  const destination = join(archive, "modules");

  const recover = async (reason: string) => {
    const notes = [reason];
    if (!existsSync(source) && existsSync(destination)) {
      try {
        renameSync(destination, source);
      } catch {
        notes.push(`submodule Git data retained at ${destination}`);
      }
    }
    if (!existsSync(destination)) {
      try {
        rmdirSync(archive);
      } catch {}
    }
    if (!(await restoreSubmoduleConfig(configFile, snapshot))) notes.push("submodule config not fully restored");
    const reinit = await runAsync(["git", "-C", wtPath, "submodule", "update", "--init", "--recursive"]);
    if (!reinit.ok) notes.push(`submodules not reinitialized: ${reinit.stderr.trim()}`);
    return { ok: false as const, reason: notes.join("; ") };
  };

  const deinit = await runAsync(["git", "-C", wtPath, "submodule", "deinit", "--all"]);
  if (!deinit.ok) return recover(`submodule deinit failed: ${deinit.stderr.trim()}`);
  if (!(await restoreSubmoduleConfig(configFile, snapshot))) return recover("cannot restore the primary's submodule config");
  if (existsSync(source)) {
    try {
      renameSync(source, destination);
    } catch (error) {
      return recover(`cannot preserve submodule Git data: ${error}`);
    }
  }
  const removed = await remove();
  if (!removed.ok) return recover(removed.stderr.trim());
  if (!existsSync(destination)) {
    try {
      rmdirSync(archive);
    } catch {}
    return { ok: true, retained: null };
  }
  return { ok: true, retained: destination };
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
  const submodules = await inspectSubmodules(wt.path);
  if (!submodules.ok) {
    err(`Not removing ${bold(target)}: ${submodules.reason}`);
    throw new ExitError(1);
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

  info(`Removing worktree ${bold(target)}`);
  const removed = await removeWorktree(wt.path, repoRoot, submodules.paths);
  if (!removed.ok) {
    err("Failed to remove worktree");
    detail(removed.reason);
    throw new ExitError(1);
  }
  log(`Removed ${dim(wt.path)}`);
  if (removed.retained) log(`Retained submodule Git data at ${dim(removed.retained)}`);

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

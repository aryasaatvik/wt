// wt rm — remove a worktree by branch, slug, or path. Never forces.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { listWorktrees, resolvePrimaryRepo, type WorktreeInfo } from "./git.ts";
import { envDriftResolution, runSafetyPipeline, type SafetyFlag } from "./safety.ts";
import { humanSize } from "./ls.ts";
import { bold, dim, run, runAsync } from "./term.ts";
import { detail, err, ExitError, info, log, warn } from "./ui.ts";
import {
  outputLabel,
  planXcodeOutputs,
  removeXcodeOutputs,
  resolveXcodeSetting,
  totalKb,
  worktreeRoots,
  type XcodeOutput,
  type XcodeSetting,
  type XcodeSkip,
} from "./xcode.ts";

export interface RmOptions {
  deleteBranch: boolean;
  cwd: string;
  /** abort if the worktree HEAD no longer matches this sha (reap's TOCTOU guard) */
  expectHead?: string;
  /** run every check and report what would be removed, removing nothing */
  dryRun?: boolean;
  /** false keeps Xcode build outputs; omitted reads `[remove] xcode` from config */
  xcode?: XcodeSetting;
}

/** Indented lines listing Xcode outputs with sizes, then kept ones with reasons. */
export function xcodeLines(
  outputs: XcodeOutput[],
  skipped: XcodeSkip[],
  verb: { removed: string; kept: string },
): string[] {
  const lines: string[] = [];
  if (outputs.length > 0) {
    lines.push(`${verb.removed} Xcode build outputs (${humanSize(totalKb(outputs))}):`);
    for (const output of outputs)
      lines.push(
        `  ${humanSize(output.kb).padStart(6)}  ${outputLabel(output).padEnd(15)}  ${output.path}`,
      );
  }
  for (const skip of skipped) lines.push(`${verb.kept} ${skip.path}: ${skip.reason}`);
  return lines;
}

/**
 * Resolve a removal target, in order: exact branch name, worktree directory
 * slug under <repo>-worktrees/, then a filesystem path. Detached worktrees
 * have no branch, so slug/path is how they are addressed.
 */
export function resolveTarget(target: string, cwd: string): WorktreeInfo | null {
  const repoRoot = resolvePrimaryRepo(cwd);
  const worktrees = listWorktrees(repoRoot).filter((w) => !w.isMain && w.path !== repoRoot);

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
      return (
        listWorktrees(owner).find((w) => !w.isMain && w.path === abs && w.path !== owner) ?? null
      );
    } catch {
      return null;
    }
  }
  return null;
}

function listForError(cwd: string): string {
  const repoRoot = resolvePrimaryRepo(cwd);
  return listWorktrees(repoRoot)
    .filter((w) => !w.isMain && w.path !== repoRoot)
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
  const index = await runAsync(["git", "-C", wtPath, "ls-files", "--stage", "-z"]);
  if (!index.ok) throw new Error(`Cannot inspect gitlinks: ${index.stderr.trim()}`);
  let allUninitialized = true;
  for (const entry of index.stdout.split("\0").filter((line) => line.startsWith("160000 "))) {
    const match = /^160000 [0-9a-f]{40,64} 0\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("Cannot parse gitlink index entry; not removing");
    const path = join(wtPath, match[1]!);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || readdirSync(path).length > 0)) allUninitialized = false;
  }
  // Empty gitlinks hold no local data, even when vendored history lacks a
  // root .gitmodules mapping and `git submodule status` cannot list them.
  if (allUninitialized) return [];

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
    const status = await runAsync([
      "git",
      "-C",
      join(wtPath, path),
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored",
    ]);
    if (!status.ok)
      return {
        ok: false,
        reason: `submodule ${path} cannot be inspected: ${status.stderr.trim()}`,
      };
    if (status.stdout.trim())
      return { ok: false, reason: `submodule ${path} has changes, untracked, or ignored files` };
  }
  return { ok: true, paths };
}

interface AdminConfigFile {
  /** per-worktree config file in the child's admin directory */
  name: "config" | "config.worktree";
  content: string;
  mode: number;
}

interface LinkedSubmodule {
  /** lane-relative path from `git submodule status` */
  path: string;
  /** canonical checkout path inside the lane */
  worktree: string;
  /** canonical shared Git directory that registers it */
  commonDir: string;
  head: string;
  branch: string | null;
  /** exact per-worktree config this admin held before removal */
  adminConfig: AdminConfigFile[];
  /** shared core.worktree, which a generic submodule reinit rewrites */
  commonWorktree: string | null;
}

/** Admin directories whose `gitdir` names this exact checkout. */
function registrationAdmins(commonDir: string, worktree: string): string[] {
  const worktrees = join(commonDir, "worktrees");
  if (!existsSync(worktrees)) return [];
  const admins: string[] = [];
  for (const name of readdirSync(worktrees)) {
    const admin = join(worktrees, name);
    let gitfile: string;
    try {
      gitfile = readFileSync(join(admin, "gitdir"), "utf8").trim();
    } catch {
      continue;
    }
    if (canonicalDirectory(dirname(resolve(admin, gitfile))) === worktree) admins.push(admin);
  }
  return admins;
}

/**
 * Find initialized submodules whose checkout is itself a linked worktree of
 * the submodule's shared Git directory (Alchemy's distilled topology). Git
 * refuses to remove a lane holding one, and `submodule deinit` clears the
 * checkout while leaving its registration behind, so these must be removed
 * through the child repository's own worktree lifecycle first.
 *
 * Every registration is checked against the exact lane checkout and the
 * primary repository's Git directory. Anything ambiguous, locked, prunable,
 * or holding initialized submodules is refused before the lane is touched.
 * The per-worktree admin config and the shared `core.worktree` are captured
 * so a failed parent removal can restore the child exactly as it was.
 */
async function inspectLinkedSubmodules(
  wtPath: string,
  primary: string,
  paths: string[],
): Promise<{ ok: true; linked: LinkedSubmodule[] } | { ok: false; reason: string }> {
  const primaryGit = run(["git", "-C", primary, "rev-parse", "--absolute-git-dir"]).trim();
  const primaryGitDir = primaryGit ? canonicalDirectory(primaryGit) : null;
  const laneRoot = canonicalDirectory(wtPath);
  if (!primaryGitDir || !laneRoot)
    return { ok: false, reason: "cannot resolve the primary Git directory or worktree" };

  const linked: LinkedSubmodule[] = [];
  // Deepest first: an outer linked checkout cannot be removed while a nested
  // one is still registered inside it.
  const ordered = [...paths].sort(
    (a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a),
  );
  for (const path of ordered) {
    const checkout = canonicalDirectory(join(laneRoot, path));
    if (!checkout || !containsPath(laneRoot, checkout))
      return { ok: false, reason: `submodule ${path} cannot be resolved inside the worktree` };

    const dirs = await runAsync([
      "git",
      "-C",
      checkout,
      "rev-parse",
      "--absolute-git-dir",
      "--git-common-dir",
    ]);
    const [gitDirRel, commonRel] = dirs.stdout.trim().split("\n");
    if (!dirs.ok || !gitDirRel || !commonRel)
      return { ok: false, reason: `submodule ${path} Git directory cannot be inspected` };
    const gitDir = canonicalDirectory(resolve(checkout, gitDirRel));
    const commonDir = canonicalDirectory(resolve(checkout, commonRel));
    if (!gitDir || !commonDir)
      return { ok: false, reason: `submodule ${path} Git directory cannot be resolved` };
    // A normal submodule checkout owns its Git directory; deinit handles it.
    if (gitDir === commonDir) continue;
    if (dirname(gitDir) !== join(commonDir, "worktrees"))
      return { ok: false, reason: `submodule ${path} has an unrecognized linked-worktree layout` };
    if (!containsPath(primaryGitDir, commonDir))
      return {
        ok: false,
        reason: `submodule ${path} is registered outside the primary repository`,
      };

    const top = await runAsync(["git", "-C", checkout, "rev-parse", "--show-toplevel"]);
    if (!top.ok || canonicalDirectory(top.stdout.trim()) !== checkout)
      return { ok: false, reason: `submodule ${path} checkout does not match its registration` };

    const registered = listWorktrees(commonDir).filter(
      (entry) => canonicalDirectory(entry.path) === checkout,
    );
    if (registered.length !== 1)
      return {
        ok: false,
        reason: `submodule ${path} has ${registered.length === 0 ? "no" : "an ambiguous"} worktree registration`,
      };
    const entry = registered[0]!;
    if (entry.locked) return { ok: false, reason: `submodule ${path} linked worktree is locked` };
    if (entry.prunable)
      return { ok: false, reason: `submodule ${path} linked worktree registration is prunable` };
    if (!entry.head)
      return { ok: false, reason: `submodule ${path} linked worktree has no recorded HEAD` };

    const admins = registrationAdmins(commonDir, checkout);
    if (admins.length !== 1 || canonicalDirectory(admins[0]!) !== gitDir)
      return { ok: false, reason: `submodule ${path} has an ambiguous worktree registration` };

    const adminConfig: AdminConfigFile[] = [];
    for (const name of ["config", "config.worktree"] as const) {
      const file = join(gitDir, name);
      const metadata = lstatSync(file, { throwIfNoEntry: false });
      if (!metadata) continue;
      if (!metadata.isFile())
        return {
          ok: false,
          reason: `submodule ${path} per-worktree ${name} is not a regular file`,
        };
      try {
        adminConfig.push({
          name,
          content: readFileSync(file, "utf8"),
          mode: metadata.mode & 0o777,
        });
      } catch {
        return { ok: false, reason: `submodule ${path} per-worktree ${name} cannot be read` };
      }
    }

    const shared = await runAsync([
      "git",
      "config",
      "--file",
      join(commonDir, "config"),
      "--get",
      "core.worktree",
    ]);
    if (!shared.ok && shared.code !== 1)
      return { ok: false, reason: `submodule ${path} shared config cannot be read` };
    const commonWorktree = shared.ok ? shared.stdout.trimEnd() : null;

    const nested = await runAsync(["git", "-C", checkout, "submodule", "status", "--recursive"]);
    if (!nested.ok)
      return {
        ok: false,
        reason: `submodule ${path} cannot be inspected: ${nested.stderr.trim()}`,
      };
    if (nested.stdout.split("\n").some((line) => line && !line.startsWith("-")))
      return {
        ok: false,
        reason: `submodule ${path} linked worktree contains initialized submodules`,
      };

    linked.push({
      path,
      worktree: checkout,
      commonDir,
      head: entry.head,
      branch: entry.branch,
      adminConfig,
      commonWorktree,
    });
  }
  // Deinitializing an ordinary ancestor would remove the linked child's
  // parent checkout; restoring that ancestor recursively would initialize the
  // child through the wrong lifecycle. Refuse this topology before mutation.
  for (const item of linked) {
    if (
      paths.some(
        (path) => item.path.startsWith(`${path}/`) && !linked.some((other) => other.path === path),
      )
    )
      return {
        ok: false,
        reason: `linked submodule ${item.path} is nested inside another submodule`,
      };
  }
  return { ok: true, linked };
}

async function submoduleConfig(configFile: string): Promise<Array<[string, string]>> {
  const res = await runAsync([
    "git",
    "config",
    "--file",
    configFile,
    "--null",
    "--get-regexp",
    "^submodule\\.",
  ]);
  if (!res.ok) return [];
  return res.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf("\n");
      return at === -1 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)];
    });
}

async function restoreSubmoduleConfig(
  configFile: string,
  entries: Array<[string, string]>,
): Promise<boolean> {
  const current = new Set((await submoduleConfig(configFile)).map(([key]) => key));
  let ok = true;
  for (const [key, value] of entries) {
    if (current.has(key)) continue;
    ok = (await runAsync(["git", "config", "--file", configFile, "--add", key, value])).ok && ok;
  }
  return ok;
}

/**
 * Remove a lane with `git worktree remove`, never forced. A submodule that is
 * itself a linked worktree of the submodule's shared Git directory is removed
 * first through that repository's native worktree lifecycle, which keeps its
 * registration in step instead of leaving a prunable entry behind. Remaining
 * clean submodules are deinitialized, and the lane's submodule Git data is
 * moved under the primary's .git rather than deleted. Deinit also unregisters
 * submodules in the config shared with the primary, so that config is
 * restored. If the parent removal fails, the lifted child worktrees are
 * re-added at their original head and branch with their per-worktree config,
 * archived lane-private Git data is put back first, and only ordinary
 * submodules are reinitialized so the shared child config is never rewritten.
 */
export async function removeWorktree(
  wtPath: string,
  repoRoot: string,
  submodules: string[],
): Promise<{ ok: true; retained: string | null } | { ok: false; reason: string }> {
  const primary = resolvePrimaryRepo(repoRoot);
  const common = run(["git", "-C", primary, "rev-parse", "--git-common-dir"]).trim();
  const target = canonicalDirectory(wtPath) ?? resolve(wtPath);
  if (
    !common ||
    target === primary ||
    target === canonicalDirectory(resolve(primary, common)) ||
    listWorktrees(primary).some((wt) => wt.isMain && wt.path === target)
  )
    return { ok: false, reason: "cannot remove the main worktree or Git common directory" };
  const remove = () => runAsync(["git", "-C", repoRoot, "worktree", "remove", wtPath]);
  if (submodules.length === 0) {
    const removed = await remove();
    return removed.ok ? { ok: true, retained: null } : { ok: false, reason: removed.stderr.trim() };
  }

  const dirs = await runAsync([
    "git",
    "-C",
    wtPath,
    "rev-parse",
    "--absolute-git-dir",
    "--git-common-dir",
  ]);
  const [gitDir, commonRel] = dirs.stdout.trim().split("\n");
  if (!dirs.ok || !gitDir || !commonRel)
    return { ok: false, reason: "cannot locate the lane's Git directory" };
  const commonDir = resolve(wtPath, commonRel);
  const configFile = join(commonDir, "config");
  const snapshot = await submoduleConfig(configFile);
  const linked = await inspectLinkedSubmodules(wtPath, primary, submodules);
  if (!linked.ok) return { ok: false, reason: linked.reason };
  const source = join(gitDir, "modules");
  let archive: string;
  try {
    archive = mkdtempSync(join(commonDir, "wt-submodules-"));
  } catch (error) {
    return { ok: false, reason: `cannot reserve submodule Git data archive: ${error}` };
  }
  const destination = join(archive, "modules");
  const lifted: LinkedSubmodule[] = [];
  // Linked checkouts are restored through their own worktree lifecycle;
  // generic reinitialization could redirect their shared core.worktree.
  const ordinary = submodules.filter((path) => !linked.linked.some((item) => item.path === path));

  const restoreAdminConfig = async (item: LinkedSubmodule, notes: string[]) => {
    const admins = registrationAdmins(item.commonDir, item.worktree);
    if (admins.length !== 1) {
      notes.push(`linked submodule ${item.path} registration is ambiguous after restore`);
      return;
    }
    for (const { name, content, mode } of item.adminConfig) {
      try {
        writeFileSync(join(admins[0]!, name), content, { mode });
        chmodSync(join(admins[0]!, name), mode);
      } catch {
        notes.push(`linked submodule ${item.path} per-worktree ${name} not restored`);
      }
    }
  };

  const restoreCommonWorktree = async (item: LinkedSubmodule, notes: string[]) => {
    const config = join(item.commonDir, "config");
    const current = await runAsync(["git", "config", "--file", config, "--get", "core.worktree"]);
    if (!current.ok && current.code !== 1) {
      notes.push(`linked submodule ${item.path} shared config cannot be read`);
      return;
    }
    if ((current.ok ? current.stdout.trimEnd() : null) === item.commonWorktree) return;
    const restored =
      item.commonWorktree === null
        ? await runAsync(["git", "config", "--file", config, "--unset-all", "core.worktree"])
        : await runAsync([
            "git",
            "config",
            "--file",
            config,
            "--replace-all",
            "core.worktree",
            item.commonWorktree,
          ]);
    // `--unset-all` exits 5 when the key is already absent.
    if (!restored.ok && !(item.commonWorktree === null && restored.code === 5))
      notes.push(`linked submodule ${item.path} shared core.worktree not restored`);
  };

  const restoreLinked = async (notes: string[]) => {
    for (const item of [...lifted].reverse()) {
      // Restore exactly the recorded mode: a branch stays on that branch and
      // a detached checkout stays detached. Never fall back silently.
      const readd = item.branch
        ? await runAsync([
            "git",
            "-C",
            item.commonDir,
            "worktree",
            "add",
            item.worktree,
            item.branch,
          ])
        : await runAsync([
            "git",
            "-C",
            item.commonDir,
            "worktree",
            "add",
            "--detach",
            item.worktree,
            item.head,
          ]);
      if (!readd.ok) {
        notes.push(`linked submodule ${item.path} not restored: ${readd.stderr.trim()}`);
        continue;
      }
      // Restore the admin config before checking state: with per-worktree
      // config enabled, `core.worktree` there is what locates the checkout.
      await restoreAdminConfig(item, notes);
      const state = await runAsync(["git", "-C", item.worktree, "rev-parse", "HEAD"]);
      const ref = await runAsync([
        "git",
        "-C",
        item.worktree,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      if (
        !state.ok ||
        state.stdout.trim() !== item.head ||
        (ref.ok ? ref.stdout.trim() : null) !== item.branch
      )
        notes.push(`linked submodule ${item.path} restored at the wrong commit or branch`);
    }
    lifted.length = 0;
  };

  const recover = async (reason: string) => {
    const notes = [reason];
    // A lane-private child common directory lives inside the archived data, so
    // put it back before re-adding any worktree that depends on it.
    if (!existsSync(source) && existsSync(destination)) {
      try {
        renameSync(destination, source);
      } catch {
        notes.push(`submodule Git data retained at ${destination}`);
      }
    }
    await restoreLinked(notes);
    if (!existsSync(destination)) {
      try {
        rmdirSync(archive);
      } catch {}
    }
    if (!(await restoreSubmoduleConfig(configFile, snapshot)))
      notes.push("submodule config not fully restored");
    if (ordinary.length > 0) {
      const reinit = await runAsync([
        "git",
        "-C",
        wtPath,
        "submodule",
        "update",
        "--init",
        "--recursive",
        "--",
        ...ordinary,
      ]);
      if (!reinit.ok) notes.push(`submodules not reinitialized: ${reinit.stderr.trim()}`);
    }
    for (const item of linked.linked) {
      if (existsSync(item.commonDir)) await restoreCommonWorktree(item, notes);
    }
    return { ok: false as const, reason: notes.join("; ") };
  };

  for (const item of linked.linked) {
    const detached = await runAsync([
      "git",
      "-C",
      item.commonDir,
      "worktree",
      "remove",
      item.worktree,
    ]);
    if (!detached.ok) {
      const notes = [
        `cannot remove linked submodule worktree ${item.path}: ${detached.stderr.trim()}`,
      ];
      await restoreLinked(notes);
      try {
        rmdirSync(archive);
      } catch {}
      return { ok: false, reason: notes.join("; ") };
    }
    lifted.push(item);
  }

  const deinit = await runAsync(["git", "-C", wtPath, "submodule", "deinit", "--all"]);
  if (!deinit.ok) return recover(`submodule deinit failed: ${deinit.stderr.trim()}`);
  if (!(await restoreSubmoduleConfig(configFile, snapshot)))
    return recover("cannot restore the primary's submodule config");
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
  if (
    callerPaths.some((path) => {
      const canonical = path ? canonicalDirectory(path) : null;
      return canonical !== null && containsPath(targetPath, canonical);
    })
  ) {
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
  const safety = await runSafetyPipeline(wt.path, repoRoot);
  if (!safety.ok) {
    printBlocked(target, safety.flags, wt.branch ?? wt.path);
    throw new ExitError(1);
  }

  // -D on a detached worktree can never succeed — fail before removing anything.
  if (opts.deleteBranch && !wt.branch) {
    err(`Cannot delete branch: ${bold(target)} is a detached worktree (drop -D to remove it)`);
    throw new ExitError(1);
  }

  const xcode = resolveXcodeSetting(false, opts.xcode);
  // Recorded paths may use either spelling; the realpath is gone after removal.
  const roots = worktreeRoots(wt.path);

  if (opts.dryRun) {
    info(`Would remove worktree ${bold(target)} ${dim(wt.path)}`);
    if (opts.deleteBranch && wt.branch) info(`Would delete branch ${bold(wt.branch)}`);
    if (xcode === false) {
      log(dim("Keeping Xcode build outputs (--keep-xcode or remove.xcode = false)"));
      return;
    }
    const plan = await planXcodeOutputs(roots, xcode, { checkActivity: true });
    if (plan.outputs.length + plan.skipped.length === 0)
      log(dim("No Xcode build outputs for this worktree"));
    const [header, ...outputs] = xcodeLines(plan.outputs, [], {
      removed: "Would remove",
      kept: "",
    });
    if (header) info(header);
    for (const line of outputs) console.log(`    ${line}`);
    for (const skip of plan.skipped) warn(`Would keep ${skip.path}: ${skip.reason}`);
    return;
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

  if (xcode !== false) {
    // The worktree is already gone: a kept output is reported, never a failure.
    const plan = await planXcodeOutputs(roots, xcode);
    const result = await removeXcodeOutputs(plan, roots, xcode);
    if (result.removed.length > 0)
      log(`Removed Xcode build outputs (${humanSize(totalKb(result.removed))})`);
    for (const output of result.removed) detail(dim(output.path));
    for (const skip of result.skipped) warn(`Kept Xcode output ${skip.path}: ${skip.reason}`);
  }

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

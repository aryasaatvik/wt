// wt new — create a worktree, sync gitignored files, install dependencies.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { branchExists, resolvePrimaryRepo } from "./git.ts";
import { computeSyncFiles, rsyncFiles } from "./sync.ts";
import { bold, dim, run, runAsync, spinner } from "./term.ts";
import { detail, err, ExitError, info, log } from "./ui.ts";

export interface CreateOptions {
  verbose: boolean;
  install: boolean;
  cwd: string;
  extraFlags: string[];
}

export function slugFor(branch: string): string {
  return branch.replaceAll("/", "-");
}

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "deno.lock",
];

function hasDependencyConfig(dir: string): boolean {
  if (LOCKFILES.some((f) => existsSync(join(dir, f)))) return true;
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) return false;
  try {
    return typeof JSON.parse(readFileSync(pkg, "utf8")).packageManager === "string";
  } catch {
    return false;
  }
}

/** Absolute path of the worktree's private git dir (<primary>/.git/worktrees/<name>). */
function worktreeGitDir(wtDir: string): string {
  return run(["git", "-C", wtDir, "rev-parse", "--absolute-git-dir"]).trim();
}

export interface ProvenanceMarker {
  createdAt: string;
  branch: string;
  base: string | null;
  syncedFiles: string[];
}

export function readProvenance(wtDir: string): ProvenanceMarker | null {
  const markerPath = join(worktreeGitDir(wtDir), "wt.json");
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf8")) as ProvenanceMarker;
  } catch {
    return null;
  }
}

export async function cmdNew(branch: string, base: string, opts: CreateOptions): Promise<string> {
  const repoRoot = resolvePrimaryRepo(opts.cwd);
  const slug = slugFor(branch);
  const wtDir = join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`, slug);

  console.log("");
  mkdirSync(dirname(wtDir), { recursive: true });

  const existing = branchExists(repoRoot, branch);
  const addArgs = existing
    ? ["git", "-C", repoRoot, "worktree", "add", wtDir, branch, ...opts.extraFlags]
    : ["git", "-C", repoRoot, "worktree", "add", "-b", branch, wtDir, base, ...opts.extraFlags];
  info(
    existing
      ? `Checking out existing branch ${bold(branch)}`
      : `Creating worktree ${bold(branch)} from ${dim(base)}`,
  );
  const spin = spinner("Creating worktree");
  const added = await runAsync(addArgs);
  spin.stop();
  if (!added.ok) {
    err("Failed to create worktree");
    detail(added.stderr);
    throw new ExitError(1);
  }
  log(`Worktree created at ${dim(wtDir)}`);

  info("Syncing gitignored files");
  let synced: string[] = [];
  const syncSpin = spinner("Syncing files");
  try {
    synced = await computeSyncFiles(repoRoot, wtDir);
    if (synced.length > 0) {
      syncSpin.update(`Syncing ${synced.length} files`);
      await rsyncFiles(repoRoot, wtDir, synced, opts.verbose);
    }
    syncSpin.stop();
    if (synced.length === 0) log("No gitignored files to sync");
    else log(`Synced ${bold(synced.length)} files`);
  } catch (e) {
    syncSpin.stop();
    err("Failed to sync gitignored files");
    detail(e instanceof Error ? e.message : String(e));
    throw new ExitError(1);
  }

  const marker: ProvenanceMarker = {
    createdAt: new Date().toISOString(),
    branch,
    base: existing ? null : base,
    syncedFiles: synced,
  };
  writeFileSync(join(worktreeGitDir(wtDir), "wt.json"), JSON.stringify(marker, null, 2) + "\n");

  if (!opts.install) {
    info("Skipping install (--no-install)");
  } else if (!Bun.which("ni")) {
    info("Skipping install (ni not found)");
  } else if (!hasDependencyConfig(wtDir)) {
    info("Skipping install (no lockfile or packageManager)");
  } else {
    info("Installing dependencies");
    console.log("");
    // No spinner here on purpose: ni's own output (package list, timing) is useful.
    const ni = Bun.spawn(["ni"], { cwd: wtDir, stdout: "inherit", stderr: "inherit" });
    const code = await ni.exited;
    console.log("");
    if (code === 0) log("Dependencies installed");
    else err("Dependency install failed (run manually in worktree)");
  }

  console.log("");
  log(`Worktree ready at ${bold(wtDir)}`);
  console.log("");
  return wtDir;
}

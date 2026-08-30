// wt new — create a worktree, sync gitignored config, install dependencies.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { branchExists, resolvePrimaryRepo } from "./git.ts";
import { applySyncPlan, planSync } from "./sync.ts";
import { bold, dim, run, runAsync, spinner } from "./term.ts";
import { detail, err, ExitError, info, log } from "./ui.ts";

export interface CreateOptions {
  verbose: boolean;
  install: boolean;
  cwd: string;
  extraFlags: string[];
  installRunner?: (wtDir: string) => Promise<number>;
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

/** Absolute path of the worktree's private git dir (<primary>/.git/worktrees/<name>), or null on git failure. */
function worktreeGitDir(wtDir: string): string | null {
  return run(["git", "-C", wtDir, "rev-parse", "--absolute-git-dir"]).trim() || null;
}

export interface ProvenanceMarker {
  createdAt: string;
  updatedAt: string;
  branch: string;
  base: string | null;
  phase: "created" | "synced" | "installing" | "ready" | "incomplete";
  syncedFiles: string[];
  failure?: string;
  recoveryCommand?: string;
  sync?: {
    source: string;
    mode: "manifest" | "legacy" | "none";
    manifestHash: string | null;
    copiedPaths: string[];
    copiedFiles: number;
    copiedBytes: number;
  };
}

function writeProvenance(wtDir: string, marker: ProvenanceMarker): void {
  const gitDir = worktreeGitDir(wtDir);
  if (!gitDir) {
    info("Skipping provenance marker (could not resolve the worktree's git dir)");
    return;
  }
  try {
    marker.updatedAt = new Date().toISOString();
    writeFileSync(join(gitDir, "wt.json"), JSON.stringify(marker, null, 2) + "\n");
  } catch (e) {
    info(`Skipping provenance marker (${e instanceof Error ? e.message : e})`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function readProvenance(wtDir: string): ProvenanceMarker | null {
  const gitDir = worktreeGitDir(wtDir);
  if (!gitDir) return null;
  const markerPath = join(gitDir, "wt.json");
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

  const createdAt = new Date().toISOString();
  const marker: ProvenanceMarker = {
    createdAt,
    updatedAt: createdAt,
    branch,
    base: existing ? null : base,
    phase: "created",
    syncedFiles: [],
  };
  writeProvenance(wtDir, marker);

  info("Syncing gitignored files");
  let synced: string[] = [];
  let syncPlan: Awaited<ReturnType<typeof planSync>> | null = null;
  const syncSpin = spinner("Syncing files");
  try {
    syncPlan = await planSync(repoRoot, wtDir);
    if (syncPlan.mode === "legacy") info("No .worktreeinclude found; using v2 legacy sync defaults");
    const copyCount = syncPlan.summary.copy;
    if (copyCount > 0) {
      syncSpin.update(`Syncing ${copyCount} files`);
      synced = await applySyncPlan(syncPlan, opts.verbose);
    }
    syncSpin.stop();
    if (synced.length === 0) log("No gitignored files to sync");
    else log(`Synced ${bold(synced.length)} files`);
  } catch (e) {
    syncSpin.stop();
    marker.phase = "incomplete";
    marker.failure = e instanceof Error ? e.message : String(e);
    marker.recoveryCommand = `cd ${shellQuote(repoRoot)} && wt sync --to ${shellQuote(wtDir)} --force`;
    writeProvenance(wtDir, marker);
    err("Failed to sync gitignored files");
    detail(marker.failure);
    detail(`Worktree kept at ${wtDir}\nRetry with: ${marker.recoveryCommand}`);
    throw new ExitError(1);
  }

  marker.phase = "synced";
  marker.syncedFiles = synced;
  marker.sync = syncPlan
    ? {
        source: syncPlan.source,
        mode: syncPlan.mode,
        manifestHash: syncPlan.manifestHash,
        copiedPaths: synced,
        copiedFiles: synced.length,
        copiedBytes: syncPlan.bytesToCopy,
      }
    : undefined;
  writeProvenance(wtDir, marker);

  if (!opts.install) {
    info("Skipping install (--no-install)");
  } else if (!opts.installRunner && !Bun.which("ni")) {
    info("Skipping install (ni not found)");
  } else if (!hasDependencyConfig(wtDir)) {
    info("Skipping install (no lockfile or packageManager)");
  } else {
    marker.phase = "installing";
    writeProvenance(wtDir, marker);
    info("Installing dependencies");
    console.log("");
    let code: number;
    try {
      code = opts.installRunner
        ? await opts.installRunner(wtDir)
        : await Bun.spawn(["ni"], { cwd: wtDir, stdout: "inherit", stderr: "inherit" }).exited;
    } catch (e) {
      marker.phase = "incomplete";
      marker.failure = `dependency install failed: ${e instanceof Error ? e.message : String(e)}`;
      marker.recoveryCommand = `cd ${shellQuote(wtDir)} && ni`;
      writeProvenance(wtDir, marker);
      console.log("");
      err("Dependency install failed");
      detail(`${marker.failure}\nWorktree kept at ${wtDir}\nRetry with: ${marker.recoveryCommand}`);
      throw new ExitError(1);
    }
    console.log("");
    if (code === 0) log("Dependencies installed");
    else {
      marker.phase = "incomplete";
      marker.failure = `dependency install exited ${code}`;
      marker.recoveryCommand = `cd ${shellQuote(wtDir)} && ni`;
      writeProvenance(wtDir, marker);
      err("Dependency install failed");
      detail(`Worktree kept at ${wtDir}\nRetry with: ${marker.recoveryCommand}`);
      throw new ExitError(code || 1);
    }
  }

  marker.phase = "ready";
  delete marker.failure;
  delete marker.recoveryCommand;
  writeProvenance(wtDir, marker);
  console.log("");
  log(`Worktree ready at ${bold(wtDir)}`);
  console.log("");
  return wtDir;
}

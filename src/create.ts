// wt new — create a worktree, sync gitignored config, install dependencies.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type CreateSource,
  listWorktrees,
  resolveCreateSource,
  resolvePrimaryRepo,
} from "./git.ts";
import { applySyncPlan, planSync } from "./sync.ts";
import { ensureSharedScratchpad } from "./scratchpad.ts";
import { bold, dim, run, runAsync, spinner } from "./term.ts";
import { detail, err, ExitError, info, log, warn } from "./ui.ts";

export interface CreateOptions {
  verbose: boolean;
  install: boolean;
  /** Run the repository's `wt.toml` post-install command; defaults to enabled. */
  postInstall?: boolean;
  cwd: string;
  extraFlags: string[];
  installRunner?: (wtDir: string) => Promise<number>;
  postInstallRunner?: (wtDir: string, command: string) => Promise<number>;
}

export interface CreateConfig {
  /** Command run in the new worktree after dependencies install. */
  postInstall?: string;
}

const CONFIG_FILE = "wt.toml";

/**
 * Read repository create policy from `<repoRoot>/wt.toml`. Read from the primary
 * checkout, like `.worktreeinclude`, so the command is repository policy rather
 * than whatever a branch happens to carry.
 */
export function readCreateConfig(repoRoot: string): CreateConfig {
  const path = join(repoRoot, CONFIG_FILE);
  if (!existsSync(path)) return {};
  let parsed: { create?: { postInstall?: unknown } };
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as typeof parsed;
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const postInstall = parsed.create?.postInstall;
  if (postInstall !== undefined && (typeof postInstall !== "string" || postInstall.trim() === "")) {
    throw new Error(`${path}: create.postInstall must be a non-empty string`);
  }
  return postInstall ? { postInstall: postInstall.trim() } : {};
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
  /** Absent on markers written before source selection was recorded. */
  source?: CreateSource;
  phase: "created" | "synced" | "installing" | "post-install" | "ready" | "incomplete";
  syncedFiles: string[];
  failure?: string;
  recoveryCommand?: string;
  postInstall?: {
    command: string;
  };
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

export async function cmdNew(
  branch: string,
  base: string | undefined,
  opts: CreateOptions,
): Promise<string> {
  const repoRoot = resolvePrimaryRepo(opts.cwd);
  const source = resolveCreateSource(repoRoot, branch, base);
  let createConfig: CreateConfig;
  try {
    createConfig = readCreateConfig(repoRoot);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    throw new ExitError(1);
  }
  const slug = slugFor(branch);
  const wtDir = join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`, slug);

  console.log("");
  mkdirSync(dirname(wtDir), { recursive: true });

  const existing = source.kind === "local";
  let fastForwardedFrom: string | null = null;
  let laneCreated = false;
  try {
    if (existing && base !== undefined) {
      const baseHead = run([
        "git",
        "-C",
        repoRoot,
        "rev-parse",
        "--verify",
        `${base}^{commit}`,
      ]).trim();
      if (!baseHead) throw new Error(`cannot resolve worktree base ${base}`);
      const counts = await runAsync([
        "git",
        "-C",
        repoRoot,
        "rev-list",
        "--left-right",
        "--count",
        `${baseHead}...${source.head}`,
      ]);
      const match = /^(\d+)\s+(\d+)$/.exec(counts.stdout.trim());
      if (!counts.ok || !match)
        throw new Error(`cannot compare ${branch} with ${base}: ${counts.stderr.trim()}`);
      const behind = Number(match[1]);
      const ahead = Number(match[2]);
      if (behind > 0 && ahead > 0)
        warn(
          `Reusing ${branch} unchanged: ${behind} ${behind === 1 ? "commit" : "commits"} behind ${base} with ${ahead} unique ${ahead === 1 ? "commit" : "commits"} (squash-merged? delete the branch to start from ${base})`,
        );
      const ancestor = await runAsync([
        "git",
        "-C",
        repoRoot,
        "merge-base",
        "--is-ancestor",
        source.head,
        baseHead,
      ]);
      if (ancestor.code !== 0 && ancestor.code !== 1)
        throw new Error(`cannot compare ${branch} with ${base}: ${ancestor.stderr.trim()}`);
      if (ancestor.ok && source.head !== baseHead) {
        if (listWorktrees(repoRoot).some((wt) => wt.branch === branch))
          throw new Error(`cannot fast-forward ${branch}: branch is already checked out`);
        const updated = await runAsync([
          "git",
          "-C",
          repoRoot,
          "update-ref",
          source.ref,
          baseHead,
          source.head,
        ]);
        if (!updated.ok) throw new Error(`cannot fast-forward ${branch}: ${updated.stderr.trim()}`);
        fastForwardedFrom = source.head;
        source.head = baseHead;
        info(`Fast-forwarded ${branch} to ${base} (${behind} commits behind, no unique commits)`);
      }
    }
    const trackingFlag = opts.extraFlags.some(
      (flag) =>
        flag === "-t" || flag === "--track" || flag.startsWith("--track=") || flag === "--no-track",
    );
    const newBranchFlags = opts.extraFlags.map((flag) => (flag === "-t" ? "--track" : flag));
    const addArgs = existing
      ? ["git", "-C", repoRoot, "worktree", "add", wtDir, branch, ...opts.extraFlags]
      : [
          "git",
          "-C",
          repoRoot,
          "worktree",
          "add",
          ...(trackingFlag ? [] : ["--no-track"]),
          "-b",
          branch,
          wtDir,
          source.ref,
          ...newBranchFlags,
        ];
    info(
      existing
        ? `Checking out existing branch ${bold(branch)}`
        : `Creating worktree ${bold(branch)} from ${dim(source.ref)}`,
    );
    info(`Source: ${source.ref} (${source.head})`);
    const spin = spinner("Creating worktree");
    const added = await runAsync(addArgs);
    laneCreated = added.ok;
    spin.stop();
    if (!added.ok) {
      err("Failed to create worktree");
      detail(added.stderr);
      throw new ExitError(1);
    }
  } catch (error) {
    if (fastForwardedFrom !== null && !laneCreated) {
      const lane = listWorktrees(repoRoot).find((wt) => wt.branch === branch);
      if (lane) {
        err(
          `Worktree exists at ${lane.path}, but setup did not complete; keeping ${branch} unchanged`,
        );
      } else {
        const restored = await runAsync([
          "git",
          "-C",
          repoRoot,
          "update-ref",
          source.ref,
          fastForwardedFrom,
          source.head,
        ]);
        if (!restored.ok) {
          err(
            `Could not restore ${branch} after lane creation failed (the branch may have changed)`,
          );
          detail(restored.stderr);
        }
      }
    }
    throw error;
  }
  log(`Worktree created at ${dim(wtDir)}`);

  const createdAt = new Date().toISOString();
  const marker: ProvenanceMarker = {
    createdAt,
    updatedAt: createdAt,
    branch,
    base: existing ? null : source.ref,
    source,
    phase: "created",
    syncedFiles: [],
  };
  writeProvenance(wtDir, marker);

  info("Syncing gitignored files");
  let synced: string[] = [];
  let syncPlan: Awaited<ReturnType<typeof planSync>> | null = null;
  const syncSpin = spinner("Syncing files");
  try {
    await ensureSharedScratchpad(repoRoot, wtDir);
    syncPlan = await planSync(repoRoot, wtDir);
    if (syncPlan.mode === "legacy")
      info("No .worktreeinclude found; using v2 legacy sync defaults");
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
    marker.recoveryCommand = `cd ${shellQuote(repoRoot)} && wt sync --to ${shellQuote(wtDir)}`;
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

  let installRan = false;
  if (!opts.install) {
    info("Skipping install (--no-install)");
  } else if (!opts.installRunner && !Bun.which("ni")) {
    info("Skipping install (ni not found)");
  } else if (!hasDependencyConfig(wtDir)) {
    info("Skipping install (no lockfile or packageManager)");
  } else {
    marker.phase = "installing";
    writeProvenance(wtDir, marker);
    installRan = true;
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

  if (createConfig.postInstall && opts.postInstall !== false && installRan) {
    const command = createConfig.postInstall;
    marker.phase = "post-install";
    marker.postInstall = { command };
    writeProvenance(wtDir, marker);
    info(`Running post-install: ${bold(command)}`);
    console.log("");
    let code: number;
    try {
      code = opts.postInstallRunner
        ? await opts.postInstallRunner(wtDir, command)
        : await Bun.spawn(["/bin/sh", "-c", command], {
            cwd: wtDir,
            stdout: "inherit",
            stderr: "inherit",
          }).exited;
    } catch (e) {
      marker.phase = "incomplete";
      marker.failure = `post-install failed: ${e instanceof Error ? e.message : String(e)}`;
      marker.recoveryCommand = `cd ${shellQuote(wtDir)} && ${command}`;
      writeProvenance(wtDir, marker);
      console.log("");
      err("Post-install failed");
      detail(`${marker.failure}\nWorktree kept at ${wtDir}\nRetry with: ${marker.recoveryCommand}`);
      throw new ExitError(1);
    }
    console.log("");
    if (code === 0) log("Post-install finished");
    else {
      marker.phase = "incomplete";
      marker.failure = `post-install exited ${code}`;
      marker.recoveryCommand = `cd ${shellQuote(wtDir)} && ${command}`;
      writeProvenance(wtDir, marker);
      err("Post-install failed");
      detail(`${marker.failure}\nWorktree kept at ${wtDir}\nRetry with: ${marker.recoveryCommand}`);
      throw new ExitError(code || 1);
    }
  } else if (createConfig.postInstall && opts.postInstall === false) {
    info("Skipping post-install (--no-post-install)");
  } else if (createConfig.postInstall && !installRan && opts.install) {
    info("Skipping post-install (dependencies were not installed)");
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

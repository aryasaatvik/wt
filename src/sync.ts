import {
  existsSync,
  copyFileSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { runAsync } from "./term.ts";

const ENV_BASENAME = /^(\.env(\..+)?|\.dev\.vars)$/;
const MANIFEST = ".worktreeinclude";

export function isEnvFile(rel: string): boolean {
  const name = basename(rel);
  return !name.endsWith(".example") && ENV_BASENAME.test(name);
}

export const SYNC_ALLOW_DIRS = [".scratchpad", ".vscode", ".idea", ".zed", ".claude"] as const;
const ALLOW_DIR_SET = new Set<string>(SYNC_ALLOW_DIRS);
const LEGACY_PATHSPECS = [
  ".env", ".env.*", ".dev.vars", ".scratchpad", ".vscode", ".idea", ".zed", ".claude",
  ":(glob)**/.env", ":(glob)**/.env.*", ":(glob)**/.dev.vars",
  ":(glob)**/.scratchpad/**", ":(glob)**/.vscode/**", ":(glob)**/.idea/**",
  ":(glob)**/.zed/**", ":(glob)**/.claude/**",
] as const;

export function isAllowed(rel: string): boolean {
  if (isEnvFile(rel)) return true;
  return rel.split("/").slice(0, -1).some((component) => ALLOW_DIR_SET.has(component));
}

/** Only state whose copying can corrupt Git or another worktree manager is unconditional. */
export const SYNC_EXCLUDE = [".git", ".claude/worktrees", ".conductor"] as const;

function matchesPathPrefix(rel: string, excluded: string): boolean {
  return rel === excluded || rel.startsWith(`${excluded}/`) || rel.includes(`/${excluded}/`) || rel.endsWith(`/${excluded}`);
}

export function isExcluded(rel: string): boolean {
  return SYNC_EXCLUDE.some((entry) => matchesPathPrefix(rel, entry));
}

export interface SyncConfig {
  requireInclude: boolean;
  exclude: string[];
}

export function readSyncConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  const path = join(configHome, "wt", "config.toml");
  if (!existsSync(path)) return { requireInclude: false, exclude: [] };
  const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as { sync?: { requireInclude?: unknown; exclude?: unknown } };
  const requireInclude = parsed.sync?.requireInclude;
  const exclude = parsed.sync?.exclude;
  if (requireInclude !== undefined && typeof requireInclude !== "boolean") {
    throw new Error(`${path}: sync.requireInclude must be a boolean`);
  }
  if (exclude !== undefined && (!Array.isArray(exclude) || exclude.some((item) => typeof item !== "string"))) {
    throw new Error(`${path}: sync.exclude must be an array of strings`);
  }
  return { requireInclude: requireInclude ?? false, exclude: (exclude as string[] | undefined) ?? [] };
}

export type SyncStatus = "copy" | "skip-identical" | "conflict" | "missing" | "excluded";

export interface SyncAction {
  path: string;
  status: SyncStatus;
  bytes: number;
  reason?: string;
}

export interface SyncPlan {
  source: string;
  target: string;
  mode: "manifest" | "legacy" | "none";
  manifestPath: string | null;
  manifestHash: string | null;
  actions: SyncAction[];
  summary: Record<SyncStatus, number>;
  bytesToCopy: number;
  force: boolean;
}

export interface PlanSyncOptions {
  config?: SyncConfig;
  force?: boolean;
}

function emptySummary(): Record<SyncStatus, number> {
  return { copy: 0, "skip-identical": 0, conflict: 0, missing: 0, excluded: 0 };
}

async function gitIgnored(repo: string, pathspecs: readonly string[] = []): Promise<string[]> {
  const result = await runAsync([
    "git", "-C", repo, "ls-files", "--others", "--ignored", "--exclude-standard", "-z",
    ...(pathspecs.length ? ["--", ...pathspecs] : []),
  ]);
  if (!result.ok) throw new Error(`git ls-files failed in ${repo}:\n${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

async function selectedByManifest(repo: string, manifestPath: string): Promise<string[]> {
  const result = await runAsync([
    "git", "-C", repo, "ls-files", "--others", "--ignored", `--exclude-from=${manifestPath}`, "-z",
  ]);
  if (!result.ok) throw new Error(`failed to evaluate ${manifestPath}:\n${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

async function ignoredByTarget(target: string, candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const p = Bun.spawn(["git", "-C", target, "check-ignore", "-z", "--stdin"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  p.stdin.write(candidates.join("\0") + "\0");
  await p.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && code !== 1) throw new Error(`git check-ignore failed in ${target}:\n${stderr}`);
  return new Set(stdout.split("\0").filter(Boolean));
}

async function matchIgnorePatterns(paths: string[], patterns: string[]): Promise<Set<string>> {
  if (paths.length === 0 || patterns.length === 0) return new Set();
  const dir = mkdtempSync(join(tmpdir(), "wt-ignore-"));
  try {
    const excludes = join(dir, "exclude");
    writeFileSync(excludes, patterns.join("\n") + "\n");
    const initialized = await runAsync(["git", "-C", dir, "init", "--quiet"]);
    if (!initialized.ok) throw new Error(`failed to initialize pattern matcher:\n${initialized.stderr}`);
    const p = Bun.spawn(
      ["git", "-C", dir, "-c", `core.excludesFile=${excludes}`, "check-ignore", "--no-index", "-z", "--stdin"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    p.stdin.write(paths.join("\0") + "\0");
    await p.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0 && code !== 1) throw new Error(`failed to evaluate sync.exclude:\n${stderr}`);
    return new Set(stdout.split("\0").filter(Boolean));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function identical(source: string, target: string): boolean {
  const sourceStat = lstatSync(source);
  const targetStat = lstatSync(target);
  if (sourceStat.isSymbolicLink() || targetStat.isSymbolicLink()) {
    return sourceStat.isSymbolicLink() && targetStat.isSymbolicLink() && readlinkSync(source) === readlinkSync(target);
  }
  if (!sourceStat.isFile() || !targetStat.isFile() || sourceStat.size !== targetStat.size) return false;
  return Bun.spawnSync(["cmp", "-s", source, target]).exitCode === 0;
}

export async function planSync(source: string, target: string, options: PlanSyncOptions = {}): Promise<SyncPlan> {
  const config = options.config ?? readSyncConfig();
  const manifestPath = join(source, MANIFEST);
  const hasManifest = existsSync(manifestPath);
  const mode = hasManifest ? "manifest" : config.requireInclude ? "none" : "legacy";
  const legacyIgnored = mode === "legacy" ? await gitIgnored(source, LEGACY_PATHSPECS) : [];
  const manifestSelected = mode === "manifest" ? await selectedByManifest(source, manifestPath) : [];
  const sourceIgnored = mode === "manifest" ? await ignoredByTarget(source, manifestSelected) : new Set(legacyIgnored);
  const selected = mode === "manifest"
    ? manifestSelected.filter((path) => sourceIgnored.has(path))
    : mode === "legacy" ? legacyIgnored.filter(isAllowed) : [];
  const targetIgnored = await ignoredByTarget(target, selected);
  const userExcluded = await matchIgnorePatterns(selected, config.exclude);
  const actions: SyncAction[] = [];

  for (const path of [...new Set(selected)].sort()) {
    const sourcePath = join(source, path);
    let stat;
    try { stat = lstatSync(sourcePath); } catch {
      actions.push({ path, status: "missing", bytes: 0, reason: "source disappeared" });
      continue;
    }
    const bytes = stat.isSymbolicLink() ? Buffer.byteLength(readlinkSync(sourcePath)) : stat.size;
    if (isExcluded(path)) actions.push({ path, status: "excluded", bytes, reason: "hard safety exclusion" });
    else if (userExcluded.has(path)) actions.push({ path, status: "excluded", bytes, reason: "sync.exclude" });
    else if (!targetIgnored.has(path)) actions.push({ path, status: "excluded", bytes, reason: "not ignored by target" });
    else {
      const targetPath = join(target, path);
      if (!lstatExists(targetPath)) actions.push({ path, status: "copy", bytes });
      else if (identical(sourcePath, targetPath)) actions.push({ path, status: "skip-identical", bytes });
      else if (options.force) actions.push({ path, status: "copy", bytes, reason: "overwrite (--force)" });
      else actions.push({ path, status: "conflict", bytes, reason: "target exists" });
    }
  }

  const summary = emptySummary();
  for (const action of actions) summary[action.status]++;
  return {
    source: resolve(source), target: resolve(target), mode,
    manifestPath: hasManifest ? manifestPath : null,
    manifestHash: hasManifest ? createHash("sha256").update(readFileSync(manifestPath)).digest("hex") : null,
    actions, summary, force: options.force ?? false,
    bytesToCopy: actions.filter((action) => action.status === "copy").reduce((sum, action) => sum + action.bytes, 0),
  };
}

export async function computeSyncFiles(repoRoot: string, wtDir: string): Promise<string[]> {
  return (await planSync(repoRoot, wtDir)).actions.filter((action) => action.status === "copy").map((action) => action.path);
}

type CopyKind = "rsync" | "symlink" | "skip";

export function classifyCopy(repoRoot: string, rel: string): CopyKind {
  const abs = join(repoRoot, rel);
  try {
    const stat = lstatSync(abs);
    return stat.isSymbolicLink() ? "symlink" : "rsync";
  } catch { return "skip"; }
}

function copyDanglingSymlink(repoRoot: string, wtDir: string, rel: string, force: boolean): void {
  const dest = join(wtDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (force && lstatExists(dest)) rmSync(dest);
  try {
    symlinkSync(readlinkSync(join(repoRoot, rel)), dest);
  } catch (e) {
    if (!force && (e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`target changed while copying: ${rel}`);
    throw e;
  }
}

function copyOne(repoRoot: string, wtDir: string, rel: string, verbose: boolean, force: boolean): void {
  const dest = join(wtDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    copyFileSync(join(repoRoot, rel), dest, force ? 0 : constants.COPYFILE_EXCL);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (!force && (code === "EEXIST" || code === "EISDIR")) throw new Error(`target changed while copying: ${rel}`);
    throw e;
  }
  if (verbose) console.log(rel);
}

export async function rsyncFiles(repoRoot: string, wtDir: string, files: string[], verbose: boolean, force = false): Promise<void> {
  for (const path of files) copyOne(repoRoot, wtDir, path, verbose, force);
}

export async function syncFiles(repoRoot: string, wtDir: string, files: string[], verbose: boolean, force = false): Promise<string[]> {
  const rsyncList: string[] = [];
  const dangling: string[] = [];
  for (const rel of files) {
    const kind = classifyCopy(repoRoot, rel);
    if (kind === "rsync") rsyncList.push(rel);
    else if (kind === "symlink") dangling.push(rel);
  }
  await rsyncFiles(repoRoot, wtDir, rsyncList, verbose, force);
  for (const rel of dangling) {
    copyDanglingSymlink(repoRoot, wtDir, rel, force);
    if (verbose) console.log(rel);
  }
  const landed = new Set([...rsyncList, ...dangling]);
  return files.filter((rel) => landed.has(rel));
}

export async function applySyncPlan(plan: SyncPlan, verbose = false): Promise<string[]> {
  const files = plan.actions.filter((action) => action.status === "copy").map((action) => action.path);
  const landed = await syncFiles(plan.source, plan.target, files, verbose, plan.force);
  if (landed.length !== files.length) {
    throw new Error(`sync source changed while copying: ${files.filter((path) => !landed.includes(path)).join(", ")}`);
  }
  const conflicts = landed.filter((path) => !identical(join(plan.source, path), join(plan.target, path)));
  if (conflicts.length > 0) throw new Error(`target changed while copying: ${conflicts.join(", ")}`);
  return landed;
}

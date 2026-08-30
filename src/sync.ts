import {
  existsSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  readSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
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

const libcPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
const libcLibrary = dlopen(libcPath, {
  openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  renameat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring],
    returns: FFIType.i32,
  },
  symlinkat: { args: [FFIType.cstring, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  readlinkat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
});
const libc = libcLibrary.symbols;

function cString(value: string): Buffer {
  if (value.includes("\0")) throw new Error("sync path contains NUL");
  return Buffer.from(`${value}\0`);
}

interface SafeParent {
  fd: number;
  name: string;
}

/** Resolve parents relative to held directory descriptors so path replacement cannot redirect I/O. */
function openSafeParent(root: string, rel: string, create: boolean): SafeParent {
  const components = rel.split("/");
  if (components.some((component) => !component || component === "." || component === "..")) {
    throw new Error(`unsafe sync path: ${rel}`);
  }
  let fd = openSync(
    realpathSync.native(root),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const component of components.slice(0, -1)) {
      const name = cString(component);
      let child = libc.openat(
        fd,
        name,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        0,
      );
      if (child < 0 && create) {
        libc.mkdirat(fd, name, 0o777);
        child = libc.openat(
          fd,
          name,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          0,
        );
      }
      if (child < 0) throw new Error(`unsafe symlink or non-directory parent: ${rel}`);
      closeSync(fd);
      fd = child;
    }
    return { fd, name: components.at(-1)! };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function unlinkAt(parentFd: number, name: string): void {
  libc.unlinkat(parentFd, cString(name), 0);
}

function readlinkAt(parentFd: number, name: string): string {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const length = Number(libc.readlinkat(parentFd, cString(name), buffer, buffer.length));
  if (length < 0 || length === buffer.length)
    throw new Error(`sync source is not a readable symlink: ${name}`);
  return buffer.subarray(0, length).toString();
}

export function copyFileNoFollow(source: string, destination: string): void {
  let sourceFd: number | null = null;
  let destinationFd: number | null = null;
  let destinationCreated = false;
  try {
    sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(sourceFd);
    if (!stat.isFile()) throw new Error(`sync source is not a regular file: ${source}`);
    destinationFd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, stat.mode);
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const read = readSync(sourceFd, buffer, 0, buffer.length, offset);
      if (read === 0) break;
      let written = 0;
      while (written < read) written += writeSync(destinationFd, buffer, written, read - written);
      offset += read;
    }
    fchmodSync(destinationFd, stat.mode);
    futimesSync(destinationFd, stat.atime, stat.mtime);
  } catch (e) {
    if (destinationCreated && lstatExists(destination)) rmSync(destination);
    throw e;
  } finally {
    if (destinationFd !== null) closeSync(destinationFd);
    if (sourceFd !== null) closeSync(sourceFd);
  }
}

export function copyFileNoFollowAt(
  sourceParent: number,
  sourceName: string,
  destinationParent: number,
  destinationName: string,
): void {
  let sourceFd: number | null = null;
  let destinationFd: number | null = null;
  let destinationCreated = false;
  try {
    sourceFd = libc.openat(
      sourceParent,
      cString(sourceName),
      constants.O_RDONLY | constants.O_NOFOLLOW,
      0,
    );
    if (sourceFd < 0) throw new Error(`sync source changed while copying: ${sourceName}`);
    const stat = fstatSync(sourceFd);
    if (!stat.isFile()) throw new Error(`sync source is not a regular file: ${sourceName}`);
    destinationFd = libc.openat(
      destinationParent,
      cString(destinationName),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      stat.mode,
    );
    if (destinationFd < 0)
      throw Object.assign(new Error(`target changed while copying: ${destinationName}`), {
        code: "EEXIST",
      });
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const read = readSync(sourceFd, buffer, 0, buffer.length, offset);
      if (read === 0) break;
      let written = 0;
      while (written < read) written += writeSync(destinationFd, buffer, written, read - written);
      offset += read;
    }
    fchmodSync(destinationFd, stat.mode);
    futimesSync(destinationFd, stat.atime, stat.mtime);
  } catch (error) {
    if (destinationCreated) unlinkAt(destinationParent, destinationName);
    throw error;
  } finally {
    if (destinationFd !== null && destinationFd >= 0) closeSync(destinationFd);
    if (sourceFd !== null && sourceFd >= 0) closeSync(sourceFd);
  }
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
  const source = openSafeParent(repoRoot, rel, false);
  let destination: SafeParent | null = null;
  try {
    destination = openSafeParent(wtDir, rel, true);
    const linkTarget = readlinkAt(source.fd, source.name);
    const name = force ? `.wt-sync-${randomUUID()}` : destination.name;
    if (libc.symlinkat(cString(linkTarget), destination.fd, cString(name)) < 0) {
      throw new Error(`target changed while copying: ${rel}`);
    }
    if (
      force &&
      libc.renameat(destination.fd, cString(name), destination.fd, cString(destination.name)) < 0
    ) {
      unlinkAt(destination.fd, name);
      throw new Error(`target changed while copying: ${rel}`);
    }
  } finally {
    if (destination) closeSync(destination.fd);
    closeSync(source.fd);
  }
}

function copyOne(
  repoRoot: string,
  wtDir: string,
  rel: string,
  verbose: boolean,
  force: boolean,
): void {
  const source = openSafeParent(repoRoot, rel, false);
  let destination: SafeParent | null = null;
  try {
    destination = openSafeParent(wtDir, rel, true);
    if (force) {
      const temp = `.wt-sync-${randomUUID()}`;
      try {
        copyFileNoFollowAt(source.fd, source.name, destination.fd, temp);
        if (
          libc.renameat(destination.fd, cString(temp), destination.fd, cString(destination.name)) <
          0
        ) {
          throw new Error(`target changed while copying: ${rel}`);
        }
      } finally {
        unlinkAt(destination.fd, temp);
      }
    } else {
      copyFileNoFollowAt(source.fd, source.name, destination.fd, destination.name);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (!force && (code === "EEXIST" || code === "EISDIR"))
      throw new Error(`target changed while copying: ${rel}`);
    throw e;
  } finally {
    if (destination) closeSync(destination.fd);
    closeSync(source.fd);
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

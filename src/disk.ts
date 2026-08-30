import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { listWorktrees, resolvePrimaryRepo } from "./git.ts";
import { runAsync } from "./term.ts";

export interface WorktreeDiskUsage {
  checkoutKb: number;
  privateGitKb: number;
  ownedKb: number;
  sharedKb?: number;
}

export interface WorktreeDiskReport {
  path: string;
  branch: string | null;
  primary: boolean;
  cached: boolean;
  usage: WorktreeDiskUsage | null;
}

export type DiskMode = "cached" | "fresh";

interface RepoMetadata {
  gitDir: string;
  commonDir: string;
}

const CACHE_VERSION = 2;
const CACHE_FILE = "wt-size.json";
const CACHE_TTL_MS = 24 * 3600_000;

function canonical(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function minimalRoots(paths: string[]): string[] {
  const roots: string[] = [];
  for (const path of [...new Set(paths.map(canonical))].sort((a, b) => a.length - b.length)) {
    if (!roots.some((root) => contains(root, path))) roots.push(path);
  }
  return roots;
}

async function duKb(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  const result = await runAsync(["du", "-sk", path]);
  if (!result.ok) throw new Error(`du failed for ${path}:\n${result.stderr}`);
  const value = Number(result.stdout.trim().split(/\s+/)[0]);
  if (!Number.isFinite(value)) throw new Error(`du returned an invalid size for ${path}`);
  return value;
}

async function sumKb(paths: string[]): Promise<number> {
  const values = await Promise.all(minimalRoots(paths).map(duKb));
  return values.reduce((sum, value) => sum + value, 0);
}

async function checkoutKb(worktree: string, metadata: RepoMetadata[]): Promise<number> {
  if (!existsSync(worktree)) return 0;
  const entries = readdirSync(worktree).filter((name) => name !== ".git").map((name) => join(worktree, name));
  const total = await sumKb(entries);
  const topGit = join(worktree, ".git");
  const nestedMetadata = minimalRoots(
    metadata.flatMap((item) => [item.gitDir, item.commonDir]).filter((path) => contains(worktree, path) && !contains(topGit, path)),
  );
  return Math.max(0, total - await sumKb(nestedMetadata));
}

async function metadataFor(repoPath: string): Promise<RepoMetadata | null> {
  const [gitDir, commonDir] = await Promise.all([
    runAsync(["git", "-C", repoPath, "rev-parse", "--absolute-git-dir"]),
    runAsync(["git", "-C", repoPath, "rev-parse", "--git-common-dir"]),
  ]);
  if (!gitDir.ok || !commonDir.ok) return null;
  const common = commonDir.stdout.trim();
  return {
    gitDir: canonical(gitDir.stdout.trim()),
    commonDir: canonical(isAbsolute(common) ? common : resolve(repoPath, common)),
  };
}

async function nestedRepos(worktree: string): Promise<string[]> {
  const result = await runAsync([
    "git", "-C", worktree, "submodule", "foreach", "--recursive", "--quiet", "pwd -P",
  ]);
  if (!result.ok) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).map(canonical);
}

async function metadataTree(worktree: string): Promise<RepoMetadata[]> {
  const paths = [worktree, ...(await nestedRepos(worktree))];
  const metadata = await Promise.all(paths.map(metadataFor));
  return metadata.filter((item): item is RepoMetadata => item !== null);
}

function cachePath(metadata: RepoMetadata[]): string | null {
  return metadata[0] ? join(metadata[0].gitDir, CACHE_FILE) : null;
}

function readCache(path: string | null): WorktreeDiskUsage | null {
  if (!path) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      measuredAt?: unknown;
      usage?: WorktreeDiskUsage;
    };
    const age = Date.now() - Date.parse(String(value.measuredAt));
    if (value.version !== CACHE_VERSION || age < 0 || age >= CACHE_TTL_MS || !value.usage) return null;
    const fields = [value.usage.checkoutKb, value.usage.privateGitKb, value.usage.ownedKb];
    return fields.every((field) => typeof field === "number" && Number.isFinite(field)) ? value.usage : null;
  } catch { return null; }
}

function writeCache(path: string | null, usage: WorktreeDiskUsage): void {
  if (!path) return;
  try {
    writeFileSync(path, `${JSON.stringify({ version: CACHE_VERSION, measuredAt: new Date().toISOString(), usage })}\n`);
  } catch { /* cache is best-effort */ }
}

export async function measureDiskUsage(cwd: string, mode: DiskMode = "cached"): Promise<WorktreeDiskReport[]> {
  const primary = resolvePrimaryRepo(cwd);
  const worktrees = listWorktrees(primary);
  const metadata = await Promise.all(worktrees.map((worktree) => metadataTree(worktree.path)));
  const cached = mode === "cached" ? metadata.map((tree) => readCache(cachePath(tree))) : metadata.map(() => null);

  const privateByWorktree = metadata.map((tree) => minimalRoots(tree.filter((item) => item.gitDir !== item.commonDir).map((item) => item.gitDir)));
  const allPrivate = minimalRoots(privateByWorktree.flat());
  const sharedRoots = minimalRoots(metadata.flatMap((tree) => tree.map((item) => item.commonDir)));
  // Shared storage is repository-wide. Reuse it only when every lane's cache
  // is valid; if any lane needs measurement, refresh the common total for all
  // reports so a stale cache cannot contaminate newly measured lanes.
  const cachedShared = cached.every((usage) => usage !== null)
    ? cached.find((usage) => typeof usage?.sharedKb === "number")?.sharedKb
    : undefined;
  const sharedKb = cachedShared ?? Math.max(
    0,
    await sumKb(sharedRoots) - await sumKb(allPrivate.filter((path) => sharedRoots.some((root) => contains(root, path)))),
  );

  const reports = await Promise.all(worktrees.map(async (worktree, index): Promise<WorktreeDiskReport> => {
    if (!existsSync(worktree.path)) {
      return { path: worktree.path, branch: worktree.branch, primary: false, cached: false, usage: null };
    }
    if (cached[index]) {
      const usage = { ...cached[index]!, sharedKb };
      if (cached[index]!.sharedKb !== sharedKb) writeCache(cachePath(metadata[index]!), usage);
      return {
        path: worktree.path,
        branch: worktree.branch,
        primary: worktree.path === primary,
        cached: true,
        usage,
      };
    }
    const tree = metadata[index]!;
    const checkoutSizeKb = await checkoutKb(worktree.path, tree);
    const privateGitKb = await sumKb(privateByWorktree[index]!);
    const usage = { checkoutKb: checkoutSizeKb, privateGitKb, ownedKb: checkoutSizeKb + privateGitKb, sharedKb };
    writeCache(cachePath(tree), usage);
    return { path: worktree.path, branch: worktree.branch, primary: worktree.path === primary, cached: false, usage };
  }));
  return reports;
}

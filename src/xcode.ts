// Xcode build outputs owned by a worktree, removed with it.
//
// Two producers write regenerable build output outside the checkout, keyed by
// the checkout's path, and nothing deletes it when the lane goes away:
//
// - XcodeBuildMCP (renamed MobileBuildMCP) keeps one workspace per root under
//   ~/Library/Developer/<name>/workspaces/<slug>-<sha256(root)[:12]>, holding
//   DerivedData/<project>-<hash>/info.plist plus logs and test products.
// - Xcode keeps ~/Library/Developer/Xcode/DerivedData/<project>-<hash>/.
//
// Each DerivedData folder's info.plist records the WorkspacePath it built.
// Ownership is decided from those paths and the MCP workspace key, never from
// a name alone, and nothing here follows a symlink. Branches and source are
// never touched: only these build folders.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "bun";
import { pool, runAsync } from "./term.ts";

export type XcodeOutputKind = "workspace" | "derived-data";

export interface XcodeOutput {
  kind: XcodeOutputKind;
  path: string;
  /** null when the size could not be measured */
  kb: number | null;
  dev: number;
  ino: number;
}

export interface XcodeSkip {
  path: string;
  reason: string;
}

export interface XcodePlan {
  outputs: XcodeOutput[];
  skipped: XcodeSkip[];
}

export interface XcodeRemoval {
  removed: XcodeOutput[];
  skipped: XcodeSkip[];
}

export interface OpenFile {
  pid: number;
  path: string;
}

export interface BuildProcess {
  pid: number;
  command: string;
}

/** A point-in-time view of what might be writing build output. */
export interface Activity {
  /** null when open files cannot be listed; every output is then kept */
  openFiles: OpenFile[] | null;
  processes: BuildProcess[] | null;
}

export interface XcodeEnv {
  /** default: process.platform; anything but darwin is a no-op */
  platform?: NodeJS.Platform;
  /** default: ~/Library/Developer */
  libraryRoot?: string;
  /** default: lsof + ps; injectable for tests */
  activity?: () => Promise<Activity>;
}

/** Remove-time setting: false opts out entirely. */
export type XcodeSetting = XcodeEnv | false;

const MCP_DIRS = ["XcodeBuildMCP", "MobileBuildMCP"] as const;
const BUILD_PROCESS = /(^|\/)(xcodebuild|XCBBuildService|swift-frontend)(\s|$)/;

/** `[remove] xcode = false` in ~/.config/wt/config.toml opts out. */
export function readXcodeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  const path = join(configHome, "wt", "config.toml");
  if (!existsSync(path)) return true;
  const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as { remove?: { xcode?: unknown } };
  const value = parsed.remove?.xcode;
  if (value !== undefined && typeof value !== "boolean")
    throw new Error(`${path}: remove.xcode must be a boolean`);
  return value ?? true;
}

/** Combine the --keep-xcode flag with config; explicit settings pass through. */
export function resolveXcodeSetting(keepFlag: boolean, setting?: XcodeSetting): XcodeSetting {
  if (keepFlag || setting === false) return false;
  if (setting) return setting;
  return readXcodeEnabled() ? {} : false;
}

/** The MCP's workspace key for a root: slug(basename) + sha256(root)[:12]. */
export function mcpWorkspaceKey(root: string): string {
  const slug =
    (basename(root) || "workspace")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 64) || "workspace";
  return `${slug}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}

/** The spellings of a worktree root a build tool may have recorded. */
export function worktreeRoots(worktree: string): string[] {
  const roots = [resolve(worktree)];
  try {
    roots.push(realpathSync.native(worktree));
  } catch {}
  return [...new Set(roots)];
}

function under(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[lower]!;
  });
}

/** WorkspacePath from a build folder's info.plist; null when absent or unreadable. */
export function readWorkspacePath(folder: string): string | null {
  const plist = join(folder, "info.plist");
  const stat = lstatSync(plist, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  try {
    const bytes = readFileSync(plist);
    if (bytes.subarray(0, 8).toString("latin1") === "bplist00") {
      const out = spawnSync(["plutil", "-extract", "WorkspacePath", "raw", "-o", "-", plist], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const value = out.success ? out.stdout.toString().trim() : "";
      return isAbsolute(value) ? value : null;
    }
    const match = /<key>WorkspacePath<\/key>\s*<string>([^<]*)<\/string>/.exec(
      bytes.toString("utf8"),
    );
    const value = match ? decodeXml(match[1]!) : "";
    return isAbsolute(value) ? value : null;
  } catch {
    return null;
  }
}

/** Real (non-symlink) child directories of a real directory. */
function childDirs(dir: string): string[] {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false);
}

/** The root whose key names this workspace, found among its projects' ancestors. */
function inferMcpRoot(key: string, workspacePaths: string[]): string | null {
  for (const path of workspacePaths) {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      if (mcpWorkspaceKey(dir) === key) return dir;
      if (dirname(dir) === dir) break;
    }
  }
  return null;
}

interface Candidate {
  kind: XcodeOutputKind;
  path: string;
}

function discover(
  roots: string[],
  libraryRoot: string,
): { candidates: Candidate[]; skipped: XcodeSkip[] } {
  const keys = new Set(roots.map(mcpWorkspaceKey));
  const candidates: Candidate[] = [];
  const skipped: XcodeSkip[] = [];
  const container = (path: string): boolean => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) skipped.push({ path, reason: "symlink, not followed" });
    return stat?.isDirectory() ?? false;
  };

  for (const name of MCP_DIRS) {
    const base = join(libraryRoot, name, "workspaces");
    if (!container(base)) continue;
    for (const entry of readdirSync(base)) {
      const workspace = join(base, entry);
      const stat = lstatSync(workspace, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink() && keys.has(entry)) {
        skipped.push({ path: workspace, reason: "symlink, not followed" });
        continue;
      }
      if (!stat?.isDirectory()) continue;
      const derived = join(workspace, "DerivedData");
      if (lstatSync(derived, { throwIfNoEntry: false })?.isSymbolicLink()) {
        if (keys.has(entry)) skipped.push({ path: derived, reason: "symlink, not followed" });
        continue;
      }
      const projects = childDirs(derived).map((path) => ({
        path,
        source: readWorkspacePath(path),
      }));
      const sources = projects.flatMap((p) => (p.source ? [p.source] : []));
      const root = keys.has(entry) ? roots[0]! : inferMcpRoot(entry, sources);
      // The workspace is the lane's when its key is the lane's (or names a root
      // inside the lane) and nothing it built lives elsewhere. A workspace of
      // an unknown root qualifies only on evidence: every build is the lane's.
      const owned =
        sources.every((source) => under(source, roots)) &&
        (root ? under(root, roots) : sources.length > 0);
      if (owned) {
        candidates.push({ kind: "workspace", path: workspace });
        continue;
      }
      for (const project of projects)
        if (project.source && under(project.source, roots))
          candidates.push({ kind: "derived-data", path: project.path });
    }
  }

  const xcodeDerived = join(libraryRoot, "Xcode", "DerivedData");
  if (container(xcodeDerived)) {
    for (const path of childDirs(xcodeDerived)) {
      const source = readWorkspacePath(path);
      if (source && under(source, roots)) candidates.push({ kind: "derived-data", path });
    }
  }
  return { candidates, skipped };
}

async function sizeKb(path: string): Promise<number | null> {
  // du never follows symlinks unless asked (-P is the default).
  const result = await runAsync(["du", "-sk", path]);
  const value = Number(result.stdout.trim().split(/\s+/)[0]);
  return result.ok && Number.isFinite(value) ? value : null;
}

/** Machine-wide open files (lsof) and build processes (ps). */
export async function probeActivity(): Promise<Activity> {
  const [lsof, ps] = await Promise.all([
    runAsync(["lsof", "-n", "-P", "-w", "-F", "pn"]),
    runAsync(["ps", "-axww", "-o", "pid=,args="]),
  ]);
  let openFiles: OpenFile[] | null = null;
  // lsof exits 1 when some process could not be read; a listing is still a listing.
  if (lsof.stdout.trim()) {
    openFiles = [];
    let pid = 0;
    for (const line of lsof.stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n/")) openFiles.push({ pid, path: line.slice(1) });
    }
  }
  const processes = ps.ok
    ? ps.stdout
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null && BUILD_PROCESS.test(m[2]!))
        .map((m) => ({ pid: Number(m[1]), command: m[2]! }))
    : null;
  return { openFiles, processes };
}

/** Why an output must be kept right now, or null when it is idle. */
export function busyReason(path: string, roots: string[], activity: Activity): string | null {
  if (!activity.openFiles) return "cannot list open files (lsof unavailable)";
  if (!activity.processes) return "cannot list build processes (ps unavailable)";
  const open = activity.openFiles.find((file) => under(file.path, [path]));
  if (open) return `open file ${open.path} (pid ${open.pid})`;
  const build = activity.processes.find(
    (proc) =>
      BUILD_PROCESS.test(proc.command) &&
      [...roots, path].some((ref) => proc.command.includes(ref)),
  );
  if (build) {
    const name = BUILD_PROCESS.exec(build.command)![2];
    return `running ${name} (pid ${build.pid}) references the worktree`;
  }
  return null;
}

/** Share one activity probe across many plans (reap previews). */
export function memoizeActivity(probe: () => Promise<Activity>): () => Promise<Activity> {
  let cached: Promise<Activity> | null = null;
  return () => (cached ??= probe());
}

/**
 * Find a worktree's Xcode build outputs and measure them. With `checkActivity`
 * the plan already lists busy outputs as skipped, for previews; removal always
 * rechecks with a fresh probe.
 */
export async function planXcodeOutputs(
  worktree: string | string[],
  env: XcodeEnv = {},
  opts: { checkActivity?: boolean } = {},
): Promise<XcodePlan> {
  if ((env.platform ?? process.platform) !== "darwin") return { outputs: [], skipped: [] };
  const roots = typeof worktree === "string" ? worktreeRoots(worktree) : worktree;
  const libraryRoot = env.libraryRoot ?? join(homedir(), "Library", "Developer");
  let found: ReturnType<typeof discover>;
  try {
    found = discover(roots, libraryRoot);
  } catch (error) {
    // Callers run this after the worktree is gone; a scan error is a report.
    const reason = `cannot scan: ${error instanceof Error ? error.message : error}`;
    return { outputs: [], skipped: [{ path: libraryRoot, reason }] };
  }
  const { candidates, skipped } = found;
  if (candidates.length === 0) return { outputs: [], skipped };
  const activity = opts.checkActivity ? await (env.activity ?? probeActivity)() : null;
  const outputs: XcodeOutput[] = [];
  await pool(candidates, 4, async (candidate) => {
    const stat = lstatSync(candidate.path, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return;
    const busy = activity ? busyReason(candidate.path, roots, activity) : null;
    if (busy) {
      skipped.push({ path: candidate.path, reason: busy });
      return;
    }
    outputs.push({ ...candidate, kb: await sizeKb(candidate.path), dev: stat.dev, ino: stat.ino });
  });
  outputs.sort((a, b) => a.path.localeCompare(b.path));
  return { outputs, skipped };
}

/**
 * Remove planned outputs that are still the same directories and idle. A
 * skipped output is reported, never retried or forced.
 */
export async function removeXcodeOutputs(
  plan: XcodePlan,
  roots: string[],
  env: XcodeEnv = {},
): Promise<XcodeRemoval> {
  const removed: XcodeOutput[] = [];
  const skipped = [...plan.skipped];
  if (plan.outputs.length === 0) return { removed, skipped };
  const activity = await (env.activity ?? probeActivity)();
  for (const output of plan.outputs) {
    const stat = lstatSync(output.path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isDirectory() || stat.dev !== output.dev || stat.ino !== output.ino) {
      skipped.push({ path: output.path, reason: "changed since planning" });
      continue;
    }
    const busy = busyReason(output.path, roots, activity);
    if (busy) {
      skipped.push({ path: output.path, reason: busy });
      continue;
    }
    try {
      // Recursive rm unlinks symlinks inside the tree without following them.
      rmSync(output.path, { recursive: true });
      removed.push(output);
    } catch (error) {
      skipped.push({
        path: output.path,
        reason: `cannot remove: ${error instanceof Error ? error.message : error}`,
      });
    }
  }
  return { removed, skipped };
}

export function totalKb(outputs: XcodeOutput[]): number {
  return outputs.reduce((sum, output) => sum + (output.kb ?? 0), 0);
}

export function outputLabel(output: XcodeOutput): string {
  return output.kind === "workspace" ? "build workspace" : "DerivedData";
}

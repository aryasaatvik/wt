// Gitignored-file sync: copy env, scratchpad, and editor/agent config from the
// primary into a fresh worktree. Artifact trees stay behind; dangling links
// are copied as links so macOS openrsync cannot fail the whole create.

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runAsync } from "./term.ts";

const ENV_BASENAME = /^(\.env(\..+)?|\.dev\.vars)$/;

/** Env file = .env, .env.*, .dev.vars — but never *.example. */
export function isEnvFile(rel: string): boolean {
  const name = basename(rel);
  if (name.endsWith(".example")) return false;
  return ENV_BASENAME.test(name);
}

// Directory components that may sync. Nested env files match via isEnvFile
// even when their parents are not listed here.
export const SYNC_ALLOW_DIRS = [".scratchpad", ".vscode", ".idea", ".zed", ".claude"] as const;

const ALLOW_DIR_SET = new Set<string>(SYNC_ALLOW_DIRS);

// Pathspecs keep `git ls-files` out of ignored artifact trees (e2e runs,
// .alchemy, node_modules). Root entries cover a missing `**` zero-directory
// match; globs cover the same names nested in packages.
const SYNC_PATHSPECS = [
  ".env",
  ".env.*",
  ".dev.vars",
  ".scratchpad",
  ".vscode",
  ".idea",
  ".zed",
  ".claude",
  ":(glob)**/.env",
  ":(glob)**/.env.*",
  ":(glob)**/.dev.vars",
  ":(glob)**/.scratchpad/**",
  ":(glob)**/.vscode/**",
  ":(glob)**/.idea/**",
  ":(glob)**/.zed/**",
  ":(glob)**/.claude/**",
] as const;

export function isAllowed(rel: string): boolean {
  if (isEnvFile(rel)) return true;
  const dirs = rel.split("/").slice(0, -1);
  return dirs.some((comp) => ALLOW_DIR_SET.has(comp));
}

// Entries name heavy artifact DIRECTORIES and match directory components as
// prefixes: `DerivedData` excludes both `DerivedData/` and
// `DerivedDataDevice/`. The final path component is a file, never matched by
// prefix. Entries containing `/` match that relative segment sequence at any
// directory boundary. Backstop after the allowlist — `.claude/worktrees`
// lives under an allowed dir.
export const SYNC_EXCLUDE = [
  // JS/TS
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  ".vercel",
  ".cache",
  // Infra
  ".sst",
  ".wrangler",
  // Xcode/Swift
  "build",
  ".build",
  "DerivedData",
  "Pods",
  "Carthage",
  "xcuserdata",
  // Agent/tooling state that must stay lane-local
  ".claude/worktrees",
  ".conductor",
  ".playwright",
] as const;

const PATH_EXCLUDES = SYNC_EXCLUDE.filter((e) => e.includes("/"));
const COMPONENT_EXCLUDES = SYNC_EXCLUDE.filter((e) => !e.includes("/"));

export function isExcluded(rel: string): boolean {
  for (const e of PATH_EXCLUDES) {
    if (rel === e || rel.startsWith(`${e}/`) || rel.includes(`/${e}/`) || rel.endsWith(`/${e}`)) {
      return true;
    }
  }
  const dirs = rel.split("/").slice(0, -1);
  return dirs.some((comp) => COMPONENT_EXCLUDES.some((e) => comp.startsWith(e)));
}

/**
 * Files to sync: gitignored config in the primary AND ignored by the
 * worktree's own gitignore (so a divergent source .gitignore can't plant
 * untracked files), minus heavy artifacts.
 */
export async function computeSyncFiles(repoRoot: string, wtDir: string): Promise<string[]> {
  const ignored = await runAsync([
    "git",
    "-C",
    repoRoot,
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ...SYNC_PATHSPECS,
  ]);
  if (!ignored.ok) throw new Error(`git ls-files failed:\n${ignored.stderr}`);
  const candidates = [
    ...new Set(
      ignored.stdout
        .split("\0")
        .filter((f) => f && isAllowed(f) && !isExcluded(f)),
    ),
  ];
  if (candidates.length === 0) return [];

  // check-ignore exits 1 when NOTHING matched — that's an empty result, not an error.
  const p = Bun.spawn(["git", "-C", wtDir, "check-ignore", "-z", "--stdin"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  p.stdin.write(candidates.join("\0") + "\0");
  await p.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0 && code !== 1) throw new Error(`git check-ignore failed:\n${stderr}`);
  return stdout.split("\0").filter(Boolean);
}

type CopyKind = "rsync" | "symlink" | "skip";

/** Classify a repo-relative path at copy time (TOCTOU against ls-files). */
export function classifyCopy(repoRoot: string, rel: string): CopyKind {
  const abs = join(repoRoot, rel);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() && !existsSync(abs)) return "symlink";
    return "rsync";
  } catch {
    return "skip";
  }
}

function copyDanglingSymlink(repoRoot: string, wtDir: string, rel: string): void {
  const dest = join(wtDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(readlinkSync(join(repoRoot, rel)), dest);
}

/** rsync the given repo-relative files from repoRoot into wtDir. Throws on failure. */
export async function rsyncFiles(
  repoRoot: string,
  wtDir: string,
  files: string[],
  verbose: boolean,
): Promise<void> {
  if (files.length === 0) return;
  const p = Bun.spawn(
    ["rsync", verbose ? "-av" : "-a", "--files-from=-", `${repoRoot}/`, `${wtDir}/`],
    { stdin: "pipe", stdout: verbose ? "inherit" : "ignore", stderr: "pipe" },
  );
  p.stdin.write(files.join("\n") + "\n");
  await p.stdin.end();
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(stderr || `rsync exited ${code}`);
}

/**
 * Copy allowlisted files into the worktree. Regular files go through rsync;
 * dangling symlinks are recreated with `symlink` because openrsync `stat()`s
 * the missing target and exits 23. Returns the paths that actually landed.
 */
export async function syncFiles(
  repoRoot: string,
  wtDir: string,
  files: string[],
  verbose: boolean,
): Promise<string[]> {
  const rsyncList: string[] = [];
  const dangling: string[] = [];
  for (const rel of files) {
    const kind = classifyCopy(repoRoot, rel);
    if (kind === "rsync") rsyncList.push(rel);
    else if (kind === "symlink") dangling.push(rel);
  }
  await rsyncFiles(repoRoot, wtDir, rsyncList, verbose);
  for (const rel of dangling) {
    copyDanglingSymlink(repoRoot, wtDir, rel);
    if (verbose) console.log(rel);
  }
  const landed = new Set([...rsyncList, ...dangling]);
  return files.filter((rel) => landed.has(rel));
}

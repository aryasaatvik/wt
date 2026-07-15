// Gitignored-file sync: mirror env files, .scratchpad, editor config, etc.
// from the primary repo into a fresh worktree, skipping heavy artifacts.

import { runAsync } from "./term.ts";

// Entries match path COMPONENTS as prefixes: `DerivedData` excludes both
// `DerivedData/` and `DerivedDataDevice/`. Entries containing `/` match that
// relative segment sequence at any directory boundary.
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
  return rel.split("/").some((comp) => COMPONENT_EXCLUDES.some((e) => comp.startsWith(e)));
}

/**
 * Files to sync: gitignored in the primary AND ignored by the worktree's own
 * gitignore (so a divergent source .gitignore can't plant untracked files),
 * minus heavy artifacts.
 */
export async function computeSyncFiles(repoRoot: string, wtDir: string): Promise<string[]> {
  const ignored = await runAsync(["git", "-C", repoRoot, "ls-files", "--others", "--ignored", "--exclude-standard"]);
  if (!ignored.ok) throw new Error(`git ls-files failed:\n${ignored.stderr}`);
  const candidates = ignored.stdout.split("\n").filter((f) => f && !isExcluded(f));
  if (candidates.length === 0) return [];

  // check-ignore exits 1 when NOTHING matched — that's an empty result, not an error.
  const p = Bun.spawn(["git", "-C", wtDir, "check-ignore", "--stdin"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  p.stdin.write(candidates.join("\n") + "\n");
  await p.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0 && code !== 1) throw new Error(`git check-ignore failed:\n${stderr}`);
  return stdout.split("\n").filter(Boolean);
}

/** rsync the given repo-relative files from repoRoot into wtDir. Throws on failure. */
export async function rsyncFiles(
  repoRoot: string,
  wtDir: string,
  files: string[],
  verbose: boolean,
): Promise<void> {
  const p = Bun.spawn(
    ["rsync", verbose ? "-av" : "-a", "--files-from=-", `${repoRoot}/`, `${wtDir}/`],
    { stdin: "pipe", stdout: verbose ? "inherit" : "ignore", stderr: "pipe" },
  );
  p.stdin.write(files.join("\n") + "\n");
  await p.stdin.end();
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(stderr || `rsync exited ${code}`);
}

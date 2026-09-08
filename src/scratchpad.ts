import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runAsync } from "./term.ts";

export type ScratchpadState =
  | { kind: "absent" | "shared" | "legacy" }
  | { kind: "invalid"; reason: string };

export function statIfPresent(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Inspect only the directory entry; never walk the shared content. */
export function scratchpadState(primary: string, worktree: string): ScratchpadState {
  const target = join(primary, ".scratchpad");
  const canonical = statIfPresent(target);
  if (canonical && (!canonical.isDirectory() || canonical.isSymbolicLink())) {
    return { kind: "invalid", reason: "primary .scratchpad must be a real directory" };
  }
  const path = join(worktree, ".scratchpad");
  const local = statIfPresent(path);
  if (!local) return { kind: "absent" };
  if (local.isSymbolicLink()) {
    try {
      if (canonical && realpathSync(path) === realpathSync(target)) return { kind: "shared" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
    }
    return { kind: "invalid", reason: "worktree .scratchpad is broken or points outside the primary .scratchpad" };
  }
  if (local.isDirectory()) return { kind: "legacy" };
  return { kind: "invalid", reason: "worktree .scratchpad is not a directory or shared link" };
}

/** Tracked Scratchpad belongs to the project, not WT's ignored-state lifecycle. */
export async function assertUntrackedScratchpad(root: string): Promise<void> {
  const result = await runAsync(["git", "-C", root, "ls-files", "-z", "--", ".scratchpad"]);
  if (!result.ok) throw new Error(`cannot inspect tracked Scratchpad: ${result.stderr}`);
  if (result.stdout) throw new Error(`tracked .scratchpad in ${root}; sharing requires an ignored directory`);
}

export async function ensureSharedScratchpad(primary: string, worktree: string): Promise<void> {
  await assertUntrackedScratchpad(primary);
  await assertUntrackedScratchpad(worktree);
  const state = scratchpadState(primary, worktree);
  if (state.kind === "invalid") throw new Error(state.reason);
  if (state.kind === "legacy") throw new Error("worktree has a local .scratchpad; reconcile it before converting to shared storage");
  const target = join(primary, ".scratchpad");
  mkdirSync(target, { recursive: true });
  // A directory-only .gitignore rule does not ignore a symlink. Keep this
  // machine-local rule in the common exclude file, without editing project files.
  const result = await runAsync(["git", "-C", primary, "rev-parse", "--git-path", "info/exclude"]);
  if (!result.ok) throw new Error(`cannot resolve Git exclude file: ${result.stderr}`);
  const exclude = resolve(primary, result.stdout.trim());
  mkdirSync(dirname(exclude), { recursive: true });
  const contents = statIfPresent(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!contents.split(/\r?\n/).includes("/.scratchpad")) appendFileSync(exclude, "\n/.scratchpad\n");
  if (state.kind === "absent") {
    try { symlinkSync(relative(worktree, target), join(worktree, ".scratchpad"), "dir"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || scratchpadState(primary, worktree).kind !== "shared") throw error;
    }
  }
  if (scratchpadState(primary, worktree).kind !== "shared") throw new Error("shared Scratchpad changed during setup");
}

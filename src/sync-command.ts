import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { listWorktrees, resolvePrimaryRepo } from "./git.ts";
import { applySyncPlan, planSync, type SyncPlan } from "./sync.ts";
import { run } from "./term.ts";

export interface SyncCommandOptions {
  cwd: string;
  from?: string;
  to?: string;
  dryRun: boolean;
  json: boolean;
  force: boolean;
  verbose: boolean;
}

function currentRoot(cwd: string): string {
  const root = run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]).trim();
  if (!root) throw new Error("not inside a git worktree");
  return realpathSync.native(root);
}

function resolveLane(cwd: string, value: string | undefined, fallback: "primary" | "current"): string {
  const choice = value ?? fallback;
  if (choice === "primary") return resolvePrimaryRepo(cwd);
  if (choice === "current") return currentRoot(cwd);
  const path = resolve(cwd, choice);
  if (existsSync(path)) return realpathSync.native(path);
  const lane = listWorktrees(cwd).find((worktree) => worktree.branch === choice || worktree.path === choice);
  if (!lane) throw new Error(`worktree not found: ${choice}`);
  return lane.path;
}

export function renderSyncPlan(plan: SyncPlan): string {
  const lines = [
    `sync ${plan.source} -> ${plan.target}`,
    `mode: ${plan.mode}`,
    ...plan.actions.map((action) => `${action.status.padEnd(14)} ${action.path}${action.reason ? ` (${action.reason})` : ""}`),
    `copy ${plan.summary.copy}, identical ${plan.summary["skip-identical"]}, conflicts ${plan.summary.conflict}, excluded ${plan.summary.excluded}, missing ${plan.summary.missing}, bytes ${plan.bytesToCopy}`,
  ];
  return lines.join("\n");
}

export async function cmdSync(options: SyncCommandOptions): Promise<{ plan: SyncPlan; copied: string[] }> {
  const source = resolveLane(options.cwd, options.from, "primary");
  const target = resolveLane(options.cwd, options.to, "current");
  if (source === target) throw new Error("sync source and target resolve to the same worktree");
  const plan = await planSync(source, target, { force: options.force });
  const copied = options.dryRun ? [] : await applySyncPlan(plan, options.verbose);
  return { plan, copied };
}

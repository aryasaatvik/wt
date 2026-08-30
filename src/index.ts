// wt — git worktree helper.
//
// Creates worktrees as siblings of the repo (`../<repo>-worktrees/<slug>/`,
// branch slashes → dashes), syncs gitignored config (env, .scratchpad, editor
// settings) from the source repo, and installs dependencies via `ni`.

import { cmdNew } from "./create.ts";
import { branchExists, defaultBase } from "./git.ts";
import { cmdLs } from "./ls.ts";
import { cmdRm } from "./rm.ts";
import { bold, spinner } from "./term.ts";
import { err, ExitError } from "./ui.ts";

const HELP = `${bold("Usage:")} wt <command> [args]

${bold("Commands:")}
  wt                   Interactive picker (TTY only)
  wt [new|create] <branch> [base] [flags]
                       Create worktree from base branch (default: origin/HEAD)
                       Checks out the branch if it already exists
                       Extra flags are passed to git worktree add
  wt sync [flags]       Copy selected ignored files between worktrees
                       --from primary|current|<path>  source (default: primary)
                       --to <branch|path>             target (default: current)
                       --dry-run  plan only · --json  machine-readable plan
                       --force    overwrite conflicting target files
  wt rm|remove <target> [flags]
                       Remove worktree (keeps branch by default)
                       <target> is a branch name, worktree dir name, or path —
                       detached worktrees are addressed by dir name or path
                       -D, --delete-branch  Also delete the branch
                       Refuses dirty worktrees; wt never uses --force
  wt ls|list [flags]    Status table: branch, dirty, ahead/behind, PR, size, age
                       Sizes come from a 24h per-worktree cache (~ marks
                       a cached value); du only runs on cache misses
                       -v, --verdicts  append reachability verdicts
                       --json     machine-readable records
                       --all      scan every <repo>-worktrees dir under ~/Developer
                       --fresh    remeasure sizes, ignoring the cache
                       --no-size  skip size measurement entirely
  wt reap [flags]       Report reapable worktrees (dry run by default)
                       Auto-removable: REACHABLE, REACHABLE_BRANCH, EMPTY,
                       CONTENT_LANDED — never dirty/env-drifted/stranded lanes
                       --apply             remove them (branches are kept)
                       --all               sweep every repo under ~/Developer
                       --older-than <days> only lanes with older last commits

${bold("Options:")}
  --verbose            Show detailed rsync output
  --no-install         Skip dependency install
  -h, --help           Show this help`;

let verbose = false;
let install = true;
const args: string[] = [];
for (const a of process.argv.slice(2)) {
  if (a === "--verbose") verbose = true;
  else if (a === "--no-install") install = false;
  else args.push(a);
}

if (args[0] === "-h" || args[0] === "--help") {
  console.log(HELP);
  process.exit(0);
}

const cwd = process.cwd();

// Bare `wt` is the "look around" gesture: the picker owns the terminal, so it
// only makes sense on a TTY. Every subcommand stays inline and leaves its
// output in scrollback. Piped or scripted, bare wt is just help.
if (args.length === 0) {
  if (!process.stdout.isTTY) {
    console.log(HELP);
    process.exit(0);
  }
  const { runPicker } = await import("./picker.ts");
  try {
    await runPicker({ cwd });
    // The renderer owns the process from here; the picker's quit() exits.
    await new Promise(() => {});
  } catch (e) {
    exitFrom(e);
  }
}

const command = args[0]!;

if (command === "ls" || command === "list") {
  let json = false;
  let all = false;
  let verdicts = false;
  let fresh = false;
  let noSize = false;
  for (const a of args.slice(1)) {
    if (a === "--json") json = true;
    else if (a === "--all") all = true;
    else if (a === "-v" || a === "--verdicts") verdicts = true;
    else if (a === "--fresh") fresh = true;
    else if (a === "--no-size") noSize = true;
    else {
      err(`unknown flag for wt ls: ${a}`);
      process.exit(1);
    }
  }
  if (fresh && noSize) {
    err("--fresh and --no-size conflict: one remeasures sizes, the other skips them");
    process.exit(1);
  }
  const sizeMode = fresh ? "fresh" : noSize ? "skip" : undefined;
  const spin = json ? null : spinner(all ? "Scanning ~/Developer" : "Scanning worktrees");
  try {
    const out = await cmdLs({ json, all, verdicts, cwd, scan: { sizeMode } });
    spin?.stop();
    console.log(out);
  } catch (e) {
    spin?.stop();
    exitFrom(e);
  }
  process.exit(0);
}

if (command === "reap") {
  let apply = false;
  let all = false;
  let olderThanDays: number | undefined;
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--apply") apply = true;
    else if (a === "--all") all = true;
    else if (a === "--older-than") {
      olderThanDays = Number(rest[++i]);
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        err("--older-than expects a number of days");
        process.exit(1);
      }
    } else {
      err(`unknown flag for wt reap: ${a}`);
      process.exit(1);
    }
  }
  const { applyReap, planReap, renderReapReport } = await import("./reap.ts");
  const spin = spinner(all ? "Planning reap across ~/Developer" : "Planning reap");
  try {
    const entries = await planReap({ all, olderThanDays, cwd });
    spin.stop();
    if (entries.length === 0) {
      console.log("no worktrees to consider");
      process.exit(0);
    }
    const applied = apply ? await applyReap(entries) : undefined;
    console.log(renderReapReport(entries, apply, applied));
    const planSkips = entries.some((e) => e.disposition === "skip");
    const applySkips = (applied?.skipped.length ?? 0) > 0;
    process.exit(planSkips || applySkips ? 1 : 0);
  } catch (e) {
    spin.stop();
    exitFrom(e);
  }
}

if (command === "sync") {
  let from: string | undefined;
  let to: string | undefined;
  let dryRun = false;
  let json = false;
  let force = false;
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--from" || arg === "--to") {
      const value = rest[++i];
      if (!value) {
        err(`${arg} expects a value`);
        process.exit(1);
      }
      if (arg === "--from") from = value;
      else to = value;
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else if (arg === "--force") force = true;
    else {
      err(`unknown flag for wt sync: ${arg}`);
      process.exit(1);
    }
  }
  try {
    const { cmdSync, renderSyncPlan } = await import("./sync-command.ts");
    const result = await cmdSync({ cwd, from, to, dryRun, json, force, verbose });
    console.log(json ? JSON.stringify(result, null, 2) : renderSyncPlan(result.plan));
  } catch (e) {
    exitFrom(e);
  }
  process.exit(0);
}

if (command === "rm" || command === "remove") {
  const rest = args.slice(1);
  const target = rest[0];
  if (!target || target.startsWith("-")) {
    console.log(HELP);
    process.exit(1);
  }
  let deleteBranch = false;
  for (const a of rest.slice(1)) {
    if (a === "-D" || a === "--delete-branch") deleteBranch = true;
    else {
      console.error(`unknown flag for wt rm: ${a} (wt never passes flags through to git worktree remove)`);
      process.exit(1);
    }
  }
  try {
    await cmdRm(target, { deleteBranch, cwd });
  } catch (e) {
    exitFrom(e);
  }
  process.exit(0);
}

// Default command: create. `wt <branch> [base]` === `wt new <branch> [base]`.
const rest = command === "new" || command === "create" ? args.slice(1) : args;
const branch = rest[0];
if (!branch || branch.startsWith("-")) {
  console.log(HELP);
  process.exit(1);
}
let base: string | undefined;
let flagStart = 1;
if (rest.length > 1 && !rest[1]!.startsWith("-")) {
  base = rest[1]!;
  flagStart = 2;
}
try {
  const resolvedBase = base ?? defaultBase(cwd) ?? (branchExists(cwd, branch) ? branch : null);
  if (!resolvedBase) throw new Error("cannot determine a default base (set origin/HEAD, create main/master/dev, or pass a base explicitly)");
  await cmdNew(branch, resolvedBase, { verbose, install, cwd, extraFlags: rest.slice(flagStart) });
} catch (e) {
  exitFrom(e);
}

function exitFrom(e: unknown): never {
  if (e instanceof ExitError) process.exit(e.code);
  err(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

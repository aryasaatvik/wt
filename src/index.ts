// wt — git worktree helper.
//
// Creates worktrees as siblings of the repo (`../<repo>-worktrees/<slug>/`,
// branch slashes → dashes), syncs gitignored files (env, .scratchpad, editor
// config) from the source repo, and installs dependencies via `ni`.

import { cmdNew } from "./create.ts";
import { cmdLs } from "./ls.ts";
import { cmdRm } from "./rm.ts";
import { bold, spinner } from "./term.ts";
import { err, ExitError } from "./ui.ts";

const HELP = `${bold("Usage:")} wt <command> [args]

${bold("Commands:")}
  wt                   Interactive picker (TTY only)
  wt [new|create] <branch> [base] [flags]
                       Create worktree from base branch (default: main)
                       Checks out the branch if it already exists
                       Extra flags are passed to git worktree add
  wt rm|remove <target> [flags]
                       Remove worktree (keeps branch by default)
                       <target> is a branch name, worktree dir name, or path —
                       detached worktrees are addressed by dir name or path
                       -D, --delete-branch  Also delete the branch
                       Refuses dirty worktrees; wt never uses --force
  wt ls|list [flags]    Status table: branch, dirty, ahead/behind, PR, size, age
                       -v, --verdicts  append reachability verdicts
                       --json   machine-readable records
                       --all    scan every <repo>-worktrees dir under ~/Developer
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
  for (const a of args.slice(1)) {
    if (a === "--json") json = true;
    else if (a === "--all") all = true;
    else if (a === "-v" || a === "--verdicts") verdicts = true;
    else {
      err(`unknown flag for wt ls: ${a}`);
      process.exit(1);
    }
  }
  const spin = json ? null : spinner(all ? "Scanning ~/Developer" : "Scanning worktrees");
  try {
    const out = await cmdLs({ json, all, verdicts, cwd });
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
let base = "main";
let flagStart = 1;
if (rest.length > 1 && !rest[1]!.startsWith("-")) {
  base = rest[1]!;
  flagStart = 2;
}
try {
  await cmdNew(branch, base, { verbose, install, cwd, extraFlags: rest.slice(flagStart) });
} catch (e) {
  exitFrom(e);
}

function exitFrom(e: unknown): never {
  if (e instanceof ExitError) process.exit(e.code);
  err(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

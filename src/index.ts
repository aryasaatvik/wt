// wt — git worktree helper.
//
// Creates worktrees as siblings of the repo (`../<repo>-worktrees/<slug>/`,
// branch slashes → dashes), syncs gitignored files (env, .scratchpad, editor
// config) from the source repo, and installs dependencies via `ni`.

import { cmdNew } from "./create.ts";
import { cmdRm } from "./rm.ts";
import { bold } from "./term.ts";
import { err, ExitError } from "./ui.ts";

const HELP = `${bold("Usage:")} wt <command> [args]

${bold("Commands:")}
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
  wt ls|list [flags]    List all worktrees
                       Extra flags are passed to git worktree list

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

if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  console.log(HELP);
  process.exit(0);
}

const cwd = process.cwd();
const command = args[0]!;

if (command === "ls" || command === "list") {
  const p = Bun.spawn(["git", "worktree", "list", ...args.slice(1)], {
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await p.exited);
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

---
name: wt
description: "Git worktree helper that creates worktrees with gitignored file sync and dependency install. Use when: (1) Creating new worktrees for parallel development, (2) Managing worktree lifecycle (create, remove, list), (3) Troubleshooting worktree-related issues (hook failures, file sync). Located at ~/Developer/wt."
disable-model-invocation: true
---

# wt - Git Worktree Helper

Quickly spin up git worktrees with explicitly selected ignored files synced and dependencies installed.

## When to use

- Create a new worktree for parallel feature development
- Remove a finished worktree while retaining its branch by default
- List active worktrees
- Debug worktree setup issues (e.g., git hooks, file sync)

Requires: `git`, `rsync`, [`ni`](https://github.com/antfu/ni).

## Quick Decision Tree

```
Worktree task?
├─ New feature branch     → wt new x/my-feature
├─ Branch off non-main    → wt new x/my-feature develop
├─ Done with branch       → wt rm x/my-feature
├─ See worktree status    → wt ls  (always inline; bare `wt` is a TTY picker — never use it)
├─ Preview ignored sync   → wt sync --dry-run --json
├─ Fleet-wide inventory   → wt ls --all --json
├─ Explain disk ownership → wt du --json
└─ Clean up landed lanes  → wt reap   (dry run; --apply to remove)
```

## Commands

### Create

```bash
# Implicit create
wt x/my-feature

# Explicit create
wt new x/my-feature # origin/HEAD, then local main/master/dev
wt create x/my-feature

# From a specific base branch
wt new x/my-feature develop

# Skip dependency install
wt new x/my-feature --no-install
```

Creates worktree at `../<repo>-worktrees/<slug>/` where slashes in the branch name become dashes (e.g., `x/my-feature` → `x-my-feature`).

Steps performed:

1. `git worktree add -b <branch> <path> <base>`
2. Sync gitignored config (env, scratchpad, editor/agent settings) via rsync
3. Run `ni` to install dependencies when a lockfile or `packageManager` field identifies the package manager

If install fails, wt exits nonzero but keeps the worktree. Read its `wt.json` phase/failure/recovery command or run the printed `cd <worktree> && ni`; an incomplete lane is never reported ready.

### Remove

```bash
wt rm x/my-feature                 # by branch name
wt rm lane-1                       # by worktree dir name (how detached worktrees are addressed)
wt rm ../myrepo-worktrees/lane-1   # by path
wt rm x/my-feature -D              # explicitly also delete the local branch
```

Runs `git worktree remove` and preserves the local branch. Pass `-D` or `--delete-branch` only when
branch deletion is explicitly requested.

The target resolves in order: exact branch name → worktree directory name under `<repo>-worktrees/`
→ filesystem path. `wt rm` has no dry-run mode, so inspect the lane with `wt ls -v` or the safe set
with `wt reap` before removal.

Every removal runs the same fail-closed safety pipeline. It refuses dirty or status-unreadable
worktrees and env files that drifted from the primary (reporting key names, never values). Unique or
older `.scratchpad/**/*.md` files are copied into the primary's dated salvage archive; a conflicting
note newer than the primary blocks removal. `wt` evaluates the pipeline read-only first, so a
blocked removal writes no salvage files, and it never passes `--force` to Git.

### List

```bash
wt ls            # status table: branch, dirty, ahead/behind, PR, size, age
wt ls --json     # machine-readable records
wt ls -v         # append reachability verdicts
wt ls --all      # every <repo>-worktrees dir under ~/Developer, incl. stray registrations
wt ls --fresh    # remeasure sizes, ignoring the 24h cache
wt ls --no-size  # skip size measurement entirely
wt du            # checkout + private Git + owned + shared
wt du feat/x --json
```

`wt ls` is always inline and safe for agents. The interactive picker (j/k move, x remove via the safety pipeline, o editor, enter print path, v verdicts, r rescan, q quit) is reserved for **bare `wt`** on a TTY — an agent must never invoke it, since it takes over the terminal and waits for keys. Bare `wt` without a TTY prints help.

PR state comes from `gh` and degrades to `?`/`"unknown"` when gh is missing or offline. SIZE is lane-owned space (checkout plus private Git metadata), not the primary's whole `.git` directory. `wt du` shows checkout/private/owned/shared fields. Sizes come from a versioned 24h per-worktree cache (`~` prefix = cached; `sizeCached` in `--json`), so `--all` is fast after the first sweep.

### Reap

```bash
wt reap                       # dry-run report: WOULD REMOVE / SKIP / KEEP with reasons
wt reap --apply               # remove the safe set (branches are never deleted)
wt reap --all --older-than 14 # fleet sweep, only lanes idle >= 14 days
```

Open or unknown PR state vetoes automatic removal. PUSHED_ONLY lanes require a confirmed merged PR;
otherwise only REACHABLE / REACHABLE_BRANCH / EMPTY / CONTENT_LANDED lanes auto-remove. Apply is
sequential and rechecks the exact HEAD, current PR state, and safety pipeline immediately before
each removal; any change demotes the lane to SKIP. Branches remain available. Exit code 1 means
something was skipped and needs a human.

## Options

| Flag           | Description                               |
| -------------- | ----------------------------------------- |
| `--verbose`    | Show detailed rsync file list during sync |
| `--no-install` | Skip dependency install                   |
| `-h`, `--help` | Show help                                 |

### Sync

```bash
wt sync --dry-run                   # primary -> current
wt sync --dry-run --json            # inspect exact actions and bytes
wt sync --from current --to feat/x  # explicit lanes
wt sync --force                     # overwrite reported conflicts
```

Prefer a tracked `.worktreeinclude` with Git ignore syntax. A file must be ignored by source and target, selected by the manifest, and not excluded by `~/.config/wt/config.toml`. Existing target files are never overwritten without `--force`.

## File Sync

The sync step uses `.worktreeinclude` as repository policy. Without one, wt 2.x warns and retains this legacy allowlist:

- **Env**: `.env`, `.env.*`, `.dev.vars` (never `*.example`)
- **Scratchpad**: `.scratchpad/`
- **Editor**: `.vscode/`, `.idea/`, `.zed/`
- **Agent**: `.claude/` except `.claude/worktrees`

Set `sync.requireInclude = true` under `[sync]` in `~/.config/wt/config.toml` to disable the fallback. `sync.exclude` is an array of subtractive Git-style patterns. Hard exclusions only protect `.git`, `.claude/worktrees`, and `.conductor`. There is no separate `.worktreeignore`; use ordered `!` rules in the manifest and user config for machine-specific exclusions.

Creation also writes a provenance marker (`.git/worktrees/<name>/wt.json` in the primary) recording the branch, base, source, manifest hash, and copied paths/counts/bytes.

If file sync fails, `wt` exits nonzero and prints the captured error output.

## Known Gotchas

- **Git hooks in worktrees**: `.git` in a worktree is a file (not a directory), so hook installers like `hk`, `husky`, or `lefthook` may fail. Guard the prepare script with `[ -f .git ]` to skip in worktrees.
- **File sync is filesystem-based**: Uses `git ls-files --ignored` + rsync, not `git archive`. This is intentional since .env files are gitignored and have no committed version.

## Agent Plugin

The [wt-plugin](https://github.com/aryasaatvik/coding-agent-plugins/tree/main/plugins/wt) (Claude Code + OpenCode) nudges `git worktree add` toward `wt new`. When you need a raw `git worktree add` anyway (custom path, `--detach`, scripting), prefix the command with `WT_HOOK_OFF=1`.

## Completions

Zsh completions are provided in `completions/wt.zsh`. They complete subcommands, flags, existing worktree branches (for `rm`), and local branches (for base branch argument).

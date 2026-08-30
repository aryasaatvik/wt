---
name: wt
description: "Git worktree helper that creates worktrees with gitignored file sync and dependency install. Use when: (1) Creating new worktrees for parallel development, (2) Managing worktree lifecycle (create, remove, list), (3) Troubleshooting worktree-related issues (hook failures, file sync). Located at ~/Developer/wt."
---

# wt - Git Worktree Helper

Quickly spin up git worktrees with all gitignored config files synced and dependencies installed.

## When to use
- Create a new worktree for parallel feature development
- Remove a worktree and its branch
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
├─ Fleet-wide inventory   → wt ls --all --json
└─ Clean up landed lanes  → wt reap   (dry run; --apply to remove)
```

## Commands

### Create

```bash
# Implicit create
wt x/my-feature

# Explicit create
wt new x/my-feature
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

### Remove

```bash
wt rm x/my-feature                 # by branch name
wt rm lane-1                       # by worktree dir name (how detached worktrees are addressed)
wt rm ../myrepo-worktrees/lane-1   # by path
wt rm x/my-feature -D
```

Runs `git worktree remove`. Pass `-D` or `--delete-branch` to also delete the branch.

The target resolves in order: exact branch name → worktree directory name under `<repo>-worktrees/` → filesystem path. `wt rm` refuses worktrees with uncommitted changes and never passes `--force` through; commit/stash first, or use raw git deliberately.

### List

```bash
wt ls            # status table: branch, dirty, ahead/behind, PR, size, age
wt ls --json     # machine-readable records
wt ls -v         # append reachability verdicts
wt ls --all      # every <repo>-worktrees dir under ~/Developer, incl. stray registrations
wt ls --fresh    # remeasure sizes, ignoring the 24h cache
wt ls --no-size  # skip size measurement entirely
```

`wt ls` is always inline and safe for agents. The interactive picker (j/k move, x remove via the safety pipeline, o editor, enter print path, v verdicts, r rescan, q quit) is reserved for **bare `wt`** on a TTY — an agent must never invoke it, since it takes over the terminal and waits for keys. Bare `wt` without a TTY prints help.

PR state comes from `gh` and degrades to `?`/`"unknown"` when gh is missing or offline. Sizes come from a 24h per-worktree cache (`~` prefix = cached; `sizeCached` in `--json`); `du` only runs on cache misses, so `--all` is fast after the first sweep.

### Reap

```bash
wt reap                       # dry-run report: WOULD REMOVE / SKIP / KEEP with reasons
wt reap --apply               # remove the safe set (branches are never deleted)
wt reap --all --older-than 14 # fleet sweep, only lanes idle >= 14 days
```

Open or unknown PR state vetoes automatic removal. PUSHED_ONLY lanes require a confirmed merged PR; otherwise only REACHABLE / REACHABLE_BRANCH / EMPTY / CONTENT_LANDED lanes auto-remove. The safety pipeline (scratchpad salvage, env-drift refusal, dirty refusal, TOCTOU HEAD guard) can still demote any candidate to SKIP. Exit code 1 means something was skipped and needs a human.

## Options

| Flag | Description |
|------|-------------|
| `--verbose` | Show detailed rsync file list during sync |
| `--no-install` | Skip dependency install |
| `-h`, `--help` | Show help |

## File Sync

The sync step copies gitignored **config** from the source repo, not every ignored file. Allowlist (`src/sync.ts`):

- **Env**: `.env`, `.env.*`, `.dev.vars` (never `*.example`)
- **Scratchpad**: `.scratchpad/`
- **Editor**: `.vscode/`, `.idea/`, `.zed/`
- **Agent**: `.claude/` except `.claude/worktrees`

Listing uses those pathspecs, so artifact trees (`apps/e2e/runs/`, `.alchemy/`) are never candidates. `SYNC_EXCLUDE` is a backstop for allowlisted paths that must stay lane-local. Dangling allowlisted symlinks are recreated as links; they are not passed to rsync (macOS openrsync fails `stat()` on a missing target).

Creation also writes a provenance marker (`.git/worktrees/<name>/wt.json` in the primary) recording the branch, base, and the list of synced files.

If file sync fails, `wt` exits nonzero and prints the captured error output.

## Known Gotchas

- **Git hooks in worktrees**: `.git` in a worktree is a file (not a directory), so hook installers like `hk`, `husky`, or `lefthook` may fail. Guard the prepare script with `[ -f .git ]` to skip in worktrees.
- **File sync is filesystem-based**: Uses `git ls-files --ignored` + rsync, not `git archive`. This is intentional since .env files are gitignored and have no committed version.

## Agent Plugin

The [wt-plugin](https://github.com/aryasaatvik/coding-agent-plugins/tree/main/plugins/wt) (Claude Code + OpenCode) nudges `git worktree add` toward `wt new`. When you need a raw `git worktree add` anyway (custom path, `--detach`, scripting), prefix the command with `WT_HOOK_OFF=1`.

## Completions

Zsh completions are provided in `completions/wt.zsh`. They complete subcommands, flags, existing worktree branches (for `rm`), and local branches (for base branch argument).

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

## Installation

```bash
# Clone and symlink
git clone https://github.com/aryasaatvik/wt ~/Developer/wt
ln -s ~/Developer/wt/bin/wt ~/.local/bin/wt
ln -s ~/Developer/wt/completions/wt.zsh ~/.zsh/completions/wt.zsh
```

Requires: `git`, `rsync`, [`ni`](https://github.com/antfu/ni).

## Quick Decision Tree

```
Worktree task?
├─ New feature branch    → wt new x/my-feature
├─ Branch off non-main   → wt new x/my-feature develop
├─ Done with branch      → wt rm x/my-feature
└─ See active worktrees  → wt ls
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
```

Creates worktree at `../<repo>-worktrees/<slug>/` where slashes in the branch name become dashes (e.g., `x/my-feature` → `x-my-feature`).

Steps performed:
1. `git worktree add -b <branch> <path> <base>`
2. Sync all gitignored files (env, scratchpad, editor config, etc.) via rsync
3. Run `ni` to install dependencies (auto-detects package manager)

### Remove

```bash
wt rm x/my-feature
wt remove x/my-feature
```

Runs `git worktree remove` and `git branch -D`.

### List

```bash
wt ls
wt list
```

Wraps `git worktree list`.

## Options

| Flag | Description |
|------|-------------|
| `--verbose` | Show detailed rsync file list during sync |
| `-h`, `--help` | Show help |

## File Sync

The sync step copies all gitignored files from the source repo to the worktree, **excluding** heavy artifacts defined in the `SYNC_EXCLUDE` array in the script:

- **JS/TS**: `node_modules`, `.next`, `.turbo`, `dist`, `.vercel`, `.cache`
- **Xcode/Swift**: `build`, `.build`, `DerivedData`, `Pods`, `Carthage`, `xcuserdata`
- **Misc**: `.wrangler`

Edit `SYNC_EXCLUDE` in `bin/wt` to customize.

## Known Gotchas

- **Git hooks in worktrees**: `.git` in a worktree is a file (not a directory), so hook installers like `hk`, `husky`, or `lefthook` may fail. Guard the prepare script with `[ -f .git ]` to skip in worktrees.
- **File sync is filesystem-based**: Uses `git ls-files --ignored` + rsync, not `git archive`. This is intentional since .env files are gitignored and have no committed version.

## Completions

Zsh completions are provided in `completions/wt.zsh`. They complete subcommands, flags, existing worktree branches (for `rm`), and local branches (for base branch argument).

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

# Skip dependency install
wt new x/my-feature --no-install
```

Creates worktree at `../<repo>-worktrees/<slug>/` where slashes in the branch name become dashes (e.g., `x/my-feature` → `x-my-feature`).

Steps performed:
1. `git worktree add -b <branch> <path> <base>`
2. Sync all gitignored files (env, scratchpad, editor config, etc.) via rsync
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
wt ls
wt list
```

Wraps `git worktree list`.

## Options

| Flag | Description |
|------|-------------|
| `--verbose` | Show detailed rsync file list during sync |
| `--no-install` | Skip dependency install |
| `-h`, `--help` | Show help |

## File Sync

The sync step copies all gitignored files from the source repo to the worktree, **excluding** heavy artifacts defined in `SYNC_EXCLUDE` (`src/sync.ts`):

- **JS/TS**: `node_modules`, `.next`, `.turbo`, `dist`, `.vercel`, `.cache`
- **Infra**: `.sst`, `.wrangler`
- **Xcode/Swift**: `build`, `.build`, `DerivedData`, `Pods`, `Carthage`, `xcuserdata`
- **Agent/tooling state**: `.claude/worktrees`, `.conductor`, `.playwright`

Entries match path components as prefixes (`DerivedData` also catches `DerivedDataDevice`). Edit `SYNC_EXCLUDE` in `src/sync.ts` to customize.

Creation also writes a provenance marker (`.git/worktrees/<name>/wt.json` in the primary) recording the branch, base, and the list of synced files.

If file sync fails, `wt` exits nonzero and prints the captured `rsync` error output.

## Known Gotchas

- **Git hooks in worktrees**: `.git` in a worktree is a file (not a directory), so hook installers like `hk`, `husky`, or `lefthook` may fail. Guard the prepare script with `[ -f .git ]` to skip in worktrees.
- **File sync is filesystem-based**: Uses `git ls-files --ignored` + rsync, not `git archive`. This is intentional since .env files are gitignored and have no committed version.

## Agent Plugin

The [wt-plugin](https://github.com/aryasaatvik/coding-agent-plugins/tree/main/plugins/wt) (Claude Code + OpenCode) nudges `git worktree add` toward `wt new`. When you need a raw `git worktree add` anyway (custom path, `--detach`, scripting), prefix the command with `WT_HOOK_OFF=1`.

## Completions

Zsh completions are provided in `completions/wt.zsh`. They complete subcommands, flags, existing worktree branches (for `rm`), and local branches (for base branch argument).

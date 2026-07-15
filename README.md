# wt

Git worktree lifecycle tool: create with gitignored-file sync and dependency install, inspect with a live status table, remove safely, and reap landed lanes.

## What it does

1. Creates a worktree in `../<repo>-worktrees/<slug>/`, syncs all gitignored files (`.env`, `.scratchpad`, editor config, etc.) from the source repo, and installs dependencies via [`ni`](https://github.com/antfu/ni)
2. `wt ls` shows every worktree's branch, dirty state, ahead/behind, PR state, size, and age — as an interactive picker on a TTY, a plain table when piped, `--json` for machines, `--all` for every repo under `~/Developer`
3. `wt rm` and `wt reap` remove worktrees through a safety pipeline that salvages unique scratchpad notes and refuses on env drift, never with `--force`

## Install

### From release (no bun required)

Compiled binaries for macOS (arm64) and Linux (x64, arm64):

```bash
curl -sLO https://github.com/aryasaatvik/wt/releases/latest/download/wt-v2.0.0-darwin-arm64.tar.gz
tar -xzf wt-v2.0.0-darwin-arm64.tar.gz
install -m 0755 wt ~/.local/bin/wt
cp completions/wt.zsh ~/.zsh/completions/wt.zsh   # optional
```

Verify against `SHA256SUMS` from the same release. Requires `git` and `rsync` on PATH.

### From source

```bash
git clone https://github.com/aryasaatvik/wt ~/Developer/wt
cd ~/Developer/wt && bun install
ln -s ~/Developer/wt/bin/wt ~/.local/bin/wt
ln -s ~/Developer/wt/completions/wt.zsh ~/.zsh/completions/wt.zsh
```

Requires: `git`, `rsync`, [`ni`](https://github.com/antfu/ni), and [`bun`](https://bun.sh) >= 1.3 when running from source.

## Usage

```bash
wt x/my-feature           # create worktree from main
wt new x/my-feature dev   # create from a specific base branch
wt new x/my-feature --no-install
wt rm x/my-feature        # remove worktree by branch (keeps branch)
wt rm lane-1              # remove by directory name — how detached worktrees are addressed
wt rm ../myrepo-worktrees/lane-1   # remove by path
wt rm x/my-feature -D     # remove worktree and delete branch
wt ls                     # interactive picker on a TTY, table when piped
wt ls --plain             # force the table
wt ls -v                  # append reachability verdicts
wt ls --all               # sweep every <repo>-worktrees dir under ~/Developer
wt ls --json              # machine-readable records
wt reap                   # dry-run report of safely-removable worktrees
wt reap --apply           # remove them (branches are kept)
wt reap --all --older-than 14
wt --verbose x/feature    # show rsync file list
```

### Interactive picker

On a TTY, `wt ls` opens a picker: `j`/`k` move · `x` remove (confirms, then runs the safety pipeline — skip reasons shown inline) · `o` open in `$EDITOR` · `enter` print the worktree path and exit · `v` toggle verdicts · `r` rescan · `q` quit.

### Removal safety

`wt rm` and `wt reap` never pass `--force` to git. Before any removal:

- unique `.scratchpad/**/*.md` notes are salvaged into the primary's `.scratchpad/archive/<date>-worktree-salvage/<worktree>/`
- a scratchpad note that is **newer** than the primary's copy blocks removal
- env files (`.env`, `.env.*`, `.dev.vars` — never `*.example`) that differ from the primary block removal; drift is reported as key **names** only, values are never printed
- dirty or status-unreadable worktrees block removal

`wt reap` classifies each worktree's reachability — `REACHABLE`, `REACHABLE_BRANCH`, `EMPTY`, `CONTENT_LANDED` (squash-merge detection), `STRANDED(n/m)` — and only the first four tiers ever auto-remove.

### Worktree layout

```
~/Developer/myrepo/                      <- source repo
~/Developer/myrepo-worktrees/
  x-my-feature/                          <- branch x/my-feature
  fix-login-bug/                         <- branch fix-login-bug
```

Branch slashes are converted to dashes for the directory name.

### File sync

All gitignored files are synced except heavy artifacts:

- **JS/TS**: `node_modules`, `.next`, `.turbo`, `dist`, `.vercel`, `.cache`
- **Infra**: `.sst`, `.wrangler`
- **Xcode/Swift**: `build`, `.build`, `DerivedData`, `Pods`, `Carthage`, `xcuserdata`
- **Agent/tooling state**: `.claude/worktrees`, `.conductor`, `.playwright`

Entries match path components as prefixes (`DerivedData` also excludes `DerivedDataDevice`). Edit `SYNC_EXCLUDE` in `src/sync.ts` to customize.

If file sync fails, `wt` exits nonzero and prints the captured `rsync` error output.

## Agent integration

A companion plugin nudges AI coding agents (Claude Code and OpenCode) to reach for `wt` instead of raw `git worktree add`, so agent-created worktrees also get gitignored files synced and dependencies installed:

- **[wt-plugin](https://github.com/aryasaatvik/coding-agent-plugins/tree/main/plugins/wt)** — intercepts `git worktree add` and suggests the equivalent `wt new <branch> [base]`.

To run a raw `git worktree add` anyway (custom path, `--detach`, scripting), prefix the command with `WT_HOOK_OFF=1`.

## Gotchas

**Git hooks in worktrees**: `.git` in a worktree is a file, not a directory. Hook installers (`hk`, `husky`, `lefthook`) may fail. Guard your prepare script:

```json
"prepare": "[ -f .git ] || (hk install)"
```

## License

MIT

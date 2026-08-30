# wt

Git worktree lifecycle tool: create with gitignored-file sync and dependency install, inspect with a live status table, remove safely, and reap landed lanes.

## What it does

1. Creates a worktree in `../<repo>-worktrees/<slug>/`, syncs ignored files selected by `.worktreeinclude`, and installs dependencies via [`ni`](https://github.com/antfu/ni)
2. `wt ls` shows every worktree's branch, dirty state, ahead/behind, PR state, size, and age as a table; `--json` for machines, `--all` for every repo under `~/Developer`. Bare `wt` on a TTY opens the same data as an interactive picker
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
wt sync --dry-run          # preview primary -> current worktree
wt sync --dry-run --json   # machine-readable plan
wt sync --from current --to x/other
wt rm x/my-feature        # remove worktree by branch (keeps branch)
wt rm lane-1              # remove by directory name — how detached worktrees are addressed
wt rm ../myrepo-worktrees/lane-1   # remove by path
wt rm x/my-feature -D     # remove worktree and delete branch
wt                        # interactive picker (TTY only)
wt ls                     # status table — always inline, stays in scrollback
wt ls -v                  # append reachability verdicts
wt ls --all               # sweep every <repo>-worktrees dir under ~/Developer
wt ls --json              # machine-readable records
wt ls --fresh             # remeasure sizes, ignoring the 24h cache
wt ls --no-size           # skip size measurement entirely
wt reap                   # dry-run report of safely-removable worktrees
wt reap --apply           # remove them (branches are kept)
wt reap --all --older-than 14
wt --verbose x/feature    # show rsync file list
```

### Interactive picker

Bare `wt` on a TTY opens the picker: `j`/`k` move · `x` remove (confirms, then runs the safety pipeline — skip reasons shown inline) · `o` open in `$EDITOR` · `enter` print the worktree path and exit · `v` toggle verdicts · `r` rescan · `q` quit.

The split is deliberate: `wt` is the "look around and act" gesture and the picker owns the terminal for it, while every subcommand answers inline and leaves its output in scrollback. Piped or scripted, bare `wt` prints help rather than a picker.

Since `enter` prints the selected path, the picker doubles as a jump command:

```bash
cd "$(wt)"
```

### Size cache

`du` over a fleet of node_modules trees is the dominant cost of a scan, so each worktree's size is cached for 24 hours in its own gitdir (`.git/worktrees/<name>/wt-size.json`; git removes it with the worktree). A `~` prefix in the SIZE column marks a cached value. `--fresh` remeasures on demand, `--no-size` skips measurement entirely; sizes are display-only, so removal safety never depends on them.

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

When the repository has a `.worktreeinclude`, it is the source of truth for file sync. Patterns use Git's ignore syntax, including comments, `!` negation, `/` anchoring, and `**`:

```gitignore
# Local development environment
/.env

# Active scratchpad entrypoints
/.scratchpad/README.md
/.scratchpad/STATE.md

# Local agent preferences
/.claude/settings.local.json
```

A path is copied only when it is ignored in both the source and target worktree, selected by `.worktreeinclude`, and not excluded by user configuration or hard safety rules. Tracked files are never copied. Existing target files are reported as conflicts and left untouched unless `--force` is explicit; identical files are skipped.

Without `.worktreeinclude`, wt 2.x retains the legacy config allowlist and prints a notice:

- **Env**: `.env`, `.env.*`, `.dev.vars` (never `*.example`), at any depth
- **Scratchpad**: `.scratchpad/`
- **Editor**: `.vscode/`, `.idea/`, `.zed/`
- **Agent**: `.claude/` except `.claude/worktrees`

Set `sync.requireInclude = true` to copy nothing from repositories without a manifest. User exclusions are subtractive and use the same pattern syntax:

```toml
# ~/.config/wt/config.toml
[sync]
requireInclude = true
exclude = [".env.production*", ".scratchpad/archive/**"]
```

There is deliberately no `.worktreeignore`: repository policy stays in one ordered pattern file, where `!` rules express exceptions, and machine-specific exclusions stay in user configuration. Hard exclusions are limited to Git and worktree-manager ownership state (`.git`, `.claude/worktrees`, `.conductor`), so a repository may explicitly include a large cache when that is intentional.

Dangling symlinks on the allowlist are recreated with `symlink` rather than handed to rsync. macOS openrsync `stat()`s the missing target and would otherwise fail the whole create (rsync exit 23).

`wt sync` defaults to primary → current and supports `--from primary|current|<path>`, `--to <branch|path>`, `--dry-run`, `--json`, and `--force`. If file sync fails, `wt` exits nonzero and prints the captured error output. Creation records the source, manifest hash, copied paths, file count, and byte count in the worktree's `wt.json` marker.

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

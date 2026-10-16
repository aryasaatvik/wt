# wt

Git worktree lifecycle tool: create with gitignored-file sync and dependency install, inspect with a live status table, remove safely, and reap landed lanes.

## What it does

1. Creates a worktree in `../<repo>-worktrees/<slug>/`, shares `.scratchpad` with the primary checkout, syncs other ignored files selected by `.worktreeinclude`, and installs dependencies via [`ni`](https://github.com/antfu/ni)
2. `wt ls` shows every worktree's branch, dirty state, ahead/behind, PR state, size, and age as a table; `--json` for machines, `--all` for every repo under `~/Developer`. Bare `wt` on a TTY opens the same data as an interactive picker
3. `wt rm` and `wt reap` remove worktrees through a safety pipeline that validates shared Scratchpad and refuses on env drift, never with `--force`

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
wt x/my-feature           # create from origin/HEAD (then main/master/dev)
wt new x/my-feature dev   # create from a specific base branch
wt new x/my-feature --no-install
wt new x/my-feature --no-post-install
wt sync --dry-run          # preview primary -> current worktree
wt sync --dry-run --json   # machine-readable plan
wt sync --from current --to x/other
wt rm x/my-feature        # remove worktree by branch (keeps branch)
wt rm lane-1              # remove by directory name — how detached worktrees are addressed
wt rm ../myrepo-worktrees/lane-1   # remove by path
wt rm x/my-feature -D     # remove worktree and delete branch
wt                        # interactive picker (TTY only)
wt help                   # usage (also -h/--help; never a branch name)
wt ls                     # status table — always inline, stays in scrollback
wt ls -v                  # append reachability verdicts
wt ls --all               # sweep every <repo>-worktrees dir under ~/Developer
wt ls --json              # machine-readable records
wt ls --fresh             # remeasure sizes, ignoring the 24h cache
wt ls --no-size           # skip size measurement entirely
wt du                     # checkout/private/shared disk breakdown
wt du feat/x --json       # one lane, machine-readable
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

`wt ls` reports the space owned by each lane: checkout files plus private Git metadata. It does not charge the primary's shared object/module store to every worktree. `wt du` exposes the full checkout/private/owned/shared breakdown; pass a branch, slug, or path to select one lane, and use `--json` or `--fresh` for automation and remeasurement. Selecting a lane scans only that lane's checkout — shared storage still reflects the repository, and its accounting still sizes each lane's private Git metadata, but no unrelated lane checkout is walked.

Measurements are cached for 24 hours in each worktree's gitdir (`wt-size.json`) using a versioned schema. A `~` prefix in the SIZE column marks a cached value. `--fresh` remeasures on demand, `--no-size` skips measurement entirely; sizes are display-only, so removal safety never depends on them.

Nested initialized submodules are inspected through their Git dir and common dir. Checkout content and lane-private linked-worktree/submodule metadata count toward `ownedKb`; common object stores are reported once as `sharedKb`. This makes recursive submodule hydration visible without pretending all of the primary repository's `.git` directory belongs to the primary checkout.

### Shared Scratchpad

New worktrees use a relative `.scratchpad` symlink to the primary checkout. Notes and evidence are visible immediately across lanes; assign one writer per file and record branch/SHA for unmerged work. The primary `.scratchpad` must be untracked and resolve to a directory; it may itself be a symlink to external canonical storage such as XDG. WT adds a machine-local Git exclude for the link without editing tracked ignore rules.

Scratchpad is excluded from `wt sync`, including explicit manifests and forced sync. Existing local directories require reconciliation before conversion; creation never replaces them. Shared-link removal checks the target without walking its contents or creating an archive. Broken or foreign links block removal. Disk accounting does not traverse symlinks: a real primary Scratchpad counts toward the primary checkout, while external canonical storage is outside checkout totals.

### Convert existing Scratchpads

Pause the target lane's writers before conversion. Start with a read-only preview saved outside the directory being converted:

```sh
wt scratchpad feature-branch --json > /tmp/scratchpad-plan.json
# Reconcile review entries into the primary Scratchpad, then either regenerate
# the plan (identical files need no decision) or add explicit resolutions.
wt scratchpad feature-branch --apply /tmp/scratchpad-plan.json --json
```

The preview fingerprints all files, directories, modes, and symlink text without following links. For each `review` entry, integrate its useful facts into the canonical document or preserve a needed artifact there. Keep the preview's snapshot fields and entries unchanged, then add resolutions. A complete one-entry example is:

```json
{
  "version": 1,
  "primary": "/path/to/repo",
  "worktree": "/path/to/repo-worktrees/lane",
  "head": "<commit SHA from preview>",
  "state": "legacy",
  "sourceHash": "<snapshot hash from preview>",
  "entries": [
    { "path": "note.md", "kind": "file", "hash": "<entry hash from preview>", "mode": 420, "status": "review" }
  ],
  "resolutions": [
    {
      "path": "note.md",
      "sourceHash": "<entry hash from preview>",
      "disposition": "integrated",
      "reason": "Relevant facts are in the canonical note.",
      "evidence": { "path": "notes/canonical.md", "hash": "<canonical file SHA-256>" }
    }
  ]
}
```

Use the actual paths and hashes from the preview; `mode: 420` represents a regular file with mode `0644`. The evidence hash is the SHA-256 of a regular file inside the primary Scratchpad. `wt scratchpad --help` shows this plan shape. Dispositions are `integrated`, `superseded`, or `preserved`. Preserved artifacts must match bytes and mode; symlinks require an explicit semantic decision because a relative target can change meaning after conversion. Directories are structural and do not require decisions. WT validates fingerprints, not the truth of prose: the reviewing agent owns semantic reconciliation. It never copies differing files into an archive automatically.

Apply rechecks Git identity, the entire source inventory, and canonical witnesses. It retains the original temporarily at `wt-scratchpad-original` in the worktree's private Git directory, establishes the link, rechecks, then disposes of the reviewed original. Failures retain recovery content and block `rm`/`reap`. Preview again and resume with a reviewed plan. A process crash can leave `wt-scratchpad-migration.lock` in that same directory; verify the migration process has stopped before removing that stale lock. Do not move or discard recovery content to bypass the checks. Conversion cannot prevent writes through already-open file descriptors, so writers must remain paused until it finishes.

Task evidence should use canonical paths and identify its source branch/SHA. Relative links into worktree code or runtime directories must be repaired during reconciliation. Retention and organization are separate from worktree removal; distinct bytes alone do not make an artifact worth keeping forever.

### Removal safety

`wt rm` and `wt reap` never pass `--force` to git. Before any removal:

- a shared `.scratchpad` link must resolve to the same directory as the primary's `.scratchpad`; the check does not traverse shared content
- an existing local Scratchpad, unexpected link, or unfinished migration blocks removal; use `wt scratchpad` to reconcile and convert it
- local env files (`.env`, `.env.*`, `.dev.vars` — never `*.example` or `*.sample`) block removal only when the lane holds a `KEY=value` the primary lacks (or a differing value). Committed env is covered by Git history and dirty checks. Primary-superset drift, comments, ordering, and a simple value written with or without enclosing quotes are lossless and do not block. Drift is reported as key **names** only; values are never printed. Reconcile with `wt sync` in the intended direction before rerunning
- existing tracked env with `assume-unchanged` or `skip-worktree` must match its saved Git blob, accounting for Git content normalization and symlinks. Omitted skip-worktree paths are allowed when their saved blob remains inspectable. With effective `core.symlinks=false`, emulated links are compared as raw target bytes. Hidden local edits or unreadable saved state block removal; inspection preserves the index and flags
- generated env under known artifact directories is skipped by default, matching legacy sync. Recorded manifest selections and current primary/lane `.worktreeinclude` selections remain protected. A legacy marker uses the generated-output defaults; an older marker without a sync mode retains its recorded env evidence conservatively. Source env created after setup is checked even when the marker lists no copied files
- dirty or status-unreadable worktrees block removal
- `wt rm` refuses a worktree that contains the caller's current directory
- initialized submodules must be clean (no changes, untracked, or ignored files); removal then runs `git submodule deinit --all`, restores the primary's submodule config that deinit clears, and retains the lane's submodule Git data under the primary's `.git/wt-submodules-*`

An exact path given to `wt rm` may name a worktree of another repository; branch and directory names resolve only in the current repository.

`wt reap` distinguishes landed commits from `PUSHED_ONLY` feature work. An open or unknown PR state vetoes every automatic removal; `PUSHED_ONLY` requires a confirmed merged PR. Otherwise only `REACHABLE`, `REACHABLE_BRANCH`, `EMPTY`, and `CONTENT_LANDED` (squash-merge detection) can auto-remove. When the lane's PR merged and its merge commit is fetched and on the default branch, `CONTENT_LANDED` compares against that commit's tree instead of the current default branch, so a squash-merged stacked lane still lands after main later edits a lower layer's files. A path that main has returned to its pre-merge content counts as reverted and keeps the lane.

Ahead/behind counts compare a lane with its own `origin/<branch>` when that ref exists, then its upstream, then the origin default.

### Worktree layout

```
~/Developer/myrepo/                      <- source repo
~/Developer/myrepo-worktrees/
  x-my-feature/                          <- branch x/my-feature
  fix-login-bug/                         <- branch fix-login-bug
```

Branch slashes are converted to dashes for the directory name.

Creation first checks out an existing local branch, then creates the branch from a cached same-name `origin/<branch>` ref. Either wins over a supplied base. Only a genuinely new branch uses the supplied base, or defaults to `origin/HEAD`, local `main`/`master`/`dev`, then cached origin `main`/`master`/`dev`. It fails with a recovery-oriented error when no base exists. Creation never fetches.

Primary-checkout discovery works from nested directories, linked lanes, and initialized submodules, including repositories whose primary `core.worktree` lives in `config.worktree`. A linked lane's own configuration does not choose the primary; a missing or foreign primary checkout blocks creation.

New branches do not track their base, including `origin/<parent>` for a stacked lane. Git sets the lane's own upstream on its first `git push -u`. Pass `--track` (or `-t`) to `wt new` to explicitly track the base; `--no-track` is also forwarded. Checking out an existing branch leaves its upstream unchanged.

Creation prints the selected source ref and SHA and records them as `source: { kind, ref, head }` in the worktree's private Git directory, in `wt.json`. `kind` is `local`, `origin`, or `base`. The marker also records its current phase (`created`, `synced`, `installing`, `post-install`, `ready`, or `incomplete`). A failed dependency install exits nonzero and keeps the worktree for diagnosis, with the exact `cd … && ni` recovery command in both the terminal and marker. It never labels an incomplete worktree ready.

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

- **Env**: `.env`, `.env.*`, `.dev.vars` (never `*.example` or `*.sample`), at any depth
- **Scratchpad**: `.scratchpad/`
- **Editor**: `.vscode/`, `.idea/`, `.zed/`
- **Agent**: `.claude/` except `.claude/worktrees`

Legacy defaults skip paths beneath `node_modules`, `.next`, `.turbo`, `dist`, `.cache`, `build`, `.build`, `Pods`, and `DerivedData`, including generated `.dev.vars`. Source `.dev.vars` outside those directories still syncs and receives env-drift protection, including under `.alchemy` and `.wrangler`. These are directory-name matches, not prefixes: `buildings/.env` remains source config. Explicit manifest selections can include those directories and remain protected during removal.

Set `sync.requireInclude = true` to copy nothing from repositories without a manifest. User exclusions are subtractive and use the same pattern syntax:

```toml
# ~/.config/wt/config.toml
[sync]
requireInclude = true
exclude = [".env.production*", ".scratchpad/archive/**"]
```

There is deliberately no `.worktreeignore`: repository policy stays in one ordered pattern file, where `!` rules express exceptions, and machine-specific exclusions stay in user configuration. Hard exclusions are limited to Git and worktree-manager ownership state (`.git`, `.claude/worktrees`, `.conductor`), so a repository may explicitly include a large cache when that is intentional.

Selected dangling symlinks are recreated with `symlink` rather than handed to rsync. macOS openrsync `stat()`s the missing target and would otherwise fail the whole create (rsync exit 23).

`wt sync` defaults to primary → current and supports `--from primary|current|<path>`, `--to <branch|path>`, `--dry-run`, `--json`, and `--force`. If file sync fails, `wt` exits nonzero and prints the captured error output. Creation records the source, manifest hash, copied paths, file count, and byte count in the worktree's `wt.json` marker.

### Post-install hook

A repository may declare a command to run in each new worktree after dependencies install, in `wt.toml` at the repository root:

```toml
[create]
postInstall = "bun run build"
```

`wt` runs it with `sh -c` from the worktree root after `ni`. A nonzero exit keeps the worktree and records `phase: incomplete` with a `cd <worktree> && <command>` recovery line in `wt.json`, matching the install-failure contract. `wt new --no-post-install` skips it; `--no-install` also skips it because dependencies were not installed. The command is read from the primary checkout, like `.worktreeinclude`, so it is repository policy rather than per-branch state.

This keeps a worktree's build fresh at creation. Workspace packages consumed through `dist` are per-worktree, so a worktree that was never built — or was built before `main` moved — can otherwise report errors for symbols that already exist on `main`.

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

## Development and release checks

Use the exact Bun version in `packageManager` in `package.json`. CI reads that pin.

```sh
bun install --frozen-lockfile --os '*' --cpu '*'
bun run check
bun run build
bun run release:check
```

- `check`: Oxfmt, Oxlint (no warnings), TypeScript 7 (source, tests, scripts and root configs), and normal offline Bun tests.
- `format` writes formatting; `format:check`, `lint`, `typecheck` and `test` run individual gates.
- `build`: compile the host distributable to `dist/wt`. No installed binary is replaced.
- `build:release-artifacts`: compile the existing Darwin ARM64, Linux x64 baseline and Linux ARM64 targets, package completions and instructions, and write SHA256SUMS. The all-platform install above supplies native dependencies for cross-compilation.
- `test:artifact`: validate checksums and archive contents, then exercise the host binary and matching extracted archive with `--help` and an offline Git fixture, with no Bun or installed wt on PATH. Cross-compiled targets are inspected as archives; only matching host targets are executed.
- `release:check`: run `check`, the host build, all release builds and `test:artifact`; no tag, release, upload or publication.
- `release:publish` (also `release`): the existing manual GitHub binary publication driver. It requires clean, freshly fetched `origin/main`, installs frozen all-platform dependencies, and must pass `release:check` before creating/pushing a tag or creating/uploading a GitHub release. Validation failure stops publication. CI only validates; merging does not publish.

`release:version` is not applicable: there is no automated version/changelog operation. The release driver uses the version already committed in `package.json`. npm packing and publishing are not applicable to this private binary tool.

# wt

Git worktree helper that creates worktrees with gitignored file sync and dependency install.

## What it does

1. Creates a worktree in `../<repo>-worktrees/<slug>/`
2. Syncs all gitignored files (`.env`, `.scratchpad`, editor config, etc.) from the source repo
3. Installs dependencies via [`ni`](https://github.com/antfu/ni) (auto-detects package manager)

## Install

### From release

```bash
curl -sL https://github.com/aryasaatvik/wt/releases/latest/download/wt-v1.0.0.tar.gz | tar -xz -C /tmp
cp /tmp/bin/wt ~/.local/bin/wt
```

For completions, copy `completions/wt.zsh` to your zsh completions directory or source it in your `.zshrc`.

### From source

```bash
git clone https://github.com/aryasaatvik/wt ~/Developer/wt
ln -s ~/Developer/wt/bin/wt ~/.local/bin/wt
ln -s ~/Developer/wt/completions/wt.zsh ~/.zsh/completions/wt.zsh
```

Requires: `git`, `rsync`, [`ni`](https://github.com/antfu/ni).

## Usage

```bash
wt x/my-feature           # create worktree from main
wt new x/my-feature dev   # create from a specific base branch
wt rm x/my-feature        # remove worktree and delete branch
wt ls                     # list all worktrees
wt --verbose x/feature    # show rsync file list
```

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
- **Xcode/Swift**: `build`, `.build`, `DerivedData`, `Pods`, `Carthage`, `xcuserdata`
- **Misc**: `.wrangler`

Edit the `SYNC_EXCLUDE` array in `bin/wt` to customize.

## Gotchas

**Git hooks in worktrees**: `.git` in a worktree is a file, not a directory. Hook installers (`hk`, `husky`, `lefthook`) may fail. Guard your prepare script:

```json
"prepare": "[ -f .git ] || (hk install)"
```

## License

MIT

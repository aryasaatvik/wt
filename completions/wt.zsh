#compdef wt
compdef _wt wt

_wt() {
  local -a subcommands=(
    'new:Create worktree from base branch'
    'create:Create worktree from base branch'
    'rm:Remove worktree'
    'remove:Remove worktree'
    'ls:List all worktrees'
    'list:List all worktrees'
  )

  _arguments -C \
    '--verbose[Show detailed rsync output]' \
    '--no-install[Skip dependency install]' \
    '(-h --help)'{-h,--help}'[Show help]' \
    '1:command:->cmd' \
    '*::arg:->args'

  case "$state" in
    cmd)
      _describe 'command' subcommands
      # Also allow bare branch names (implicit create)
      _wt_branches
      ;;
    args)
      case "${words[1]}" in
        rm|remove)
          _arguments \
            '(-D --delete-branch)'{-D,--delete-branch}'[Also delete the branch]' \
            '*:worktree:_wt_worktree_targets'
          return
          ;;
        new|create)
          if [[ $CURRENT -eq 2 ]]; then
            _message 'branch name'
          elif [[ $CURRENT -eq 3 ]]; then
            _wt_branches
          fi
          ;;
      esac
      ;;
  esac
}

_wt_branches() {
  local -a branches
  branches=(${(f)"$(git branch --format='%(refname:short)' 2>/dev/null)"})
  _describe 'branch' branches
}

# rm targets: worktree branches plus directory names (how detached worktrees
# are addressed). The primary worktree is excluded.
_wt_worktree_targets() {
  # Never name a local `path`: in zsh it is tied to PATH, so `local path=""`
  # empties PATH for the rest of this function and hides git/coreutils.
  local -a targets
  local primary=""
  local worktree_dir="" branch=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        worktree_dir="${line#worktree }"
        [[ -z "$primary" ]] && primary="$worktree_dir" && worktree_dir=""
        ;;
      "branch refs/heads/"*)
        branch="${line#branch refs/heads/}"
        ;;
      "")
        if [[ -n "$worktree_dir" ]]; then
          [[ -n "$branch" ]] && targets+=("$branch")
          targets+=("${worktree_dir:t}")
        fi
        worktree_dir="" branch=""
        ;;
    esac
  done < <(git worktree list --porcelain 2>/dev/null; echo)
  _describe 'worktree' targets
}

if [ "${funcstack[1]}" = "_wt" ]; then
  _wt
fi

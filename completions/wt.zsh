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
            '*:worktree branch:_wt_worktree_branches'
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

_wt_worktree_branches() {
  local -a wt_branches
  wt_branches=(${(f)"$(git worktree list --porcelain 2>/dev/null | grep '^branch ' | sed 's|^branch refs/heads/||')"})
  # Exclude main worktree (current repo)
  local main_branch
  main_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  wt_branches=(${wt_branches:#$main_branch})
  _describe 'worktree branch' wt_branches
}

if [ "${funcstack[1]}" = "_wt" ]; then
  _wt
fi

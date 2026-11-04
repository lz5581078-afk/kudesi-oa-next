#!/usr/bin/env bash
# Reuse an existing task before creating a new isolated worktree.
set -euo pipefail
name="${1:-}"
[ -n "$name" ] || { echo '用法：bash scripts/collab/start-task.sh <任务简称>'; exit 1; }
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo '任务简称只允许英文、数字、点、横线、下划线'; exit 1; }
root="$(git rev-parse --show-toplevel)"
common="$(git rev-parse --path-format=absolute --git-common-dir)"
branch="feat/$name"
existing="$(git worktree list --porcelain | awk -v branch="refs/heads/$branch" '/^worktree / {path=substr($0,10)} /^branch / {if (substr($0,8)==branch) print path}')"
if [ -n "$existing" ]; then
  echo "复用已有任务：$existing"
  echo '先核对任务板和未提交内容；不要重复创建同一任务。'
  exit 0
fi
# Always create siblings of the primary checkout, even when invoked in a worktree.
primary="$(dirname "$common")"
dir="$(dirname "$primary")/wt-$name"
[ ! -e "$dir" ] || { echo "目录已存在，请先核对：$dir"; exit 1; }
git fetch origin --prune
if git show-ref --verify --quiet "refs/heads/$branch"; then
  git worktree add "$dir" "$branch"
else
  git rev-parse --verify origin/integration >/dev/null
  git worktree add -b "$branch" "$dir" origin/integration
fi
if [ -d "$primary/node_modules" ] && [ ! -e "$dir/node_modules" ]; then
  ln -s "$primary/node_modules" "$dir/node_modules"
fi
echo "工作目录：$dir"
echo "分支：${branch}；在任务板认领后开始修改。完成后按工作区管理规则验收回收。"

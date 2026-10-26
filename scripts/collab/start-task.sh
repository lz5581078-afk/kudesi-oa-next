#!/usr/bin/env bash
# 用法：bash scripts/collab/start-task.sh <任务简称>
# 从 integration 切出 feat/<任务简称>，并在 ../wt-<任务简称> 建独立工作目录（复用主目录的 node_modules）。
set -euo pipefail
name="${1:-}"
[ -n "$name" ] || { echo "用法：bash scripts/collab/start-task.sh <任务简称（英文/拼音，无空格）>"; exit 1; }
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "任务简称只能用字母、数字、点、下划线、短横线"; exit 1; }
root="$(git rev-parse --show-toplevel)"
cd "$root"
git fetch origin --prune 2>/dev/null || echo "（没有远程仓库，只用本地分支）"
base_ref=""
if git rev-parse --verify -q origin/integration >/dev/null; then base_ref="origin/integration"
elif git rev-parse --verify -q integration >/dev/null; then base_ref="integration"
else
  main_ref="main"; git rev-parse --verify -q origin/main >/dev/null && main_ref="origin/main"
  git branch integration "$main_ref"
  git push -u origin integration 2>/dev/null || true
  base_ref="integration"
fi
dir="$root/../wt-$name"
[ -e "$dir" ] && { echo "目录已存在：$dir"; exit 1; }
git worktree add -b "feat/$name" "$dir" "$base_ref"
if [ -d "$root/node_modules" ] && [ ! -e "$dir/node_modules" ]; then
  ln -s "$root/node_modules" "$dir/node_modules"
  grep -qx node_modules "$root/.git/info/exclude" 2>/dev/null || echo node_modules >> "$root/.git/info/exclude"
fi
echo "已建好：分支 feat/$name，工作目录 $dir"
echo "下一步：cd $dir ；在 docs/协作/任务板.md 认领任务；改完提交并向 integration 提 PR。"

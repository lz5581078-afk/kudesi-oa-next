#!/usr/bin/env bash
# 输出下一个可用的迁移编号（扫描 main、integration 和所有远程分支里的迁移文件，再加上任务板里已占用的号段）。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
dir="apps/api/src/database/migrations"
git fetch origin --prune 2>/dev/null || true
max=0
refs=$(git for-each-ref --format='%(refname)' refs/heads refs/remotes | grep -v HEAD || true)
for r in $refs; do
  for f in $(git ls-tree --name-only "$r" "$dir/" 2>/dev/null || true); do
    n=$(basename "$f" | grep -oE '^[0-9]{13}' || true)
    [ -n "$n" ] && [ "$n" -gt "$max" ] && max=$n
  done
done
for f in "$dir"/*.ts; do
  n=$(basename "$f" | grep -oE '^[0-9]{13}' || true)
  [ -n "$n" ] && [ "$n" -gt "$max" ] && max=$n
done
# 任务板“迁移占用”表里登记过的编号也算
if [ -f docs/协作/任务板.md ]; then
  for n in $(grep -oE '17[0-9]{11}' docs/协作/任务板.md || true); do [ "$n" -gt "$max" ] && max=$n; done
fi
next=$(( (max / 1000000000 + 1) * 1000000000 ))
echo "当前最大编号：$max"
echo "建议下一个：$next   （文件名 ${next}-描述.ts，并在 data-source.ts 注册；先到任务板“迁移占用”登记）"

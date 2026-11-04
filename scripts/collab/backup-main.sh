#!/usr/bin/env bash
# Preview by default; an identical main revision reuses an existing backup ref.
set -euo pipefail
label="${1:-}"
mode="${2:-}"
[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || { echo '用法：bash scripts/collab/backup-main.sh <说明> [--apply]'; exit 1; }
[ -z "$mode" ] || [ "$mode" = '--apply' ] || { echo '未知参数'; exit 1; }
git fetch origin --prune
sha="$(git rev-parse --verify origin/main)"
existing="$(git for-each-ref --points-at "$sha" --format='%(refname:short)' refs/heads/backup/ refs/remotes/origin/backup/ | head -1)"
if [ -n "$existing" ]; then
  # A local-only backup still needs publishing before it can serve as release backup.
  branch="${existing#origin/}"
  echo "复用版本备份：${branch} (${sha})"
else
  branch="backup/main-before-${label}-$(date -u +%Y%m%d)"
  if git show-ref --verify --quiet "refs/heads/$branch" || git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    branch="${branch}-${sha:0:12}"
  fi
  echo "新增版本备份：${branch} (${sha})"
fi
if [ "$mode" != '--apply' ]; then
  echo '仅预览；--apply 才创建并推送引用，不创建代码副本。'
  exit 0
fi
# Create-only lease: an existing remote ref is never updated, even in a race.
remote_sha="$(git ls-remote --heads origin "refs/heads/$branch" | awk '{print $1}')"
if [ -n "$remote_sha" ]; then
  [ "$remote_sha" = "$sha" ] || { echo '远程备份已存在且版本不同，拒绝覆盖'; exit 1; }
else
  git push --force-with-lease="refs/heads/${branch}:" origin "${sha}:refs/heads/${branch}"
fi
if ! git show-ref --verify --quiet "refs/heads/$branch"; then
  git branch "$branch" "$sha"
fi
echo "备份已保留：$branch"

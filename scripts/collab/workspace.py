#!/usr/bin/env python3
"""Local worktree lifecycle. Read-only by default; never force-remove or delete refs."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def git(*args, cwd=None, check=True):
    p = subprocess.run(['git', *args], cwd=cwd, text=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE)
    if check and p.returncode:
        raise RuntimeError(p.stderr.strip() or 'Git command failed')
    return p


def common():
    return Path(git('rev-parse', '--path-format=absolute', '--git-common-dir').stdout.strip())


def entries():
    # NUL format supports spaces, newlines and non-ASCII paths without quoting.
    result, row = [], {}
    for field in git('worktree', 'list', '--porcelain', '-z').stdout.split('\0'):
        if not field:
            if row:
                result.append(row)
                row = {}
            continue
        key, _, value = field.partition(' ')
        row[key] = value
    if row:
        result.append(row)
    return result


def read_record(root, path):
    try:
        return json.loads((root / 'accepted.json').read_text()).get(str(path))
    except FileNotFoundError:
        return None


def write_record(root, path, value):
    root.mkdir(exist_ok=True)
    file = root / 'accepted.json'
    data = json.loads(file.read_text()) if file.exists() else {}
    data[str(path)] = value
    temp = root / 'accepted.tmp'
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temp.replace(file)


def reasons(entry, root, now=None):
    path = Path(entry['worktree']).resolve()
    out = []
    if path == root.parent.parent.resolve():
        out.append('主仓库')
    if Path.cwd().resolve().is_relative_to(path):
        out.append('当前工作区')
    if 'locked' in entry or 'prunable' in entry or not path.exists():
        out.append('锁定、缺失或待修复')
    branch = entry.get('branch', '')
    if branch in ('refs/heads/main', 'refs/heads/integration') or not branch:
        out.append('受保护分支或分离HEAD')
    if out:
        return out
    record = read_record(root, path)
    if not record:
        out.append('尚未登记验收（旧任务也须人工核对）')
    else:
        if record['head'] != entry['HEAD'] or record['branch'] != branch:
            out.append('验收后版本或分支已改变')
        if (now if now is not None else time.time()) - record['accepted_at'] < 3 * 86400:
            out.append('验收后未满3天')
        target = record['target']
        if git('merge-base', '--is-ancestor', entry['HEAD'], target, check=False).returncode:
            out.append('未完整合入验收目标（压缩合并须另行人工审查）')
    # Include ignored files: .env, screenshots and local artifacts must not disappear.
    status = git('status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching',
                 cwd=path).stdout.splitlines()
    status = [line for line in status if line != '!! node_modules' or not (path / 'node_modules').is_symlink()]
    if status:
        out.append('有未提交、未跟踪或忽略文件')
    tracked = git('rev-parse', '--abbrev-ref', '@{upstream}', cwd=path, check=False)
    if tracked.returncode or not tracked.stdout.strip().startswith('origin/'):
        out.append('没有origin远程跟踪分支')
    elif git('merge-base', '--is-ancestor', entry['HEAD'], tracked.stdout.strip(), check=False).returncode:
        out.append('当前提交尚未推送至跟踪分支')
    return out


def size(path):
    total = 0
    for base, dirs, files in os.walk(path, followlinks=False):
        dirs[:] = [d for d in dirs if not Path(base, d).is_symlink()]
        for name in files:
            p = Path(base, name)
            if not p.is_symlink():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
    return round(total / 1024 / 1024, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='cmd', required=True)
    inventory = sub.add_parser('list', help='只读清单，默认不扫描目录大小')
    inventory.add_argument('--sizes', action='store_true')
    accept = sub.add_parser('accept', help='操作者确认任务及发布验收已完成后登记')
    accept.add_argument('path')
    accept.add_argument('--target', choices=['origin/main', 'origin/integration'], required=True)
    accept.add_argument('--evidence', required=True, help='PR/验收记录位置；不含密码或密钥')
    clean = sub.add_parser('clean', help='指定一个目录；默认预览，--apply才回收')
    clean.add_argument('path')
    clean.add_argument('--apply', action='store_true')
    sub.add_parser('backups', help='只读列出备份引用；不删除本地或远程分支')
    args = parser.parse_args()
    root = common()
    state = root / 'workspace-lifecycle'
    if args.cmd == 'backups':
        print(git('for-each-ref', '--format=%(refname:short) %(objectname:short)',
                  'refs/heads/backup/', 'refs/remotes/origin/backup/').stdout, end='')
        print('备份引用不复制工作区。历史创建时间不可靠，未经核对的引用一律保留。')
        return
    all_entries = entries()
    if args.cmd == 'list':
        report = []
        for entry in all_entries:
            path = Path(entry['worktree']).resolve()
            row = dict(path=str(path), branch=entry.get('branch', '').removeprefix('refs/heads/'),
                       blockers=reasons(entry, state))
            if args.sizes:
                row['size_mib'] = size(path)
            report.append(row)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    path = Path(args.path).resolve()
    entry = next((e for e in all_entries if Path(e['worktree']).resolve() == path), None)
    if not entry:
        raise RuntimeError('只允许处理本仓库登记的准确工作区路径')
    # Serialize lifecycle commands. Git is not an editor lock: the operator must stop
    # the task and its dev processes before acceptance/removal.
    state.mkdir(exist_ok=True)
    lock = state / 'operation.lock'
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.close(fd)
        if args.cmd == 'accept':
            blocked = reasons(entry, state)
            ignored = ('尚未登记验收', '验收后', '未完整合入验收目标')
            blocked = [r for r in blocked if not r.startswith(ignored)]
            if git('merge-base', '--is-ancestor', entry['HEAD'], args.target, check=False).returncode:
                blocked.append('提交尚未完整合入指定目标')
            if not args.evidence.strip():
                blocked.append('缺少验收证据')
            if blocked:
                raise RuntimeError('不能登记：' + '；'.join(blocked))
            write_record(state, path, dict(head=entry['HEAD'], branch=entry['branch'],
                         target=args.target, evidence=args.evidence, accepted_at=time.time()))
            print('已登记；3天后可预览回收。若继续修改，需重新验收。')
        else:
            blocked = reasons(entry, state)
            print(json.dumps(dict(path=str(path), blockers=blocked,
                                  action='回收' if args.apply else '仅预览'), ensure_ascii=False, indent=2))
            if args.apply:
                if blocked:
                    raise RuntimeError('已阻止回收，请处理上面的原因')
                # Do not use --force: Git performs the final clean/lock check.
                git('worktree', 'remove', str(path))
                with (state / 'operations.jsonl').open('a') as f:
                    f.write(json.dumps(dict(path=str(path), head=entry['HEAD'],
                              removed_at=dt.datetime.now(dt.timezone.utc).isoformat())) + '\n')
                print('已回收目录；分支和远程历史保留。')
    finally:
        lock.unlink()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

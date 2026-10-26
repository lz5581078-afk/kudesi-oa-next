#!/usr/bin/env python3
"""Package compiled artifacts only; never include source environment files or node_modules."""
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import tarfile


def package(revision, release, output, root=Path('.')):
    if not re.fullmatch(r'[a-f0-9]{40}(?:[a-f0-9]{24})?', revision) or not re.fullmatch(r'[0-9]{8}-[a-z0-9-]{1,60}', release):
        raise ValueError('Invalid revision or release ID')
    paths = ['package.json', 'package-lock.json', 'packages/shared/package.json', 'packages/shared/dist',
             'apps/api/package.json', 'apps/api/dist', 'apps/web/package.json', 'apps/web/dist',
             'apps/agent/package.json', 'deploy/server/Dockerfile']
    manifest = {'revision': revision, 'release': release, 'domain': 'lc.kudesi.com', 'name': '\u5c0f\u767d\u5168\u6d41\u7a0b\u7cfb\u7edf'}
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(output, 'w:gz') as bundle:
        for relative in paths:
            path = root / relative
            if not path.exists() or path.is_symlink():
                raise ValueError('Build output is missing or unsafe: ' + relative)
            members = [path] + (sorted(path.rglob('*')) if path.is_dir() else [])
            for member in members:
                if member.is_symlink() or (not member.is_dir() and not member.is_file()):
                    raise ValueError('Special files cannot be packaged')
                name = member.relative_to(root).as_posix()
                if any(part in ['.env', 'node_modules', '.git'] for part in Path(name).parts):
                    raise ValueError('Unexpected private build output')
                if name == 'apps/web/dist/release.json':
                    continue
                bundle.add(member, arcname=name, recursive=False)
        payload = (json.dumps(manifest, ensure_ascii=False) + '\n').encode()
        for name in ['release.json', 'apps/web/dist/release.json']:
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = 0o644
            bundle.addfile(info, io.BytesIO(payload))
    return hashlib.sha256(output.read_bytes()).hexdigest()


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: package-release.py <revision> <release> <archive>')
    print(package(*sys.argv[1:]))

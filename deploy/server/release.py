#!/usr/bin/env python3
"""Trusted server-side release controller. Installed by an administrator, never run from an upload."""
import contextlib
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

ID = re.compile(r"^[0-9]{8}-[a-z0-9-]{1,60}$")
SHA = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
LIMIT = 64 * 1024 * 1024
PAYLOAD_LIMIT = 256 * 1024 * 1024


class ReleaseError(Exception):
    pass


def release_id(value):
    if not ID.fullmatch(value):
        raise ReleaseError("Invalid release ID")
    return value


def atomic_json(path, data, mode=0o600):
    temp = path.with_name(path.name + ".next")
    temp.write_text(json.dumps(data) + "\n")
    temp.chmod(mode)
    os.replace(temp, path)


class Runner:
    def __init__(self, log):
        self.log = log

    def run(self, args, timeout=900):
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        with self.log.open("ab") as log:
            log.write(result.stdout + result.stderr)
        if result.returncode:
            raise ReleaseError("Server command failed; see the private deployment log")
        return result.stdout.decode().strip()

    def backup(self, target):
        command = ["docker", "exec", "kudesi-lc-mysql-1", "sh", "-c",
                   'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump -u"$MYSQL_USER" --single-transaction --no-tablespaces "$MYSQL_DATABASE"']
        with self.log.open("ab") as log, target.open("wb") as output:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=log)
            try:
                with gzip.GzipFile(fileobj=output, mode="wb") as compressed:
                    shutil.copyfileobj(process.stdout, compressed)
            finally:
                process.stdout.close()
            if process.wait(timeout=300):
                raise ReleaseError("Database backup failed")


class Deployment:
    def __init__(self, root, runner=None):
        self.root = Path(root).resolve()
        for directory in ["incoming", "state", "logs", "backups"]:
            (self.root / directory).mkdir(mode=0o700, parents=True, exist_ok=True)
        self.runner = runner or Runner(self.root / "logs" / "deploy.log")

    @contextlib.contextmanager
    def lock(self):
        with (self.root / "state" / "deploy.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ReleaseError("Another deployment is in progress")
            yield

    def current(self):
        path = (self.root / "current").resolve(strict=True)
        if path.parent != self.root / "releases":
            raise ReleaseError("Current release is outside the release directory")
        release_id(path.name)
        return path

    def manifest(self, path):
        data = json.loads((path / "release.json").read_text())
        if data.get("release") != path.name or not SHA.fullmatch(data.get("revision", "")):
            raise ReleaseError("Invalid release manifest")
        return data

    def receive(self, name, digest, stream):
        release_id(name)
        if not DIGEST.fullmatch(digest):
            raise ReleaseError("Invalid archive digest")
        target = self.root / "incoming" / (name + ".tar.gz")
        if target.exists() or (self.root / "releases" / name).exists():
            raise ReleaseError("Release ID already exists; rerun with a new attempt")
        checksum = hashlib.sha256()
        temp = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as out:
                temp = Path(out.name)
                size = 0
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > LIMIT:
                        raise ReleaseError("Archive exceeds 64 MiB")
                    checksum.update(chunk)
                    out.write(chunk)
            if not size or checksum.hexdigest() != digest:
                raise ReleaseError("Archive checksum mismatch")
            os.replace(temp, target)
            return {"uploaded": name}
        finally:
            if temp and temp.exists():
                temp.unlink()

    @staticmethod
    def allowed(name):
        files = {"package.json", "package-lock.json", "release.json", "deploy/server/Dockerfile"}
        roots = ["apps/api/dist", "apps/web/dist", "packages/shared/dist"]
        packages = ["apps/api/package.json", "apps/web/package.json", "apps/agent/package.json", "packages/shared/package.json"]
        dirs = {"apps", "apps/api", "apps/web", "apps/agent", "packages", "packages/shared", "deploy", "deploy/server"}
        return name in files or name in packages or name in dirs or any(name == p or name.startswith(p + "/") for p in roots)

    def extract(self, name):
        target = self.root / "releases" / name
        if target.exists():
            raise ReleaseError("Release directory already exists")
        archive = self.root / "incoming" / (name + ".tar.gz")
        target.mkdir(mode=0o755)
        try:
            with tarfile.open(archive, "r:gz") as bundle:
                total, count, seen = 0, 0, set()
                for member in bundle:
                    path = PurePosixPath(member.name)
                    normalized = str(path)
                    total += member.size
                    count += 1
                    if (path.is_absolute() or ".." in path.parts or "\\" in member.name or
                            not self.allowed(normalized) or not (member.isdir() or member.isfile()) or
                            member.size < 0 or total > PAYLOAD_LIMIT or count > 20000 or normalized in seen):
                        raise ReleaseError("Unsafe or unexpected archive member")
                    seen.add(normalized)
                    out = target / normalized
                    if member.isdir():
                        out.mkdir(parents=True, exist_ok=True, mode=0o755)
                    else:
                        out.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                        with bundle.extractfile(member) as source, out.open("xb") as dest:
                            shutil.copyfileobj(source, dest)
                        out.chmod(0o644)
            target.chmod(0o755)
            for directory in target.rglob("*"):
                if directory.is_dir():
                    directory.chmod(0o755)
            self.manifest(target)
            for required in ["apps/api/dist/main.js", "apps/web/dist/index.html", "packages/shared/dist/index.js", "package-lock.json"]:
                if not (target / required).is_file():
                    raise ReleaseError("Release payload is incomplete")
            atomic_json(target / "apps/web/dist/release.json", self.manifest(target), mode=0o644)
            (target / "image.env").write_text("KUDESI_API_IMAGE=kudesi-lc-api:" + name + "\n")
            return target
        except Exception:
            shutil.rmtree(target)
            raise

    def compose(self, target, *args):
        return self.runner.run(["docker", "compose", "--progress", "plain", "--env-file", str(target / "image.env"),
                                "-f", str(self.root / "control/compose.yml"), *args], timeout=300)

    def backup(self, name, old):
        backup = self.root / "backups" / name
        backup.mkdir(mode=0o700)
        atomic_json(backup / "state.json", {"previous": old.name, "revision": self.manifest(old)["revision"]})
        output = backup / "database.sql.gz"
        self.runner.backup(output)
        size = 0
        with gzip.open(output, "rb") as dump:
            while True:
                data = dump.read(1024 * 1024)
                if not data:
                    break
                size += len(data)
        if size < 32:
            raise ReleaseError("Database backup is empty")
        return backup

    def migrations(self, old, target):
        before = old / "apps/api/dist/database/migrations"
        after = target / "apps/api/dist/database/migrations"
        for previous in before.glob("*.js"):
            following = after / previous.name
            if not following.is_file() or previous.read_bytes() != following.read_bytes():
                raise ReleaseError("An existing migration was changed or removed")
        code = "const {MIGRATIONS}=require('/app/apps/api/dist/database/data-source.js'); console.log(JSON.stringify(MIGRATIONS.map(C=>new C().name||C.name)))"
        declared = json.loads(self.runner.run(["docker", "run", "--rm", "--env-file", str(self.root / "shared/api.env"),
                                              "kudesi-lc-api:" + target.name, "node", "-e", code]))
        query = 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u"$MYSQL_USER" -N -B "$MYSQL_DATABASE" -e "SELECT name FROM migrations ORDER BY timestamp,id"'
        executed = self.runner.run(["docker", "exec", "kudesi-lc-mysql-1", "sh", "-c", query]).splitlines()
        if not isinstance(declared, list) or not all(isinstance(n, str) for n in declared) or len(set(declared)) != len(declared):
            raise ReleaseError("Invalid migration registry")
        if set(executed) - set(declared):
            raise ReleaseError("The new release omits executed migrations")
        pending = set(declared) - set(executed)
        if pending:
            self.compose(target, "run", "--rm", "--no-deps", "api", "node", "node_modules/typeorm/cli.js", "migration:run", "-d", "apps/api/dist/database/data-source.js")
        return len(pending)

    def activate(self, target):
        next_link = self.root / "state/current.next"
        if next_link.is_symlink():
            next_link.unlink()
        next_link.symlink_to(target)
        os.replace(next_link, self.root / "current")
        self.compose(target, "up", "-d", "--wait", "--wait-timeout", "120", "api")

    def health(self, target):
        health = json.loads(self.runner.run(["curl", "-fsS", "--retry", "5", "--retry-delay", "2", "--retry-all-errors", "--max-time", "10", "http://127.0.0.1:4107/api/health"], timeout=90))
        manifest = json.loads(self.runner.run(["curl", "-fsS", "--retry", "5", "--retry-delay", "2", "--retry-all-errors", "--max-time", "10", "--resolve", "lc.kudesi.com:443:127.0.0.1", "https://lc.kudesi.com/release.json?check=" + target.name], timeout=90))
        if health.get("status") != "ok" or manifest != self.manifest(target):
            raise ReleaseError("Health or served-release verification failed")

    def switch(self, target, old, commit=None):
        try:
            self.activate(target)
            self.health(target)
            if commit:
                commit()
        except Exception as error:
            try:
                self.activate(old)
                self.health(old)
            except Exception:
                raise ReleaseError("Release failed and rollback needs operator attention; private logs and backup are preserved") from error
            raise ReleaseError("Release failed; previous application version restored (database is not automatically restored)") from error

    def deploy(self, name):
        release_id(name)
        old = self.current()
        target = self.extract(name)
        self.backup(name, old)
        self.runner.run(["docker", "build", "-f", str(self.root / "control/Dockerfile"), "-t", "kudesi-lc-api:" + name, str(target)])
        pending = self.migrations(old, target)
        result = {"release": name, "previous": old.name, "revision": self.manifest(target)["revision"], "migrations": pending}
        def commit():
            atomic_json(self.root / "state/last-deploy.json", result)
            (self.root / "incoming" / (name + ".tar.gz")).unlink()
        self.switch(target, old, commit)
        return result

    def rollback(self, name):
        release_id(name)
        old = self.current()
        target = self.root / "releases" / name
        self.manifest(target)
        if target == old:
            self.health(old)
            return {"release": name, "unchanged": True}
        self.backup("rollback-" + str(time.time_ns()), old)
        self.switch(target, old)
        return {"release": name, "previous": old.name, "revision": self.manifest(target)["revision"]}

    def rollback_if_current(self, name):
        release_id(name)
        data = json.loads((self.root / "state/last-deploy.json").read_text())
        if self.current().name != name or data["release"] != name:
            raise ReleaseError("Refusing to roll back a different deployment")
        return self.rollback(data["previous"])


def main():
    os.umask(0o077)
    deployment = Deployment(os.environ.get("KUDESI_DEPLOY_ROOT", "/srv/kudesi-lc"))
    arguments = sys.argv[1:]
    try:
        with deployment.lock():
            if len(arguments) == 3 and arguments[0] == "upload":
                result = deployment.receive(arguments[1], arguments[2], sys.stdin.buffer)
            elif len(arguments) == 2 and arguments[0] in ["deploy", "rollback", "rollback-if-current"]:
                method = getattr(deployment, arguments[0].replace("-", "_"))
                result = method(arguments[1])
            elif arguments == ["status"]:
                result = deployment.manifest(deployment.current())
            else:
                raise ReleaseError("Unsupported release command")
        print(json.dumps(result))
    except Exception as error:
        # Never print subprocess output or runtime environment to CI.
        print("Deployment error: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

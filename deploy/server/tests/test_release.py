import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj

release = module('controller', 'release.py')
packager = module('packager', 'package-release.py')
OLD = '20261026-01'
NEW = '20261027-100-1-abcdefabcdef'
REVISION = 'b' * 40


def fixture(path):
    for name in ['package.json', 'package-lock.json', 'packages/shared/package.json', 'packages/shared/dist/index.js',
                 'apps/api/package.json', 'apps/api/dist/main.js', 'apps/api/dist/database/migrations/1-Initial.js',
                 'apps/web/package.json', 'apps/web/dist/index.html', 'apps/agent/package.json', 'deploy/server/Dockerfile']:
        file = path / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text('initial migration' if name.endswith('1-Initial.js') else '{}')


class FakeRunner:
    def __init__(self, root):
        self.root = root
        self.calls = []
        self.declared = ['Initial1']
        self.executed = ['Initial1']
        self.fail = None
        self.failed = False
        self.backups = 0
        self.migrated = False

    def backup(self, target):
        self.backups += 1
        if self.fail == 'backup':
            raise release.ReleaseError('Backup failed')
        target.write_bytes(gzip.compress(b'CREATE TABLE fixture(id int);\n' * 4))

    def run(self, args, timeout=900):
        self.calls.append(args)
        if args[:2] == ['docker', 'build']:
            if self.fail == 'build':
                raise release.ReleaseError('Build failed')
            return ''
        if args[:2] == ['docker', 'run']:
            return json.dumps(self.declared)
        if args[:2] == ['docker', 'exec']:
            return '\n'.join(self.executed)
        if args[:2] == ['docker', 'compose']:
            if 'migration:run' in args:
                self.migrated = True
                self.executed = list(self.declared)
                if self.fail == 'migration':
                    raise release.ReleaseError('Migration failed')
            if 'up' in args and self.fail == 'start' and not self.failed:
                self.failed = True
                raise release.ReleaseError('Container did not become healthy')
            return ''
        if args[0] == 'curl':
            if self.fail == 'health' and not self.failed:
                self.failed = True
                raise release.ReleaseError('API unhealthy')
            if '/api/health' in args[-1]:
                return '{"status":"ok"}'
            if self.fail == 'wrong-release' and not self.failed:
                self.failed = True
                return '{"release":"stale"}'
            return (self.root / 'current/release.json').read_text()
        raise AssertionError(args)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        (self.root / 'releases').mkdir()
        self.old = self.root / 'releases' / OLD
        fixture(self.old)
        (self.old / 'release.json').write_text(json.dumps({'release': OLD, 'revision': 'a' * 40}))
        (self.old / 'image.env').write_text('KUDESI_API_IMAGE=kudesi-lc-api:' + OLD + '\n')
        (self.root / 'current').symlink_to(self.old)
        self.source = self.root / 'source'
        fixture(self.source)
        self.archive = self.root / 'package.tar.gz'
        (self.root / 'shared').mkdir()
        (self.root / 'shared/sentinel').write_text('shared configuration must remain unchanged')
        self.runner = FakeRunner(self.root)
        self.controller = release.Deployment(self.root, self.runner)

    def tearDown(self):
        self.assertEqual((self.root / 'shared/sentinel').read_text(), 'shared configuration must remain unchanged')
        self.temp.cleanup()

    def upload(self):
        digest = packager.package(REVISION, NEW, self.archive, self.source)
        self.controller.receive(NEW, digest, io.BytesIO(self.archive.read_bytes()))

    def test_successful_release_has_backup_and_serves_exact_revision(self):
        self.upload()
        result = self.controller.deploy(NEW)
        self.assertEqual(result['previous'], OLD)
        self.assertEqual(result['revision'], REVISION)
        self.assertEqual(self.controller.current().name, NEW)
        self.assertEqual(result['migrations'], 0)
        self.assertFalse(self.runner.migrated)
        self.assertTrue((self.root / 'backups' / NEW / 'database.sql.gz').is_file())
        self.assertEqual((self.controller.current() / 'apps/web/dist/release.json').stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.controller.current().stat().st_mode & 0o777, 0o755)
        self.assertEqual(json.loads((self.root / 'state/last-deploy.json').read_text())['release'], NEW)
        self.assertFalse((self.root / 'incoming' / (NEW + '.tar.gz')).exists())

    def test_public_manifest_is_readable_even_with_private_server_umask(self):
        previous = os.umask(0o077)
        try:
            self.upload()
            self.controller.deploy(NEW)
        finally:
            os.umask(previous)
        self.assertEqual((self.controller.current() / 'apps/web/dist/release.json').stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.controller.current().stat().st_mode & 0o777, 0o755)

    def test_pending_migration_runs_only_after_a_verified_backup(self):
        (self.source / 'apps/api/dist/database/migrations/2-Next.js').write_text('new migration')
        self.runner.declared.append('Next2')
        self.upload()
        result = self.controller.deploy(NEW)
        self.assertEqual(result['migrations'], 1)
        self.assertTrue(self.runner.migrated)
        self.assertEqual(self.runner.backups, 1)

    def test_backup_failure_never_builds_migrates_or_switches(self):
        self.upload()
        self.runner.fail = 'backup'
        with self.assertRaises(release.ReleaseError):
            self.controller.deploy(NEW)
        self.assertEqual(self.controller.current(), self.old)
        self.assertEqual(self.runner.calls, [])

    def test_build_failure_preserves_running_release(self):
        self.upload()
        self.runner.fail = 'build'
        with self.assertRaises(release.ReleaseError):
            self.controller.deploy(NEW)
        self.assertEqual(self.controller.current(), self.old)
        self.assertFalse(self.runner.migrated)

    def test_migration_failure_does_not_switch_or_restore_data(self):
        self.runner.declared.append('Next2')
        self.runner.fail = 'migration'
        self.upload()
        with self.assertRaises(release.ReleaseError):
            self.controller.deploy(NEW)
        self.assertEqual(self.controller.current(), self.old)
        self.assertTrue((self.root / 'backups' / NEW / 'database.sql.gz').exists())
        self.assertFalse(any('up' in cmd for cmd in self.runner.calls))

    def test_start_health_and_wrong_web_revision_failures_restore_previous_release(self):
        for failure in ['start', 'health', 'wrong-release']:
            with self.subTest(failure=failure):
                self.upload()
                self.runner.fail, self.runner.failed = failure, False
                with self.assertRaisesRegex(release.ReleaseError, 'previous application version restored'):
                    self.controller.deploy(NEW)
                self.assertEqual(self.controller.current(), self.old)
                self.assertTrue(any('up' in cmd and str(self.old / 'image.env') in cmd for cmd in self.runner.calls))
                # Recreate this failed release as a new attempt for the next injected failure.
                import shutil
                shutil.rmtree(self.root / 'releases' / NEW)
                shutil.rmtree(self.root / 'backups' / NEW)
                (self.root / 'incoming' / (NEW + '.tar.gz')).unlink()

    def test_mutated_or_removed_existing_migration_is_rejected(self):
        (self.source / 'apps/api/dist/database/migrations/1-Initial.js').write_text('modified')
        self.upload()
        with self.assertRaisesRegex(release.ReleaseError, 'existing migration'):
            self.controller.deploy(NEW)
        self.assertEqual(self.controller.current(), self.old)
        self.assertFalse(self.runner.migrated)

    def test_missing_executed_migration_is_rejected(self):
        self.runner.executed.append('Missing9')
        self.upload()
        with self.assertRaisesRegex(release.ReleaseError, 'omits executed'):
            self.controller.deploy(NEW)
        self.assertEqual(self.controller.current(), self.old)

    def test_manual_rollback_backs_up_current_and_restores_previous(self):
        self.upload()
        self.controller.deploy(NEW)
        result = self.controller.rollback(OLD)
        self.assertEqual(result['release'], OLD)
        self.assertEqual(self.controller.current(), self.old)
        self.assertEqual(self.runner.backups, 2)

    def test_public_failure_rollback_is_conditional_on_current_release(self):
        self.upload()
        self.controller.deploy(NEW)
        with self.assertRaisesRegex(release.ReleaseError, 'different deployment'):
            self.controller.rollback_if_current('20261027-999')
        self.assertEqual(self.controller.current().name, NEW)
        self.controller.rollback_if_current(NEW)
        self.assertEqual(self.controller.current(), self.old)

    def test_checksum_failure_never_creates_a_release(self):
        with self.assertRaisesRegex(release.ReleaseError, 'checksum'):
            self.controller.receive(NEW, '0' * 64, io.BytesIO(b'bad data'))
        self.assertEqual(list((self.root / 'incoming').iterdir()), [])
        self.assertEqual(self.controller.current(), self.old)

    def test_existing_release_cannot_be_overwritten(self):
        with self.assertRaisesRegex(release.ReleaseError, 'already exists'):
            self.controller.receive(OLD, '0' * 64, io.BytesIO(b'bad'))

    def test_archive_rejects_traversal_links_private_and_special_files(self):
        for name, kind in [('../outside', tarfile.REGTYPE), ('/tmp/outside', tarfile.REGTYPE),
                           ('apps/web/dist/link', tarfile.SYMTYPE), ('apps/web/dist/hard', tarfile.LNKTYPE),
                           ('apps/web/dist/fifo', tarfile.FIFOTYPE), ('.env', tarfile.REGTYPE), ('apps/api/src/main.ts', tarfile.REGTYPE)]:
            with self.subTest(name=name):
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode='w:gz') as bundle:
                    info = tarfile.TarInfo(name)
                    info.type = kind
                    info.linkname = '/etc/passwd'
                    bundle.addfile(info)
                content = data.getvalue()
                self.controller.receive(NEW, hashlib.sha256(content).hexdigest(), io.BytesIO(content))
                with self.assertRaisesRegex(release.ReleaseError, 'Unsafe'):
                    self.controller.extract(NEW)
                self.assertFalse((self.root / 'releases' / NEW).exists())
                (self.root / 'incoming' / (NEW + '.tar.gz')).unlink()

    def test_unsafe_ids_cannot_escape_release_directory(self):
        for name in ['../evil', '20261027-x;id', '20261027-foo/bar', '20261027-x\nid', '-rf']:
            with self.assertRaises(release.ReleaseError):
                self.controller.receive(name, '0' * 64, io.BytesIO(b'bad'))

    def test_concurrent_deployment_is_rejected(self):
        other = release.Deployment(self.root, self.runner)
        with self.controller.lock():
            with self.assertRaisesRegex(release.ReleaseError, 'in progress'):
                with other.lock():
                    pass

    def test_packager_includes_only_compiled_allowlisted_files(self):
        (self.source / '.env').write_text('must never be packaged')
        (self.source / 'apps/api/src').mkdir()
        (self.source / 'apps/api/src/hidden.ts').write_text('source')
        packager.package(REVISION, NEW, self.archive, self.source)
        with tarfile.open(self.archive) as archive:
            names = archive.getnames()
        self.assertNotIn('.env', names)
        self.assertNotIn('apps/api/src/hidden.ts', names)
        self.assertIn('apps/web/dist/release.json', names)

    def test_packager_rejects_links_in_build_output(self):
        (self.source / 'apps/web/dist/leak').symlink_to(self.source / '.env')
        with self.assertRaises(ValueError):
            packager.package(REVISION, NEW, self.archive, self.source)

    def test_gateway_rejects_shell_sftp_and_command_injection(self):
        for command in ['', 'bash', 'id', 'internal-sftp', 'deploy 20261027-1;id', 'status\nid', 'upload 20261027-1 x', 'rollback ../../x', 'status extra']:
            result = subprocess.run(['bash', str(HERE / 'ssh-gateway.sh')], env={**os.environ, 'SSH_ORIGINAL_COMMAND': command}, capture_output=True)
            self.assertEqual(result.returncode, 64, command)

    def test_shell_scripts_parse(self):
        for script in HERE.glob('*.sh'):
            result = subprocess.run(['bash', '-n', str(script)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()

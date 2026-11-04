"""Safety checks use disposable Git repositories, never the project's worktrees."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(__file__).with_name('workspace.py').resolve()
START = SCRIPT.with_name('start-task.sh')
spec = importlib.util.spec_from_file_location('lifecycle', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workspace-safety-')
        self.base = Path(self.temp.name).resolve()
        self.old = Path.cwd()
        self.repo = self.base / 'main repo'
        self.repo.mkdir()
        self.run_git('init', '--initial-branch=main', cwd=self.repo)
        self.run_git('config', 'user.email', 'test@example.invalid', cwd=self.repo)
        self.run_git('config', 'user.name', 'Test', cwd=self.repo)
        (self.repo / '.gitignore').write_text('node_modules\n.env\ndist/\n')
        self.run_git('add', '.', cwd=self.repo)
        self.run_git('commit', '-m', 'initial', cwd=self.repo)
        self.run_git('init', '--bare', str(self.base / 'remote.git'))
        self.run_git('remote', 'add', 'origin', str(self.base / 'remote.git'), cwd=self.repo)
        self.run_git('branch', 'integration', cwd=self.repo)
        self.run_git('push', 'origin', 'main', 'integration', cwd=self.repo)
        self.work = self.base / 'wt-task with spaces'
        self.run_git('worktree', 'add', '-b', 'feat/task', str(self.work), 'origin/integration', cwd=self.repo)
        os.chdir(self.repo)
        self.state = m.common() / 'workspace-lifecycle'

    def tearDown(self):
        os.chdir(self.old)
        self.temp.cleanup()

    def run_git(self, *args, cwd=None):
        subprocess.run(['git', *args], cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def entry(self):
        return next(e for e in m.entries() if Path(e['worktree']) == self.work)

    def accepted(self):
        e = self.entry()
        m.write_record(self.state, self.work, dict(head=e['HEAD'], branch=e['branch'], target='origin/integration',
                       evidence='fixture', accepted_at=time.time() - 4 * 86400))

    def cli(self, *args):
        return subprocess.run(['python3', str(SCRIPT), *args], text=True, capture_output=True)

    def test_unaccepted_and_primary_are_protected(self):
        self.assertTrue(any('尚未登记' in r for r in m.reasons(self.entry(), self.state)))
        main = next(e for e in m.entries() if Path(e['worktree']) == self.repo)
        self.assertIn('主仓库', m.reasons(main, self.state))
        self.assertNotEqual(0, self.cli('clean', str(self.repo), '--apply').returncode)
        self.assertTrue(self.repo.exists())

    def test_grace_period_and_current_worktree(self):
        self.assertEqual(0, self.cli('accept', str(self.work), '--target', 'origin/integration', '--evidence', 'PR test').returncode)
        self.assertTrue(any('未满3天' in r for r in m.reasons(self.entry(), self.state)))
        os.chdir(self.work)
        self.assertIn('当前工作区', m.reasons(self.entry(), self.state))

    def test_modified_untracked_ignored_and_real_dependencies_block(self):
        self.accepted()
        for name in ['notes.txt', '.env', 'node_modules/package.json']:
            p = self.work / name
            p.parent.mkdir(exist_ok=True)
            p.write_text('fixture')
            self.assertTrue(any('文件' in r for r in m.reasons(self.entry(), self.state)))
            self.assertNotEqual(0, self.cli('clean', str(self.work), '--apply').returncode)
            p.unlink()
        (self.work / 'node_modules').rmdir()
        (self.work / '.gitignore').write_text('modified')
        self.assertTrue(any('文件' in r for r in m.reasons(self.entry(), self.state)))

    def test_symlink_dependencies_are_not_scanned(self):
        self.accepted()
        deps = self.base / 'deps'
        deps.mkdir()
        (deps / 'large').write_text('x' * 50000)
        (self.work / 'node_modules').symlink_to(deps, target_is_directory=True)
        self.assertEqual([], m.reasons(self.entry(), self.state))
        self.assertLess(m.size(self.work), 0.01)

    def test_new_commit_unpushed_or_unmerged_invalidates_acceptance(self):
        self.accepted()
        (self.work / 'new.txt').write_text('new')
        self.run_git('add', '.', cwd=self.work)
        self.run_git('commit', '-m', 'new', cwd=self.work)
        blocked = m.reasons(self.entry(), self.state)
        self.assertTrue(any('版本' in r for r in blocked))
        self.assertTrue(any('未完整合入' in r for r in blocked))
        self.assertTrue(any('尚未推送' in r for r in blocked))

    def test_preview_then_remove_retains_refs_and_audit(self):
        self.accepted()
        self.assertEqual(0, self.cli('clean', str(self.work)).returncode)
        self.assertTrue(self.work.exists())
        p = self.cli('clean', str(self.work), '--apply')
        self.assertEqual(0, p.returncode, p.stderr)
        self.assertFalse(self.work.exists())
        self.run_git('rev-parse', '--verify', 'feat/task', cwd=self.repo)
        self.assertEqual(str(self.work), json.loads((self.state / 'operations.jsonl').read_text())['path'])

    def test_locked_or_unregistered_path_cannot_be_removed(self):
        self.accepted()
        self.run_git('worktree', 'lock', str(self.work), cwd=self.repo)
        self.assertNotEqual(0, self.cli('clean', str(self.work), '--apply').returncode)
        self.assertNotEqual(0, self.cli('clean', str(self.base), '--apply').returncode)
        self.assertTrue(self.work.exists())

    def test_start_reuses_existing_task(self):
        p = subprocess.run(['bash', str(START), 'task'], capture_output=True, text=True)
        self.assertEqual(0, p.returncode, p.stderr)
        self.assertIn(str(self.work), p.stdout)
        self.assertEqual(2, len(m.entries()))

    def test_start_from_secondary_worktree_creates_sibling_and_reuses_branch(self):
        os.chdir(self.work)
        p = subprocess.run(['bash', str(START), 'second'], capture_output=True, text=True)
        self.assertEqual(0, p.returncode, p.stderr)
        self.assertTrue((self.base / 'wt-second').exists())
        self.assertEqual(3, len(m.entries()))

    def test_backup_preview_and_reuse_do_not_multiply_refs(self):
        backup = SCRIPT.with_name('backup-main.sh')
        def run(*args):
            return subprocess.run(['bash', str(backup), *args], capture_output=True, text=True)
        self.assertEqual(0, run('test').returncode)
        self.assertEqual('', m.git('for-each-ref', 'refs/heads/backup/').stdout)
        self.assertEqual(0, run('test', '--apply').returncode)
        first = m.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/backup/').stdout
        self.assertEqual(0, run('another', '--apply').returncode)
        self.assertEqual(first, m.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/backup/').stdout)
        (self.repo / 'second.txt').write_text('change')
        self.run_git('add', '.', cwd=self.repo)
        self.run_git('commit', '-m', 'next', cwd=self.repo)
        self.run_git('push', 'origin', 'main', cwd=self.repo)
        p = run('test', '--apply')
        self.assertEqual(0, p.returncode, p.stderr)
        refs = m.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/backup/').stdout
        self.assertIn(first.strip(), refs)
        self.assertEqual(2, len(refs.splitlines()))


if __name__ == '__main__':
    unittest.main()

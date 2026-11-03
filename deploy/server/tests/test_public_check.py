"""Exercise the CI heredoc with simulated public responses; never contact production."""
import contextlib
import io
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
SOURCE = (HERE / 'ci-deploy.sh').read_text().split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
RELEASE = '20261103-fast-check'
REVISION = 'a' * 40


class PublicCheckTests(unittest.TestCase):
    def run_check(self, responder, revision=REVISION):
        with patch('sys.argv', ['-', RELEASE, revision]), \
                patch('urllib.request.urlopen', side_effect=responder) as requests, \
                patch('time.sleep') as sleep, contextlib.redirect_stdout(io.StringIO()):
            exec(compile(SOURCE, 'ci-public-check', 'exec'), {})
        return requests, sleep

    def response(self, url, revision=REVISION):
        value = {'status': 'ok'} if '/api/health' in url else {'release': RELEASE, 'revision': revision}
        return io.StringIO(json.dumps(value))

    def test_success_checks_both_paths_concurrently_without_sleep(self):
        barrier = threading.Barrier(2)

        def respond(url, timeout):
            # Serial requests would time out at this barrier and fail verification.
            barrier.wait(timeout=2)
            return self.response(url)

        requests, sleep = self.run_check(respond)
        self.assertEqual(requests.call_count, 2)
        sleep.assert_not_called()

    def test_transient_outage_retries_and_then_stops_immediately(self):
        counts = {}

        def respond(url, timeout):
            counts[url] = counts.get(url, 0) + 1
            if counts[url] == 1:
                raise OSError('simulated outage')
            return self.response(url)

        requests, sleep = self.run_check(respond)
        self.assertEqual(requests.call_count, 4)
        sleep.assert_called_once_with(1)

    def test_persistent_failure_exits_without_a_final_sleep(self):
        with patch('sys.argv', ['-', RELEASE, REVISION]), \
                patch('urllib.request.urlopen', side_effect=OSError('offline')) as requests, \
                patch('time.sleep') as sleep:
            with self.assertRaisesRegex(SystemExit, 'verification failed'):
                exec(compile(SOURCE, 'ci-public-check', 'exec'), {})
        self.assertEqual(requests.call_count, 12)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 1, 2, 3, 3])

    def test_wrong_revision_or_release_or_health_is_rejected(self):
        for wrong in ({'revision': 'b' * 40}, {'release': 'stale'}, {'status': 'failed'}):
            with self.subTest(wrong=wrong):
                def respond(url, timeout):
                    response = json.load(self.response(url))
                    response.update(wrong)
                    return io.StringIO(json.dumps(response))
                with self.assertRaisesRegex(SystemExit, 'verification failed'):
                    self.run_check(respond)

    def test_manual_rollback_accepts_exact_release_without_revision_argument(self):
        requests, sleep = self.run_check(lambda url, timeout: self.response(url), revision='')
        self.assertEqual(requests.call_count, 2)
        sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()

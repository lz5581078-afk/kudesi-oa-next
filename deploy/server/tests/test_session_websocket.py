import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class SessionWebsocketProxyTests(unittest.TestCase):
    def test_shop_signaling_has_dedicated_upgrade_proxy_in_both_templates(self):
        for name in ('nginx-http.conf', 'nginx-https.conf'):
            with self.subTest(template=name):
                text = (ROOT / name).read_text(encoding='utf-8')
                blocks = re.findall(r'location\s*=\s*/api/session-manager/webrtc\s*\{([^}]+)\}', text)
                self.assertEqual(len(blocks), 1)
                block = blocks[0]
                for directive in ('proxy_pass http://127.0.0.1:4107;', 'proxy_http_version 1.1;',
                                  'proxy_set_header Upgrade $http_upgrade;', 'proxy_set_header Connection "upgrade";',
                                  'proxy_set_header X-Forwarded-Proto $scheme;', 'proxy_buffering off;'):
                    self.assertIn(directive, block)
                self.assertRegex(block, r'proxy_read_timeout\s+360s;')

    def test_existing_collector_upgrade_and_general_api_remain_separate(self):
        for name in ('nginx-http.conf', 'nginx-https.conf'):
            with self.subTest(template=name):
                text = (ROOT / name).read_text(encoding='utf-8')
                collector = re.search(r'location\s*=\s*/api/collector/realtime\s*\{([^}]+)\}', text).group(1)
                self.assertIn('proxy_set_header Upgrade $http_upgrade;', collector)
                api = re.search(r'location\s+/api/\s*\{([^}]+)\}', text).group(1)
                self.assertNotIn('proxy_set_header Upgrade', api)
                self.assertIn('proxy_pass http://127.0.0.1:4107;', api)

if __name__ == '__main__':
    unittest.main()

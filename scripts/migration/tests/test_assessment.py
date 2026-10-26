import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('assessment', Path(__file__).parents[1] / 'build-assessment.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class AssessmentTests(unittest.TestCase):
    def setUp(self):
        self.source = {'tables': [{'name': 'archives', 'columns': [{'name': 'data_json'}]}], 'profiles': {'archives': {'rows': 1}}, 'jsonProfiles': {'archives.data_json': {'paths': {'$.items': {'elements': 2}, '$.items[].name': {'maxLength': 80}}}}}
        self.rule = {'tables': ['archives'], 'aliases': {}, 'json': {'column': 'data_json', 'path': '$.items[]'}}
        self.rules = {'resources': {'items': self.rule}, 'commonAliases': {}}
        self.target = {'resources': [{'key': 'items', 'label': 'Items', 'fields': [{'key': 'name', 'label': 'Name', 'type': 'text', 'required': True, 'maxLength': 20}]}]}

    def test_json_count_is_elements_not_sql_container_rows(self):
        fields, resources, _ = m.assessment(self.source, self.target, self.rules)
        self.assertEqual(resources[0]['旧来源记录数'], 2)
        self.assertEqual(fields[0]['来源匹配方式'], 'json')
        self.assertIn('不自动截断', fields[0]['注意事项'])

    def test_absent_array_is_zero_not_container_count(self):
        self.source['jsonProfiles']['archives.data_json']['paths'] = {}
        fields, resources, _ = m.assessment(self.source, self.target, self.rules)
        self.assertEqual(resources[0]['旧来源记录数'], 0)
        self.assertIn('不新增空资料', fields[0]['结论'])

    def test_truncated_shape_does_not_claim_zero(self):
        self.source['jsonProfiles']['archives.data_json'] = {'paths': {}, 'truncated': True}
        _, resources, _ = m.assessment(self.source, self.target, self.rules)
        self.assertEqual(resources[0]['旧来源记录数'], '未核定')

    def test_readonly_value_is_not_import_mapping(self):
        self.target['resources'][0]['fields'][0]['readonly'] = True
        fields, _, _ = m.assessment(self.source, self.target, self.rules)
        self.assertIn('不直接迁值', fields[0]['结论'])

    def test_unverified_transform_stays_explicit(self):
        self.rule['aliases']['name'] = ['@review:需要核定业务含义']
        fields, _, _ = m.assessment(self.source, self.target, self.rules)
        self.assertEqual(fields[0]['来源匹配方式'], 'review')
        self.assertIn('尚无可执行映射', fields[0]['注意事项'])

    def test_excluded_dataset_cannot_become_ready(self):
        self.rule['policy'] = 'exclude-derived'
        fields, _, tables = m.assessment(self.source, self.target, self.rules)
        self.assertIn('本轮不迁', fields[0]['结论'])
        self.assertEqual(tables[0]['处置'], '本轮不迁')

if __name__ == '__main__':
    unittest.main()

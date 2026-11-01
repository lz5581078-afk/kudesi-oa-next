export {};
const { collectSourceRows } = require('../../../../scripts/migration/source-row-catalog.cjs');
describe('已核实公司归属的原始资料目录', () => {
  it('保留已删除记录和完整旧JSON，不因原映射策略跳过；组合主键稳定', () => {
    const row = { company_id: 3, position_id: 9, permission_key: 'old.view', legacy: { status: 'deleted' } };
    const columns = [{ t: 'position_permissions', c: 'position_id', pk: 'PRI', ordinal: 1 }, { t: 'position_permissions', c: 'permission_key', pk: 'PRI', ordinal: 2 }];
    expect(collectSourceRows({ position_permissions: [row] }, columns, 3)).toEqual([{ table: 'position_permissions', key: '[9,"old.view"]', row }]);
  });
  it('无主键重复行全部保留；主键重复或未核实的跨公司行拒绝', () => {
    const rows = collectSourceRows({ old_history: [{ event: 'same' }, { event: 'same' }] }, [], 3);
    expect(rows).toHaveLength(2); expect(rows[0].key).not.toBe(rows[1].key);
    expect(() => collectSourceRows({ old_history: [{ id: 1 }, { id: 1 }] }, [], 3)).toThrow('主键重复');
    expect(() => collectSourceRows({ stores: [{ id: 1, company_id: 1 }] }, [], 3)).toThrow('归属不一致');
  });
  it('岗位条目仅接受已有父级归属策略，原错误公司字段完整保存在原始行中', () => {
    const row = { id: 1, company_id: 1, position_id: 10, title: '原岗位条目' };
    expect(collectSourceRows({ position_duties: [row] }, [], 3)[0]).toEqual({ table: 'position_duties', key: '1', row: { company_id: 3, ownership: 'position.department', source_row: row } });
  });
});

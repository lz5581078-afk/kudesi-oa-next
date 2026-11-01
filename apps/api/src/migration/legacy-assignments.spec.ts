export {};
const { resolveLegacyRole } = require('../../../../scripts/migration/legacy-assignments.cjs');
describe('旧线性流程选人事实读取', () => {
  it('先取有效委托，再取旧角色；不使用岗位名称判断', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 9 }]);
    expect(await resolveLegacyRole(query, 3, 'finance', 5, '2026-11-01 10:00:00')).toEqual({ employeeId: '9', via: 'delegation' });
    expect(query).toHaveBeenCalledTimes(1); expect(query.mock.calls[0][1]).toEqual(['finance', 3, '2026-11-01 10:00:00', '2026-11-01 10:00:00']);
    const role = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 5 }]);
    expect(await resolveLegacyRole(role, 3, 'finance', 7, 'now')).toEqual({ employeeId: '5', via: 'role' });
    expect(role.mock.calls[1][1]).toEqual(['finance', 'finance', 3]);
  });
  it('保留明确后备和老板回退顺序；公司无人时不回填其他公司的1号员工', async () => {
    const explicit = jest.fn().mockResolvedValueOnce([{ id: 7 }]);
    expect(await resolveLegacyRole(explicit, 3, null, 7, 'now')).toEqual({ employeeId: '7', via: 'fallback' });
    const boss = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 2 }]);
    expect(await resolveLegacyRole(boss, 3, null, 7, 'now')).toEqual({ employeeId: '2', via: 'boss_fallback' });
    await expect(resolveLegacyRole(jest.fn().mockResolvedValue([]), 3, null, 7, 'now')).rejects.toThrow('本公司');
  });
});

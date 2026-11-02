const { createWithdrawalReader } = require('../../../../scripts/migration/withdrawal-source.cjs');
describe('提现冻结来源读取器', () => {
  it('强制读取隔离恢复库，不能误连旧生产库', async () => {
    const c = { query: jest.fn(async () => [[{ name: 'ecommerce_oa' }]]), rollback: jest.fn(async () => undefined), end: jest.fn(async () => undefined) };
    await expect(createWithdrawalReader({ connect: async () => c, decryptPassword: () => '', backupDigest: 'a'.repeat(64) }).read({ sourceCompanyId: 3 })).rejects.toThrow('separate restored');
    expect(c.query).toHaveBeenCalledTimes(1); expect(c.rollback).toHaveBeenCalled(); expect(c.end).toHaveBeenCalled();
  });
  it('同一只读快照内按公司和提现工作区读取，不传出旧令牌和远程任务', async () => {
    const calls: Array<[string,unknown]> = [];
    const c = { query: jest.fn(async (sql: string, params?: unknown) => {
      calls.push([sql, params]);
      if (sql.includes('DATABASE()')) return [[{ name: 'withdrawal_restore_test' }]];
      if (sql.includes('FROM companies')) return [[{ id: 3, name: '测试公司' }]];
      if (sql.includes('FROM session_workspaces')) return [[{ id: 17, company_id: 3, workspace_key: 'finance_withdrawal' }]];
      return [[]];
    }), rollback: jest.fn(async () => undefined), end: jest.fn(async () => undefined) };
    const result = await createWithdrawalReader({ connect: async () => c, decryptPassword: () => '', backupDigest: 'a'.repeat(64) }).read({ sourceCompanyId: 3 });
    expect(result.company.id).toBe(3);
    expect(calls[2][0]).toContain('READ ONLY');
    for (const [sql, params] of calls.filter(([sql]) => /FROM session_(devices|managed_shops)/.test(sql))) { expect(params).toEqual([3,17]); expect(sql).not.toMatch(/token_hash|public_key/); }
    expect(calls.some(([sql]) => /open_requests|remote_sessions|versions/.test(sql))).toBe(false);
    expect(c.rollback).toHaveBeenCalled(); expect(c.end).toHaveBeenCalled();
  });
});

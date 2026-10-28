import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceChangeLog, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { GridSaveService } from './grid-save.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('表格编辑批量保存（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let grid: GridSaveService;
  let boss: AuthUser;
  let other: AuthUser;
  let editor: AuthUser;
  const asUser = (companyId: number, id: number, allow: string[]): AuthUser => ({ id, companyId, name: '员工', permissions: { isCompanyAdmin: false, allow, deny: [] } });

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    grid = new GridSaveService(svc);
    const mk = async (name: string) => {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `x${crypto.randomBytes(5).toString('hex')}`, name, status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `g${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      return { c, u };
    };
    const a = await mk('表格测试A');
    const b = await mk('表格测试B');
    boss = { id: a.u.id, companyId: a.c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    other = { id: b.u.id, companyId: b.c.id, name: '外司', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    editor = asUser(a.c.id, a.u.id, ['resource.software.view', 'resource.software.edit', 'resource.software.create', 'resource.partners.view', 'resource.partners.edit']);
  });
  afterAll(async () => { await ds?.destroy(); });

  it('逐行保存：成功的落库，失败的带原因，互不影响；与单条接口同一套校验', async () => {
    const a = await svc.create(boss, 'software', { name: '软件甲', account: 'a1' });
    const b = await svc.create(boss, 'software', { name: '软件乙', account: 'b1' });
    const res = await grid.save(boss, 'software', {
      updates: [
        { id: a.id, version: a.version, data: { annualFee: 12345, renewAt: '2030-01-02' } },
        { id: b.id, version: b.version, data: { renewAt: '不是日期' } },
      ],
      creates: [
        { clientId: 'n1', data: { name: '新软件', account: 'z' } },
        { clientId: 'n2', data: { account: '缺名称' } },
        { clientId: 'n3', data: { name: '软件甲', account: 'a1' } }, // 与已有重复（组合唯一）
      ],
    });
    expect(res.saved).toBe(2);
    expect(res.failed).toBe(3);
    const byKey = (k: string) => res.results.find((r) => (r.clientId ?? String(r.id)) === k)!;
    expect(byKey(String(a.id)).ok).toBe(true);
    expect(byKey(String(a.id)).row?.data.annualFee).toBe(12345);
    expect(byKey(String(b.id))).toMatchObject({ ok: false, code: 'invalid' });
    expect(byKey('n1').ok).toBe(true);
    expect(byKey('n1').id).toBeGreaterThan(0);
    expect(byKey('n2')).toMatchObject({ ok: false, code: 'invalid' });
    expect(byKey('n3')).toMatchObject({ ok: false, code: 'invalid', message: expect.stringContaining('已经登记') });
    expect((await svc.get(boss, 'software', b.id)).data.renewAt).toBeUndefined();
    // 审计：每个成功行有变更日志，标明表格编辑
    const logs = await ds.manager.find(ResourceChangeLog, { where: { companyId: boss.companyId, resourceType: 'software', resourceId: a.id } });
    expect(logs.some((l) => l.action === 'update' && l.note === '表格编辑')).toBe(true);
    const created = await ds.manager.find(ResourceChangeLog, { where: { companyId: boss.companyId, resourceType: 'software', resourceId: byKey('n1').id } });
    expect(created.map((l) => l.action)).toContain('create');
  });

  it('乐观并发：别人改过的行提示冲突，不覆盖；版本对得上才保存', async () => {
    const r = await svc.create(boss, 'software', { name: '并发软件', account: 'c1' });
    await svc.update(boss, 'software', r.id, { account: 'c2' }); // 别人先改了
    const res = await grid.save(boss, 'software', { updates: [{ id: r.id, version: r.version, data: { annualFee: 1 } }] });
    expect(res.results[0]).toMatchObject({ ok: false, code: 'conflict' });
    expect((await svc.get(boss, 'software', r.id)).data.annualFee).toBeUndefined();
    const fresh = await svc.get(boss, 'software', r.id);
    const ok = await grid.save(boss, 'software', { updates: [{ id: r.id, version: fresh.version, data: { annualFee: 1 } }] });
    expect(ok.results[0].ok).toBe(true);
  });

  it('公司隔离：别家的行当作不存在；请求体里的 companyId 无处可传', async () => {
    const mine = await svc.create(boss, 'software', { name: '本司软件', account: 'm1' });
    const res = await grid.save(other, 'software', { updates: [{ id: mine.id, data: { annualFee: 9 } }] });
    expect(res.results[0]).toMatchObject({ ok: false, code: 'not_found' });
    const row = await ds.manager.findOneOrFail(ResourceRecord, { where: { id: mine.id } });
    expect(row.data.annualFee).toBeUndefined();
    // 新增的行归属令牌里的公司
    const made = await grid.save(other, 'software', { creates: [{ clientId: 'x', data: { name: '外司软件', account: 'o1', companyId: boss.companyId } }] });
    expect(made.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
    const ok = await grid.save(other, 'software', { creates: [{ clientId: 'x', data: { name: '外司软件', account: 'o1' } }] });
    const rec = await ds.manager.findOneOrFail(ResourceRecord, { where: { id: ok.results[0].id! } });
    expect(rec.companyId).toBe(other.companyId);
  });

  it('权限：没有新增权限不能新增；改证件号/密钥要“查看明文”权限；不在网格允许范围的字段整行拒绝', async () => {
    const noCreate = asUser(boss.companyId, boss.id, ['resource.software.view', 'resource.software.edit']);
    const r1 = await grid.save(noCreate, 'software', { creates: [{ clientId: 'c', data: { name: 'x', account: 'y' } }] });
    expect(r1.results[0]).toMatchObject({ ok: false, code: 'forbidden', message: '没有新增权限' });

    const p = await svc.create(boss, 'partners', { name: '合作人', idNumber: '110101199001011234' });
    const r2 = await grid.save(editor, 'partners', { updates: [{ id: p.id, data: { idNumber: '110101199001015678' } }] });
    expect(r2.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
    expect((await svc.get(boss, 'partners', p.id)).data.idNumber).toBe('110101199001011234');
    const withSecret = asUser(boss.companyId, boss.id, ['resource.partners.view', 'resource.partners.edit', 'resource.partners.secret']);
    const r3 = await grid.save(withSecret, 'partners', { updates: [{ id: p.id, data: { idNumber: '110101199001015678' } }] });
    expect(r3.results[0].ok).toBe(true);
    expect((await svc.get(boss, 'partners', p.id)).data.idNumber).toBe('110101199001015678');

    const r4 = await grid.save(boss, 'partners', { updates: [{ id: p.id, data: { cardFlag: 'yes' } }, { id: p.id, data: { idFront: [1] } }, { id: p.id, data: { nope: 1 } }] });
    expect(r4.results.every((r) => !r.ok && r.code === 'forbidden')).toBe(true);
  });

  it('密码类字段：网格里只能写新值，响应不回显', async () => {
    const s = await svc.create(boss, 'software', { name: '密码软件', account: 'pw' });
    const res = await grid.save(boss, 'software', { updates: [{ id: s.id, data: { password: 'S3cret!' } }] });
    expect(res.results[0].ok).toBe(true);
    expect(JSON.stringify(res)).not.toContain('S3cret!');
    expect(res.results[0].row?.secretConfigured.password).toBe(true);
    const noSecret = asUser(boss.companyId, boss.id, ['resource.software.view', 'resource.software.edit']);
    const bad = await grid.save(noSecret, 'software', { updates: [{ id: s.id, data: { password: 'x' } }] });
    expect(bad.results[0].code).toBe('forbidden');
  });

  it('待删除=归档（要原因、要删除权限）；已归档的行不能再改；禁用的资料类型整体拒绝', async () => {
    const s = await svc.create(boss, 'software', { name: '待归档', account: 'ar' });
    const noDelete = await grid.save(editor, 'software', { archives: [{ id: s.id, reason: '不用了' }] });
    expect(noDelete.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
    const noReason = await grid.save(boss, 'software', { archives: [{ id: s.id, reason: ' ' }] });
    expect(noReason.results[0]).toMatchObject({ ok: false, code: 'invalid' });
    const done = await grid.save(boss, 'software', { archives: [{ id: s.id, reason: '不用了' }] });
    expect(done.results[0].ok).toBe(true);
    expect((await ds.manager.findOneOrFail(ResourceRecord, { where: { id: s.id } })).archivedAt).not.toBeNull();
    const again = await grid.save(boss, 'software', { updates: [{ id: s.id, data: { annualFee: 1 } }] });
    expect(again.results[0]).toMatchObject({ ok: false, message: expect.stringContaining('已归档') });
    await expect(grid.save(boss, 'finance-bundles', { updates: [{ id: 1, data: {} }] })).rejects.toThrow();
    await expect(grid.save(boss, 'software', {})).rejects.toThrow('没有要保存');
  });

  it('商品档案不能在网格里新增（要走专属表单）', async () => {
    const res = await grid.save(boss, 'finance-products', { creates: [{ clientId: 'p', data: { name: 'x' } }] });
    expect(res.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

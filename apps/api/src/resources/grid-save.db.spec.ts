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

    const r4 = await grid.save(boss, 'partners', { updates: [{ id: p.id, data: { cardFlag: 'yes' } }, { id: p.id, data: { nope: 1 } }] });
    expect(r4.results.every((r) => !r.ok && r.code === 'forbidden')).toBe(true);
    // 文件字段现在可以在网格里改，但文件必须真实存在且属于本公司，由同一套保存流程校验
    const r5 = await grid.save(boss, 'partners', { updates: [{ id: p.id, data: { idFront: [999999] } }] });
    expect(r5.results[0].ok).toBe(false);
    expect(r5.results[0].code).not.toBe('forbidden');
    expect((await svc.get(boss, 'partners', p.id)).data.idFront).toBeUndefined();
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

  it('多行文本、多引用、敏感字段：与详情表单同一套校验（长度、数量上限、跨公司引用、需要“查看明文”权限）', async () => {
    const cat1 = await svc.create(boss, 'finance-supplier-categories', { name: '分类一' });
    const cat2 = await svc.create(boss, 'finance-supplier-categories', { name: '分类二' });
    const foreign = await svc.create(other, 'finance-supplier-categories', { name: '别家的分类' });
    const sup = await svc.create(boss, 'finance-suppliers', { name: '供应商甲', categoryIds: [cat1.id] });
    const ok = await grid.save(boss, 'finance-suppliers', { updates: [{ id: sup.id, version: sup.version, data: { note: '第一行\n第二行', categoryIds: [cat1.id, cat2.id] } }] });
    expect(ok.results[0].ok).toBe(true);
    const got = await svc.get(boss, 'finance-suppliers', sup.id);
    expect(got.data.note).toBe('第一行\n第二行');
    expect(got.data.categoryIds).toEqual([cat1.id, cat2.id]);
    expect(got.refLabels.categoryIds).toBe('分类一、分类二');
    // 别的公司的记录不能引用
    const cross = await grid.save(boss, 'finance-suppliers', { updates: [{ id: sup.id, data: { categoryIds: [foreign.id] } }] });
    expect(cross.results[0]).toMatchObject({ ok: false, code: 'invalid' });
    // 多引用最多 10 项；多行文本超长
    const many = await grid.save(boss, 'finance-suppliers', { updates: [{ id: sup.id, data: { categoryIds: Array.from({ length: 11 }, (_, i) => cat1.id + i) } }] });
    expect(many.results[0]).toMatchObject({ ok: false, code: 'invalid' });
    const long = await grid.save(boss, 'finance-suppliers', { updates: [{ id: sup.id, data: { note: 'x'.repeat(5000) } }] });
    expect(long.results[0]).toMatchObject({ ok: false, code: 'invalid' });
    // 清空 = null
    const clear = await grid.save(boss, 'finance-suppliers', { updates: [{ id: sup.id, data: { categoryIds: null, note: null } }] });
    expect(clear.results[0].ok).toBe(true);
    expect((await svc.get(boss, 'finance-suppliers', sup.id)).data.categoryIds).toBeUndefined();
    // 银行卡号（敏感）：没有“查看明文”权限的人不能改，有的可以
    const noSecret = asUser(boss.companyId, boss.id, ['resource.finance-suppliers.view', 'resource.finance-suppliers.edit']);
    const denied = await grid.save(noSecret, 'finance-suppliers', { updates: [{ id: sup.id, data: { bankAccountNo: '6222020200112233445' } }] });
    expect(denied.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
    const withSecret = asUser(boss.companyId, boss.id, ['resource.finance-suppliers.view', 'resource.finance-suppliers.edit', 'resource.finance-suppliers.secret']);
    const done = await grid.save(withSecret, 'finance-suppliers', { updates: [{ id: sup.id, data: { bankAccountNo: '6222020200112233445' } }] });
    expect(done.results[0].ok).toBe(true);
    expect((await ds.manager.findOneOrFail(ResourceRecord, { where: { id: sup.id } })).secrets).not.toContain('6222020200112233445'); // 库里是加密的
  });

  it('分类属性（attrs）：值被规整，名称/内容过长或超过 30 项被拒绝', async () => {
    const cat = await svc.create(boss, 'asset-categories', { name: '电脑类', customFields: '颜色,尺寸' });
    const asset = await svc.create(boss, 'fixed-assets', { name: '笔记本', categoryId: cat.id });
    const ok = await grid.save(boss, 'fixed-assets', { updates: [{ id: asset.id, data: { attrs: { 颜色: ' 黑 ', 尺寸: '' } } }] });
    expect(ok.results[0].ok).toBe(true);
    expect((await svc.get(boss, 'fixed-assets', asset.id)).data.attrs).toEqual({ 颜色: '黑' });
    const tooLong = await grid.save(boss, 'fixed-assets', { updates: [{ id: asset.id, data: { attrs: { 颜色: 'x'.repeat(201) } } }] });
    expect(tooLong.results[0]).toMatchObject({ ok: false, code: 'invalid' });
    const tooMany = await grid.save(boss, 'fixed-assets', { updates: [{ id: asset.id, data: { attrs: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, 'v'])) } }] });
    expect(tooMany.results[0]).toMatchObject({ ok: false, code: 'invalid' });
    const notObject = await grid.save(boss, 'fixed-assets', { updates: [{ id: asset.id, data: { attrs: ['a'] } }] });
    expect(notObject.results[0]).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('状态：和字段一起在同一事务保存；需要原因的必须带原因；要“停用”权限；失败时字段和状态都不动', async () => {
    const lic = await svc.create(boss, 'licenses', { category: 'operation', companyName: '状态测试公司', creditCode: '91110000MA01ABCDE1', legalPerson: '张三' });
    const noDisable = asUser(boss.companyId, boss.id, ['resource.licenses.view', 'resource.licenses.edit']);
    const denied = await grid.save(noDisable, 'licenses', { updates: [{ id: lic.id, data: { legalPerson: '改名' }, status: 'abnormal' }] });
    expect(denied.results[0]).toMatchObject({ ok: false, code: 'forbidden', message: expect.stringContaining('状态') });
    // 需要原因的状态没带原因：整行不保存（字段也不动）
    const noReason = await grid.save(boss, 'licenses', { updates: [{ id: lic.id, data: { legalPerson: '李四' }, status: 'cancelled' }] });
    expect(noReason.results[0]).toMatchObject({ ok: false, code: 'invalid' });
    const still = await svc.get(boss, 'licenses', lic.id);
    expect(still.status).toBe('normal');
    expect(still.data.legalPerson).toBe('张三');
    // 非法状态
    const bad = await grid.save(boss, 'licenses', { updates: [{ id: lic.id, data: {}, status: 'no-such' }] });
    expect(bad.results[0]).toMatchObject({ ok: false, code: 'invalid' });
    // 普通状态 + 字段一起改
    const a = await grid.save(boss, 'licenses', { updates: [{ id: lic.id, version: still.version, data: { legalPerson: '李四' }, status: 'abnormal' }] });
    expect(a.results[0].ok).toBe(true);
    expect(a.results[0].row).toMatchObject({ status: 'abnormal' });
    expect((await svc.get(boss, 'licenses', lic.id)).data.legalPerson).toBe('李四');
    // 带原因的状态：原因记在记录上，日志里有状态变化
    const fresh = await svc.get(boss, 'licenses', lic.id);
    const b = await grid.save(boss, 'licenses', { updates: [{ id: lic.id, version: fresh.version, data: {}, status: 'cancelled', statusReason: '主体已注销' }] });
    expect(b.results[0].ok).toBe(true);
    const after = await svc.get(boss, 'licenses', lic.id);
    expect(after.status).toBe('cancelled');
    expect(after.statusReason).toBe('主体已注销');
    const logs = await ds.manager.find(ResourceChangeLog, { where: { companyId: boss.companyId, resourceType: 'licenses', resourceId: lic.id } });
    expect(logs.some((l) => (l.note ?? '').includes('表格编辑') && (l.note ?? '').includes('主体已注销'))).toBe(true);
    // 版本冲突同样适用于改状态
    const stale = await grid.save(boss, 'licenses', { updates: [{ id: lic.id, version: fresh.version, data: {}, status: 'normal' }] });
    expect(stale.results[0]).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('列表接口返回资料的全部字段（含列表里不显示的），没有字段权限的列服务端不返回', async () => {
    const cat = await svc.create(boss, 'finance-supplier-categories', { name: '分类三' });
    const sup = await svc.create(boss, 'finance-suppliers', { name: '全字段供应商', note: '备注内容', categoryIds: [cat.id] });
    const hidden = require('@kudesi/shared').getResourceDef('finance-suppliers').fields.find((f: { key: string }) => f.key === 'note');
    expect(hidden.list).toBeFalsy(); // note 不是列表默认列
    const list = await svc.list(boss, 'finance-suppliers', { pageSize: 200 });
    expect(list.items.find((i) => i.id === sup.id)?.data.note).toBe('备注内容');
    // 成本字段：没有 product.cost.view 的人，接口里就没有
    const m = await svc.create(boss, 'finance-margins', { profitPercent: 12, reason: '测试' });
    const viewer = asUser(boss.companyId, boss.id, ['resource.finance-margins.view', 'resource.finance-margins.edit']);
    const seen = (await svc.list(viewer, 'finance-margins', { pageSize: 200 })).items.find((i) => i.id === m.id)!;
    expect('profitPercent' in seen.data).toBe(false);
    const full = (await svc.list(boss, 'finance-margins', { pageSize: 200 })).items.find((i) => i.id === m.id)!;
    expect('profitPercent' in full.data).toBe(true);
    // 没有字段权限的人在网格里也不能写这个字段
    const w = await grid.save(viewer, 'finance-margins', { updates: [{ id: m.id, data: { profitPercent: 1 } }] });
    expect(w.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('只剩状态可改的资料（专属品）也能进网格：字段全是系统生成，网格同样不让改', async () => {
    const res = await grid.save(boss, 'finance-product-exclusives', { updates: [{ id: 1, data: { ownerName: '偷改' } }] });
    expect(res.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

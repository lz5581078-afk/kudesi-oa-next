import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, OutboxJob, ResourceChangeLog, ResourceImportBackup, ResourceRecord, User } from '../entities';
import { OutboxService, type OutboxSender, type RemoteCategory } from '../outbox/outbox.service';
import { buildServices } from '../test-support';
import { JstMaintenanceService } from './jst-maintenance.service';

const suite = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
suite('普通商品资料维护：签名预检与唯一待发送链', () => {
  let ds: DataSource, services: ReturnType<typeof buildServices>, outbox: OutboxService, svc: JstMaintenanceService, boss: AuthUser;
  let target = 'synthetic-target-A', unavailable = false;
  let remote: Array<{ skuId: string; styleId: string; name: string; spec: string; category: string }> = [];
  const defaultCategories = (): RemoteCategory[] => [{ id: 'root', parentId: '0', name: '聚水潭水果', sort: null, enable: true }, { id: 'leaf', parentId: 'root', name: '苹果', sort: null, enable: true }];
  let categories = defaultCategories();
  const send = jest.fn(async () => undefined);
  const form = (id: string) => ({ skuId: `SKU-${id}`, styleId: `STYLE-${id}`, name: `商品-${id}`, shortName: '简称', propertiesValue: '红色;100g', categoryName: '聚水潭水果/苹果', brand: '自由品牌', costPrice: 1.2345, purchasePrice: 1.2345, weight: 0, unit: '个' });
  const actor = async () => {
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: randomBytes(8).toString('hex'), name: '合成普通商品维护', status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'synthetic', name: '合成管理员', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    return { id: user.id, companyId: company.id, name: user.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } } satisfies AuthUser;
  };
  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never); await ds.initialize();
    services = buildServices(ds); outbox = new OutboxService(ds, services.resources); svc = new JstMaintenanceService(ds, services.resources, outbox, services.crypto);
    jest.spyOn(outbox, 'senderFor').mockImplementation(async companyId => ({ configured: true, targetKey: `${companyId}:${target}`, send, searchNormal: async () => { if (unavailable) throw new Error('synthetic-private-error'); return remote; }, readCategories: async () => categories } satisfies OutboxSender));
    boss = await actor();
  });
  afterEach(() => { categories = defaultCategories(); remote = []; unavailable = false; target = 'synthetic-target-A'; send.mockClear(); });
  afterAll(async () => { await ds?.destroy(); });
  const counts = async () => [await ds.manager.count(ResourceRecord, { where: { companyId: boss.companyId, type: 'finance-jst-uploads' } }), await ds.manager.count(OutboxJob, { where: { companyId: boss.companyId, kind: 'normal_product_upload' } })];
  it('远端分类与本地目录独立；查重结果只含必要字段、不含成本或裸摘要', async () => {
    await services.resources.create(boss, 'finance-categories', { archiveType: 'raw', name: '本地不可用分类', code: 'LOCAL' });
    expect(await svc.options(boss)).toMatchObject({ categories: ['聚水潭水果/苹果'], brands: [], errors: {} });
    const f = form('projection'); remote = [{ skuId: f.skuId, styleId: f.styleId, name: f.name, spec: '规格', category: '分类' }];
    const check = await svc.checkDuplicate(boss, f);
    expect(check).toMatchObject({ hasHighRisk: true, hasWarning: true, errors: [] });
    expect(check.matches).toHaveLength(3); expect(check.signature).toMatch(/^\d+\.idx1:/);
    expect(Object.keys(check.matches[0]).sort()).toEqual(['category', 'field', 'hit', 'level', 'name', 'skuId', 'source', 'spec', 'styleId'].sort());
    expect(JSON.stringify(check)).not.toMatch(/costPrice|cost_price|1\.2345|target-A|password|endpoint/);
  });
  it('普通请求仍拒绝高风险，签名加显式继续才入队，授权正常时无需开关即可发送', async () => {
    const f = form('override'); remote = [{ skuId: f.skuId, styleId: 'OLD', name: '旧商品', spec: '规格', category: '分类' }];
    const check = await svc.checkDuplicate(boss, f), before = await counts();
    await expect(svc.upload(boss, f, { signature: check.signature! })).rejects.toThrow(/已经存在/);
    expect(await counts()).toEqual(before);
    const queued = await svc.upload(boss, f, { signature: check.signature!, confirmed: true }); expect(queued.queued).toBe(true);
    const job = await ds.manager.findOneByOrFail(OutboxJob, { companyId: boss.companyId, resourceId: queued.id });
    expect((await ds.manager.find(ResourceChangeLog, { where: { companyId: boss.companyId, resourceType: 'finance-jst-uploads', resourceId: queued.id } })).some(row => row.note?.includes('已核对并确认覆盖重复商品编码'))).toBe(true);
    expect(job.payloadJson).toMatchObject({ targetKey: `${boss.companyId}:synthetic-target-A`, costPrice: 1.2345, weight: 0 });
    expect((await outbox.processCompany(boss.companyId)).sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('签名不可伪造、过期、改三身份、换人/公司/权限或用于新命中', async () => {
    const f = form('signed'), check = await svc.checkDuplicate(boss, f), signature = check.signature!, before = await counts();
    const old = Date.now; Date.now = () => Number(signature.split('.')[0]) + 300001;
    try { await expect(svc.upload(boss, f, { signature, confirmed: true })).rejects.toThrow(/失效/); } finally { Date.now = old; }
    for (const other of [boss, { ...boss, id: boss.id + 1 }, { ...boss, permissions: { ...boss.permissions, allow: ['product.cost.edit'] } }, await actor()]) await expect(svc.upload(other, f, { signature: other === boss ? signature + 'x' : signature, confirmed: true })).rejects.toThrow(/失效/);
    await expect(svc.upload(boss, f, { signature: signature.slice(0, -1) + '汉', confirmed: true })).rejects.toThrow(/失效/);
    await expect(svc.upload(boss, { ...f, name: '修改身份' }, { signature, confirmed: true })).rejects.toThrow(/失效/);
    remote = [{ skuId: f.skuId, styleId: 'NEW', name: '新重复', spec: '', category: '' }];
    await expect(svc.upload(boss, f, { signature, confirmed: true })).rejects.toThrow(/失效/);
    expect(await counts()).toEqual(before);
  });
  it('目标账号切换不复用预检；入队末步重新核验目标，失败登记和任务一起回滚', async () => {
    const f = form('target'), check = await svc.checkDuplicate(boss, f), before = await counts();
    target = 'synthetic-target-B'; await expect(svc.upload(boss, f, { signature: check.signature!, confirmed: true })).rejects.toThrow(/失效/); target = 'synthetic-target-A';
    const enqueue = jest.spyOn(outbox, 'enqueueUpload').mockImplementationOnce(async (...args) => { target = 'synthetic-target-C'; enqueue.mockRestore(); return outbox.enqueueUpload(...args); });
    try { await expect(svc.upload(boss, f, { signature: check.signature!, confirmed: true })).rejects.toThrow(/账号在查重之后变了/); } finally { enqueue.mockRestore(); }
    expect(await counts()).toEqual(before);
  });
  it('任务已插入后抛错，上传记录、任务和审计一起回滚', async () => {
    const f = form('after-insert'), checked = await svc.checkDuplicate(boss, f), before = await counts();
    const original = outbox.enqueueUpload.bind(outbox);
    const fail = jest.spyOn(outbox, 'enqueueUpload').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('合成任务插入后故障'); });
    try { await expect(svc.upload(boss, f, { signature: checked.signature! })).rejects.toThrow('合成任务插入后故障'); } finally { fail.mockRestore(); }
    expect(await counts()).toEqual(before);
    expect((await svc.upload(boss, f, { signature: checked.signature! })).queued).toBe(true);
  });

  it('并发同内容只保留一个登记和待发送任务，失败任务后允许明确再次提交', async () => {
    const f = form('concurrent'), check = await svc.checkDuplicate(boss, f), before = await counts();
    const result = await Promise.all([svc.upload(boss, f, { signature: check.signature! }), svc.upload(boss, f, { signature: check.signature! })]);
    expect(result.map(row => row.queued).sort()).toEqual([false, true]); expect(result[0].id).toBe(result[1].id);
    expect(await counts()).toEqual(before.map(value => value + 1));
    await ds.manager.update(OutboxJob, { companyId: boss.companyId, resourceId: result[0].id }, { status: 'failed' });
    expect((await svc.upload(boss, f, { signature: check.signature! })).queued).toBe(true); expect(await counts()).toEqual(before.map(value => value + 2));
  });
  it('实时查重失败不能声称无重复；有目标且签名绑定该失败，用户显式继续后才可排队', async () => {
    const f = form('failure'); unavailable = true; const check = await svc.checkDuplicate(boss, f);
    expect(check.hasWarning).toBe(true); expect(check.errors.length).toBe(1); expect(JSON.stringify(check)).not.toContain('synthetic-private-error');
    await expect(svc.upload(boss, f, { signature: check.signature! })).rejects.toThrow(/查重提示/);
    expect((await svc.upload(boss, f, { signature: check.signature!, confirmed: true })).queued).toBe(true);
  });
  it('记录按多条搜索任一匹配且维持公司隔离和30条分页', async () => {
    const logs = await svc.logs(boss, { keyword: 'SKU-concurrent\nSKU-after-insert', page: 1, pageSize: 30 });
    expect(logs.rows.length).toBe(3);
    expect(logs.rows.every(row => ['SKU-concurrent', 'SKU-after-insert'].includes(row.skuId))).toBe(true);
    expect((await svc.logs(boss, { keyword: '等待发送', page: 1, pageSize: 30 })).total).toBeGreaterThan(0);
    expect((await svc.logs(boss, { keyword: '1.2345', page: 1, pageSize: 30 })).rows).toEqual([]);
    const other = await actor(); expect((await svc.logs(other, { keyword: 'SKU-concurrent', page: 1, pageSize: 30 })).rows).toEqual([]);
  });

  it('上传内容的通用详情、导出、历史、备份与队列按成本/价格四组合保护且公司隔离', async () => {
    const f = { ...form('acl'), salePrice: 2.3456, marketPrice: 3.4567, otherPrice1: 4.5678 }, check = await svc.checkDuplicate(boss, f);
    const saved = await svc.upload(boss, f, { signature: check.signature! });
    const job = await ds.manager.findOneByOrFail(OutboxJob, { companyId: boss.companyId, resourceId: saved.id });
    await ds.manager.update(OutboxJob, { id: job.id }, { payloadJson: { ...job.payloadJson, nested: { cost_price: 1.2345, sale_price: 2.3456, qty: 3 }, encoded: JSON.stringify({ purchasePrice: 1.2345, s_price: 2.3456, skuId: f.skuId }) } });
    await ds.manager.save(ResourceImportBackup, ds.manager.create(ResourceImportBackup, { companyId: boss.companyId, resourceType: 'finance-jst-uploads', recordCount: 1, snapshotJson: JSON.stringify([{ id: saved.id, payload: f }]), createdBy: boss.id }));
    for (const [cost, price] of [[false, false], [true, false], [false, true], [true, true]]) {
      const viewer: AuthUser = { ...boss, permissions: { isCompanyAdmin: false, allow: ['resource.finance-jst-uploads.view', 'resource.finance-jst-uploads.export', 'finance.jst-sync.view', ...(cost ? ['product.cost.view'] : []), ...(price ? ['product.price.view'] : [])], deny: [] } };
      const detail = await services.resources.get(viewer, 'finance-jst-uploads', saved.id);
      expect('payload' in detail.data).toBe(cost && price);
      const exported = await services.resources.exportCsv(viewer, 'finance-jst-uploads', true, { ids: [saved.id] });
      expect(exported.csv.includes('上传内容')).toBe(cost && price);
      const history = await services.resources.logs(viewer, 'finance-jst-uploads', saved.id);
      expect(JSON.stringify(history).includes('costPrice')).toBe(cost && price);
      const backup = await services.resources.listImportBackups(viewer, 'finance-jst-uploads'); expect(JSON.stringify(backup)).not.toMatch(/snapshotJson|costPrice|salePrice/);
      const jobs = await outbox.jobs(viewer, { page: 1, pageSize: 100, kind: 'normal_product_upload' });
      const own = jobs.rows.find((row: { id: number }) => row.id === job.id)!;
      expect('costPrice' in own.payload).toBe(cost); expect('salePrice' in own.payload).toBe(price); expect('otherPrice1' in own.payload).toBe(price);
      expect('cost_price' in own.payload.nested).toBe(cost); expect('sale_price' in own.payload.nested).toBe(price); expect(own.payload.nested.qty).toBe(3);
    }
    const other = await actor();
    await expect(services.resources.get(other, 'finance-jst-uploads', saved.id)).rejects.toThrow(/不存在/);
    await expect(services.resources.logs(other, 'finance-jst-uploads', saved.id)).rejects.toThrow(/不存在/);
    expect((await services.resources.exportCsv(other, 'finance-jst-uploads', true, { ids: [saved.id] })).count).toBe(0);
    expect(await services.resources.listImportBackups(other, 'finance-jst-uploads')).toEqual([]);
    expect((await outbox.jobs(other, { page: 1, pageSize: 100, kind: 'normal_product_upload' })).rows).toEqual([]);
  });

  it('同名远端叶在选项、预检和伪造上传使用同一错误，已核对也不能绕过且不留任务', async () => {
    const f = form('ambiguous'), checked = await svc.checkDuplicate(boss, f), before = await counts();
    categories = [...categories, { id: 'other', parentId: '0', name: '另一父类', sort: null, enable: true }, { id: 'other-leaf', parentId: 'other', name: '苹果', sort: null, enable: true }];
    const options = await svc.options(boss), disabled = options.categoryOptions.find(option => option.value === f.categoryName)!;
    expect(disabled.disabled).toBe(true); expect(disabled.reason).toMatch(/同名分类/); expect(options.categories).not.toContain(f.categoryName);
    await expect(svc.checkDuplicate(boss, f)).rejects.toThrow(disabled.reason!);
    await expect(svc.upload(boss, f, { signature: checked.signature!, confirmed: true })).rejects.toThrow(disabled.reason!);
    await expect(svc.upload(boss, { ...f, categoryName: '苹果' }, { signature: checked.signature!, confirmed: true })).rejects.toThrow(disabled.reason!);
    expect(await counts()).toEqual(before); expect(send).not.toHaveBeenCalled();
  });

  it('伪造父级、缺失分类均拒绝；唯一远端叶名与原完整路径成功状态保持不变', async () => {
    const f = form('category-valid'), checked = await svc.checkDuplicate(boss, f), before = await counts();
    for (const categoryName of ['聚水潭水果', '伪造路径/苹果']) await expect(svc.upload(boss, { ...f, categoryName }, { signature: checked.signature!, confirmed: true })).rejects.toThrow(/末级|失效/);
    expect(await counts()).toEqual(before);
    const saved = await svc.upload(boss, { ...f, categoryName: '苹果' }, { signature: checked.signature! });
    expect(saved).toMatchObject({ queued: true, status: 'queued' });
  });

  it('白名单、精度、必填和管理员/成本拒绝在任何入队前生效，日志不带成本', async () => {
    const f = form('permissions');
    await expect(svc.upload(boss, { ...f, brand: '' })).rejects.toThrow(/品牌/);
    await expect(svc.upload(boss, { ...f, companyId: 999 })).rejects.toThrow(/不支持/);
    await expect(svc.upload(boss, { ...f, costPrice: 0.000001 })).rejects.toThrow(/精度|保留/);
    await expect(svc.upload({ ...boss, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, f)).rejects.toThrow(/管理员/);
    await expect(svc.upload({ ...boss, permissions: { isCompanyAdmin: false, allow: ['finance.jst-maintenance.view'], deny: ['product.cost.edit'] } }, f)).rejects.toThrow(/管理员/);
    const logs = await svc.logs(boss, { page: 1, pageSize: 30 }); expect(JSON.stringify(logs)).not.toMatch(/costPrice|purchasePrice|1\.2345|payload/);
  });
});

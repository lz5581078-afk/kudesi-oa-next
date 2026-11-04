/** 隔离MySQL验证整组失败回滚、并发冲突及网络重试，不操作真实业务记录。 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import type { ResourceFormInput } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceFormMutation, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('通用资料表单整组保存（真实数据库）', () => {
  let ds: DataSource, svc: ResourcesService, actor: AuthUser, categoryId: number, supplierId: number;
  beforeAll(async () => {
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never).initialize();
    svc = buildServices(ds).resources;
    const company = await ds.manager.save(Company, ds.manager.create(Company, { code: `atomic${randomBytes(5).toString('hex')}`, name: '整组测试隔离公司', status: 'active' }));
    const user = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'admin', passwordHash: 'x', name: '测试', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    actor = { id: user.id, companyId: company.id, name: user.name, permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    categoryId = (await svc.create(actor, 'finance-categories', { archiveType: 'raw', name: '整组测试分类', code: 'ZZ' })).id;
    supplierId = (await svc.create(actor, 'finance-suppliers', { name: '整组测试供应商' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });
  const source = (over: Record<string, unknown> = {}) => ({ supplierId, originArea: '山东', purchasePrice: 100, ...over });
  const request = (over: Partial<ResourceFormInput> = {}): ResourceFormInput => ({ requestKey: randomUUID(), values: { archiveType: 'raw', name: `合成原料${randomBytes(3).toString('hex')}`, categoryId, specQty: 1, specUnit: 'KG', purchaseSpec: '千克', freight: 1, handlingFee: 1 }, collections: [{ type: 'finance-product-sources', expected: [], rows: [{ values: source() }] }], ...over });
  const sources = (id: number) => svc.list(actor, 'finance-product-sources', { fieldKey: 'productId', fieldValue: String(id), showHidden: true, pageSize: 200 });
  const editRequest = async (id: number): Promise<ResourceFormInput> => {
    const parent = await svc.get(actor, 'finance-products', id), rows = (await sources(id)).items;
    return request({ id, version: parent.version, values: { name: parent.title }, collections: [{ type: 'finance-product-sources', expected: rows.map(row => ({ id: row.id, version: row.version! })), rows: rows.map(row => ({ id: row.id, values: source({ originArea: row.data.originArea, purchasePrice: row.data.purchasePrice, systemSpec: row.data.systemSpec }) })) }] });
  };
  const graph = async () => (await ds.manager.find(ResourceRecord, { where: { companyId: actor.companyId }, order: { id: 'ASC' } })).map(r => [r.id, r.type, r.title, r.data, r.status]);

  it('任一子行失败时主档、已有下游和前面的有效子行全部回滚，修正后可使用同一请求重试', async () => {
    const body = request();
    body.collections[0].rows.push({ values: source({ supplierId: 999999999 }) });
    const before = await graph();
    await expect(svc.saveForm(actor, 'finance-products', body)).rejects.toThrow(/供应商/);
    expect(await graph()).toEqual(before);
    expect(await ds.manager.countBy(ResourceFormMutation, { companyId: actor.companyId, requestKey: body.requestKey })).toBe(0);
    body.collections[0].rows.pop();
    const saved = await svc.saveForm(actor, 'finance-products', body);
    expect((await sources(saved.id)).total).toBe(1);
    expect(saved.data).toMatchObject({ purchasePrice: 100, totalCost: 102 });
  });

  it('相同请求并发提交和已提交后的重试只生成一个主档、一条来源及同一组历史', async () => {
    const body = request();
    const [a, b] = await Promise.all([svc.saveForm(actor, 'finance-products', body), svc.saveForm(actor, 'finance-products', body)]);
    expect(a.id).toBe(b.id);
    expect((await sources(a.id)).total).toBe(1);
    const before = await graph();
    expect((await svc.saveForm(actor, 'finance-products', body)).id).toBe(a.id);
    expect(await graph()).toEqual(before);
    await expect(svc.saveForm(actor, 'finance-products', { ...body, values: { ...body.values, name: '不同请求内容' } })).rejects.toThrow(/保存已经处理/);
  });

  it('替换来源中途失败时保留旧来源和旧主档金额，成功后才整组替换', async () => {
    const product = await svc.saveForm(actor, 'finance-products', request());
    const edit = await editRequest(product.id);
    edit.values.name = '替换后名称';
    edit.collections[0].rows = [{ values: source({ purchasePrice: 200 }) }, { values: source({ supplierId: 999999999 }) }];
    const before = await graph();
    await expect(svc.saveForm(actor, 'finance-products', edit)).rejects.toThrow();
    expect(await graph()).toEqual(before);
    edit.collections[0].rows.pop();
    const changed = await svc.saveForm(actor, 'finance-products', edit);
    expect(changed.title).toBe('替换后名称');
    expect(changed.data.purchasePrice).toBe(200);
    expect((await sources(product.id)).items[0].id).not.toBe(edit.collections[0].expected[0].id);
  });

  it('主档版本、来源版本及新增来源均检测并发，不能覆盖其他窗口的更改', async () => {
    const product = await svc.saveForm(actor, 'finance-products', request());
    const stale = await editRequest(product.id);
    await svc.update(actor, 'finance-product-sources', stale.collections[0].rows[0].id!, { note: '其他窗口更新' });
    const before = await graph();
    await expect(svc.saveForm(actor, 'finance-products', stale)).rejects.toThrow(/刚被修改/);
    expect(await graph()).toEqual(before);
    const stale2 = await editRequest(product.id);
    await svc.create(actor, 'finance-product-sources', { productId: product.id, ...source({ originArea: '新增来源' }) });
    await expect(svc.saveForm(actor, 'finance-products', stale2)).rejects.toThrow(/刚被修改/);
    const stale3 = await editRequest(product.id);
    await svc.update(actor, 'finance-products', product.id, { name: '其他窗口主档' });
    await expect(svc.saveForm(actor, 'finance-products', stale3)).rejects.toThrow(/主档刚被修改/);
  });

  it('不能修改其他商品的来源、伪造归属或提交未开放的成本子表', async () => {
    const a = await svc.saveForm(actor, 'finance-products', request()), b = await svc.saveForm(actor, 'finance-products', request());
    const edit = await editRequest(a.id);
    edit.collections[0].rows[0].id = (await sources(b.id)).items[0].id;
    await expect(svc.saveForm(actor, 'finance-products', edit)).rejects.toThrow(/不属于/);
    const moved = await editRequest(a.id);
    moved.collections[0].rows[0].values.productId = b.id;
    await expect(svc.saveForm(actor, 'finance-products', moved)).rejects.toThrow(/归属/);
    await expect(svc.saveForm(actor, 'finance-products', request({ collections: [{ type: 'finance-product-costs', expected: [], rows: [] }] }))).rejects.toThrow(/不允许/);
    await expect(svc.saveForm({ ...actor, companyId: 999999999 }, 'finance-products', await editRequest(a.id))).rejects.toThrow(/不存在/);
  });

  it('子行删除权限不足时整组不落库；成本权限在统一保存中强制执行', async () => {
    const product = await svc.saveForm(actor, 'finance-products', request());
    const editor = { ...actor, permissions: { isCompanyAdmin: false, allow: ['resource.finance-products.view', 'resource.finance-products.edit', 'resource.finance-products.create'], deny: [] } };
    const deleted = await editRequest(product.id);
    deleted.values.name = '不应落库'; deleted.collections[0].rows = [{ values: source() }];
    const before = await graph();
    await expect(svc.saveForm(editor, 'finance-products', deleted)).rejects.toThrow(/权限/);
    expect(await graph()).toEqual(before);
    const cost = await editRequest(product.id);
    cost.collections[0].rows[0].values.purchasePrice = 9999;
    await svc.saveForm(editor, 'finance-products', cost);
    expect((await svc.get(actor, 'finance-products', product.id)).data.purchasePrice).toBe(100);
  });

  it('最后一条来源不能清空后直接保存，组成失败也回滚父档和先前的组成', async () => {
    const raw = await svc.saveForm(actor, 'finance-products', request());
    const empty = await editRequest(raw.id); empty.collections[0].rows = [];
    await expect(svc.saveForm(actor, 'finance-products', empty)).rejects.toThrow(/至少保留/);
    const category = await svc.create(actor, 'finance-categories', { archiveType: 'self_made', name: '整组自产', code: 'ZZZC' });
    const brand = await svc.create(actor, 'finance-brands', { name: '合成品牌' });
    const body = request({ values: { archiveType: 'self_made', name: '组成回滚测试', categoryId: category.id, brandId: brand.id, specQty: '混装', specUnit: 'BOX' }, collections: [{ type: 'finance-product-boms', expected: [], rows: [{ values: { componentId: raw.id, qty: 2 } }, { values: { componentId: 999999999, qty: 1 } }] }] });
    const before = await graph();
    await expect(svc.saveForm(actor, 'finance-products', body)).rejects.toThrow();
    expect(await graph()).toEqual(before);
    body.collections[0].rows.pop();
    const made = await svc.saveForm(actor, 'finance-products', body);
    expect(made.data).toMatchObject({ weightG: 2000, totalCost: 204 });
  });

  it('同毫秒多条改价依照提交顺序，不误用行号决定最新采购价', async () => {
    const body = request(); body.collections[0].rows.push({ values: source({ originArea: '浙江', purchasePrice: 200 }) });
    const product = await svc.saveForm(actor, 'finance-products', body);
    const edit = await editRequest(product.id);
    edit.collections[0].rows.reverse();
    edit.collections[0].rows[0].values.purchasePrice = 250;
    edit.collections[0].rows[1].values.purchasePrice = 300;
    const timer = jest.spyOn(Date, 'now').mockReturnValue(new Date('2030-01-01T00:00:00Z').getTime());
    try {
      const changed = await svc.saveForm(actor, 'finance-products', edit);
      expect(changed.data.purchasePrice).toBe(300);
    } finally { timer.mockRestore(); }
  });

  it('相同请求重放仍检查当前权限，不能利用已保存结果绕过授权', async () => {
    const body = request(); await svc.saveForm(actor, 'finance-products', body);
    await expect(svc.saveForm({ ...actor, permissions: { isCompanyAdmin: false, allow: [], deny: [] } }, 'finance-products', body)).rejects.toThrow(/权限/);
  });
});

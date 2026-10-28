import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, User } from '../entities';
import { buildServices } from '../test-support';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
const cf = (...f: Array<Record<string, unknown>>) => JSON.stringify(f);

d('列筛选（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let boss: AuthUser;
  let other: AuthUser;
  let viewer: AuthUser;
  const asUser = (companyId: number, id: number, allow: string[]): AuthUser => ({ id, companyId, name: '员工', permissions: { isCompanyAdmin: false, allow, deny: [] } });
  const titles = async (user: AuthUser, type: string, q: Record<string, unknown>) => {
    const r = await svc.list(user, type, { pageSize: 200, ...q } as never);
    return { names: r.items.map((i) => i.title).sort(), total: r.total, r };
  };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_colfilter_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    const mk = async (name: string) => {
      const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `x${crypto.randomBytes(5).toString('hex')}`, name, status: 'active' }));
      const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: `c${crypto.randomBytes(4).toString('hex')}`, passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
      return { c, u };
    };
    const a = await mk('列筛选A');
    const b = await mk('列筛选B');
    boss = { id: a.u.id, companyId: a.c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    other = { id: b.u.id, companyId: b.c.id, name: '外司', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    viewer = asUser(a.c.id, a.u.id, ['resource.finance-products.view', 'resource.phones.view', 'resource.partners.view']);
  });
  afterAll(async () => { await ds?.destroy(); });

  const insert = (companyId: number, type: string, title: string, data: Record<string, unknown>, status = 'normal') =>
    ds.manager.save(ResourceRecord, ds.manager.create(ResourceRecord, { companyId, type, title, status, data, searchText: title.toLowerCase(), secrets: null }));

  describe('手机号：文本 / 手机 / 数字 / 金额 / 日期 / 单选 / 引用', () => {
    let main: number;
    beforeAll(async () => {
      const m = await svc.create(boss, 'phones', { number: '13800000001', usageType: 'company_kept', carrier: '中国移动' });
      main = m.id;
      await svc.create(boss, 'phones', { number: '13800000002', usageType: 'personal_used', carrier: '中国联通', monthlyFee: 3000, lastRechargeAt: '2030-03-10', rechargeCycleDays: 30, parentPhoneId: main, feeCycle: 'monthly' });
      await svc.create(boss, 'phones', { number: '13900000003', usageType: 'personal_used', carrier: '中国电信', monthlyFee: 9900, lastRechargeAt: '2030-04-01', rechargeCycleDays: 90, feeCycle: 'quarterly', plan: '50_G_套餐' });
      await svc.create(boss, 'phones', { number: '13900000004', usageType: 'partner_used', monthlyFee: 0, lastRechargeAt: '2030-03-31', plan: '50%套餐' });
      await svc.create(other, 'phones', { number: '13800000099', usageType: 'company_kept', carrier: '中国移动' });
    });

    it('文本：包含 / 等于 / 不等于 / 开头是 / 为空 / 不为空；通配符按字面处理', async () => {
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'carrier', op: 'contains', value: '联通' }) })).total).toBe(1);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'carrier', op: 'eq', value: '中国移动' }) })).total).toBe(2); // 新建时默认中国移动
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'carrier', op: 'neq', value: '中国移动' }) })).total).toBe(2);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'carrier', op: 'startsWith', value: '中国电' }) })).total).toBe(1);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'plan', op: 'empty' }) })).total).toBe(2);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'plan', op: 'notEmpty' }) })).total).toBe(2);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'plan', op: 'neq', value: '50%套餐' }) })).total).toBe(3); // 没填的也算不等于
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'plan', op: 'contains', value: '%' }) })).total).toBe(1);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'plan', op: 'contains', value: '_' }) })).total).toBe(1);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'plan', op: 'contains', value: "' OR 1=1 --" }) })).total).toBe(0);
    });

    it('手机号：数字片段包含 / 开头 / 等于，输入里的空格横线不影响', async () => {
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'number', op: 'contains', value: '0000' }) })).total).toBe(4);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'number', op: 'startsWith', value: '139' }) })).total).toBe(2);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'number', op: 'eq', value: '138-0000-0002' }) })).names).toEqual(['13800000002']);
    });

    it('数字 / 金额：等于 / 大于 / 小于 / 区间；金额按存储的分比较；没填的不算', async () => {
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'monthlyFee', op: 'gt', value: '3000' }) })).names).toEqual(['13900000003']);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'monthlyFee', op: 'lt', value: '3000' }) })).names).toEqual(['13900000004']);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'monthlyFee', op: 'eq', value: '3000' }) })).names).toEqual(['13800000002']);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'monthlyFee', op: 'between', value: '0', value2: '3000' }) })).total).toBe(2);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'rechargeCycleDays', op: 'between', value: '31', value2: '100' }) })).names).toEqual(['13900000003']);
    });

    it('日期：区间 / 早于 / 晚于 / 等于 / 为空', async () => {
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'lastRechargeAt', op: 'between', value: '2030-03-01', value2: '2030-03-31' }) })).total).toBe(2);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'lastRechargeAt', op: 'before', value: '2030-03-31' }) })).names).toEqual(['13800000002']);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'lastRechargeAt', op: 'after', value: '2030-03-31' }) })).names).toEqual(['13900000003']);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'lastRechargeAt', op: 'eq', value: '2030-03-31' }) })).names).toEqual(['13900000004']);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'lastRechargeAt', op: 'empty' }) })).names).toEqual(['13800000001']);
    });

    it('单选多选、引用多选、状态列多选', async () => {
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'usageType', op: 'in', values: ['personal_used', 'partner_used'] }) })).total).toBe(3);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'parentPhoneId', op: 'in', values: [String(main)] }) })).names).toEqual(['13800000002']);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: 'parentPhoneId', op: 'empty' }) })).total).toBe(3);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: '$status', op: 'in', values: ['normal'] }) })).total).toBe(4);
      expect((await titles(boss, 'phones', { colFilters: cf({ key: '$status', op: 'in', values: ['abnormal'] }) })).total).toBe(0);
    });

    it('多列条件是“并且”；分页总数是筛选后的总数；每页 2 条翻页不重复', async () => {
      const both = await titles(boss, 'phones', { colFilters: cf({ key: 'usageType', op: 'in', values: ['personal_used'] }, { key: 'monthlyFee', op: 'gt', value: '4000' }) });
      expect(both.names).toEqual(['13900000003']);
      const p1 = await svc.list(boss, 'phones', { colFilters: cf({ key: 'number', op: 'contains', value: '0000' }), pageSize: 3, page: 1 });
      const p2 = await svc.list(boss, 'phones', { colFilters: cf({ key: 'number', op: 'contains', value: '0000' }), pageSize: 3, page: 2 });
      expect(p1.total).toBe(4);
      expect(p2.total).toBe(4);
      expect(p1.items).toHaveLength(3);
      expect(p2.items).toHaveLength(1);
      expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(4);
    });

    it('与页签 / 状态 / 搜索词 / 现有筛选 / 排序并存；页签数量也跟着列筛选走', async () => {
      const r = await svc.list(boss, 'phones', { tab: 'personal_used', keyword: '1390', colFilters: cf({ key: 'monthlyFee', op: 'gt', value: '1' }), sortBy: 'monthlyFee', sortDir: 'desc', pageSize: 50 });
      expect(r.items.map((i) => i.title)).toEqual(['13900000003']);
      const withTabs = await svc.list(boss, 'phones', { colFilters: cf({ key: 'carrier', op: 'notEmpty' }), pageSize: 50 });
      expect(withTabs.tabCounts?.personal_used).toBe(2);
      expect(withTabs.tabCounts?.company_kept).toBe(1);
      expect(withTabs.tabCounts?.partner_used).toBe(1);
      const byFilters = await svc.list(boss, 'phones', { filters: JSON.stringify({ feeCycle: 'monthly' }), colFilters: cf({ key: 'carrier', op: 'contains', value: '联通' }) });
      expect(byFilters.total).toBe(1);
      const none = await svc.list(boss, 'phones', { filters: JSON.stringify({ feeCycle: 'yearly' }), colFilters: cf({ key: 'carrier', op: 'contains', value: '联通' }) });
      expect(none.total).toBe(0);
      const archived = await svc.list(boss, 'phones', { archived: true, colFilters: cf({ key: 'carrier', op: 'notEmpty' }) });
      expect(archived.total).toBe(0);
    });

    it('导出遵守列筛选', async () => {
      const out = await svc.exportCsv(boss, 'phones', false, { colFilters: cf({ key: 'usageType', op: 'in', values: ['partner_used'] }) });
      expect(out.count).toBe(1);
      expect(out.csv).toContain('13900000004');
      expect(out.csv).not.toContain('13800000001');
    });

    it('单选列的值和数量：按其它列的条件算，本列自己的条件不算', async () => {
      const all = await svc.columnFacets(boss, 'phones', { key: 'usageType' });
      expect(Object.fromEntries(all.items.map((i) => [i.value, i.count]))).toEqual({ company_kept: 1, personal_used: 2, partner_used: 1 });
      const narrowed = await svc.columnFacets(boss, 'phones', { key: 'usageType', colFilters: cf({ key: 'monthlyFee', op: 'gt', value: '4000' }, { key: 'usageType', op: 'in', values: ['company_kept'] }) });
      expect(narrowed.items).toEqual([{ value: 'personal_used', count: 1 }]);
      await expect(svc.columnFacets(boss, 'phones', { key: 'carrier' })).rejects.toThrow();
    });

    it('跨公司隔离：只看得到自己公司的，别家的数据既不在结果里也不在数量里', async () => {
      const mine = await titles(boss, 'phones', { colFilters: cf({ key: 'number', op: 'eq', value: '13800000099' }) });
      expect(mine.total).toBe(0);
      const theirs = await titles(other, 'phones', { colFilters: cf({ key: 'number', op: 'eq', value: '13800000099' }) });
      expect(theirs.total).toBe(1);
      const facet = await svc.columnFacets(other, 'phones', { key: 'usageType' });
      expect(facet.items).toEqual([{ value: 'company_kept', count: 1 }]);
      // 公司只取自令牌：参数里塞 companyId 过不了校验
      await expect(svc.list(boss, 'phones', { colFilters: cf({ key: 'carrier', op: 'empty', companyId: other.companyId }) })).rejects.toThrow();
    });

    it('非法字段 / 操作符 / 值 / 条件过多都被拒绝（400）', async () => {
      const bad = [
        cf({ key: 'nope', op: 'contains', value: 'a' }),
        cf({ key: 'monthlyFee', op: 'contains', value: 'a' }),
        cf({ key: 'carrier', op: 'gt', value: '1' }),
        cf({ key: 'monthlyFee', op: 'gt', value: 'abc' }),
        cf({ key: 'lastRechargeAt', op: 'before', value: '2030-13-45' }),
        cf({ key: 'usageType', op: 'in', values: [] }),
        cf({ key: '$status', op: 'in', values: ['bogus'] }),
        '{"a":1}', 'not json',
        JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ key: 'carrier', op: 'empty', i }))),
        JSON.stringify(Array.from({ length: 13 }, () => ({ key: 'carrier', op: 'empty' }))),
      ];
      for (const b of bad) await expect(svc.list(boss, 'phones', { colFilters: b })).rejects.toMatchObject({ status: 400 });
    });

    it('跨资料引用的编号只是编号：塞别家公司的记录编号不会带出别家数据', async () => {
      const foreign = (await ds.manager.findOneByOrFail(ResourceRecord, { companyId: other.companyId, type: 'phones' })).id;
      const r = await titles(boss, 'phones', { colFilters: cf({ key: 'parentPhoneId', op: 'in', values: [String(foreign)] }) });
      expect(r.total).toBe(0);
    });
  });

  describe('证件号 / 银行卡（加密存放）：只能筛选已填 / 未填，不能猜明文', () => {
    beforeAll(async () => {
      await svc.create(boss, 'partners', { partnerType: 'partner', name: '甲', idNumber: '110101199001011234' });
      await svc.create(boss, 'partners', { partnerType: 'legal', name: '乙' });
    });
    it('已填 / 未填正确', async () => {
      expect((await titles(boss, 'partners', { colFilters: cf({ key: 'idNumber', op: 'notEmpty' }) })).names).toEqual(['甲']);
      expect((await titles(boss, 'partners', { colFilters: cf({ key: 'idNumber', op: 'empty' }) })).names).toEqual(['乙']);
    });
    it('按内容筛选（包含 / 等于 / 开头）一律拒绝，没法通过筛选结果探测明文', async () => {
      for (const op of ['contains', 'eq', 'neq', 'startsWith', 'gt']) {
        await expect(svc.list(boss, 'partners', { colFilters: cf({ key: 'idNumber', op, value: '1101' }) })).rejects.toMatchObject({ status: 400 });
      }
    });
    it('密码类字段不会因为筛选泄露：结果里没有，也只能判断是否设置过', async () => {
      const r = await svc.list(boss, 'partners', { colFilters: cf({ key: 'idNumber', op: 'notEmpty' }) });
      expect(JSON.stringify(r.items)).not.toContain('"password"');
    });
  });

  describe('布尔', () => {
    it('是 / 否（没填算否）', async () => {
      await insert(boss.companyId, 'licenses', '有缺失', { originalPhotoMissing: true });
      await insert(boss.companyId, 'licenses', '无缺失', { originalPhotoMissing: false });
      await insert(boss.companyId, 'licenses', '没填', {});
      expect((await titles(boss, 'licenses', { colFilters: cf({ key: 'originalPhotoMissing', op: 'yes' }) })).names).toEqual(['有缺失']);
      expect((await titles(boss, 'licenses', { colFilters: cf({ key: 'originalPhotoMissing', op: 'no' }) })).names).toEqual(['无缺失', '没填']);
    });
  });

  describe('成本字段：没有权限的人既看不到也不能筛选 / 排序 / 统计', () => {
    beforeAll(async () => {
      await svc.create(boss, 'finance-products', { name: '商品甲', code: 'CF-A', archiveType: 'finished', purchasePrice: 1234 } as never).catch(() => undefined);
      await insert(boss.companyId, 'finance-products', '成本品', { code: 'CF-B', purchasePrice: 5555, remark: 'x' });
    });
    it('有权限（管理员）可以按成本筛选', async () => {
      const r = await titles(boss, 'finance-products', { colFilters: cf({ key: 'purchasePrice', op: 'eq', value: '5555' }) });
      expect(r.names).toEqual(['成本品']);
    });
    it('没有 product.cost.view：列筛选、旧的 filters、排序、导出都被拒绝，结果里也没有成本字段', async () => {
      await expect(svc.list(viewer, 'finance-products', { colFilters: cf({ key: 'purchasePrice', op: 'eq', value: '5555' }) })).rejects.toMatchObject({ status: 400 });
      await expect(svc.list(viewer, 'finance-products', { filters: JSON.stringify({ purchasePrice: '5555' }) })).rejects.toMatchObject({ status: 403 });
      await expect(svc.list(viewer, 'finance-products', { sortBy: 'purchasePrice', sortDir: 'asc' })).rejects.toMatchObject({ status: 403 });
      await expect(svc.exportCsv(viewer, 'finance-products', false, { colFilters: cf({ key: 'purchasePrice', op: 'gt', value: '1' }) })).rejects.toMatchObject({ status: 400 });
      const r = await svc.list(viewer, 'finance-products', { pageSize: 50 });
      expect(r.items.length).toBeGreaterThan(0);
      for (const i of r.items) expect(i.data).not.toHaveProperty('purchasePrice');
      // 其它不受限的列照常可筛
      expect((await svc.list(viewer, 'finance-products', { colFilters: cf({ key: 'code', op: 'eq', value: 'CF-B' }) })).total).toBe(1);
    });
  });

  describe('几千行的数量级', () => {
    it('2000 行手机号：文本 / 日期 / 单选 / 组合筛选的总数与分页正确，耗时合理', async () => {
      const rows = Array.from({ length: 2000 }, (_, i) => ({
        companyId: other.companyId, type: 'phones', title: `1370${String(i).padStart(7, '0')}`, status: 'normal',
        data: { number: `1370${String(i).padStart(7, '0')}`, usageType: i % 3 === 0 ? 'company_kept' : 'personal_used', lastRechargeAt: `2031-${String((i % 12) + 1).padStart(2, '0')}-15`, monthlyFee: i * 100 },
        searchText: `1370${i}`, secrets: null,
      }));
      await ds.manager.insert(ResourceRecord, rows as never);
      const t0 = Date.now();
      const text = await svc.list(other, 'phones', { colFilters: cf({ key: 'number', op: 'startsWith', value: '13700001' }), pageSize: 200 });
      expect(text.total).toBe(1000);
      expect(text.items).toHaveLength(200);
      const date = await svc.list(other, 'phones', { colFilters: cf({ key: 'lastRechargeAt', op: 'between', value: '2031-03-01', value2: '2031-03-31' }), pageSize: 200 });
      expect(date.total).toBe(Math.floor(2000 / 12) + (2000 % 12 > 2 ? 1 : 0));
      const sel = await svc.list(other, 'phones', { colFilters: cf({ key: 'usageType', op: 'in', values: ['company_kept'] }), pageSize: 200 });
      expect(sel.total).toBe(667 + 1); // 667 条是 i%3===0 的，加上前面单独建的那条 company_kept
      const combo = await svc.list(other, 'phones', { colFilters: cf({ key: 'usageType', op: 'in', values: ['personal_used'] }, { key: 'monthlyFee', op: 'between', value: '100000', value2: '110000' }, { key: 'number', op: 'contains', value: '137000' }), pageSize: 200 });
      expect(combo.total).toBeGreaterThan(0);
      expect(Date.now() - t0).toBeLessThan(8000);
    });
  });
});

/** 聚水潭分类页面（基础编码、组合编码）的服务端行为：马甲、核对与二次验证、删除、命名规则、批量生成与重复检查、构成修订、归档。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { OutboxService } from '../outbox/outbox.service';
import { buildServices } from '../test-support';
import { BaseCodeToolsService } from './base-code-tools.service';
import { BundleToolsService } from './bundle-tools.service';
import { JstMaintenanceService } from './jst-maintenance.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('聚水潭分类：基础编码与组合编码（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let outbox: OutboxService;
  let bc: BaseCodeToolsService;
  let bt: BundleToolsService;
  let jm: JstMaintenanceService;
  let boss: AuthUser;
  let ops: AuthUser;
  const ids: Record<string, number> = {};

  const mkProduct = (over: Record<string, unknown>) =>
    svc.create(boss, 'finance-products', { archiveType: 'raw', name: '苹果', categoryId: ids.leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 100, handlingFee: 50, ...over });

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    svc = buildServices(ds).resources;
    outbox = new OutboxService(ds, svc);
    bc = new BaseCodeToolsService(ds, svc, outbox);
    bt = new BundleToolsService(ds, svc, outbox);
    jm = new JstMaintenanceService(ds, svc, outbox);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `j${crypto.randomBytes(5).toString('hex')}`, name: '聚水潭分类测试', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    ops = { id: u.id, companyId: c.id, name: '运营', permissions: { isCompanyAdmin: false, allow: ['resource.finance-base-codes.*', 'resource.finance-bundles.*', 'resource.finance-products.*'], deny: [] } };
    const root = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
    ids.leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: root })).id;
    ids.root = root;
    ids.tb = (await svc.create(boss, 'finance-platforms', { code: 'TB', name: '淘宝' })).id;
    ids.dy = (await svc.create(boss, 'finance-platforms', { code: 'DY', name: '抖音' })).id;
    ids.std = (await svc.create(boss, 'finance-scenarios', { code: 'standard', name: '标准' })).id;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('基础编码：款式编码和编码用横线连接，相邻重复的分类码去掉；旧格式的编码自动换成新格式', async () => {
    const p = await mkProduct({ name: '红富士', rawFinishedNames: '精品红富士\n礼盒红富士' });
    ids.p1 = p.id;
    const c1 = await svc.create(boss, 'finance-base-codes', { productId: p.id });
    ids.c1 = c1.id;
    expect(c1.data.styleCode).toBe('SG-PG-HFS');
    expect(c1.data.code).toBe('SG-PG-HFS-1KG');
    expect(c1.data.spec).toBe('1KG');
    // 旧格式编码（连在一起）当作自动生成，重新生成成新格式，不要求写原因
    const old = await svc.update(boss, 'finance-base-codes', c1.id, { code: 'SGPGHFS-1KG' });
    expect(old.data.code).toBe('SG-PG-HFS-1KG');
    await expect(svc.update(boss, 'finance-base-codes', c1.id, { styleCode: 'MYSTYLE' })).rejects.toThrow(/原因/);
  });

  it('马甲：原料的成品名自动生成别名编码，别名不能手工新增，被引用或同步过的别名不能去掉', async () => {
    const aliases = (await svc.list(boss, 'finance-base-codes', { pageSize: 50 } as never)).items.filter((r: { data: Record<string, unknown> }) => r.data.canonicalId === ids.c1);
    expect(aliases).toHaveLength(2);
    expect(String(aliases[0].data.code)).toMatch(/^YL-[0-9A-F]{20}$/);
    expect(aliases.map((a: { data: Record<string, unknown> }) => String(a.data.name)).some((n: string) => n.startsWith('精品红富士-1KG-YL-'))).toBe(true);
    await expect(svc.create(boss, 'finance-base-codes', { productId: ids.p1, code: 'YL-AAAAAAAAAAAAAAAAAAAA', canonicalId: ids.c1 })).rejects.toThrow(/自动生成/);
    // 去掉一个成品名：对应马甲删除
    await svc.update(boss, 'finance-products', ids.p1, { rawFinishedNames: '精品红富士' });
    const after = (await svc.list(boss, 'finance-base-codes', { pageSize: 50 } as never)).items.filter((r: { data: Record<string, unknown> }) => r.data.canonicalId === ids.c1);
    expect(after).toHaveLength(1);
    ids.alias = after[0].id;
    // 马甲被已同步标记后不能去掉
    await ds.manager.query("UPDATE resource_records SET data = JSON_SET(data, '$.jstUploadedCode', 'X') WHERE id = ?", [ids.alias]);
    await expect(svc.update(boss, 'finance-products', ids.p1, { rawFinishedNames: '' })).rejects.toThrow(/同步过聚水潭/);
    await ds.manager.query("UPDATE resource_records SET data = JSON_REMOVE(data, '$.jstUploadedCode') WHERE id = ?", [ids.alias]);
  });

  it('核对报告：资料问题按档案分组并带“去修改”信息；验证要求核对指纹一致', async () => {
    const box = await svc.create(boss, 'finance-products', { archiveType: 'self_made', name: '苹果礼盒', categoryId: (await svc.create(boss, 'finance-categories', { archiveType: 'self_made', name: '礼盒', code: 'LH' })).id, brandId: (await svc.create(boss, 'finance-brands', { name: '测试牌' })).id, specQty: 1, specUnit: 'BOX', freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' });
    ids.box = box.id;
    const comp = await mkProduct({ name: '无重量苹果', weightManual: true, weightG: 0, zeroValueReason: '' });
    await svc.create(boss, 'finance-product-boms', { productId: box.id, componentId: comp.id, qty: 1 });
    const boxBc = await svc.create(boss, 'finance-base-codes', { productId: box.id });
    ids.boxBc = boxBc.id;
    const rep = await bc.report(boss, boxBc.id);
    expect(rep.issueCount).toBeGreaterThan(0);
    const g = rep.issues.find((x) => x.archiveName === '无重量苹果');
    expect(g?.parentPath).toEqual(['苹果礼盒']);
    expect(g?.productId).toBe(comp.id);
    const r = await bc.verify(boss, [{ id: boxBc.id, signature: rep.signature }], { confirmed: true, syncToJst: false });
    expect(r.failed).toBe(1);
  });

  it('批量验证：必须勾选已核对；核对后资料变了要拒绝；通过后记录快照，下级档案一变就“需重新验证”并给出差异', async () => {
    const rep = await bc.report(boss, ids.c1);
    expect(rep.issueCount).toBe(0);
    expect(rep.outbound.values.sku_id).toBe('SG-PG-HFS-1KG');
    await expect(bc.verify(boss, [{ id: ids.c1, signature: rep.signature }], { confirmed: false, syncToJst: false })).rejects.toThrow(/已核对/);
    await expect(bc.verify(ops, [{ id: ids.c1, signature: rep.signature }], { confirmed: true, syncToJst: true })).rejects.toThrow(/管理员/);
    await svc.update(boss, 'finance-products', ids.p1, { freight: 120 });
    const stale = await bc.verify(boss, [{ id: ids.c1, signature: rep.signature }], { confirmed: true, syncToJst: false });
    expect(stale.results[0].error).toMatch(/又变了/);
    const fresh = await bc.report(boss, ids.c1);
    const ok = await bc.verify(boss, [{ id: ids.c1, signature: fresh.signature, uploadSignature: fresh.uploadSignature }], { confirmed: true, syncToJst: true });
    expect(ok.verified).toBe(1);
    expect(ok.results[0].queued).toBe(true);
    const v = await svc.get(boss, 'finance-base-codes', ids.c1);
    expect(v.status).toBe('verified');
    expect(String(v.data.snapshot)).toContain('红富士');
    // 不是运营能看到的：快照字段属于成本权限
    expect((await svc.get(ops, 'finance-base-codes', ids.c1)).data.snapshot).toBeUndefined();
    // 改成本：重新验证，二次验证有差异；没有成本权限的人看不到成本差异
    await svc.update(boss, 'finance-products', ids.p1, { purchasePrice: 1300 });
    expect((await svc.get(boss, 'finance-base-codes', ids.c1)).status).toBe('reverify');
    const second = await bc.report(boss, ids.c1);
    expect(second.secondVerification).toBe(true);
    expect(second.changes.some((c) => c.field === 'purchasePrice')).toBe(true);
    const opsView = await bc.report({ ...ops, permissions: { isCompanyAdmin: false, allow: ['resource.finance-base-codes.*'], deny: [] } }, ids.c1);
    expect(opsView.changes.some((c) => c.field === 'purchasePrice' || c.field === 'totalCost')).toBe(false);
    expect(opsView.outbound.values).not.toHaveProperty('cost_price');
    // 改名称也会让已验证的基础编码重新验证
    await bc.verify(boss, [{ id: ids.c1, signature: second.signature }], { confirmed: true, syncToJst: false });
    expect((await svc.get(boss, 'finance-base-codes', ids.c1)).status).toBe('verified');
    await svc.update(boss, 'finance-base-codes', ids.c1, { shortName: '红富士简称' });
    expect((await svc.get(boss, 'finance-base-codes', ids.c1)).status).toBe('reverify');
    const again = await bc.report(boss, ids.c1);
    await bc.verify(boss, [{ id: ids.c1, signature: again.signature }], { confirmed: true, syncToJst: false });
  });

  it('改码：上传过的编码和现在不同，必须确认旧码已处理才能再次入队', async () => {
    await ds.manager.query("UPDATE resource_records SET data = JSON_SET(data, '$.jstUploadedCode', 'OLD-CODE') WHERE id = ?", [ids.c1]);
    await expect(outbox.enqueue(boss, 'finance-base-codes', [ids.c1])).rejects.toThrow(/不同/);
    const r = await outbox.enqueue(boss, 'finance-base-codes', [ids.c1], { replaceConfirmed: true });
    expect(r.queued).toBe(1);
    const jobs = await outbox.jobs(boss, { page: 1, pageSize: 20, kind: 'base_code_replace' });
    expect(jobs.rows[0].payload).toMatchObject({ oldCode: 'OLD-CODE', sku_id: 'SG-PG-HFS-1KG' });
    const plain = await outbox.jobs({ ...ops, permissions: { isCompanyAdmin: false, allow: ['finance.jst-sync.view'], deny: [] } }, { page: 1, pageSize: 20 });
    expect(JSON.stringify(plain.rows)).not.toContain('cost_price');
  });

  it('删除：未验证未同步的可以直接删（真实编码连同马甲），验证过的不行；来源档案删除后按“来源已删除”处理并排停用任务', async () => {
    const p = await mkProduct({ name: '临时梨', rawFinishedNames: '梨王' });
    const c = await svc.create(boss, 'finance-base-codes', { productId: p.id });
    const pre = await bc.deletionPreview(boss, 'pending', [c.id]);
    expect(pre.groups[0]).toMatchObject({ canDelete: true, aliasCount: 1 });
    await expect(bc.deletionExecute(boss, 'pending', [{ token: pre.groups[0].token, ids: pre.groups[0].ids }], '', false)).rejects.toThrow(/原因/);
    const done = await bc.deletionExecute(boss, 'pending', [{ token: pre.groups[0].token, ids: pre.groups[0].ids }], '建错了', false);
    expect(done.results[0].ok).toBe(true);
    await expect(svc.get(boss, 'finance-base-codes', c.id)).rejects.toThrow();
    const blocked = await bc.deletionPreview(boss, 'pending', [ids.c1]);
    expect(blocked.groups[0].canDelete).toBe(false);

    // 来源已删除
    const p2 = await mkProduct({ name: '临时桃' });
    const c2 = await svc.create(boss, 'finance-base-codes', { productId: p2.id });
    await svc.changeStatus(boss, 'finance-base-codes', c2.id, 'verified');
    await ds.manager.query("UPDATE resource_records SET data = JSON_SET(data, '$.jstUploadedCode', 'TAO-OLD') WHERE id = ?", [c2.id]);
    expect((await bc.deletionPreview(boss, 'source')).groups).toHaveLength(0);
    await svc.changeStatus(boss, 'finance-products', p2.id, 'deleted', '不做了');
    const src = await bc.deletionPreview(boss, 'source');
    expect(src.groups).toHaveLength(1);
    const g = src.groups[0];
    expect(g.everSynced).toBe(true);
    await expect(bc.deletionExecute(boss, 'source', [{ token: g.token, ids: g.ids }], '来源删了', false)).resolves.toMatchObject({ results: [{ ok: false }] });
    const ex = await bc.deletionExecute(boss, 'source', [{ token: g.token, ids: g.ids }], '来源删了', true);
    expect(ex.results[0]).toMatchObject({ ok: true, disableQueued: true });
    expect((await svc.get(boss, 'finance-base-codes', c2.id)).status).toBe('deleted');
    expect((await bc.deletionJobs(boss)).rows).toHaveLength(1);
  });

  it('组合：命名规则（按分类、下级沿用上级）、手改要写原因、批量生成多个平台与四层重复检查', async () => {
    const p = await mkProduct({ name: '红肖梨' });
    const main = await svc.create(boss, 'finance-base-codes', { productId: p.id });
    await svc.changeStatus(boss, 'finance-base-codes', main.id, 'verified');
    const lines = [{ role: 'main', baseCodeId: main.id, qty: 2 }];
    const first = await bt.preview(boss, lines, [{ platformId: ids.tb, scenarioId: ids.std }, { platformId: ids.dy, scenarioId: ids.std }]);
    expect(first.targets.map((t) => t.code)).toEqual([`ZH-TB-${main.data.code}*2`, `ZH-DY-${main.data.code}*2`]);
    await expect(bt.preview(boss, lines, [{ platformId: ids.tb, scenarioId: ids.std }, { platformId: ids.tb, scenarioId: ids.std }])).rejects.toThrow(/不能重复/);

    // 命名规则挂在上级分类，下级沿用；非管理员不能改
    await expect(svc.create(ops, 'finance-bundle-naming-rules', { categoryId: ids.root, prefix: 'ZZ-', codeFields: 'category,platform,baseCode' })).rejects.toThrow();
    await expect(svc.create(boss, 'finance-bundle-naming-rules', { categoryId: ids.root, prefix: 'bad', codeFields: 'platform' })).rejects.toThrow(/前缀/);
    await svc.create(boss, 'finance-bundle-naming-rules', { categoryId: ids.root, prefix: 'ZZ-', namePrefix: '套-', codeFields: 'category,platform,quantity', nameFields: 'name,quantity' });
    const named = await bt.preview(boss, lines, [{ platformId: ids.tb, scenarioId: ids.std }]);
    expect(named.targets[0].code).toBe('ZZ-SG-PG-TB-2');
    expect(named.targets[0].name).toBe('套-红肖梨×2-×2');

    // 聚水潭镜像撞码
    await svc.create(boss, 'finance-jst-skus', { skuId: 'ZZ-SG-PG-DY-2', goodsType: 'combine' });
    const jst = await bt.preview(boss, lines, [{ platformId: ids.tb, scenarioId: ids.std }, { platformId: ids.dy, scenarioId: ids.std }]);
    expect(jst.targets[1].duplicates[0].layer).toBe('jstCombine');
    await expect(bt.generate(boss, lines, [{ platformId: ids.tb, scenarioId: ids.std }, { platformId: ids.dy, scenarioId: ids.std }])).rejects.toThrow(/重复/);
    // 全部失败：一个组合都没有生成
    expect((await svc.list(boss, 'finance-bundles', { pageSize: 50 } as never)).items).toHaveLength(0);
    await svc.create(boss, 'finance-jst-skus', { skuId: 'ZZ-SG-PG-TB-2', goodsType: 'normal' });
    expect((await bt.preview(boss, lines, [{ platformId: ids.tb, scenarioId: ids.std }])).targets[0].duplicates[0].layer).toBe('jstNormal');
    await ds.manager.query("DELETE FROM resource_records WHERE company_id = ? AND type = 'finance-jst-skus'", [boss.companyId]);

    const made = await bt.generate(boss, lines, [{ platformId: ids.tb, scenarioId: ids.std }, { platformId: ids.dy, scenarioId: ids.std }]);
    expect(made.created.map((c) => c.code)).toEqual(['ZZ-SG-PG-TB-2', 'ZZ-SG-PG-DY-2']);
    ids.b1 = made.created[0].id;
    ids.b2 = made.created[1].id;
    // 同构成同平台同场景：复用
    const again = await bt.generate(boss, lines, [{ platformId: ids.tb, scenarioId: ids.std }]);
    expect(again.created[0]).toMatchObject({ id: ids.b1, reused: true });

    await expect(svc.update(boss, 'finance-bundles', ids.b1, { manualCode: 'MY-CODE' })).rejects.toThrow(/原因/);
    const manual = await svc.update(boss, 'finance-bundles', ids.b1, { manualCode: 'MY-CODE', manualReason: '客户指定' });
    expect(manual.data.code).toBe('MY-CODE');
    await svc.update(boss, 'finance-bundles', ids.b1, { manualCode: '', manualReason: '' });
    expect((await svc.get(boss, 'finance-bundles', ids.b1)).data.code).toBe('ZZ-SG-PG-TB-2');
    ids.main = main.id;
  });

  it('组合验证：核对报告、验证入队；构成修订只能改主品、需原因、随验证发布，过期的修订要拒绝', async () => {
    const rep = await bt.report(boss, ids.b1);
    expect(rep.components[0]).toMatchObject({ qty: 2 });
    const v = await bt.verify(boss, [{ id: ids.b1, signature: rep.signature, uploadSignature: rep.uploadSignature }], { confirmed: true, syncToJst: true });
    expect(v.verified).toBe(1);
    expect((await svc.get(boss, 'finance-bundles', ids.b1)).status).toBe('verified');

    const other = await mkProduct({ name: '砂糖橘' });
    const o = await svc.create(boss, 'finance-base-codes', { productId: other.id });
    await svc.changeStatus(boss, 'finance-base-codes', o.id, 'verified');
    const gift = await svc.create(boss, 'finance-base-codes', { productId: (await mkProduct({ name: '赠品梨' })).id });
    await svc.changeStatus(boss, 'finance-base-codes', gift.id, 'verified');

    const newLines = [{ role: 'main', baseCodeId: ids.main, qty: 3 }];
    await expect(bt.createRevision(boss, ids.b1, '', newLines)).rejects.toThrow();
    await expect(bt.createRevision(boss, ids.b1, '加量', [...newLines, { role: 'gift', baseCodeId: gift.id, qty: 1 }])).rejects.toThrow(/赠品/);
    const r = await bt.createRevision(boss, ids.b1, '主品加到 3 件', newLines);
    expect(r.id).toBeGreaterThan(0);
    const cur = await svc.get(boss, 'finance-bundles', ids.b1);
    expect(cur.status).toBe('reverify');
    expect(cur.data.pendingRevisionId).toBe(r.id);
    await expect(bt.createRevision(boss, ids.b1, '再来一份', newLines)).rejects.toThrow(/已经有一份/);
    // 取消需要原因，取消后可以重新提交
    await expect(bt.cancelRevision(boss, ids.b1, '')).rejects.toThrow(/原因/);
    await bt.cancelRevision(boss, ids.b1, '写错了');
    expect((await svc.get(boss, 'finance-bundles', ids.b1)).data.pendingRevisionId).toBeUndefined();
    const r2 = await bt.createRevision(boss, ids.b1, '主品加到 3 件', newLines);
    // 修订发布前，直接改构成会让修订过期
    const line = (await svc.list(boss, 'finance-bundle-lines', { pageSize: 50 } as never)).items.find((x: { data: Record<string, unknown> }) => x.data.bundleId === ids.b1);
    await svc.update(boss, 'finance-bundle-lines', line!.id, { qty: 5 });
    const rep2 = await bt.report(boss, ids.b1);
    const stale = await bt.verify(boss, [{ id: ids.b1, signature: rep2.signature }], { confirmed: true, syncToJst: false });
    expect(stale.results[0].error).toMatch(/又被改过/);
    await bt.cancelRevision(boss, ids.b1, '作废');
    void r2;
    const r3 = await bt.createRevision(boss, ids.b1, '主品改 3 件', newLines);
    const rep3 = await bt.report(boss, ids.b1);
    expect(rep3.pendingRevision?.id).toBe(r3.id);
    const done = await bt.verify(boss, [{ id: ids.b1, signature: rep3.signature }], { confirmed: true, syncToJst: false });
    expect(done.verified).toBe(1);
    const after = await svc.get(boss, 'finance-bundles', ids.b1);
    expect(after.status).toBe('verified');
    expect(after.data.pendingRevisionId).toBeUndefined();
    expect(after.data.code).toBe('ZZ-SG-PG-TB-3');
    expect((await svc.get(boss, 'finance-bundle-revisions', r3.id)).status).toBe('published');
  });

  it('组合删除与归档：未验证的凭编码确认可删；验证过的只能归档，上传过聚水潭的要确认并入停用队列', async () => {
    const pre = await bt.deletionPreview(boss, ids.b2);
    expect(pre.canDelete).toBe(true);
    await expect(bt.deletionExecute(boss, ids.b2, pre.token, 'WRONG', '不要了')).rejects.toThrow(/完整输入/);
    await bt.deletionExecute(boss, ids.b2, pre.token, pre.code, '不要了');
    await expect(svc.get(boss, 'finance-bundles', ids.b2)).rejects.toThrow();
    expect((await bt.deletionPreview(boss, ids.b1)).canDelete).toBe(false);
    await expect(bt.archive(boss, ids.b1, '', false)).rejects.toThrow(/原因/);
    await ds.manager.query("UPDATE resource_records SET data = JSON_SET(data, '$.jstUploadedCode', 'OLD-B') WHERE id = ?", [ids.b1]);
    await expect(bt.archive(boss, ids.b1, '停售', false)).rejects.toThrow(/停用/);
    await expect(bt.archive(ops, ids.b1, '停售', true)).rejects.toThrow(/管理员/);
    const r = await bt.archive(boss, ids.b1, '停售', true);
    expect(r.disableQueued).toBe(true);
    expect((await svc.get(boss, 'finance-bundles', ids.b1)).status).toBe('archived');
    const jobs = await outbox.jobs(boss, { page: 1, pageSize: 20, kind: 'bundle_disable' });
    expect(jobs.rows).toHaveLength(1);
  });

  it('资料维护：普通商品上传服务端校验必填项和重复，只加入出站队列，上传记录不带成本价', async () => {
    const form = { skuId: 'NEW-SKU-1', styleId: 'NEW-STYLE', name: '手工商品', shortName: '手工', propertiesValue: '红色;100g', categoryName: '水果/苹果类', brand: '测试牌', costPrice: 12.5, purchasePrice: 10, weight: 0.5, unit: '个' };
    await expect(jm.upload(boss, { ...form, brand: '', weight: undefined })).rejects.toThrow(/品牌、重量/);
    await expect(jm.upload(boss, { ...form, costPrice: -1 })).rejects.toThrow(/数字/);
    const opts = await jm.options(boss);
    expect(opts.categories).toContain('水果/苹果类');
    // 款式编码重复只是提醒；商品编码重复不让传
    await svc.create(boss, 'finance-jst-skus', { skuId: 'EXIST-1', goodsType: 'normal', styleId: 'NEW-STYLE', name: '别的商品' });
    const dup = await jm.checkDuplicate(boss, { skuId: 'exist-1', styleId: 'NEW-STYLE', name: '手工商品' });
    expect(dup.hasHighRisk).toBe(true);
    expect(dup.matches.some((m) => m.field === 'styleId' && m.level === 'warning')).toBe(true);
    await expect(jm.upload(boss, { ...form, skuId: 'EXIST-1' })).rejects.toThrow(/已经存在/);
    await expect(jm.upload(ops, form)).rejects.toThrow(/管理员/);
    const r = await jm.upload(boss, form);
    expect(r.queued).toBe(true);
    expect(r.warnings).toHaveLength(1);
    const logs = await jm.logs(boss, { page: 1, pageSize: 10, keyword: 'NEW-SKU' });
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({ skuId: 'NEW-SKU-1', status: 'queued' });
    expect(JSON.stringify(logs)).not.toContain('12.5');
    const jobs = await outbox.jobs(boss, { page: 1, pageSize: 10, kind: 'normal_product' });
    expect(jobs.rows).toHaveLength(1);
    const plain = await outbox.jobs({ ...ops, permissions: { isCompanyAdmin: false, allow: ['finance.jst-sync.view'], deny: [] } }, { page: 1, pageSize: 10, kind: 'normal_product' });
    expect(JSON.stringify(plain.rows)).not.toContain('12.5');
  });

  it('同步清单：已验证的编码对照上次上传内容列差异，给出状态和同步记录，没有成本权限的看不到成本', async () => {
    const list = await outbox.items(boss, { type: 'finance-base-codes', page: 1, pageSize: 20 });
    const row = list.rows.find((r) => r.id === ids.c1)!;
    expect(row.state).toBe('queued');
    expect(row.records.length).toBeGreaterThan(0);
    expect(row.replacing).toBe(true);
    expect(row.current).toHaveProperty('cost_price');
    const plain = await outbox.items({ ...ops, permissions: { isCompanyAdmin: false, allow: ['finance.jst-sync.view'], deny: [] } }, { type: 'finance-base-codes', page: 1, pageSize: 20 });
    expect(JSON.stringify(plain)).not.toContain('cost_price');
    // 发送成功后：和上次上传一致就是已同步；资料再变就出现差异
    outbox.setSender({ configured: true, send: async () => undefined });
    await outbox.setSwitch(boss, true);
    await outbox.processCompany(boss.companyId);
    const synced = (await outbox.items(boss, { type: 'finance-base-codes', page: 1, pageSize: 20 })).rows.find((r) => r.id === ids.c1)!;
    expect(synced.state).toBe('synced');
    expect(synced.uploadedCode).toBe('SG-PG-HFS-1KG');
    expect(synced.replacing).toBe(false);
    await svc.update(boss, 'finance-products', ids.p1, { purchasePrice: 1500 });
    await svc.update(boss, 'finance-base-codes', ids.c1, { shortName: '变了' });
    const again = await bc.report(boss, ids.c1);
    await bc.verify(boss, [{ id: ids.c1, signature: again.signature }], { confirmed: true, syncToJst: false });
    const changed = (await outbox.items(boss, { type: 'finance-base-codes', page: 1, pageSize: 20 })).rows.find((r) => r.id === ids.c1)!;
    expect(changed.diff.map((d) => d.field)).toEqual(expect.arrayContaining(['short_name', 'cost_price']));
    await outbox.setSwitch(boss, false);
  });
});

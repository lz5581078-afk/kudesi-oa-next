/** 分类拖拽排序、改命名规则后按新规则批量重生成编码（预览→写原因→确认）。 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, ResourceRecord, ResourceChangeLog, ResourceLink, User } from '../entities';
import { buildServices } from '../test-support';
import { OutboxService } from '../outbox/outbox.service';
import { BundleToolsService } from './bundle-tools.service';
import { CategoryToolsService } from './category-tools.service';
import { ResourcesService } from './resources.service';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('分类排序与批量重生成编码（真实数据库）', () => {
  let ds: DataSource;
  let svc: ResourcesService;
  let tools: BundleToolsService;
  let cats: CategoryToolsService;
  let boss: AuthUser;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    svc = s.resources;
    tools = new BundleToolsService(ds, svc, new OutboxService(ds, svc));
    cats = new CategoryToolsService(ds, svc);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `r${crypto.randomBytes(5).toString('hex')}`, name: '重生成', status: 'active' }));
    const u = await ds.manager.save(User, ds.manager.create(User, { companyId: c.id, account: 'admin', passwordHash: 'x', name: '老板', isCompanyAdmin: true, status: 'active', mustChangePassword: false }));
    boss = { id: u.id, companyId: c.id, name: '老板', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    ids.root = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '水果', code: 'SG' })).id;
    const leaf = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: '苹果类', code: 'PG', parentId: ids.root })).id;
    const p = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '苹果', categoryId: leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无' });
    const bc = await svc.create(boss, 'finance-base-codes', { productId: p.id, code: 'APPLE-A', codeChangeReason: '测试' });
    await svc.changeStatus(boss, 'finance-base-codes', bc.id, 'verified');
    ids.bc = bc.id;
    ids.scen = (await svc.create(boss, 'finance-scenarios', { code: 'standard', name: '标准', segment: '' })).id;
    ids.bcat = (await svc.create(boss, 'finance-categories', { archiveType: 'bundle', name: '水果组合', code: 'SGZH' })).id;
    ids.leaf = leaf;
  });
  afterAll(async () => { await ds?.destroy(); });

  it('拖拽排序：同一上级下重排，只改顺序；跨上级、跨树、重复都拒绝；被隐藏的兄弟不动', async () => {
    const a = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: 'A类', code: 'AA', parentId: ids.root })).id;
    const b = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: 'B类', code: 'BB', parentId: ids.root })).id;
    const c = (await svc.create(boss, 'finance-categories', { archiveType: 'raw', name: 'C类', code: 'CC', parentId: ids.root })).id;
    const sortOf = async (id: number) => Number((await svc.get(boss, 'finance-categories', id)).data.sort ?? 0);
    const order = async () => (await Promise.all([ids.leaf, a, b, c].map(async (id) => ({ id, s: await sortOf(id) })))).sort((x, y) => x.s - y.s || x.id - y.id).map((x) => x.id);
    await cats.reorder(boss, [c, b, a]);
    expect((await order()).slice(-3)).toEqual([c, b, a]);
    // 只传两个：它们占住原来的位置，没传的苹果类不动
    const before = await order();
    await cats.reorder(boss, [a, c]);
    const after = await order();
    expect(after.indexOf(a)).toBeLessThan(after.indexOf(c));
    expect(after.indexOf(ids.leaf)).toBe(before.indexOf(ids.leaf));
    await expect(cats.reorder(boss, [a, ids.root])).rejects.toThrow(/同一个上级/);
    await expect(cats.reorder(boss, [a, ids.bcat])).rejects.toThrow(/同一个上级/);
    await expect(cats.reorder(boss, [a, a])).rejects.toThrow(/重复/);
    await expect(cats.reorder(boss, [a, 99999999])).rejects.toThrow(/不存在/);
    // 分类目录接口按新顺序给出
    const tree = await cats.tree(boss, 'raw');
    const kids = tree.nodes.filter((n) => n.parentId === ids.root).map((n) => n.id);
    expect(kids.indexOf(a)).toBeLessThan(kids.indexOf(c));
  });

  it('改了命名规则：预览列出新旧编码；必须写原因并确认；预览后规则又变了拒绝；已验证的变成需重新验证', async () => {
    const made = await tools.generate(boss, [{ role: 'main', baseCodeId: ids.bc, qty: 2 }], []).catch(() => null);
    expect(made).toBeNull(); // 没有目标不能生成
    const plat = await svc.create(boss, 'finance-platforms', { code: 'TB', name: '淘宝' });
    const gen = await tools.generate(boss, [{ role: 'main', baseCodeId: ids.bc, qty: 2 }], [{ platformId: plat.id, scenarioId: ids.scen, bundleCategoryId: ids.bcat }]);
    const bundleId = gen.created[0].id;
    await svc.changeStatus(boss, 'finance-bundles', bundleId, 'verified');
    const oldCode = String((await svc.get(boss, 'finance-bundles', bundleId)).data.code);
    expect((await tools.regeneratePreview(boss)).rows).toHaveLength(0); // 规则没变，没有差异
    await svc.create(boss, 'finance-bundle-naming-rules', { categoryId: ids.root, prefix: 'QQ-', namePrefix: '套-', codeFields: 'category,platform,quantity', nameFields: 'name,quantity' });
    const pv = await tools.regeneratePreview(boss);
    expect(pv.rows).toHaveLength(1);
    expect(pv.rows[0]).toMatchObject({ id: bundleId, oldCode, blocked: null, error: null });
    expect(pv.rows[0].newCode.startsWith('QQ-')).toBe(true);
    // 预览不改任何东西
    expect(String((await svc.get(boss, 'finance-bundles', bundleId)).data.code)).toBe(oldCode);
    await expect(tools.regenerateExecute(boss, [{ id: bundleId, token: pv.rows[0].token }], '', true)).rejects.toThrow(/原因/);
    await expect(tools.regenerateExecute(boss, [{ id: bundleId, token: pv.rows[0].token }], '规则调整', false)).rejects.toThrow(/确认/);
    const stale = await tools.regenerateExecute(boss, [{ id: bundleId, token: 'old' }], '规则调整', true);
    expect(stale.results[0]).toMatchObject({ ok: false });
    const done = await tools.regenerateExecute(boss, [{ id: bundleId, token: pv.rows[0].token }], '规则调整', true);
    expect(done.done).toBe(1);
    const after = await svc.get(boss, 'finance-bundles', bundleId);
    expect(after.data.code).toBe(pv.rows[0].newCode);
    expect(after.status).toBe('reverify');
    expect((await tools.regeneratePreview(boss)).rows).toHaveLength(0);
  });

  it('原新建字段款式/规格/计量单位/精确手工重量经过预览、统一保存和重算完整保留',async()=>{
    const platform=await svc.create(boss,'finance-platforms',{code:'GENPRO',name:'合成原表单平台'});
    const lines=[{role:'main',baseCodeId:ids.bc,qty:3}],target={platformId:platform.id,scenarioId:ids.scen,bundleCategoryId:ids.bcat,manualCode:'GEN-PROFILE-3',manualStyleCode:'GEN-STYLE+ZP-G*1',manualName:'合成手填名称',manualShortName:'合成简称',manualPropertiesValue:'合成自定规格',manualReason:'新建时人工修改',baseUnit:'组合件',weightMode:'manual' as const,manualWeightG:2345.678901,overrideReason:'合成实测总重量'};
    const preview=await tools.preview(boss,lines,[target]);expect(preview.targets[0]).toMatchObject({styleCode:target.manualStyleCode,mainStyleCode:'GEN-STYLE',propertiesValue:target.manualPropertiesValue,baseUnit:target.baseUnit,weightG:target.manualWeightG});
    const made=await tools.generate(boss,lines,[target]);const row=await svc.get(boss,'finance-bundles',made.created[0].id);expect(row.data).toMatchObject({manualStyleCode:target.manualStyleCode,styleCode:target.manualStyleCode,mainStyleCode:'GEN-STYLE',manualPropertiesValue:target.manualPropertiesValue,propertiesValue:target.manualPropertiesValue,baseUnit:'组合件',weightMode:'manual',manualWeightG:2345.678901,overrideReason:target.overrideReason});
    const changed=await tools.preview(boss,lines,[{...target,manualWeightG:2346}]);expect(changed.targets[0].reuse).toBeNull();expect(changed.targets[0].ok).toBe(false);expect((await svc.get(boss,'finance-bundles',row.id)).data.manualWeightG).toBe(target.manualWeightG);
    const viewer={...boss,permissions:{isCompanyAdmin:false,allow:['resource.finance-bundles.create'],deny:[]}};
    await expect(tools.preview(viewer,lines,[target])).rejects.toMatchObject({status:403});
    const automatic=await tools.preview(viewer,lines,[{platformId:platform.id,scenarioId:ids.scen,bundleCategoryId:ids.bcat}]);expect(automatic.targets[0]).not.toHaveProperty('cost');
    for(const patch of [{manualWeightG:1.1234567},{manualWeightG:0},{manualWeightG:1_000_000_001},{overrideReason:''}])await expect(tools.preview(boss,lines,[{...target,...patch}])).rejects.toThrow();
  });
  it('多平台最后一项失败时新字段、主档、BOM和日志全部回滚',async()=>{
    const platforms=await Promise.all(['GFA','GFB'].map(code=>svc.create(boss,'finance-platforms',{code,name:'合成原子平台'+code}))),lines=[{role:'main',baseCodeId:ids.bc,qty:7}];
    const targets=platforms.map((platform,i)=>({platformId:platform.id,scenarioId:ids.scen,bundleCategoryId:ids.bcat,manualCode:'GEN-ATOMIC-'+i,manualStyleCode:'GEN-ATOMIC-STYLE-'+i,manualPropertiesValue:'真实规格',manualReason:'新建时人工修改',baseUnit:'组合件',weightMode:'manual' as const,manualWeightG:4567.123456,overrideReason:'合成称重'}));
    const records=await ds.manager.count(ResourceRecord,{where:{companyId:boss.companyId}}),logs=await ds.manager.count(ResourceChangeLog,{where:{companyId:boss.companyId}}),save=svc.createRecord.bind(svc);let count=0;
    const spy=jest.spyOn(svc,'createRecord').mockImplementation(async(...args)=>{if(args[2]==='finance-bundles'&&++count===2)throw new Error('合成最后平台失败');return save(...args);});
    try{await expect(tools.generate(boss,lines,targets)).rejects.toThrow(/最后平台失败/);}finally{spy.mockRestore();}
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:boss.companyId}})).toBe(records);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:boss.companyId}})).toBe(logs);
  });

  it('跨平台复用固定服务器源BOM/版本，客户端伪造行不会替换来源，保留已存手工重量且源变动拒绝',async()=>{
    const source=(await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId,type:'finance-bundles'}})).find(row=>row.data.manualCode==='GEN-PROFILE-3')!;
    const context=await tools.composition(boss,source.id),platform=await svc.create(boss,'finance-platforms',{name:'可信跨平台目标',code:'TRREUSE'}),target={platformId:platform.id,scenarioId:ids.scen,sourceBundleId:source.id,sourceToken:context.sourceToken};
    const made=await tools.generate(boss,[{role:'main',baseCodeId:999999999,qty:999}],[target]),copy=await svc.get(boss,'finance-bundles',made.created[0].id),copiedLines=await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId,type:'finance-bundle-lines'}});
    expect(copiedLines.filter(row=>row.data.bundleId===copy.id).map(row=>[row.data.baseCodeId,row.data.qty])).toEqual([[ids.bc,3]]);expect(copy.data).toMatchObject({manualWeightG:source.data.manualWeightG,weightMode:'manual',manualPropertiesValue:source.data.manualPropertiesValue,baseUnit:source.data.baseUnit});
    const sourceFresh=await svc.get(boss,'finance-bundles',source.id);expect(copy.data.bomVersionId).toBe(sourceFresh.data.bomVersionId);expect(copy.data.bomDefinitionKey).toBe(sourceFresh.data.bomDefinitionKey);expect((await tools.bomVersions(boss,copy.id)).rows.map(row=>row.id)).toEqual((await tools.bomVersions(boss,source.id)).rows.map(row=>row.id));
    await svc.update(boss,'finance-bundles',source.id,{manualShortName:'已变更源简称',manualReason:'合成源后续变化'});await expect(tools.generate(boss,[{role:'main',baseCodeId:ids.bc,qty:999}],[target])).rejects.toMatchObject({status:409});
    const foreign={...boss,companyId:boss.companyId+10000000};await expect(tools.preview(foreign,[{role:'main',baseCodeId:ids.bc,qty:999}],[target])).rejects.toMatchObject({status:404});
  });

  it('真实独立编码分类缺配置阻止新建；父级规则继承、子级覆盖和删除后继承，不重写既有组合',async()=>{
    const root=await svc.create(boss,'finance-code-dictionaries',{kind:'product_category',name:'合成命名来源根'}),child=await svc.create(boss,'finance-code-dictionaries',{kind:'product_category',name:'合成命名来源叶',parentId:root.id});
    const oldBase=await svc.get(boss,'finance-base-codes',ids.bc),oldProduct=await svc.get(boss,'finance-products',Number(oldBase.data.productId));
    const ownArchiveCategory=await svc.create(boss,'finance-categories',{archiveType:'raw',name:'合成命名原料归属',code:'NAMERAW'});
    const product=await svc.create(boss,'finance-products',{...oldProduct.data,categoryId:ownArchiveCategory.id,code:undefined,name:'合成独立命名主品'}),sourceBase=await svc.create(boss,'finance-base-codes',{productId:product.id,code:'NMSRC',codeChangeReason:'合成原场景',codeDictionaryCategoryId:child.id});ids.namingBase=sourceBase.id;await svc.changeStatus(boss,'finance-base-codes',sourceBase.id,'verified');
    const platform=await svc.create(boss,'finance-platforms',{code:'NRULE',name:'合成来源命名平台'}),lines=[{role:'main',baseCodeId:ids.namingBase,qty:9}],target={platformId:platform.id,scenarioId:ids.scen,bundleCategoryId:ids.bcat};
    await expect(tools.preview(boss,lines,[target])).rejects.toThrow(/未配置/);
    const legacyRows=await ds.manager.find(ResourceRecord,{where:{companyId:boss.companyId,type:'finance-bundles'}}),legacy=legacyRows.map(row=>[row.id,row.data.code,row.data.name]);
    const rule=await svc.create(boss,'finance-bundle-naming-rules',{codeDictionaryCategoryId:root.id,scopeKey:'cat:forged',prefix:'SOURCE-',namePrefix:'来源规则-',codeFields:'baseCode',nameFields:'name'});expect(rule.data.scopeKey).toBe('code-cat:'+root.id);
    const parentPreview=await tools.preview(boss,lines,[target]);expect(parentPreview.targets[0].code).toMatch(/^SOURCE-/);
    const made=await tools.generate(boss,lines,[target]);expect((await svc.get(boss,'finance-bundles',made.created[0].id)).data.code).toBe(parentPreview.targets[0].code);
    for(const [id,code,name] of legacy)expect((await svc.get(boss,'finance-bundles',Number(id))).data).toMatchObject({code,name});
    const own=await svc.create(boss,'finance-bundle-naming-rules',{codeDictionaryCategoryId:child.id,prefix:'CHILD-',namePrefix:'子级规则-',codeFields:'baseCode',nameFields:'name'});expect((await tools.preview(boss,[{...lines[0],qty:10}],[target])).targets[0].code).toMatch(/^CHILD-/);await svc.remove(boss,'finance-bundle-naming-rules',own.id,'取消本级配置');expect((await tools.preview(boss,[{...lines[0],qty:10}],[target])).targets[0].code).toMatch(/^SOURCE-/);
  });
  it('每个明确来源均查配置，赠品走自己的真实规则且不需要旧简称；多个主品前缀冲突拒绝',async()=>{
    const platform=await svc.create(boss,'finance-platforms',{name:'逐来源规则平台',code:'MULTI'}),target={platformId:platform.id,scenarioId:ids.scen,bundleCategoryId:ids.bcat},lines=[{role:'main',baseCodeId:ids.namingBase,qty:2},{role:'gift',baseCodeId:ids.namingBase,qty:1}];
    const checked=await tools.preview(boss,lines,[target]);expect(checked.targets[0].ok).toBe(true);expect(checked.targets[0].code).toContain('+ZP-NMSRC');const made=await tools.generate(boss,lines,[target]);expect((await svc.get(boss,'finance-bundles',made.created[0].id)).data.code).toBe(checked.targets[0].code);
    const old=await svc.get(boss,'finance-base-codes',ids.namingBase),product=await svc.get(boss,'finance-products',Number(old.data.productId)),cat=await svc.create(boss,'finance-code-dictionaries',{kind:'product_category',name:'第二独立命名来源'}),archive=await svc.create(boss,'finance-categories',{archiveType:'raw',name:'第二命名原料类',code:'NMR2'}),nextProduct=await svc.create(boss,'finance-products',{...product.data,code:undefined,categoryId:archive.id,name:'合成第二主品'}),next=await svc.create(boss,'finance-base-codes',{productId:nextProduct.id,code:'SECOND',codeChangeReason:'合成逐来源',codeDictionaryCategoryId:cat.id});await svc.changeStatus(boss,'finance-base-codes',next.id,'verified');
    await expect(tools.preview(boss,[...lines,{role:'main',baseCodeId:next.id,qty:1}],[target])).rejects.toThrow(/来源类目及上级未配置/);
    await svc.create(boss,'finance-bundle-naming-rules',{codeDictionaryCategoryId:cat.id,prefix:'OTHER-',namePrefix:'另一前缀-',codeFields:'baseCode',nameFields:'name'});const bad=await tools.preview(boss,[...lines,{role:'main',baseCodeId:next.id,qty:1}],[target]);expect(bad.targets[0].ok).toBe(false);expect(bad.targets[0].errors.join('；')).toContain('前缀不一致');
  });

  it('命名来源互斥、同公司/种类权限验证；没有独立分类的旧档案规则仍可预览',async()=>{
    const base=await svc.get(boss,'finance-base-codes',ids.namingBase),category=Number(base.data.codeDictionaryCategoryId);
    const sample=await tools.namingSample(boss,ids.namingBase,2.123456);expect(sample.input.mains[0].qty).toBe(2.123456);expect(JSON.stringify(sample)).not.toMatch(/unitPrice|purchasePrice|externalCost|snapshot|totalCost/);
    await expect(tools.namingSample({...boss,permissions:{isCompanyAdmin:false,allow:['resource.finance-bundles.view'],deny:[]}},ids.namingBase,1)).rejects.toMatchObject({status:403});await expect(tools.namingSample(boss,ids.namingBase,1.1234567)).rejects.toMatchObject({status:400});

    await expect(svc.create(boss,'finance-bundle-naming-rules',{categoryId:ids.root,codeDictionaryCategoryId:category,prefix:'BAD-'})).rejects.toThrow(/一种/);
    const company=await ds.manager.save(Company,ds.manager.create(Company,{name:'合成命名外公司',code:crypto.randomBytes(8).toString('hex'),status:'active'})),foreign=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:company.id,type:'finance-code-dictionaries',title:'外公司分类',data:{kind:'product_category',name:'外公司分类',code:'F'},status:'active',createdBy:null,updatedBy:null}));
    await expect(svc.create(boss,'finance-bundle-naming-rules',{codeDictionaryCategoryId:foreign.id,prefix:'BAD-'})).rejects.toThrow(/来源分类|同公司/);
    const variety=await svc.create(boss,'finance-code-dictionaries',{kind:'variety',name:'不能作为命名来源的品种'});await expect(svc.create(boss,'finance-bundle-naming-rules',{codeDictionaryCategoryId:variety.id,prefix:'BAD-'})).rejects.toThrow(/来源分类/);
    const raw=await ds.manager.findOneOrFail(ResourceRecord,{where:{id:ids.namingBase,companyId:boss.companyId}}),data={...raw.data};delete data.codeDictionaryCategoryId;data.code='OLD-LEGACY';const old=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:boss.companyId,type:'finance-base-codes',title:'旧无独立分类',data,status:'verified',createdBy:boss.id,updatedBy:boss.id}));
    const platform=await svc.create(boss,'finance-platforms',{name:'旧规则预览平台',code:'OLDVIEW'});expect((await tools.preview(boss,[{role:'main',baseCodeId:old.id,qty:1}],[{platformId:platform.id,scenarioId:ids.scen,bundleCategoryId:ids.bcat}])).targets).toHaveLength(1);
  });

  it('新建组合时手填编码/名称/简称：必须写原因；手填值进组合并参与重复检查', async () => {
    const plat = await svc.create(boss, 'finance-platforms', { code: 'PDD', name: '拼多多' });
    const lines = [{ role: 'main', baseCodeId: ids.bc, qty: 3 }];
    const base = { platformId: plat.id, scenarioId: ids.scen, bundleCategoryId: ids.bcat };
    await expect(tools.generate(boss, lines, [{ ...base, manualCode: 'my-own-1' }])).rejects.toThrow(/原因/);
    const gen = await tools.generate(boss, lines, [{ ...base, manualCode: 'my-own-1', manualName: '手填名', manualReason: '平台要求' }]);
    const b = await svc.get(boss, 'finance-bundles', gen.created[0].id);
    expect(b.data).toMatchObject({ code: 'MY-OWN-1', name: '手填名', manualCode: 'MY-OWN-1', manualReason: '平台要求' });
    // 同编码再来一次（不同构成）被重复检查拦住
    await expect(tools.generate(boss, [{ role: 'main', baseCodeId: ids.bc, qty: 4 }], [{ ...base, manualCode: 'MY-OWN-1', manualReason: '平台要求' }])).rejects.toThrow(/重复/);
  });

  it('真实编码有马甲：验证通过后列表里隐藏（马甲代表它），没验证的仍然显示；计数一致', async () => {
    const p = await svc.create(boss, 'finance-products', { archiveType: 'raw', name: '红富士', categoryId: ids.leaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000, freight: 0, handlingFee: 0, zeroValueReason: '运费：无\n装卸费：无', rawFinishedNames: '精品红富士' });
    const real = await svc.create(boss, 'finance-base-codes', { productId: p.id });
    const listIds = async (status: string) => (await svc.list(boss, 'finance-base-codes', { status, pageSize: 100, filters: JSON.stringify({ realView: 'foldVerified' }) } as never)).items.map((i: { id: number }) => i.id);
    expect(await listIds('pending')).toContain(real.id);
    await svc.changeStatus(boss, 'finance-base-codes', real.id, 'verified');
    expect(await listIds('verified')).not.toContain(real.id);
    // 不带这个筛选（比如详情、选择器）仍然看得到
    expect((await svc.list(boss, 'finance-base-codes', { status: 'verified', pageSize: 100 } as never)).items.map((i: { id: number }) => i.id)).toContain(real.id);
    const aliases = (await svc.list(boss, 'finance-base-codes', { pageSize: 100 } as never)).items.filter((r: { data: Record<string, unknown> }) => r.data.canonicalId === real.id);
    expect(aliases).toHaveLength(1);
    const ov = await new (await import('./base-code-tools.service')).BaseCodeToolsService(ds, svc, new OutboxService(ds, svc)).overview(boss);
    const byCat = ov.byCategory[String(ids.leaf)] ?? {};
    expect(byCat.verified ?? 0).toBe(1); // 只剩马甲这一条，真实编码不计
  });

  it('商品档案导入：旧系统自由写的单位（公斤、只、斤）对到固定单位；对不上的报错', async () => {
    const row = (name: string, unit: string) => ({ 档案类型: '原料档案', 商品名称: name, 分类: '水果 / 苹果类', 系统规格: '千克', 规格数量: '1', 规格单位: unit, 采购价: '10', 运费: '0', 装卸费: '0', 零值说明: '运费：无\n装卸费：无' });
    const r = await svc.importRows(boss, 'finance-products', [row('导入苹果甲', '公斤'), row('导入苹果乙', '斤'), row('导入苹果丙', '光年')], true);
    const unitErrors = r.results.map((x: { errors: string[] }) => x.errors.filter((e) => e.includes('规格单位')));
    expect(unitErrors[0]).toHaveLength(0);
    expect(unitErrors[1]).toHaveLength(0);
    expect(unitErrors[2].length).toBeGreaterThan(0);
  });
  it('独立BOM草稿沿统一资源保存真实版本，引用/启用锁由服务器重算且成本字段不进入JSON',async()=>{
    const platform=await svc.create(boss,'finance-platforms',{name:'合成BOM草稿平台',code:'BOMDRAFT'}),made=await tools.generate(boss,[{role:'main',baseCodeId:ids.bc,qty:11}],[{platformId:platform.id,scenarioId:ids.scen,bundleCategoryId:ids.bcat}]),bundleId=made.created[0].id;
    const current=(await tools.bomVersions(boss,bundleId)).rows;expect(current).toHaveLength(1);expect(current[0]).toMatchObject({versionNo:'V01',used:true,editable:false});
    const used=await svc.get(boss,'finance-bundle-bom-versions',current[0].id!);
    await expect(svc.update(boss,'finance-bundle-bom-versions',used.id,{remark:'伪造未启用绕过',activatedAt:null})).rejects.toThrow(/引用|使用/);
    const draft=await svc.create(boss,'finance-bundle-bom-versions',{bundleId,versionNo:'V02',activatedAt:'1999-01-01',definitionKey:'别家公司伪造'});
    expect(draft.data).not.toHaveProperty('activatedAt');expect(draft.data.definitionKey).toBe('bundle:'+bundleId);
    let versions=(await tools.bomVersions(boss,bundleId)).rows,editable=versions.find(row=>row.id===draft.id)!;expect(editable).toMatchObject({used:false,editable:true});
    const payload=JSON.stringify({version:1,sourceToken:editable.sourceToken,lines:[{role:'main',baseCodeId:ids.bc,qty:2,unit:'G',includeInJst:true,cost:999999,snapshot:{cost:88888}}]});
    await svc.update(boss,'finance-bundle-bom-versions',draft.id,{payload,remark:'真实未启用版本'});
    const saved=await svc.get(boss,'finance-bundle-bom-versions',draft.id);const savedLine=JSON.parse(String(saved.data.payload)).lines[0];expect(savedLine.unit).toBe('G');expect(savedLine).not.toHaveProperty('cost');expect(savedLine).not.toHaveProperty('snapshot');expect(savedLine).not.toHaveProperty('unitPrice');expect(JSON.parse(String(saved.data.sourceFacts)).lines[0]).toMatchObject({kind:'base',id:ids.bc,code:expect.any(String)});expect(JSON.parse(String(saved.data.sourceFacts)).lines[0]).not.toHaveProperty('cost');expect(JSON.stringify(savedLine)).not.toMatch(/999999|88888/);
    await expect(svc.update(boss,'finance-bundle-bom-versions',draft.id,{payload})).rejects.toThrow(/变化/);
    await svc.changeStatus(boss,'finance-bundle-bom-versions',draft.id,'active');const active=await svc.get(boss,'finance-bundle-bom-versions',draft.id);expect(active.data.activatedAt).toEqual(expect.any(String));expect(active.data.sourceFacts).toBe(saved.data.sourceFacts);
    const overlap=await svc.create(boss,'finance-bundle-bom-versions',{bundleId,versionNo:'V03',copyFromId:draft.id});await expect(svc.changeStatus(boss,'finance-bundle-bom-versions',overlap.id,'active')).rejects.toThrow(/日期范围/);expect((await svc.get(boss,'finance-bundle-bom-versions',overlap.id)).data).not.toHaveProperty('activatedAt');
    await svc.changeStatus(boss,'finance-bundle-bom-versions',draft.id,'inactive');
    await expect(svc.update(boss,'finance-bundle-bom-versions',draft.id,{remark:'停用后假解锁'})).rejects.toThrow(/历史BOM/);
    await expect(svc.remove(boss,'finance-bundle-bom-versions',draft.id,'合成删除')).rejects.toThrow(/不能删除/);
    const foreign={...boss,companyId:boss.companyId+999999};await expect(tools.bomVersions(foreign,bundleId)).rejects.toMatchObject({status:404});
    const viewer={...boss,permissions:{isCompanyAdmin:false,allow:['resource.finance-bundles.view'],deny:['product.cost.view','product.price.view']}};const exposed=await tools.bomVersions(viewer,bundleId);for(const version of exposed.rows)for(const line of version.lines){expect(line).not.toHaveProperty('cost');expect(line).not.toHaveProperty('unitPrice');expect(line).not.toHaveProperty('snapshot');}expect(JSON.stringify(exposed)).not.toMatch(/999999/);
  });
  it('独立BOM同定义版本并发创建仅一条成功，最后保存失败不会留下明细/引用/日志',async()=>{
    const platform=await svc.create(boss,'finance-platforms',{name:'合成BOM并发平台',code:'BOMCONCURRENT'}),made=await tools.generate(boss,[{role:'main',baseCodeId:ids.bc,qty:12}],[{platformId:platform.id,scenarioId:ids.scen,bundleCategoryId:ids.bcat}]),bundleId=made.created[0].id;
    const concurrent=await Promise.allSettled([1,2].map(()=>svc.create(boss,'finance-bundle-bom-versions',{bundleId,versionNo:'V02'})));expect(concurrent.filter(row=>row.status==='fulfilled')).toHaveLength(1);
    const draft=(await tools.bomVersions(boss,bundleId)).rows.find(row=>row.versionNo==='V02')!,before=await svc.get(boss,'finance-bundle-bom-versions',draft.id!),logs=await ds.manager.count(ResourceChangeLog,{where:{companyId:boss.companyId}});
    const payload=JSON.stringify({version:1,sourceToken:draft.sourceToken,lines:[{role:'main',baseCodeId:ids.bc,qty:2},{role:'package',baseCodeId:999999999,qty:1}]});
    await expect(svc.update(boss,'finance-bundle-bom-versions',draft.id!,{payload})).rejects.toThrow();expect(await svc.get(boss,'finance-bundle-bom-versions',draft.id!)).toEqual(before);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:boss.companyId}})).toBe(logs);
    const base=await svc.get(boss,'finance-base-codes',ids.bc),links=await ds.manager.count(ResourceLink,{where:{companyId:boss.companyId}}),insert=EntityManager.prototype.insert;let component=0;
    const spy=jest.spyOn(EntityManager.prototype,'insert').mockImplementation(async function(this:EntityManager,...args:Parameters<EntityManager['insert']>){const value=args[1] as {relation?:string};if(args[0]===ResourceLink&&value.relation?.startsWith('bom.component:')&&++component===2)throw new Error('合成第二个来源引用失败');return insert.apply(this,args);});
    try{const valid=JSON.stringify({version:1,sourceToken:draft.sourceToken,lines:[{role:'main',baseCodeId:ids.bc,qty:2},{role:'package',productId:base.data.productId,qty:1,includeInJst:false}]});await expect(svc.update(boss,'finance-bundle-bom-versions',draft.id!,{payload:valid})).rejects.toThrow(/第二个来源引用失败/);}finally{spy.mockRestore();}
    expect(component).toBe(2);expect(await svc.get(boss,'finance-bundle-bom-versions',draft.id!)).toEqual(before);expect(await ds.manager.count(ResourceLink,{where:{companyId:boss.companyId}})).toBe(links);expect(await ds.manager.count(ResourceChangeLog,{where:{companyId:boss.companyId}})).toBe(logs);

  });

});

import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User, ResourceRecord } from '../entities';
import { buildServices } from '../test-support';
import { runLegacyImport } from './runner';
import { LegacyArchive, legacyRef as ref } from './protocol';
import { verifyPassword } from '../auth/password';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;
d('迁入账本与马甲（隔离MySQL）', () => {
  let ds: DataSource, company: Company, actor: User, svc: ReturnType<typeof buildServices>;
  let source: LegacyArchive;
  const oldFilesRoot=process.env.FILES_LOCAL_ROOT, oldJwtSecret=process.env.JWT_SECRET;
  const fileRoot=mkdtempSync(join(tmpdir(),'migration-files-'));
  const image=Buffer.from([137,80,78,71,13,10,26,10,0]);
  const contentHash=createHash('sha256').update(image).digest('hex');
  beforeAll(async () => {
    process.env.FILES_LOCAL_ROOT=fileRoot;
    process.env.JWT_SECRET='isolated-migration-test-signing-key-32bytes';
    ds = await new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true }).initialize();
    svc = buildServices(ds);
    const tag = randomBytes(6).toString('hex');
    company = await ds.manager.save(Company, ds.manager.create(Company, { code: tag, name: '迁前公司', status: 'active' }));
    actor = await ds.manager.save(User, ds.manager.create(User, { companyId: company.id, account: 'migration-actor-'+tag, name: '管理员', passwordHash: 'x', status: 'active', isCompanyAdmin: true, mustChangePassword: false }));
    const salt = '0123456789abcdef0123456789abcdef';
    source = { company: { id: 99, name: '迁入测试公司' }, departments: [{ id: 1, name: '来源部门', status: 'active' }], positions: [], employees: [
      { id: 1, name: '有账号人员', login_account: 'migration-user-'+tag, role_key:'boss', password_salt: salt, password_hash: scryptSync('original-pass-123',salt,64).toString('hex'), status: 'active', department_id: 1 },
      { id: 2, name: '无账号人员', login_account: null, status: 'inactive', department_id: 1 },
    ], employeePositions: [], positionPermissions: [], exclusions: [], loadFile: async () => image, records: [
      { type:'bank-accounts',id:'bank-a',files:[{field:'attachments',id:'a',name:'a.png',locator:'a',contentHash}],data:{kind:'company_public',accountName:'测试账户',bank:'测试银行',accountNo:'6222000055556666'} },
      { type:'bank-accounts',id:'bank-b',files:[{field:'attachments',id:'b',name:'b.png',locator:'b',contentHash}],data:{kind:'company_public',accountName:'测试账户',bank:'测试银行',accountNo:'6222000055556666',note:'第二条来源备注'} },
      {type:'finance-suppliers',id:'vendor-old',data:{name:'旧来源供应商'}},
      {type:'finance-suppliers',id:'vendor-new',data:{name:'新来源供应商'}},
      {type:'finance-product-sources',id:'2',sourceUpdatedAt:'2026-10-02 10:00:00',data:{productId:ref('finance-products','prod'),supplierId:ref('finance-suppliers','vendor-new'),originArea:'测试产区',purchasePrice:0.75}},
      {type:'finance-product-sources',id:'3',sourceUpdatedAt:'2026-09-30 10:00:00',data:{productId:ref('finance-products','prod'),supplierId:ref('finance-suppliers','vendor-old'),originArea:'测试产区',purchasePrice:0.1}},
      {type:'finance-product-sources',id:'1',sourceUpdatedAt:'2026-10-01 10:00:00',data:{productId:ref('finance-products','prod'),supplierId:ref('finance-suppliers','vendor-old'),originArea:'测试产区',purchasePrice:0.5}},
      { type: 'finance-categories', id: 'cat', data: { archiveType: 'raw', name: '来源原料分类', code: 'YL' } },
      { type: 'finance-products', id: 'prod', data: { archiveType:'raw', name:'真实原料', code:'LEGACY-RAW', categoryId:ref('finance-categories','cat'), specQty:1, specUnit:'J', purchaseSpec:'斤', purchasePrice:100, freight:100, handlingFee:100, rawFinishedNames:'原料马甲' } },
      { type:'finance-base-codes', id:'real', data:{ productId:ref('finance-products','prod'), code:'OLD-BASE', codeChangeReason:'迁移保留旧码' }, status:'pending' },
      { type:'finance-base-codes', id:'alias', data:{ productId:ref('finance-products','prod'), canonicalId:ref('finance-base-codes','real'), code:'YL-AAAAAAAAAAAAAAAAAAAA', name:'原料马甲-1-斤' }, status:'pending', aliasName:'原料马甲' },
      { type:'finance-platforms', id:'platform', data:{ name:'测试平台',code:'CS' } },
      { type:'finance-scenarios', id:'scenario', data:{ name:'测试场景',code:'single',segment:'D' } },
      { type:'finance-bundles', id:'bundle', data:{ platformId:ref('finance-platforms','platform'),scenarioId:ref('finance-scenarios','scenario'),manualCode:'OLD-BUNDLE',manualName:'旧组合名',manualReason:'迁移保留旧组合' },status:'pending' },
      { type:'finance-bundle-lines', id:'line',data:{bundleId:ref('finance-bundles','bundle'),baseCodeId:ref('finance-base-codes','alias'),role:'main',qty:1} },
    ] };
  });
  afterAll(async () => { await ds?.destroy();if(oldFilesRoot===undefined)delete process.env.FILES_LOCAL_ROOT;else process.env.FILES_LOCAL_ROOT=oldFilesRoot;if(oldJwtSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=oldJwtSecret;rmSync(fileRoot,{recursive:true,force:true}); });
  const run = (apply:boolean) => runLegacyImport(ds,svc.resources,svc.files,source,{companyId:company.id,actorId:actor.id,expectedName:'迁前公司',apply});
  it('试跑走真实校验并全部回滚，不增加人员/资料/账本', async () => {
    const before = await ds.manager.count(User,{where:{companyId:company.id}});
    const result = await run(false);
    expect(result.failures).toEqual([]);
    expect(result.created['finance-base-codes']).toBe(2);
    expect(await ds.manager.count(User,{where:{companyId:company.id}})).toBe(before);
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:company.id}})).toBe(0);
    expect((await ds.query('SELECT COUNT(*) n FROM legacy_import_links WHERE company_id=?',[company.id]))[0].n).toBe('0');
  });
  it('保留马甲旧码与组合引用、无账号人员和原密码；重跑无重复', async () => {
    const first = await run(true);
    expect(first.failures).toEqual([]);
    expect(first.created.file).toBe(1);expect(first.reused.file).toBe(1);
    expect(first.mappings.filter(m=>m.type==='file').map(m=>m.targetId)).toEqual([expect.any(Number),first.mappings.find(m=>m.type==='file')!.targetId]);
    const storedBank=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:company.id,type:'bank-accounts'});
    expect(JSON.stringify(storedBank)).not.toContain('6222000055556666');
    expect(storedBank.uniqueKey).toMatch(/^idx1:/);expect(first.created['bank-accounts']).toBe(1);expect(first.reused['bank-accounts']).toBe(1);
    const aliases = (await ds.manager.find(ResourceRecord,{where:{companyId:company.id,type:'finance-base-codes'}})).filter(r=>r.data.canonicalId);
    expect(aliases).toHaveLength(1); expect(aliases[0].data.code).toBe('YL-AAAAAAAAAAAAAAAAAAAA');
    const line = await ds.manager.findOneByOrFail(ResourceRecord,{companyId:company.id,type:'finance-bundle-lines'});
    expect(line.data.baseCodeId).toBe(aliases[0].id);
    const people = await ds.manager.find(User,{where:{companyId:company.id}});
    expect(people.filter(p=>p.account===null)).toHaveLength(1);
    expect(people.find(p=>p.name==='有账号人员')!.isCompanyAdmin).toBe(true);
    expect(people.find(p=>p.name==='无账号人员')!.isCompanyAdmin).toBe(false);
    expect(await verifyPassword('original-pass-123',people.find(p=>p.name==='有账号人员')!.passwordHash)).toBe(true);
    const second = await run(true); expect(second.failures).toEqual([]); expect(second.created).toEqual({});
    // 回归：旧库更新时间必须落库（updated_at 是只读列，曾被“现在”覆盖，同秒并列时靠 id 兜底，跨秒就选错）
    const stamps=await ds.query("select json_unquote(json_extract(data,'$.legacySourceId')) l, updated_at u from resource_records where company_id=? and type='finance-product-sources' order by l",[company.id]);
    expect(stamps.map((x:{l:string;u:Date})=>[x.l,x.u.toISOString()])).toEqual([['1','2026-10-01T02:00:00.000Z'],['2','2026-10-02T02:00:00.000Z'],['3','2026-09-30T02:00:00.000Z']]);
    const prod = await ds.manager.findOneByOrFail(ResourceRecord,{companyId:company.id,type:'finance-products'});
    expect(prod.data.purchasePrice).toBe(0.75);
    expect(prod.data.totalCost).toBe(200.75);
    await svc.resources.update({id:actor.id,companyId:company.id,name:'管理员',permissions:{isCompanyAdmin:true,allow:[],deny:[]}},'finance-products',prod.id,{rawFinishedNames:'原料马甲'});
    const after = await ds.manager.find(ResourceRecord,{where:{companyId:company.id,type:'finance-base-codes'}});
    expect(after.filter(r=>r.data.canonicalId)).toHaveLength(1);
    expect(after.find(r=>r.data.canonicalId)!.data.code).toBe('YL-AAAAAAAAAAAAAAAAAAAA');
    expect(after.find(r=>r.data.canonicalId)!.data.name).toBe('原料马甲-1-斤');
    await ds.manager.update(ResourceRecord,{id:prod.id,companyId:company.id},{data:{...prod.data,totalCost:123.4567}});
    await run(true);
    expect((await ds.manager.findOneByOrFail(ResourceRecord,{id:prod.id,companyId:company.id})).data.totalCost).toBe(123.4567);
  });  it('源资料变化时阻止静默复用，保持已迁入数据',async()=>{
    const before=await ds.manager.count(ResourceRecord,{where:{companyId:company.id}});
    const original=source.employees[0].name;source.employees[0].name='源姓名已变化';
    await expect(run(true)).rejects.toThrow(/来源资料已变化/);
    source.employees[0].name=original;
    expect(await ds.manager.count(ResourceRecord,{where:{companyId:company.id}})).toBe(before);
  });

});

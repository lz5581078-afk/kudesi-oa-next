/** SKU 申请汇总：汇总待办、批量办理、整单退回、个别规格退回并重新提交。RESOURCE_DB_TEST=1 TEST_DB_NAME=xxx npx jest --runInBand sku-batch */
import 'reflect-metadata';
import {ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {APP_GUARD} from '@nestjs/core';
import {PermissionsGuard} from '../common/permissions.guard';
import {FlowController} from './flow.controller';
import {SkuApplyController} from './sku-apply.controller';
import * as crypto from 'crypto';
import { DataSource,EntityManager, In } from 'typeorm';
import {todayInChina} from '@kudesi/shared';
import type { StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { FinanceCostSnapshot,Company,FlowCc,TaskDelayRequest,SupervisionException, FormDraft, FlowDefinition, FlowRun, FlowStep, FlowEvent, WorkItem, OutboxJob, Notification, ResourceRecord, User } from '../entities';
import { FeishuNoticeService } from '../outbox/feishu-notice.service';
import { OutboxService,UnconfiguredSender } from '../outbox/outbox.service';
import {ExternalConfigurationError} from '../integrations/external-configuration-error';
import {FakeJstSender} from '../outbox/fake-jst-sender';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { buildServices } from '../test-support';
import { FlowService } from './flow.service';
import { SkuApplyService } from './sku-apply.service';
import { SkuBatchService } from './sku-batch.service';
import { AuditLog } from '../entities';
import { FormDraftsService } from '../resources/form-drafts.service';
import { FlowApplicationHeaderStore } from './flow-application-header';

const d = process.env.RESOURCE_DB_TEST === '1' ? describe : describe.skip;

d('SKU 申请汇总（真实数据库）', () => {
  let ds: DataSource;
  let flow: FlowService;
  let sku: SkuApplyService;
  let batch: SkuBatchService;
  let feishu: FeishuNoticeService;
  let outbox:OutboxService;
  let ordinaryDrafts:FormDraftsService;
  let resources: ReturnType<typeof buildServices>['resources'];
  let wh2: AuthUser;
  let admin: AuthUser, ops: AuthUser, wh: AuthUser, fin: AuthUser, finNoPerm: AuthUser, stranger: AuthUser, noApply: AuthUser;
  const ids: Record<string, number> = {};
  const key = () => crypto.randomBytes(8).toString('hex') + 'abcd';
  const mkUser = async (companyId: number, account: string, name: string, extra: Partial<User> = {}) =>
    (await ds.manager.save(User, ds.manager.create(User, { companyId, account, passwordHash: 'x', name, status: 'active', mustChangePassword: false, ...extra }))).id;
  const au = (id: number, companyId: number, name: string, allow: string[] = []): AuthUser => ({ id, companyId, name, permissions: { isCompanyAdmin: false, allow, deny: [] } });
  const step = (k: string, name: string, type: StepDef['type'], assigneeId?: number): StepDef =>
    ({ key: k, name, type, ...(type === 'submit' ? { assignee: { source: 'requester' } } : assigneeId ? { assignee: { source: 'employee', id: assigneeId } } : {}) }) as StepDef;

  const spec = (name: string, main: number, over: Record<string, unknown> = {}) => ({ name, main: [{ baseCodeId: main, qty: 2 }], gift: [], ...over });
  const payload = (specs: unknown[], over: Record<string, unknown> = {}) => ({ batchName: '10 月新品', scenarioId: ids.scen, platformIds: [ids.tb, ids.dy], specs, bundleCategoryId: ids.bcat, ...over });
  const whLines = (over: Record<string, unknown> = {}) => ({
    lines: [{ role: 'package', baseCodeId: ids.boxBc, qty: 1 }, { role: 'label', baseCodeId: ids.labelBc, qty: 1 }, { role: 'labor', laborId: ids.labor, qty: 1 }],
    notRequired: { other: '没有其他物料' }, ...over,
  });
  const whPass = (u: AuthUser, run: Awaited<ReturnType<FlowService['start']>>, config: unknown) => flow.pass(u, run.id, { revision: run.revision, stepId: run.activeStep!.id, form: { config } });
  const finPass = (u: AuthUser, run: Awaited<ReturnType<FlowService['start']>>, form: Record<string, unknown> = { confirmed: true }) => flow.pass(u, run.id, { revision: run.revision, stepId: run.activeStep!.id, form });
  const toWarehouse = async (specs: unknown[], over: Record<string, unknown> = {}) => flow.start(ops, 'sku-batch-apply', payload(specs, over), key());
  const toReview = async (specs: unknown[], configs?: unknown[]) => {
    const run = await toWarehouse(specs);
    return whPass(wh, run, configs ?? specs.map(() => whLines()));
  };

  beforeAll(async () => {
    ds = new DataSource({ ...buildDataSourceOptions({ ...process.env, DB_NAME: process.env.TEST_DB_NAME ?? 'kudesi_oa_test' }), migrationsRun: true } as never);
    await ds.initialize();
    const s = buildServices(ds);
    resources = s.resources;ordinaryDrafts=new FormDraftsService(ds,s.crypto);
    outbox = new OutboxService(ds, resources);
    const bundles = new BundleToolsService(ds, resources, outbox);
    feishu = new FeishuNoticeService(ds);
    flow = new FlowService(ds, resources, new FinanceDocumentsService(ds), bundles, outbox, feishu,undefined,s.crypto);
    sku = new SkuApplyService(ds, flow, bundles);
    batch = new SkuBatchService(ds, flow, bundles);
    const c = await ds.manager.save(Company, ds.manager.create(Company, { code: `k${crypto.randomBytes(5).toString('hex')}`, name: 'SKU申请测试', status: 'active' }));
    admin = { id: await mkUser(c.id, 'admin', '管理员', { isCompanyAdmin: true }), companyId: c.id, name: '管理员', permissions: { isCompanyAdmin: true, allow: [], deny: [] } };
    ops = au(await mkUser(c.id, 'ops', '运营'), c.id, '运营', ['flow.apply.view']);
    wh = au(await mkUser(c.id, 'wh', '仓库'), c.id, '仓库');
    wh2 = au(await mkUser(c.id, 'wh2', '仓库二'), c.id, '仓库二');
    fin = au(await mkUser(c.id, 'fin', '财务'), c.id, '财务', ['resource.finance-bundles.create', 'resource.finance-bundles.edit', 'finance.jst-sync.view', 'finance.bundle-sync.manage', 'product.cost.view']);
    finNoPerm = au(await mkUser(c.id, 'fin2', '财务二'), c.id, '财务二');
    stranger = au(await mkUser(c.id, 'str', '路人'), c.id, '路人', ['flow.apply.view']);
    noApply = au(await mkUser(c.id, 'na', '无权限'), c.id, '无权限');

    // ---- 商品资料 ----
    const cat = async (archiveType: string, name: string, code: string) => {
      const root = await resources.create(admin, 'finance-categories', { archiveType, name, code });
      return (await resources.create(admin, 'finance-categories', { archiveType, name: `${name}下级`, code: `${code}1`, parentId: root.id })).id;
    };
    const rawLeaf = await cat('raw', '水果', 'SG');
    const shipLeaf = await cat('shipping_material', '发货物料', 'FH');
    const pkgLeaf = await cat('package', '包装', 'BZ');
    ids.mainBrand=(await resources.create(admin,'finance-brands',{name:'主商品品牌',code:'MAIN'})).id;
    const zero = { zeroValueReason: '运费：无\n装卸费：无' };
    const baseCode = async (productData: Record<string, unknown>, code: string) => {
      const p = await resources.create(admin, 'finance-products', {brandId:ids.mainBrand, ...productData, freight: 0, handlingFee: 0, ...zero });
      const bc = await resources.create(admin, 'finance-base-codes', { productId: p.id, code, codeChangeReason: '测试' });
      await resources.changeStatus(admin, 'finance-base-codes', bc.id, 'verified');
      return bc.id;
    };
    ids.appleBc = await baseCode({ archiveType: 'raw', name: '苹果', categoryId: rawLeaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1000 }, 'APPLE-A');
    ids.mangoBc = await baseCode({ archiveType: 'raw', name: '芒果', categoryId: rawLeaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 2000 }, 'MANGO-A');
    ids.pearBc = await baseCode({ archiveType: 'raw', name: '梨', categoryId: rawLeaf, purchaseSpec: '千克', specQty: 1, specUnit: 'KG', purchasePrice: 1500 }, 'PEAR-A');
    ids.giftBc = await baseCode({ archiveType: 'shipping_material', name: '小赠品', categoryId: shipLeaf, specQty: 1, specUnit: 'PCS', weightManual: true, weightG: 50, purchasePrice: 100 }, 'GIFT-A');
    ids.labelBc = await baseCode({ archiveType: 'shipping_material', name: '标签', categoryId: shipLeaf, specQty: 1, specUnit: 'PCS', weightManual: true, weightG: 1, purchasePrice: 10 }, 'LABEL-A');
    ids.boxBc = await baseCode({ archiveType: 'package', name: '纸箱', categoryId: pkgLeaf, specQty: 1, specUnit: 'PCS', capacities: '5斤', weightManual: true, weightG: 200, purchasePrice: 300 }, 'BOX-A');
    // 人工
    const v = await resources.create(admin, 'finance-labor-versions', { versionCode: 'V1', versionName: '测试版', effectiveFrom: '2026-01-01' });
    const lc = await resources.create(admin, 'finance-labor-categories', { versionId: v.id, name: '车间' });
    const wt = await resources.create(admin, 'finance-labor-work-types', { name: '包装' });
    const unit = await resources.create(admin, 'finance-labor-units', { name: '元/个' });
    ids.labor = (await resources.create(admin, 'finance-labor-costs', { versionId: v.id, workTypeId: wt.id, unitId: unit.id, workName: '装箱', unitPrice: 150, archiveCategoryId: lc.id })).id;
    await resources.changeStatus(admin, 'finance-labor-versions', v.id, 'active');
    ids.bcat = (await resources.create(admin, 'finance-categories', { archiveType: 'bundle', name: '水果组合', code: 'SGZH' })).id;
    const giftProductId = (await resources.get(admin, 'finance-base-codes', ids.giftBc)).data.productId as number;
    await resources.update(admin, 'finance-products', giftProductId, { giftShortName: '小赠品', giftCodeShortName: 'XZP' });
    ids.tb = (await resources.create(admin, 'finance-platforms', { code: 'TB', name: '淘宝' })).id;
    ids.dy = (await resources.create(admin, 'finance-platforms', { code: 'DY', name: '抖音' })).id;
    ids.scen = (await resources.create(admin, 'finance-scenarios', { code: 'standard', name: '标准', segment: '' })).id;

    // 子商品已在聚水潭上（组合装上传前的依赖检查）
    await ds.query("UPDATE resource_records SET data = JSON_SET(data, '$.jstUploadedCode', JSON_UNQUOTE(JSON_EXTRACT(data, '$.code'))) WHERE company_id = ? AND type = 'finance-base-codes'", [admin.companyId]);
    // ---- 流程配置并发布 ----
    await flow.saveDraft(admin, 'sku-batch-apply', [step('apply', '运营申请', 'submit'), step('warehouse', '仓库完善', 'execute', wh.id), step('review', '财务审核', 'finance', fin.id), step('end', '结束', 'end')], []);
    await flow.publish(admin, 'sku-batch-apply');
  });
  afterAll(async () => { await ds?.destroy(); });
  const qspec = (name: string, main: number, qty: number) => ({ name, main: [{ baseCodeId: main, qty }], gift: [] });
  let seq = 100;
  const nextQty = () => (seq += 1);
  const split = async (n: number) => {
    const specs = Array.from({ length: n }, (_, i) => qspec(`批${seq}-${i + 1}`, ids.pearBc, nextQty()));
    const out = await sku.startSplit(ops, payload(specs), key());
    return out;
  };
  const rev = async (id: number) => {
    const r = await flow.detail(admin, id);
    return { runId: id, revision: r.revision, stepId: r.activeStep?.id };
  };
  const auditCount = async (action: string) =>
    (await ds.manager.count(AuditLog, { where: { companyId: admin.companyId, action } }));

  it('组合编码申请入口按整申请分页，完整计数规格；默认逐流程与其他人的mine范围不变',async()=>{
    const before=await flow.listRuns(ops,{view:'started',templateKey:'sku-batch-apply',page:1,pageSize:100});
    const one=await split(3),two=await split(2);
    const grouped=await flow.listRuns(ops,{view:'started',templateKey:'sku-batch-apply',groupSku:true,page:1,pageSize:1});
    expect(grouped.total).toBe(before.total+2);expect(grouped.rows).toHaveLength(1);
    const second=await flow.listRuns(ops,{view:'started',templateKey:'sku-batch-apply',groupSku:true,page:2,pageSize:1});
    const rows=[...grouped.rows,...second.rows] as Array<{batchRef:string;specCount:number;progress:Array<{name:string;count:number;handlers:string[]}>}>;
    expect(rows.find(row=>row.batchRef===one.batchKey)?.specCount).toBe(3);expect(rows.find(row=>row.batchRef===two.batchKey)?.specCount).toBe(2);
    expect(rows.find(row=>row.batchRef===one.batchKey)?.progress).toEqual([expect.objectContaining({name:'仓库完善',count:3,handlers:['仓库']})]);
    expect((await flow.listRuns(ops,{view:'started',templateKey:'sku-batch-apply',page:1,pageSize:100})).total).toBe(before.total+5);
    expect((await flow.listRuns(stranger,{view:'started',templateKey:'sku-batch-apply',groupSku:true,page:1,pageSize:20})).total).toBe(0);
    await expect(flow.listRuns(admin,{view:'all',templateKey:'sku-batch-apply',groupSku:true,page:1,pageSize:20})).rejects.toThrow(/只支持我的SKU/);
    await expect(flow.listRuns(ops,{view:'started',templateKey:'leave',groupSku:true,page:1,pageSize:20})).rejects.toThrow(/只支持我的SKU/);
    const board=await batch.board(ops,one.batchKey);expect(board.total).toBe(3);expect(board.requesterId).toBe(ops.id);
  });

  it('拆规格重复及并发首发保持同一批次/原run，已进入后续节点也不重归组，改内容或其他人复用拒绝',async()=>{
    const data=payload([qspec('稳定甲',ids.pearBc,nextQty()),qspec('稳定乙',ids.pearBc,nextQty())]),request=key();
    const [first,concurrent]=await Promise.all([sku.startSplit(ops,data,request),sku.startSplit(ops,data,request)]);
    expect(first.failed).toEqual([]);expect(concurrent.failed).toEqual([]);expect(concurrent.batchKey).toBe(first.batchKey);expect(concurrent.runs).toEqual(first.runs);
    expect(await ds.manager.count(FlowRun,{where:{companyId:ops.companyId,requestKey:`${request}-0`}})).toBe(1);
    const moved=await whPass(wh,await flow.detail(wh,first.runs[0].id),[whLines()]);expect(moved.activeStep?.key).toBe('review');
    const retry=await sku.startSplit(ops,data,request);expect(retry).toEqual(first);expect((await batch.board(ops,first.batchKey)).total).toBe(2);
    await expect(sku.startSplit(ops,{...data,batchName:'改内容'},request)).rejects.toThrow(/内容已变化/);
    await expect(sku.startSplit(admin,data,request)).rejects.toThrow(/其他申请/);
    await expect(sku.startSplit({...ops,companyId:admin.companyId+999999},data,request)).rejects.toThrow();expect((await batch.board(ops,first.batchKey)).total).toBe(2);
  });

  it('新规格入场后失败回滚run/step/todo再保留其他规格成功，重试仅补失败项且沿原key',async()=>{
    const data=payload([qspec('回滚甲',ids.pearBc,nextQty()),qspec('回滚乙',ids.pearBc,nextQty())]),request=key();
    const original=flow.startIn.bind(flow);let failedRun=0;let injected=false;
    const spy=jest.spyOn(flow,'startIn').mockImplementation(async(...args)=>{const run=await original(...args);if(!injected){injected=true;failedRun=run.id;throw new Error('合成入场后失败');}return run;});
    let first:Awaited<ReturnType<SkuApplyService['startSplit']>>;
    try{first=await sku.startSplit(ops,data,request);}finally{spy.mockRestore();}
    expect(first!.failed).toEqual([{specName:'回滚甲',message:'合成入场后失败'}]);expect(first!.runs).toHaveLength(1);
    expect(await ds.manager.findOneBy(FlowRun,{companyId:ops.companyId,id:failedRun})).toBeNull();expect(await ds.manager.count(FlowStep,{where:{companyId:ops.companyId,runId:failedRun}})).toBe(0);expect(await ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:failedRun}})).toBe(0);
    const retry=await sku.startSplit(ops,data,request);expect(retry.failed).toEqual([]);expect(retry.batchKey).toBe(first!.batchKey);expect(retry.runs[1].id).toBe(first!.runs[0].id);expect((await batch.board(ops,first!.batchKey)).total).toBe(2);
  });

  it('旧派生requestKey已有归组原样复用，旧key始终可查；跨公司不能读原汇总或改变归组',async()=>{
    const data=payload([qspec('旧归组甲',ids.pearBc,nextQty()),qspec('旧归组乙',ids.pearBc,nextQty())]),request=key(),first=await sku.startSplit(ops,data,request),legacyKey='Blegacy'+crypto.randomBytes(4).toString('hex');
    for(const item of first.runs)await ds.query("UPDATE flow_runs SET payload=JSON_REMOVE(JSON_SET(payload,'$._batchKey',?),'$._splitRequestHash') WHERE company_id=? AND id=?",[legacyKey,ops.companyId,item.id]);
    const retry=await sku.startSplit(ops,data,request);expect(retry.batchKey).toBe(legacyKey);expect(retry.runs).toEqual(first.runs);expect((await batch.board(ops,legacyKey)).total).toBe(2);
    const company=await ds.manager.save(Company,ds.manager.create(Company,{code:`other${crypto.randomBytes(4).toString('hex')}`,name:'合成另一公司',status:'active'}));const actor=au(await mkUser(company.id,'other','另一公司'),company.id,'另一公司',['flow.apply.view']);
    await expect(batch.board(actor,legacyKey)).rejects.toThrow(/不存在|查看权限/);await expect(sku.startSplit(actor,data,request)).rejects.toThrow();expect((await batch.board(ops,legacyKey)).total).toBe(2);
  });

  it('通用申请草稿只对SKU启用，真实停用定义可选，创建首运营活节点但不产生TODO/通知/出站或旧办理能力',async()=>{
    await flow.saveDraft(admin,'sku-batch-apply',[step('apply','运营申请','submit'),step('warehouse','仓库完善','execute',wh2.id),step('review','财务审核','finance',fin.id),step('end','结束','end')],[]);
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'draft'});
    const counts=async()=>({todos:await ds.manager.count(WorkItem,{where:{companyId:ops.companyId}}),notices:await ds.manager.count(Notification,{where:{companyId:ops.companyId}}),outbox:await ds.manager.count(OutboxJob,{where:{companyId:ops.companyId}})}),before=await counts();
    const input={templateKey:'sku-batch-apply',confirmations:{referenceSearched:true},definitionId:definition.id,requestKey:key(),payloads:[{batchName:'源式未提交申请',specs:[{name:'仅填规格甲'}]},{batchName:'源式未提交申请',specs:[{name:'仅填规格乙'}]}]};
    const created=await flow.createApplicationDrafts(ops,input);expect(created.runs).toHaveLength(2);expect((await flow.createApplicationDrafts(ops,input)).runs).toEqual(created.runs);expect(await counts()).toEqual(before);
    const id=created.runs[0].id,detail=await flow.detail(ops,id);expect(detail.status).toBe('draft');expect(detail.activeStep).toMatchObject({key:'apply',type:'submit',recipients:[{id:ops.id,name:'运营'}]});expect(detail.dueAt).toBeNull();expect(detail.me.canPass).toBe(false);expect(detail.me.canResubmit).toBe(false);
    expect(await ds.manager.count(FlowStep,{where:{companyId:ops.companyId,runId:id}})).toBe(1);expect((await ds.manager.findOneByOrFail(FlowRun,{id,companyId:ops.companyId})).stepsSnapshot).toEqual(definition.steps);
    const action={revision:detail.revision,stepId:detail.activeStep!.id,reason:'不能提前办理'};
    await expect(flow.pass(ops,id,action)).rejects.toThrow(/已经结束/);await expect(flow.returnBack(ops,id,action)).rejects.toThrow(/已经结束/);await expect(flow.stop(ops,id,'cancel',action)).rejects.toThrow(/已经结束/);await expect(flow.withdraw(ops,id,{revision:detail.revision})).rejects.toThrow(/已经结束/);await expect(flow.resubmit(ops,id,{revision:detail.revision,payload:{}})).rejects.toThrow(/已经结束/);await expect(flow.transfer(admin,id,{...action,toUserId:wh.id})).rejects.toThrow(/已经结束/);
    const first=await ds.manager.findOneByOrFail(FlowStep,{companyId:ops.companyId,runId:id,status:'active'});await ds.manager.update(FlowStep,{id:first.id},{dueAt:new Date('1900-01-01')});await flow.scanOverdue(new Date('2000-01-01'));expect(await counts()).toEqual(before);await ds.manager.update(FlowStep,{id:first.id},{dueAt:null});
    await ds.manager.update(FlowDefinition,{id:definition.id,companyId:ops.companyId},{status:'retired'});
    try {
      expect((await flow.applicationDraftTemplates(ops,'sku-batch-apply')).templates.some(t=>t.id===definition.id)).toBe(false);
      await expect(flow.createApplicationDrafts(ops,{...input,requestKey:key()})).rejects.toThrow(/版本已停用/);
      expect((await flow.createApplicationDrafts(ops,input)).runs).toEqual(created.runs);
      expect((await batch.board(ops,created.batchKey)).applicationHeader?.definitionId).toBe(definition.id);
    } finally { await ds.manager.update(FlowDefinition,{id:definition.id,companyId:ops.companyId},{status:'draft'}); }
    expect((await batch.board(ops,created.batchKey)).total).toBe(2);await expect(flow.applicationDraftTemplates(ops,'license-borrow')).rejects.toThrow(/未启用申请草稿/);await expect(flow.start(ops,'sku-batch-apply',{batchName:'伪造draft',specs:[{name:'空主商品'}],_applicationDraftOrigin:true},key())).rejects.toThrow();
  });

  it('草稿保存核同公司/本人/版本/规格唯一和已选引用，公共设置同组事务且进入仓库后锁定',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'});
    const created=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',confirmations:{referenceSearched:true},definitionId:definition.id,requestKey:key(),payloads:[{batchName:'草稿编辑与公共锁',specs:[{name:'待改规格甲'}]},{batchName:'草稿编辑与公共锁',specs:[{name:'待改规格乙'}]}]});const first=created.runs[0];
    await expect(flow.saveApplicationDraft(stranger,first.id,first.revision,{note:'越权'})).rejects.toThrow(/本人/);await expect(flow.saveApplicationDraft(ops,first.id,first.revision-1,{note:'过期'})).rejects.toThrow(/已被修改/);
    await expect(flow.saveApplicationDraft(ops,first.id,first.revision,{specs:[{name:'待改规格乙'}]})).rejects.toThrow(/同名规格/);await expect(flow.saveApplicationDraft(ops,first.id,first.revision,{specs:[{name:'未选原真实资料',main:[{baseCodeId:999999999,qty:1}]}]})).rejects.toThrow(/本公司|删除/);
    await expect(flow.saveApplicationDraft(ops,first.id,first.revision,{scenarioId:ids.scen})).rejects.toThrow(/公共设置/);await expect(flow.submitApplicationDraft(ops,first.id,first.revision,key())).rejects.toThrow();expect((await flow.detail(ops,first.id)).status).toBe('draft');
    const common={scenarioId:ids.scen,platformIds:[ids.tb],bundleCategoryId:ids.bcat};await flow.saveApplicationDraftShared(ops,'sku-batch-apply',created.batchKey,created.runs,common,created.headerVersion);
    let one=await flow.detail(ops,first.id);await flow.saveApplicationDraft(ops,first.id,one.revision,{specs:[{name:'已改规格甲',main:[{baseCodeId:ids.pearBc,qty:nextQty()}],gift:[]}]});one=await flow.detail(ops,first.id);
    const request=key(),results=await Promise.all([flow.submitApplicationDraft(ops,first.id,one.revision,request),flow.submitApplicationDraft(ops,first.id,one.revision,request)]);expect(results).toHaveLength(2);const started=await flow.detail(ops,first.id);expect(started.status).toBe('running');expect(started.activeStep?.key).toBe('warehouse');expect(await ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:first.id,status:'open'}})).toBe(1);
    const rows=await ds.manager.find(FlowRun,{where:{companyId:ops.companyId,id:In(created.runs.map(row=>row.id))},order:{id:'ASC'}});await expect(flow.saveApplicationDraftShared(ops,'sku-batch-apply',created.batchKey,rows.map(row=>({id:row.id,revision:row.revision})),{platformIds:[ids.dy]},(await flow.applicationDraftHeader(ops,'sku-batch-apply',created.batchKey)).headerVersion)).rejects.toThrow(/已锁定/);await expect(flow.removeApplicationDraft(ops,first.id,started.revision,'不得删除已提交')).rejects.toThrow(/未提交/);
  });

  it('公共品牌清空同步到真实规格和加密header，不残留旧默认品牌',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'});
    const brand=await resources.create(admin,'finance-brands',{name:'草稿公共品牌',code:'DRAFT-BRAND'});
    const made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',confirmations:{referenceSearched:true},definitionId:definition.id,requestKey:key(),payloads:[{batchName:'清空品牌',brandId:brand.id,specs:[{name:'规格一'}]},{batchName:'清空品牌',brandId:brand.id,specs:[{name:'规格二'}]}]});
    await flow.saveApplicationDraftShared(ops,'sku-batch-apply',made.batchKey,made.runs,{brandId:''},made.headerVersion);
    expect((await flow.applicationDraftHeader(ops,'sku-batch-apply',made.batchKey)).shared.brandId).toBeUndefined();for(const item of made.runs)expect((await flow.detail(ops,item.id)).payload.brandId).toBeUndefined();
  });

  it('草稿提交入场失败整体回滚原draft/首节点/任务和通知，修复后同请求可提交；删除未提交留真实原因审计',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),data=payload([qspec('事务草稿',ids.pearBc,nextQty())]);
    const created=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',confirmations:{referenceSearched:true},definitionId:definition.id,requestKey:key(),payloads:[data]}),item=created.runs[0],before=await flow.detail(ops,item.id),noticeCount=await ds.manager.count(Notification,{where:{companyId:ops.companyId}}),events=await ds.manager.count(FlowEvent,{where:{companyId:ops.companyId,runId:item.id}});
    const original=(flow as any).activateStartIn.bind(flow);const spy=jest.spyOn(flow as any,'activateStartIn').mockImplementationOnce(async(...args:unknown[])=>{await original(...args);throw new Error('合成节点入场失败');});const submitKey=key();
    try{await expect(flow.submitApplicationDraft(ops,item.id,item.revision,submitKey)).rejects.toThrow('合成节点入场失败');}finally{spy.mockRestore();}
    const rolled=await flow.detail(ops,item.id);expect(rolled).toMatchObject({status:'draft',revision:before.revision,activeStep:{key:'apply',id:before.activeStep!.id}});expect(await ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:item.id}})).toBe(0);expect(await ds.manager.count(Notification,{where:{companyId:ops.companyId}})).toBe(noticeCount);expect(await ds.manager.count(FlowEvent,{where:{companyId:ops.companyId,runId:item.id}})).toBe(events);
    await flow.submitApplicationDraft(ops,item.id,item.revision,submitKey);expect((await flow.detail(ops,item.id)).activeStep?.key).toBe('warehouse');
    const extra=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',confirmations:{referenceSearched:true},definitionId:definition.id,requestKey:key(),payloads:[{batchName:'可删除草稿',specs:[{name:'删除前规格'}]}]});await expect(flow.removeApplicationDraft(ops,extra.runs[0].id,extra.runs[0].revision,'')).rejects.toThrow(/原因/);await flow.removeApplicationDraft(ops,extra.runs[0].id,extra.runs[0].revision,'合成不再申请');expect(await ds.manager.findOneBy(FlowRun,{id:extra.runs[0].id,companyId:ops.companyId})).toBeNull();const log=await ds.manager.findOne(AuditLog,{where:{companyId:ops.companyId,resourceId:String(extra.runs[0].id),action:'flow.application-draft.delete'}});expect(log?.detail).toMatchObject({reason:'合成不再申请'});
  });

  it('删除最后规格后0申请保留加密header并进入真实分页/空board，普通草稿路径不能读改内部索引，后加规格沿旧图',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'draft'}),title=`零规格申请-${key()}`,created=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',confirmations:{referenceSearched:true},definitionId:definition.id,requestKey:key(),payloads:[{batchName:title,specs:[{name:'最后一个规格'}]}]}),id=created.runs[0].id;
    const graph=(await ds.manager.findOneByOrFail(FlowRun,{companyId:ops.companyId,id})).stepsSnapshot;
    const raw=await ds.manager.findOneByOrFail(FormDraft,{companyId:ops.companyId,userId:ops.id,moduleKey:'flow-application:sku-batch-apply',sourceRecordId:created.batchKey});expect(Object.keys(raw.payload)).toEqual(['__encryptedDraft']);expect(JSON.stringify(raw.payload)).not.toContain('最后一个规格');
    await expect(ordinaryDrafts.get(ops,raw.draftKey)).rejects.toThrow(/草稿模块/);await expect(ordinaryDrafts.put(ops,raw.draftKey,{moduleKey:raw.moduleKey,payload:{overwrite:true}})).rejects.toThrow(/草稿模块/);await expect(ordinaryDrafts.remove(ops,raw.draftKey)).rejects.toThrow(/申请索引/);
    const removed=await flow.removeApplicationDraft(ops,id,created.runs[0].revision,'删除最后规格测试');expect(await ds.manager.count(FlowRun,{where:{companyId:ops.companyId,id}})).toBe(0);expect(await ds.manager.count(FormDraft,{where:{companyId:ops.companyId,id:raw.id}})).toBe(1);
    const board=await batch.board(ops,created.batchKey);expect(board).toMatchObject({batchKey:created.batchKey,batchName:title,total:0,items:[],applicationHeader:{headerVersion:removed.headerVersion,definitionId:definition.id}});
    const page=await flow.listRuns(ops,{view:'started',templateKey:'sku-batch-apply',groupSku:true,keyword:title,page:1,pageSize:1});expect(page.total).toBe(1);expect(page.rows[0]).toMatchObject({batchRef:created.batchKey,title,specCount:0,status:'draft'});expect((await flow.listRuns(ops,{view:'started',templateKey:'sku-batch-apply',groupSku:true,keyword:title,page:2,pageSize:1})).rows).toEqual([]);
    await flow.saveDraft(admin,'sku-batch-apply',[step('apply','更新后的运营节点','submit'),step('warehouse','更新后的仓库节点','execute',wh.id),step('review','更新后的财务节点','finance',fin.id),step('end','结束','end')],[]);
    const added=await flow.addApplicationDrafts(ops,'sku-batch-apply',created.batchKey,removed.headerVersion,key(),[{specs:[{name:'重新添加规格'}]}]);expect(added.runs).toHaveLength(1);expect((await ds.manager.findOneByOrFail(FlowRun,{companyId:ops.companyId,id:added.runs[0].id})).stepsSnapshot).toEqual(graph);
    const current=await flow.applicationDraftHeader(ops,'sku-batch-apply',created.batchKey);await flow.removeApplicationDraftBatch(ops,'sku-batch-apply',created.batchKey,current.headerVersion,added.runs,'删除真实申请');expect(await ds.manager.count(FormDraft,{where:{companyId:ops.companyId,id:raw.id}})).toBe(0);
  });

  it('header版本防并发覆盖，重复添规格只产生一次；删除失败回滚run/header/审计，空申请公共引用也按同公司校验',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),created=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',confirmations:{referenceSearched:true},definitionId:definition.id,requestKey:key(),payloads:[{batchName:'header并发闭环',specs:[{name:'初始规格'}]}]}),item=created.runs[0];
    const before=await flow.applicationDraftHeader(ops,'sku-batch-apply',created.batchKey),logs=await ds.manager.count(AuditLog,{where:{companyId:ops.companyId,action:'flow.application-draft.delete'}});
    const spy=jest.spyOn(FlowApplicationHeaderStore.prototype,'save').mockRejectedValueOnce(new Error('合成header写入失败'));try{await expect(flow.removeApplicationDraft(ops,item.id,item.revision,'应整组回滚')).rejects.toThrow('合成header写入失败');}finally{spy.mockRestore();}
    expect((await flow.detail(ops,item.id)).status).toBe('draft');expect((await flow.applicationDraftHeader(ops,'sku-batch-apply',created.batchKey)).headerVersion).toBe(before.headerVersion);expect(await ds.manager.count(AuditLog,{where:{companyId:ops.companyId,action:'flow.application-draft.delete'}})).toBe(logs);
    const removed=await flow.removeApplicationDraft(ops,item.id,item.revision,'删除到空');await expect(flow.saveApplicationDraftShared(ops,'sku-batch-apply',created.batchKey,[],{scenarioId:999999999},removed.headerVersion)).rejects.toThrow(/不属于本公司|不存在/);
    const concurrent=await Promise.allSettled([flow.addApplicationDrafts(ops,'sku-batch-apply',created.batchKey,removed.headerVersion,key(),[{specs:[{name:'并发规格甲'}]}]),flow.addApplicationDrafts(ops,'sku-batch-apply',created.batchKey,removed.headerVersion,key(),[{specs:[{name:'并发规格乙'}]}])]);expect(concurrent.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(concurrent.filter(result=>result.status==='rejected')).toHaveLength(1);expect((await batch.board(ops,created.batchKey)).total).toBe(1);
    const latest=await flow.applicationDraftHeader(ops,'sku-batch-apply',created.batchKey),addKey=key(),payloads=[{specs:[{name:'幂等新增规格'}]}];const [a,b]=await Promise.all([flow.addApplicationDrafts(ops,'sku-batch-apply',created.batchKey,latest.headerVersion,addKey,payloads),flow.addApplicationDrafts(ops,'sku-batch-apply',created.batchKey,latest.headerVersion,addKey,payloads)]);expect(a.runs).toEqual(b.runs);expect(a.headerVersion).toBe(b.headerVersion);expect((await batch.board(ops,created.batchKey)).total).toBe(2);
    await expect(flow.addApplicationDrafts(ops,'sku-batch-apply',created.batchKey,a.headerVersion,addKey,[{specs:[{name:'伪造相同请求不同内容'}]}])).rejects.toThrow(/其他明细内容/);
  });

  it('真实HTTP闭环：严格DTO建立/删到0/分页与空board/再添加，身份字段和错误header版本不能覆盖',async()=>{
    const module=await Test.createTestingModule({controllers:[FlowController,SkuApplyController],providers:[{provide:FlowService,useValue:flow},{provide:SkuApplyService,useValue:sku},{provide:SkuBatchService,useValue:batch},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile(),app=module.createNestApplication();
    app.use((req:{user?:AuthUser},_res:unknown,next:()=>void)=>{req.user=ops;next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');const url=await app.getUrl();
    const send=(path:string,method:string,body?:unknown)=>fetch(url+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    try{
      const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),title=`HTTP空申请-${key()}`,input={templateKey:'sku-batch-apply',confirmations:{referenceSearched:true},definitionId:definition.id,requestKey:key(),payloads:[{batchName:title,specs:[{name:'HTTP待删规格'}]}]};
      expect((await send('/flow/sku-apply/options?kind=main&catalog=true&companyId=999','GET')).status).toBe(400);const catalogRead=await send('/flow/sku-apply/options?kind=main&catalog=true&pageSize=1','GET');expect(catalogRead.status).toBe(200);const catalogBody=await catalogRead.json() as {items:Array<Record<string,unknown>>;total:number};expect(catalogBody.items).toHaveLength(1);expect(catalogBody.items[0]).not.toHaveProperty('costCents');
      expect((await send('/flow/runs/drafts','POST',{...input,companyId:999})).status).toBe(400);const response=await send('/flow/runs/drafts','POST',input);expect(response.status).toBe(201);const created=await response.json() as {batchKey:string;headerVersion:string;runs:Array<{id:number;revision:number}>};
      const removed=await send(`/flow/runs/${created.runs[0].id}/draft`,'DELETE',{revision:created.runs[0].revision,reason:'HTTP删除到零'});expect(removed.status).toBe(200);const removal=await removed.json() as {headerVersion:string};
      const pageResponse=await send(`/flow/runs?view=started&templateKey=sku-batch-apply&groupSku=true&keyword=${encodeURIComponent(title)}&page=1&pageSize=1`,'GET');expect(pageResponse.status).toBe(200);expect(await pageResponse.json()).toMatchObject({total:1,rows:[{batchRef:created.batchKey,specCount:0}]});
      const boardResponse=await send(`/flow/sku-apply/applications/${created.batchKey}`,'GET');expect(boardResponse.status).toBe(200);expect(await boardResponse.json()).toMatchObject({total:0,items:[],applicationHeader:{headerVersion:removal.headerVersion}});
      const prefix=`/flow/application-drafts/sku-batch-apply/${created.batchKey}`,add={headerVersion:removal.headerVersion,requestKey:key(),payloads:[{specs:[{name:'HTTP后来规格'}]}]};expect((await send(`${prefix}/items`,'POST',{...add,headerVersion:'0'.repeat(64)})).status).toBe(409);const added=await send(`${prefix}/items`,'POST',add);expect(added.status).toBe(201);const out=await added.json() as {headerVersion:string;runs:Array<{id:number;revision:number}>};
      expect((await send(`${prefix}/shared`,'PUT',{headerVersion:out.headerVersion,expected:out.runs.map(row=>({...row,companyId:999})),payload:{platformIds:[ids.tb]}})).status).toBe(400);expect((await send(`${prefix}/shared`,'PUT',{headerVersion:out.headerVersion,expected:out.runs,payload:{platformIds:[ids.tb]}})).status).toBe(200);
      const refreshed=await flow.applicationDraftHeader(ops,'sku-batch-apply',created.batchKey),original=await flow.detail(ops,out.runs[0].id),copy={headerVersion:refreshed.headerVersion,requestKey:key(),copySource:{id:original.id,revision:original.revision},payloads:[{specs:[{name:'HTTP严格复制规格'}]}]};
      expect((await send(`${prefix}/items`,'POST',{...copy,copySource:{...copy.copySource,companyId:999}})).status).toBe(400);const copied=await send(`${prefix}/items`,'POST',copy);expect(copied.status).toBe(201);const copyOut=await copied.json() as {headerVersion:string;runs:Array<{id:number;revision:number}>};expect((await flow.detail(ops,copyOut.runs[0].id)).payload.specs).toMatchObject([{name:'HTTP严格复制规格'}]);
      const freshRows=(await batch.board(ops,created.batchKey)).items.map(row=>({id:row.runId,revision:row.revision}));const deletion=await send(prefix,'DELETE',{headerVersion:copyOut.headerVersion,expected:freshRows,reason:'HTTP删除未提交申请'});expect(deletion.status).toBe(200);expect(await ds.manager.count(FormDraft,{where:{companyId:ops.companyId,sourceRecordId:created.batchKey}})).toBe(0);

    }finally{await app.close();}
  });

  it('创建前查询为真实只读参考，不泄漏成本或不可见申请；必须确认查询，批量提交逐规格部分成功且重放不重复待办',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),data=payload([qspec('可提交规格',ids.pearBc,nextQty())]),draftInput={templateKey:'sku-batch-apply',definitionId:definition.id,requestKey:key(),payloads:[data,{...data,specs:[{name:'待补主品规格'}]}]};
    await expect(flow.createApplicationDrafts(ops,draftInput)).rejects.toThrow(/商品查询/);const created=await flow.createApplicationDrafts(ops,{...draftInput,confirmations:{referenceSearched:true}});
    const base=await resources.get(admin,'finance-base-codes',ids.pearBc),search=await sku.draftReferences(ops,String(base.data.name||base.title)),hit=search.items.find(row=>row.id===ids.pearBc);expect(hit?.inProgress.some(row=>row.runId===created.runs[0].id)).toBe(true);expect(JSON.stringify(search)).not.toMatch(/"(cost|purchasePrice|unitPrice)"/);
    const otherSearch=await sku.draftReferences(stranger,String(base.data.name||base.title)),otherHit=otherSearch.items.find(row=>row.id===ids.pearBc);expect(otherHit?.inProgress).toEqual([]);expect(otherHit?.restrictedUsage).toBe(true);await expect(sku.draftReferences(wh,String(base.data.name||base.title))).rejects.toThrow(/权限/);
    const submitKey=key(),first=await flow.submitApplicationDrafts(ops,'sku-batch-apply',created.batchKey,created.runs,submitKey);expect(first).toMatchObject({ok:1,failed:1});expect((await flow.detail(ops,created.runs[1].id)).status).toBe('draft');const todoCount=await ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:created.runs[0].id}});const replay=await flow.submitApplicationDrafts(ops,'sku-batch-apply',created.batchKey,created.runs,submitKey);expect(replay).toMatchObject({ok:1,failed:1});expect(await ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:created.runs[0].id}})).toBe(todoCount);expect((await batch.board(ops,created.batchKey)).total).toBe(2);
  });

  it('汇总待办：同一张申请单的多个规格在办理人待办里只占一行，带规格数；汇总看板列出每个规格', async () => {
    const out = await split(3);
    const todos = await flow.todos(wh, { tab: 'pending', page: 1, pageSize: 50 });
    const rows = todos.rows.filter((x: { batchKey?: string }) => x.batchKey === out.batchKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].batchCount).toBe(3);
    const board = await batch.board(wh, out.batchKey);
    expect(board.total).toBe(3);
    expect(board.me).toMatchObject({ holdStepKey: 'warehouse', holdCount: 3, canReturnAll: true });
    expect(board.items.every((i) => i.mine)).toBe(true);
    // 路人看不到
    await expect(batch.board(noApply, out.batchKey)).rejects.toThrow(/不存在|权限/);
    await expect(batch.board(wh, 'bad ref!')).rejects.toThrow(/编号/);
    for (const r of out.runs) await flow.withdraw(ops, r.id, { revision: (await rev(r.id)).revision });
  });

  it('批量通过：仓库一次把选中的规格提交财务（套用同一份发货组成），财务再批量通过；汇总通知不逐条刷屏', async () => {
    const out = await split(3);
    const before = await ds.manager.count(Notification, { where: { companyId: admin.companyId, userId: fin.id } });
    const items = await Promise.all(out.runs.map((r) => rev(r.id)));
    const res = await batch.act(wh, { ref: out.batchKey, action: 'pass', items, form: { config: [whLines()] } });
    expect(res).toMatchObject({ ok: 3, failed: 0 });
    const after = await ds.manager.count(Notification, { where: { companyId: admin.companyId, userId: fin.id } });
    expect(after - before).toBe(1);
    expect(await auditCount('flow.sku.batch.pass')).toBeGreaterThanOrEqual(1);
    const todos = await flow.todos(fin, { tab: 'pending', page: 1, pageSize: 50 });
    expect(todos.rows.filter((x: { batchKey?: string }) => x.batchKey === out.batchKey)).toHaveLength(1);
    const fItems = await Promise.all(out.runs.map((r) => rev(r.id)));
    const fres = await batch.act(fin, { ref: out.batchKey, action: 'pass', items: fItems, form: { confirmed: true } });
    expect(fres.ok).toBe(3);
    const b = await batch.board(ops, out.batchKey);
    expect(b.counts.completed).toBe(3);
    expect(b.history.length).toBeGreaterThan(0);
  });

  it('批量办理：部分成功。别人的待办、版本号过期的规格单独报失败，其余照常办；没选或超过 100 个被拒', async () => {
    const out = await split(3);
    const items = await Promise.all(out.runs.map((r) => rev(r.id)));
    items[2].revision -= 1; // 过期
    const res = await batch.act(wh, { ref: out.batchKey, action: 'pass', items, form: { config: [whLines()] } });
    expect(res.ok).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.results.find((r) => !r.ok)!.runId).toBe(items[2].runId);
    // 不是办理人
    const none = await batch.act(wh2, { ref: out.batchKey, action: 'pass', items: [await rev(out.runs[2].id)], form: { config: [whLines()] } }).catch((e: Error) => e);
    expect(none instanceof Error ? none.message : none.failed).toBeTruthy();
    await expect(batch.act(wh, { ref: out.batchKey, action: 'pass', items: [] })).rejects.toThrow(/1 到 100/);
    await expect(batch.act(wh, { ref: out.batchKey, action: 'pass', items: [items[0], items[0]] })).rejects.toThrow(/重复/);
    const fItems = await Promise.all(out.runs.map((r) => rev(r.id)));
    await batch.act(fin, { ref: out.batchKey, action: 'cancel', items: fItems.filter((x) => x.stepId), comment: '清理' }).catch(() => undefined);
  });

  it('批量退回：原因必填；退回的规格回到申请人，申请人收到一条汇总通知，且带原因', async () => {
    const out = await split(3);
    const items = await Promise.all(out.runs.map((r) => rev(r.id)));
    await expect(batch.act(wh, { ref: out.batchKey, action: 'return', items })).rejects.toThrow(/原因/);
    const before = await ds.manager.count(Notification, { where: { companyId: admin.companyId, userId: ops.id, kind: 'returned' } });
    const res = await batch.act(wh, { ref: out.batchKey, action: 'return', items: items.slice(0, 2), comment: '赠品不对' });
    expect(res.ok).toBe(2);
    const after = await ds.manager.find(Notification, { where: { companyId: admin.companyId, userId: ops.id, kind: 'returned' }, order: { id: 'DESC' } });
    expect(after.length - before).toBe(1);
    expect(after[0].body).toContain('赠品不对');
    const board = await batch.board(ops, out.batchKey);
    expect(board.counts.returned).toBe(2);
    // 申请人在发起步骤上没有“办理”动作（只能修改后重新提交），不能被当成批量办理人
    expect(board.me).toMatchObject({ isRequester: true, holdStepKey: null, holdCount: 0, canReturnAll: false });
    const ret = board.items.filter((i) => i.enteredVia === 'return');
    expect(ret.every((i) => i.returnReason === '赠品不对' && i.canResubmit)).toBe(true);
    // 申请人原样重新提交：回到仓库，批次标记保留
    const re = await batch.act(ops, { ref: out.batchKey, action: 'resubmit', items: await Promise.all(ret.map((i) => rev(i.runId as number))) });
    expect(re.ok).toBe(2);
    const again = await batch.board(wh, out.batchKey);
    expect(again.me.holdCount).toBe(3);
    expect(await auditCount('flow.sku.batch.return')).toBeGreaterThanOrEqual(1);
    for (const r of out.runs) await flow.withdraw(ops, r.id, { revision: (await rev(r.id)).revision });
  });

  it('整单退回：必须全是自己的待办、原因必填、版本过期整体失败；成功则全部规格同时退回', async () => {
    const out = await split(3);
    const items = await Promise.all(out.runs.map((r) => rev(r.id)));
    await expect(batch.returnAll(wh, { ref: out.batchKey, items, reason: '' })).rejects.toThrow(/原因/);
    // 版本过期：什么都不退
    await expect(batch.returnAll(wh, { ref: out.batchKey, items: items.map((x, i) => (i === 0 ? { ...x, revision: x.revision - 1 } : x)), reason: '不对' })).rejects.toThrow(/变化/);
    expect((await batch.board(wh, out.batchKey)).counts.returned).toBe(0);
    // 另一个仓库的人手里没有这些规格
    await expect(batch.returnAll(wh2, { ref: out.batchKey, items, reason: '不对' })).rejects.toThrow();
    const hidden = items[2];
    await ds.manager.update(FlowStep, { id: hidden.stepId, companyId: wh.companyId }, { recipients: [wh2.id] });
    await ds.manager.update(WorkItem, { stepId: hidden.stepId, companyId: wh.companyId }, { assigneeId: wh2.id });
    expect((await batch.board(wh, out.batchKey)).me.canReturnAll).toBe(false);
    await expect(batch.returnAll(wh, { ref: out.batchKey, items: items.slice(0, 2), reason: '缺少其他办理人的规格' })).rejects.toThrow(/不是你办理/);
    expect((await batch.board(ops, out.batchKey)).counts.returned).toBe(0);
    await ds.manager.update(FlowStep, { id: hidden.stepId, companyId: wh.companyId }, { recipients: [wh.id] });
    await ds.manager.update(WorkItem, { stepId: hidden.stepId, companyId: wh.companyId }, { assigneeId: wh.id });
    const ok = await batch.returnAll(wh, { ref: out.batchKey, items, reason: '整单资料有误' });
    expect(ok.count).toBe(3);
    const board = await batch.board(ops, out.batchKey);
    expect(board.counts.returned).toBe(3);
    expect(await auditCount('flow.sku.return-all')).toBeGreaterThanOrEqual(1);
    for (const r of out.runs) await flow.withdraw(ops, r.id, { revision: (await rev(r.id)).revision });
  });

  it('个别规格退回（没拆开的一张申请）：被退回的拆出成新流程回到申请人，其余规格留在仓库继续办理', async () => {
    const run = await toWarehouse([qspec('留一', ids.pearBc, nextQty()), qspec('退二', ids.pearBc, nextQty()), qspec('留三', ids.pearBc, nextQty())]);
    const st = run.activeStep!;
    // 第一个办理步骤（仓库）也要能看到“退回”：旧系统仓库退回运营是最常用的操作之一
    expect((await flow.detail(wh, run.id)).me.canReturn).toBe(true);
    expect((await flow.detail(ops, run.id)).me.canReturn).toBe(false);
    await expect(batch.returnSpecs(wh, { runId: run.id, revision: run.revision, stepId: st.id, specs: ['退二'], reason: '' })).rejects.toThrow(/原因/);
    await expect(batch.returnSpecs(wh, { runId: run.id, revision: run.revision, stepId: st.id, specs: ['没有'], reason: '错' })).rejects.toThrow(/没有规格/);
    await expect(batch.returnSpecs(stranger, { runId: run.id, revision: run.revision, stepId: st.id, specs: ['退二'], reason: '错' })).rejects.toThrow();
    const out = await batch.returnSpecs(wh, { runId: run.id, revision: run.revision, stepId: st.id, specs: ['退二'], reason: '规格二的包装不对' });
    expect(out.split).toBe(true);
    const rest = await flow.detail(admin, run.id);
    expect((rest.payload.specs as { name: string }[]).map((s) => s.name)).toEqual(['留一', '留三']);
    expect(rest.activeStep!.key).toBe('warehouse');
    const carved = await flow.detail(admin, out.newRunId);
    expect((carved.payload.specs as { name: string }[]).map((s) => s.name)).toEqual(['退二']);
    expect(carved.activeStep!.key).toBe('apply');
    // 剩下的继续走完（仓库 → 财务）
    const rv = await whPass(wh, rest as never, [whLines(), whLines()]);
    const done = await finPass(fin, rv);
    expect(done.status).toBe('completed');
    // 退回的那条申请人改好重新提交
    const re = await flow.resubmit(ops, carved.id, { revision: carved.revision, payload: Object.fromEntries(Object.entries(carved.payload).filter(([k]) => !k.startsWith('_'))) });
    expect(re.activeStep!.key).toBe('warehouse');
    const keyRow = await ds.query("SELECT JSON_UNQUOTE(JSON_EXTRACT(payload, '$._batchKey')) AS k FROM flow_runs WHERE id IN (?, ?)", [rest.id, re.id]);
    expect(keyRow.map((x: { k: string }) => x.k)).toEqual([out.ref, out.ref]);
    expect(await auditCount('flow.sku.return-specs')).toBeGreaterThanOrEqual(1);
    const board = await batch.board(ops, out.ref);
    expect(board.runCount).toBe(2);
    await flow.withdraw(ops, re.id, { revision: re.revision });
  });

  it('个别规格退回：全选等于整条退回（不拆）', async () => {
    const run = await toWarehouse([qspec('全一', ids.pearBc, nextQty()), qspec('全二', ids.pearBc, nextQty())]);
    const out = await batch.returnSpecs(wh, { runId: run.id, revision: run.revision, stepId: run.activeStep!.id, specs: ['全一', '全二'], reason: '整体不对' });
    expect(out.split).toBe(false);
    expect((await flow.detail(admin, run.id)).activeStep!.key).toBe('apply');
    await flow.withdraw(ops, run.id, { revision: (await flow.detail(admin, run.id)).revision });
  });

  it('每规格品牌ID覆盖从草稿、公共设置、预览到真实财务发布；空选恢复默认，非法跨公司/停用品牌拒绝',async()=>{
    const defaultBrand=await resources.create(admin,'finance-brands',{name:'申请默认品牌',code:'DRAFT-DEFAULT'}),manualBrand=await resources.create(admin,'finance-brands',{name:'规格独立品牌',code:'DRAFT-MANUAL'});
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),spec={...qspec('品牌闭环规格',ids.pearBc,nextQty()),brandId:manualBrand.id};
    const made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',confirmations:{referenceSearched:true},definitionId:definition.id,requestKey:key(),payloads:[payload([spec],{brandId:defaultBrand.id})]});
    await flow.saveApplicationDraftShared(ops,'sku-batch-apply',made.batchKey,made.runs,{brandId:''},made.headerVersion);let detail=await flow.detail(ops,made.runs[0].id);expect((detail.payload.specs as Array<{brandId?:number}>)[0].brandId).toBe(manualBrand.id);
    await expect(flow.saveApplicationDraft(ops,detail.id,detail.revision,{specs:[{...spec,brandId:999999999}]})).rejects.toThrow(/品牌不存在/);
    const other=await ds.manager.save(Company,ds.manager.create(Company,{code:`brand${crypto.randomBytes(4).toString('hex')}`,name:'品牌隔离公司',status:'active'})),otherAdmin={...admin,companyId:other.id,id:await mkUser(other.id,'brandAdmin','隔离品牌管理员',{isCompanyAdmin:true})},foreign=await resources.create(otherAdmin,'finance-brands',{name:'隔离品牌',code:'FOREIGN'});await expect(flow.saveApplicationDraft(ops,detail.id,detail.revision,{specs:[{...spec,brandId:foreign.id}]})).rejects.toThrow(/品牌不存在/);
    await resources.changeStatus(admin,'finance-brands',manualBrand.id,'inactive','合成暂时停用');await expect(flow.saveApplicationDraft(ops,detail.id,detail.revision,{specs:[spec]})).rejects.toThrow(/已停用/);await resources.changeStatus(admin,'finance-brands',manualBrand.id,'active','恢复合成品牌');
    await flow.saveApplicationDraft(ops,detail.id,detail.revision,{specs:[{...spec,brandId:''}]});detail=await flow.detail(ops,detail.id);expect((detail.payload.specs as Array<{brandId?:number}>)[0].brandId).toBeUndefined();
    await flow.saveApplicationDraft(ops,detail.id,detail.revision,{specs:[spec]});detail=await flow.detail(ops,detail.id);await flow.submitApplicationDraft(ops,detail.id,detail.revision,key());const review=await whPass(wh,await flow.detail(wh,detail.id),[whLines()]);await finPass(fin,review);
    const stored=await ds.manager.findOneByOrFail(FlowRun,{id:detail.id,companyId:ops.companyId}),created=stored.payload._created as Array<{bundleId:number}>;expect(created.length).toBeGreaterThan(0);for(const row of created)expect((await resources.get(admin,'finance-bundles',row.bundleId)).data.brandId).toBe(manualBrand.id);
  });


  it('真24无主商品品牌时草稿可存但提交拒绝；显式默认/继承主品牌均真实解析，普通旧入口不借客户端flag启用',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),bc=await resources.get(admin,'finance-base-codes',ids.pearBc),product=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:Number(bc.data.productId)}),original={...product.data};
    await ds.manager.save(ResourceRecord,{...product,data:{...original,brandId:undefined}});
    try{
      const data=payload([qspec('缺品牌草稿',ids.pearBc,nextQty())]),made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[data]});await expect(flow.submitApplicationDraft(ops,made.runs[0].id,made.runs[0].revision,key())).rejects.toThrow(/主商品未关联品牌/);expect((await flow.detail(ops,made.runs[0].id)).status).toBe('draft');
      await flow.saveApplicationDraftShared(ops,'sku-batch-apply',made.batchKey,made.runs,{brandId:ids.mainBrand},made.headerVersion);const d=await flow.detail(ops,made.runs[0].id);await flow.submitApplicationDraft(ops,d.id,d.revision,key());expect((await flow.detail(ops,d.id)).activeStep?.key).toBe('warehouse');
    }finally{await ds.manager.save(ResourceRecord,{...product,data:original});}
    const options=await sku.options(ops,'names','',String(ids.pearBc));expect(options).toMatchObject({items:[{id:ids.pearBc,brandId:ids.mainBrand}]});
  });

  it('复制未完成规格沿通用新增保留运营事实和手工品牌，仅draft/仓库退回可复制且版本/公司/幂等不放松',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),source={...qspec('复制运营规格',ids.pearBc,nextQty()),note:'复制运营需求',brandId:ids.mainBrand,reuseReason:'不应复制旧确认理由'},made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([source])]});
    const original=made.runs[0],copyKey=key(),input=[{specs:[{name:'复制运营规格 副本'}],_warehouse:[{bad:true}],_created:[{bundleId:999}]}];
    const [a,b]=await Promise.all([flow.addApplicationDrafts(ops,'sku-batch-apply',made.batchKey,made.headerVersion,copyKey,input,original),flow.addApplicationDrafts(ops,'sku-batch-apply',made.batchKey,made.headerVersion,copyKey,input,original)]);expect(a.runs).toEqual(b.runs);const copied=await flow.detail(ops,a.runs[0].id);expect(copied.payload.specs).toEqual([{...source,name:'复制运营规格 副本',reuseReason:undefined}]);expect(copied.payload._warehouse).toBeUndefined();expect(copied.payload._created).toBeUndefined();expect(await ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:copied.id}})).toBe(0);
    const header=await flow.applicationDraftHeader(ops,'sku-batch-apply',made.batchKey);await expect(flow.addApplicationDrafts(ops,'sku-batch-apply',made.batchKey,header.headerVersion,key(),[{specs:[{name:'过期复制'}]}],{id:original.id,revision:original.revision+1})).rejects.toThrow(/来源规格或版本/);
    await flow.submitApplicationDraft(ops,original.id,original.revision,key());let d=await flow.detail(wh,original.id);await expect(flow.addApplicationDrafts(ops,'sku-batch-apply',made.batchKey,header.headerVersion,key(),[{specs:[{name:'不准复制仓库'}]}],{id:d.id,revision:d.revision})).rejects.toThrow(/未完成规格/);
    await expect(flow.saveApplicationDraft(ops,d.id,d.revision,{specs:[source]})).rejects.toThrow(/退回规格/);await flow.returnBack(wh,d.id,{revision:d.revision,stepId:d.activeStep!.id,reason:'仓库退回后复制'});d=await flow.detail(ops,d.id);const activeId=d.activeStep!.id,todos=await ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:d.id}});await flow.saveApplicationDraft(ops,d.id,d.revision,{specs:[{...source,name:'退回运营已修改'}]});d=await flow.detail(ops,d.id);expect(d.status).toBe('running');expect(d.activeStep!.id).toBe(activeId);expect(await ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:d.id}})).toBe(todos);const returned=await flow.addApplicationDrafts(ops,'sku-batch-apply',made.batchKey,header.headerVersion,key(),[{specs:[{name:'退回规格副本'}]}],{id:d.id,revision:d.revision});expect((await flow.detail(ops,returned.runs[0].id)).status).toBe('draft');
  });

  it('真24整单删除只准申请人草稿/仓库退回；队列sending阻断、取消pending/failed保尝试、done保留且retry不能复活；依赖同事务回滚',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('仓库退回删除',ids.pearBc,nextQty())])]});const id=made.runs[0].id;
    await flow.submitApplicationDraft(ops,id,made.runs[0].revision,key());let detail=await flow.detail(wh,id);expect((await flow.applicationDraftHeader(ops,'sku-batch-apply',made.batchKey)).canDelete).toBe(false);await flow.returnBack(wh,id,{revision:detail.revision,stepId:detail.activeStep!.id,reason:'仓库要求重新发起'});detail=await flow.detail(ops,id);const header=await flow.applicationDraftHeader(ops,'sku-batch-apply',made.batchKey);expect(header.canDelete).toBe(true);const expected=[{id,revision:detail.revision}];await expect(flow.removeApplicationDraftBatch(admin,'sku-batch-apply',made.batchKey,header.headerVersion,expected,'管理员不得代删')).rejects.toThrow(/本人/);
    const notice=await ds.manager.save(Notification,ds.manager.create(Notification,{companyId:ops.companyId,userId:ops.id,kind:'todo',title:'删除申请的合成通知',body:null,link:`/workbench/todos?run=${id}`})),otherNotice=await ds.manager.save(Notification,ds.manager.create(Notification,{companyId:ops.companyId,userId:ops.id,kind:'todo',title:'不得误删相近ID通知',body:null,link:`/workbench/todos?run=${id}0`}));
    const jobs=[];for(const status of ['pending','failed','done','sending'] as const)jobs.push(await ds.manager.save(OutboxJob,ds.manager.create(OutboxJob,{companyId:ops.companyId,channel:'feishu',kind:'feishu_notice',resourceType:'flow-run',resourceId:id,idempotencyKey:`delete-${key()}`,payloadJson:{runId:id,notificationId:notice.id,userId:ops.id},status,attempts:3,nextAttemptAt:new Date(),lastError:'合成已有尝试',createdBy:ops.id})));
    const work=await ds.manager.findOneByOrFail(WorkItem,{companyId:ops.companyId,runId:id,status:'open'});await ds.manager.save(TaskDelayRequest,ds.manager.create(TaskDelayRequest,{companyId:ops.companyId,workItemId:work.id,requesterId:ops.id,approverId:admin.id,oldDueAt:null,requestedDueAt:new Date(),reason:'合成延时',status:'pending'}));await ds.manager.save(SupervisionException,ds.manager.create(SupervisionException,{companyId:ops.companyId,sourceType:'task',sourceId:work.id,sourceKey:`delete-${key()}`,runId:id,title:'合成异常',status:'open'}));await ds.manager.save(FlowCc,ds.manager.create(FlowCc,{companyId:ops.companyId,runId:id,userId:admin.id,stepKey:'apply'}));
    await expect(flow.removeApplicationDraftBatch(ops,'sku-batch-apply',made.batchKey,header.headerVersion,expected,'申请人删除SKU申请')).rejects.toThrow(/正在发送/);expect(await ds.manager.count(FlowRun,{where:{companyId:ops.companyId,id}})).toBe(1);expect((await ds.manager.findOneByOrFail(OutboxJob,{id:jobs[0].id})).status).toBe('pending');await ds.manager.update(OutboxJob,{id:jobs[3].id},{status:'failed'});
    const originalDelete=EntityManager.prototype.delete,spy=jest.spyOn(EntityManager.prototype,'delete').mockImplementation(function(this:EntityManager,target,criteria){if(target===FlowRun)throw new Error('合成删除run失败');return originalDelete.call(this,target,criteria);});try{await expect(flow.removeApplicationDraftBatch(ops,'sku-batch-apply',made.batchKey,header.headerVersion,expected,'回滚整个删除')).rejects.toThrow('合成删除run失败');}finally{spy.mockRestore();}expect((await ds.manager.findOneByOrFail(OutboxJob,{id:jobs[0].id})).status).toBe('pending');expect(await ds.manager.count(Notification,{where:{companyId:ops.companyId,id:notice.id}})).toBe(1);
    await flow.removeApplicationDraftBatch(ops,'sku-batch-apply',made.batchKey,header.headerVersion,expected,'申请人删除SKU申请');for(const entity of [FlowRun,FlowStep,FlowEvent,WorkItem,FlowCc,SupervisionException]){const count=entity===FlowRun?await ds.manager.count(FlowRun,{where:{companyId:ops.companyId,id}}):await ds.manager.count(entity as typeof FlowStep,{where:{companyId:ops.companyId,runId:id}});expect(count).toBe(0);}expect(await ds.manager.count(TaskDelayRequest,{where:{companyId:ops.companyId,workItemId:work.id}})).toBe(0);expect(await ds.manager.count(Notification,{where:{companyId:ops.companyId,id:notice.id}})).toBe(0);expect(await ds.manager.count(Notification,{where:{companyId:ops.companyId,id:otherNotice.id}})).toBe(1);
    for(const job of jobs){const stored=await ds.manager.findOneByOrFail(OutboxJob,{id:job.id});expect(stored.status).toBe(job.status==='done'?'done':'cancelled');expect(stored.attempts).toBe(3);}const queue=new OutboxService(ds,resources);await expect(queue.retry(admin,jobs[0].id)).rejects.toThrow(/申请已删除/);
    const independent=await ds.manager.save(OutboxJob,ds.manager.create(OutboxJob,{companyId:ops.companyId,channel:'feishu',kind:'feishu_notice',resourceType:'notification',resourceId:notice.id,idempotencyKey:key(),payloadJson:{notificationId:notice.id},status:'cancelled',nextAttemptAt:new Date()}));await expect(queue.retry(admin,independent.id)).rejects.toThrow(/通知已删除/);
  });

  it('进入过财务/有发布结果/仍在仓库的申请整单删除均拒绝，不能只看当前已退回运营',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('财务历史防删',ids.pearBc,nextQty())])]});const id=made.runs[0].id;await flow.submitApplicationDraft(ops,id,made.runs[0].revision,key());const review=await whPass(wh,await flow.detail(wh,id),[whLines()]);await flow.returnBack(fin,id,{revision:review.revision,stepId:review.activeStep!.id,reason:'财务退回仓库'});let d=await flow.detail(wh,id);await flow.returnBack(wh,id,{revision:d.revision,stepId:d.activeStep!.id,reason:'仓库再退回运营'});d=await flow.detail(ops,id);const header=await flow.applicationDraftHeader(ops,'sku-batch-apply',made.batchKey);expect(header.canDelete).toBe(false);await expect(flow.removeApplicationDraftBatch(ops,'sku-batch-apply',made.batchKey,header.headerVersion,[{id,revision:d.revision}],'不能删财务历史')).rejects.toThrow(/进入过财务/);expect(await ds.manager.count(FlowRun,{where:{companyId:ops.companyId,id}})).toBe(1);
  });


  it('取消分支须在运营首节点，仓库取消不准删除；已发布结果即使伪成首节点draft也拒绝',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'});
    const make=async(name:string)=>flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec(name,ids.pearBc,nextQty())])]});
    const allowed=await make('首运营取消后删除');await flow.submitApplicationDraft(ops,allowed.runs[0].id,allowed.runs[0].revision,key());let d=await flow.detail(wh,allowed.runs[0].id);await flow.returnBack(wh,d.id,{revision:d.revision,stepId:d.activeStep!.id,reason:'仓库退回运营'});d=await flow.detail(ops,d.id);await flow.stop(ops,d.id,'cancel',{revision:d.revision,stepId:d.activeStep!.id,reason:'运营废除未完成规格'});d=await flow.detail(ops,d.id);let header=await flow.applicationDraftHeader(ops,'sku-batch-apply',allowed.batchKey);expect(header.canDelete).toBe(true);await flow.removeApplicationDraftBatch(ops,'sku-batch-apply',allowed.batchKey,header.headerVersion,[{id:d.id,revision:d.revision}],'申请人删除已废除申请');
    const denied=await make('仓库取消不可删除');await flow.submitApplicationDraft(ops,denied.runs[0].id,denied.runs[0].revision,key());d=await flow.detail(wh,denied.runs[0].id);await flow.stop(wh,d.id,'cancel',{revision:d.revision,stepId:d.activeStep!.id,reason:'仓库取消'});header=await flow.applicationDraftHeader(ops,'sku-batch-apply',denied.batchKey);expect(header.canDelete).toBe(false);
    const result=await make('已有结果保护'),raw=await ds.manager.findOneByOrFail(FlowRun,{companyId:ops.companyId,id:result.runs[0].id});raw.payload={...raw.payload,_created:[{bundleId:1}]};await ds.manager.save(FlowRun,raw);header=await flow.applicationDraftHeader(ops,'sku-batch-apply',result.batchKey);expect(header.canDelete).toBe(false);await expect(flow.removeApplicationDraftBatch(ops,'sku-batch-apply',result.batchKey,header.headerVersion,result.runs,'禁止误删已发布结果')).rejects.toThrow(/发布结果/);
  });


  it('原申请主商品整数、包装六位小数从仓库到真实发布不截成三位或四位',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),quantity=nextQty(),spec={name:'六位数量发布',main:[{baseCodeId:ids.pearBc,qty:quantity}],gift:[]},made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([spec])]});const id=made.runs[0].id;
    const board=await batch.board(ops,made.batchKey);expect(board.items[0].specName).toBe(spec.name);const preview=await sku.preview(admin,id);expect(preview.specs[0].lines[0].qty).toBe(quantity);expect(preview.specs[0].totalCost).toBeGreaterThan(0);await flow.submitApplicationDraft(ops,id,made.runs[0].revision,key());let d=await flow.detail(wh,id);
    const config={lines:[{role:'package',baseCodeId:ids.boxBc,qty:.123456}],notRequired:{label:'不贴标签',other:'没有其他材料',labor:'无需人工'}};d=await flow.pass(wh,id,{revision:d.revision,stepId:d.activeStep!.id,form:{config:[config]}});expect(d.activeStep!.key).toBe('review');await finPass(fin,d);const stored=await ds.manager.findOneByOrFail(FlowRun,{companyId:ops.companyId,id}),created=stored.payload._created as Array<{bundleId:number}>;expect(created.length).toBeGreaterThan(0);for(const item of created){const lines=await ds.manager.find(ResourceRecord,{where:{companyId:ops.companyId,type:'finance-bundle-lines'}});expect(lines.filter(line=>line.data.bundleId===item.bundleId&&line.data.role==='main')[0].data.qty).toBe(quantity);expect(lines.filter(line=>line.data.bundleId===item.bundleId&&line.data.role==='package')[0].data.qty).toBe(.123456);}
  });


  it('真24 main/gift小数可暂存与复制草稿，但正式查重/提交须正整数，不放宽普通BOM/JST边界',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),spec={name:'可暂存小数草稿',main:[{baseCodeId:ids.pearBc,qty:.5}],gift:[]},made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([spec])]});const id=made.runs[0].id;
    expect((await sku.preview(admin,id)).planError).toContain('基础SKU的正整数件数');await flow.saveApplicationDraft(ops,id,made.runs[0].revision,{specs:[{...spec,main:[{baseCodeId:ids.pearBc,qty:.000001}]}]});let d=await flow.detail(ops,id);expect((d.payload.specs as Array<{main:Array<{qty:number}>}>)[0].main[0].qty).toBe(.000001);await expect(flow.submitApplicationDraft(ops,id,d.revision,key())).rejects.toThrow(/基础SKU的正整数件数/);expect((await flow.detail(ops,id)).status).toBe('draft');expect(await ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:id}})).toBe(0);
    const copied=await flow.addApplicationDrafts(ops,'sku-batch-apply',made.batchKey,made.headerVersion,key(),[{specs:[{name:'小数草稿副本'}]}],{id,revision:d.revision});d=await flow.detail(ops,copied.runs[0].id);expect((d.payload.specs as Array<{main:Array<{qty:number}>}>)[0].main[0].qty).toBe(.000001);await expect(flow.start(ops,'sku-batch-apply',payload([spec]),key())).rejects.toThrow(/整数/);
  });


  it('SKU目录多选数据只需apply；真实目录分页/成本ACL，仓库必须实际办理此SKU步骤才可读本角色选项',async()=>{
    expect((await sku.catalogNames(ops,String(ids.pearBc))).items[0]).not.toHaveProperty('costCents');expect((await sku.catalogNames(admin,String(ids.pearBc))).items[0]).toHaveProperty('costCents');
    const first=await sku.catalogOptions(ops,'main',{page:1,pageSize:1});expect(first.total).toBeGreaterThanOrEqual(3);expect(first.items).toHaveLength(1);expect(first.categories.some(row=>row.id.startsWith('archive:'))).toBe(true);expect(first.items[0]).not.toHaveProperty('costCents');const second=await sku.catalogOptions(ops,'main',{page:2,pageSize:1});expect(second.items[0].id).not.toBe(first.items[0].id);expect((await sku.catalogOptions(admin,'main',{keyword:'梨'})).items[0]).toHaveProperty('costCents');
    await expect(sku.catalogOptions(noApply,'main',{})).rejects.toThrow(/权限/);const run=await toWarehouse([qspec('仓库目录鉴权',ids.pearBc,nextQty())]);const allowed=await sku.catalogOptions(wh,'package',{runId:run.id});expect(allowed.items.map(row=>row.id)).toContain(ids.boxBc);expect(allowed.items.every(row=>!Object.hasOwn(row,'costCents'))).toBe(true);await expect(sku.catalogOptions(wh,'main',{runId:run.id})).rejects.toThrow(/当前SKU步骤/);await expect(sku.catalogOptions({...stranger,permissions:{isCompanyAdmin:false,allow:['flow.overview.view'],deny:[]}},'package',{runId:run.id})).rejects.toThrow(/当前SKU步骤/);await expect(sku.catalogOptions(wh2,'package',{runId:run.id})).rejects.toThrow();
    const extraPlatform=await resources.create(admin,'finance-platforms',{code:'UNRELATEDMETA',name:'无关平台'}),viewer={...stranger,permissions:{isCompanyAdmin:false,allow:['flow.overview.view'],deny:[]}};expect((await sku.options(viewer,'meta','','',{runId:run.id})).platforms?.map(row=>row.id)).not.toContain(extraPlatform.id);expect((await sku.catalogNames(viewer,`${ids.pearBc},${ids.appleBc}`,run.id)).items.map(row=>row.id)).toEqual([ids.pearBc]);
    const named=await sku.options(wh,'names','',`${ids.pearBc},${ids.boxBc}`,{runId:run.id});expect(named.items?.map(row=>row.id)).toEqual([ids.pearBc]);const review=await whPass(wh,run,[whLines()]);expect((await sku.options(fin,'meta','','',{runId:review.id})).platforms?.length).toBeGreaterThan(0);await expect(sku.catalogOptions(fin,'main',{runId:review.id})).rejects.toThrow(/当前SKU步骤/);
  });

  it('原SKU商品目录按真实更新时间降序，搜索只认名称编码不让规格误命中；成本ACL与分页保持',async()=>{
    const idsToSort=[ids.appleBc,ids.mangoBc,ids.pearBc],before=await ds.manager.findBy(ResourceRecord,{companyId:ops.companyId,id:In(idsToSort)});
    try{
      for(const [index,id]of idsToSort.entries())await ds.manager.query('UPDATE resource_records SET updated_at=? WHERE company_id=? AND id=?',[new Date(Date.UTC(2025,0,index+1)),ops.companyId,id]);
      const all=await sku.catalogOptions(ops,'main',{page:1,pageSize:100});expect(all.items.filter(row=>idsToSort.includes(row.id)).map(row=>row.id)).toEqual([...idsToSort].reverse());expect(all.items.every(row=>!Object.hasOwn(row,'costCents'))).toBe(true);
      const apple=before.find(row=>row.id===ids.appleBc)!;expect(apple.data.spec).toBe('1KG');expect(String(apple.data.name)+' '+String(apple.data.code)).not.toContain('1KG');const units=await sku.catalogOptions(ops,'main',{keyword:'1KG',pageSize:100});for(const id of idsToSort)expect(units.items.map(row=>row.id)).not.toContain(id);
      expect((await sku.catalogOptions(ops,'main',{keyword:'APPLE-A'})).items.map(row=>row.id)).toContain(ids.appleBc);expect((await sku.catalogOptions(ops,'main',{keyword:'苹果'})).items.map(row=>row.id)).toContain(ids.appleBc);await expect(sku.catalogOptions(noApply,'main',{})).rejects.toThrow(/权限/);
    }finally{for(const row of before)await ds.manager.query('UPDATE resource_records SET updated_at=? WHERE company_id=? AND id=?',[row.updatedAt,ops.companyId,row.id]);}
  });

  it('SKU角色目录保留同公司空树；搜索仅筛结果，原加载目录祖先计数与空目录选择保持',async()=>{
    const root=await resources.create(admin,'finance-code-dictionaries',{kind:'product_category',name:'原料档案',code:'EMPTY-TREE-RAW'}),leaf=await resources.create(admin,'finance-code-dictionaries',{kind:'product_category',name:'有货目录',code:'EMPTY-TREE-LIVE',parentId:root.id}),empty=await resources.create(admin,'finance-code-dictionaries',{kind:'product_category',name:'空目录',code:'EMPTY-TREE-ZERO',parentId:root.id}),excluded=await resources.create(admin,'finance-code-dictionaries',{kind:'product_category',name:'产品包装档案',code:'EMPTY-TREE-PACK'});
    const archive=await resources.create(admin,'finance-categories',{archiveType:'raw',name:'空档案目录',code:'ETAR'}),archiveLeaf=await resources.create(admin,'finance-categories',{archiveType:'raw',name:'空档案下级',code:'ETAR1',parentId:archive.id});
    const other=await ds.manager.save(Company,ds.manager.create(Company,{code:`empty${crypto.randomBytes(4).toString('hex')}`,name:'目录隔离公司',status:'active'})),otherAdmin={...admin,companyId:other.id,id:await mkUser(other.id,'emptyAdmin','隔离目录管理员',{isCompanyAdmin:true})},foreign=await resources.create(otherAdmin,'finance-code-dictionaries',{kind:'product_category',name:'原料档案',code:'FOREIGN-EMPTY'});
    const source=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:ids.pearBc});
    const made:ResourceRecord[]=[];for(const [code,name]of [['EMPTY-TREE-A','独有查询甲'],['EMPTY-TREE-B','独有查询乙']])made.push(await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{...source,id:undefined,uniqueKey:null,title:code,data:{origin:'external_import',code,name,codeDictionaryCategoryId:leaf.id,codeSpecQty:1,codeSpecUnit:'KG',cost:123.4567,weightG:50},searchText:`${code} ${name}`})));
    const all=await sku.catalogOptions(ops,'main',{pageSize:100}),find=(rows:typeof all.categories,id:string)=>rows.find(row=>row.id===id);
    expect(find(all.categories,`code:${root.id}`)?.count).toBe(2);expect(find(all.categories,`code:${leaf.id}`)?.count).toBe(2);expect(find(all.categories,`code:${empty.id}`)).toMatchObject({parentId:`code:${root.id}`,count:0});expect(find(all.categories,`archive:${archive.id}`)?.count).toBe(0);expect(find(all.categories,`archive:${archiveLeaf.id}`)).toMatchObject({parentId:`archive:${archive.id}`,count:0});for(const id of [excluded.id,foreign.id])expect(find(all.categories,`code:${id}`)).toBeUndefined();
    const searched=await sku.catalogOptions(ops,'main',{keyword:'独有查询甲',pageSize:100});expect(searched.items.map(row=>row.id)).toEqual([made[0].id]);expect(find(searched.categories,`code:${root.id}`)?.count).toBe(2);expect(find(searched.categories,`code:${leaf.id}`)?.count).toBe(2);expect(find(searched.categories,`code:${empty.id}`)?.count).toBe(0);expect(searched.items[0]).not.toHaveProperty('costCents');
    const chosen=await sku.catalogOptions(ops,'main',{keyword:'独有查询甲',category:`code:${empty.id}`,pageSize:100});expect(chosen.items).toEqual([]);expect(chosen.total).toBe(0);expect(chosen.categories).toEqual(searched.categories);const none=await sku.catalogOptions(ops,'main',{keyword:'不存在的目录查询',pageSize:100});expect(none.categories).toHaveLength(all.categories.length);expect(none.categories).toEqual(all.categories);expect(none.items).toEqual([]);expect((await sku.catalogOptions(admin,'main',{keyword:'EMPTY-TREE-A'})).items[0].costCents).toBe(123.4567);await expect(sku.catalogOptions(noApply,'main',{})).rejects.toThrow(/权限/);
  });

  it('SKU人工只选同公司当前有效启用版本；边界当天可用，暂存旧项而正式check/提交拒绝，旧BOM/历史不改',async()=>{
    const template=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),old=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:ids.labor}),day=todayInChina();
    const make=async(name:string,dates:Record<string,string>={},state:'active'|'inactive'|'draft'='active',actor=admin)=>{const v=await resources.create(actor,'finance-labor-versions',{versionCode:'SKU'+key().slice(0,10),versionName:name,...dates}),cat=await resources.create(actor,'finance-labor-categories',{versionId:v.id,name:'本版本归档'}),workTypeId=actor.companyId===admin.companyId?old.data.workTypeId:(await resources.create(actor,'finance-labor-work-types',{name:'同公司工作分类'})).id,unitId=actor.companyId===admin.companyId?old.data.unitId:(await resources.create(actor,'finance-labor-units',{name:'元/个'})).id,item=await resources.create(actor,'finance-labor-costs',{versionId:v.id,archiveCategoryId:cat.id,workTypeId,unitId,workName:name,unitPrice:100});if(state!=='draft'){await resources.changeStatus(actor,'finance-labor-versions',v.id,'active');if(state==='inactive')await resources.changeStatus(actor,'finance-labor-versions',v.id,'inactive','合成停用版本');}return {v,item};};
    const today=await make('SKU当天人工',{effectiveFrom:day,effectiveTo:day}),future=await make('SKU未来人工',{effectiveFrom:'2099-01-01'}),past=await make('SKU过期人工',{effectiveTo:'2000-01-01'}),stopped=await make('SKU停用版本人工',{},'inactive'),draft=await make('SKU草稿版本人工',{},'draft');
    const company=await ds.manager.save(Company,ds.manager.create(Company,{code:'labor'+crypto.randomBytes(5).toString('hex'),name:'SKU人工隔离公司',status:'active'})),foreignAdmin={...admin,companyId:company.id,id:await mkUser(company.id,'labor-admin','隔离人工管理员',{isCompanyAdmin:true})},foreign=await make('SKU隔离人工',{},'active',foreignAdmin);
    const chinese:number[]=[];for(const name of ['扎口','贴标'])chinese.push((await resources.create(admin,'finance-labor-costs',{versionId:today.v.id,archiveCategoryId:today.item.data.archiveCategoryId,workTypeId:old.data.workTypeId,unitId:old.data.unitId,workName:name,unitPrice:100})).id);
    const previous=await toReview([qspec('人工可用范围前的实际发布',ids.mangoBc,nextQty())]);await finPass(fin,previous);
    const catalog=await sku.catalogOptions(ops,'labor',{pageSize:100}),selectable=catalog.items.map(row=>row.id);expect(selectable).toContain(today.item.id);expect(catalog.items.filter(row=>chinese.includes(row.id)).map(row=>row.name)).toEqual(['扎口','贴标']);for(const row of [future,past,stopped,draft,foreign])expect(selectable).not.toContain(row.item.id);expect(catalog.items.every(row=>!Object.hasOwn(row,'costCents'))).toBe(true);
    const bom=await ds.manager.findBy(ResourceRecord,{companyId:ops.companyId,type:'finance-bundle-lines'}),oldHistory=await ds.manager.find(FlowStep,{where:{companyId:ops.companyId,stepKey:'warehouse',action:'pass'}});const history=oldHistory.map(row=>({id:row.id,form:JSON.parse(JSON.stringify(row.form))})),oldCosts=JSON.parse(JSON.stringify(await ds.manager.find(FinanceCostSnapshot,{where:{companyId:ops.companyId},order:{id:'ASC'}})));expect(bom.length).toBeGreaterThan(0);expect(history.length).toBeGreaterThan(0);expect(oldCosts.length).toBeGreaterThan(0);
    const made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:template.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('SKU人工有效期边界',ids.pearBc,nextQty())])]});await flow.submitApplicationDraft(ops,made.runs[0].id,made.runs[0].revision,key());let run=await flow.detail(wh,made.runs[0].id);
    const config=(laborId:number)=>[whLines({lines:[...whLines().lines.filter(line=>line.role!=='labor'),{role:'labor',laborId,qty:.123456}]})];
    for(const invalid of [future,past,stopped,draft]){run=await flow.saveStepDraft(wh,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{config:config(invalid.item.id),note:'保留旧引用待核对'}});expect((await sku.preview(wh,run.id,run.revision)).planError).toContain('版本');await expect(flow.pass(wh,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{config:config(invalid.item.id)}})).rejects.toThrow('版本');expect((await flow.detail(wh,run.id)).revision).toBe(run.revision);expect((await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:invalid.item.id})).status).toBe('active');}
    await expect(flow.saveStepDraft(wh,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{config:config(foreign.item.id)}})).rejects.toThrow('不存在');const previewConfig=config(today.item.id);const reviewed=await flow.pass(wh,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{config:previewConfig}});expect(reviewed.activeStep?.key).toBe('review');await resources.changeStatus(admin,'finance-labor-versions',today.v.id,'inactive','合成财务办理前版本停用');await expect(flow.pass(fin,reviewed.id,{revision:reviewed.revision,stepId:reviewed.activeStep!.id,form:{confirmed:true}})).rejects.toThrow('版本');expect((await flow.detail(fin,reviewed.id)).revision).toBe(reviewed.revision);expect(JSON.parse(JSON.stringify(await ds.manager.find(FinanceCostSnapshot,{where:{companyId:ops.companyId},order:{id:'ASC'}})))).toEqual(oldCosts);
    const reuseTarget=await toWarehouse([qspec('失效人工来源读取',ids.mangoBc,nextQty())]),library=await sku.reuseLibrary(wh,reuseTarget.id);expect(library.rows.find(row=>row.runId===reviewed.id)?.config.lines.some(line=>line.laborId===today.item.id&&line.qty===.123456)).toBe(true);expect(library.references.find(row=>row.id===today.item.id)?.available).toBe(false);expect((await ds.manager.findOneByOrFail(FlowStep,{companyId:ops.companyId,runId:reviewed.id,stepKey:'warehouse',action:'pass'})).form?.config).toEqual(previewConfig);
    expect((await ds.manager.findBy(ResourceRecord,{companyId:ops.companyId,type:'finance-bundle-lines'})).map(row=>({id:row.id,data:row.data}))).toEqual(bom.map(row=>({id:row.id,data:row.data})));for(const entry of history)expect((await ds.manager.findOneByOrFail(FlowStep,{companyId:ops.companyId,id:entry.id})).form).toEqual(entry.form);
  });

  it('外部无productId编码沿真实编码分类根族进入SKU目录，不造商品、不将编码树与档案树同名合并',async()=>{
    const root=(await ds.manager.find(ResourceRecord,{where:{companyId:admin.companyId,type:'finance-code-dictionaries'}})).find(row=>row.data.kind==='product_category'&&row.data.name==='原料档案'&&row.data.parentId==null)??await resources.create(admin,'finance-code-dictionaries',{kind:'product_category',name:'原料档案',code:'CATALOG-RAW'}),leaf=await resources.create(admin,'finance-code-dictionaries',{kind:'product_category',name:'导入水果',code:'CATALOG-FRUIT',parentId:root.id}),source=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:ids.pearBc});
    const external=await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{...source,id:undefined,uniqueKey:null,title:'EXTERNAL-CATALOG',data:{origin:'external_import',code:'EXTERNAL-CATALOG',name:'真实导入成本编码',codeDictionaryCategoryId:leaf.id,codeSpecQty:1,codeSpecUnit:'KG',codeBrandId:ids.mainBrand,externalCost:123.4567,cost:123.4567,weightG:50},searchText:'EXTERNAL-CATALOG 真实导入成本编码'}));
    const selected=await sku.catalogOptions(ops,'main',{keyword:'EXTERNAL-CATALOG',category:`code:${root.id}`});expect(selected.items).toMatchObject([{id:external.id,categoryKey:`code:${leaf.id}`}]);expect(selected.items[0]).not.toHaveProperty('costCents');expect((await ds.manager.findOneByOrFail(ResourceRecord,{id:external.id,companyId:ops.companyId})).data).not.toHaveProperty('productId');expect(selected.categories.some(row=>row.id===`code:${root.id}`)).toBe(true);await expect(resources.create(admin,'finance-base-codes',{...external.data,code:'CLIENT-FAKE-IMPORT'})).rejects.toThrow(/只能通过商品数据导入/);
  });

  it('原仓库暂存沿当前步骤事务，不流转/通知/新待办；六位数量与1000字说明保真，校验仍要求完整',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'});
    const made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('仓库实际暂存',ids.pearBc,nextQty())])]});
    const id=made.runs[0].id;await flow.submitApplicationDraft(ops,id,made.runs[0].revision,key());const initial=await flow.detail(wh,id),stepId=initial.activeStep!.id;
    expect(initial.stepDraft?.canSave).toBe(true);expect((await flow.detail(ops,id)).stepDraft?.canSave).toBe(false);
    const counts=async()=>Promise.all([ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:id}}),ds.manager.count(Notification,{where:{companyId:ops.companyId}}),ds.manager.count(OutboxJob,{where:{companyId:ops.companyId}}),ds.manager.count(FlowStep,{where:{runId:id}})]);
    const before=await counts(),form={config:[{lines:[{role:'package',baseCodeId:ids.boxBc,qty:.123456}],notRequired:{}}],note:'仓'.repeat(1000)};
    await expect(flow.saveStepDraft(ops,id,{revision:initial.revision,stepId,form})).rejects.toThrow(/不是你办理/);
    const saved=await flow.saveStepDraft(wh,id,{revision:initial.revision,stepId,form});expect(saved.revision).toBe(initial.revision+1);expect(saved.activeStep!.id).toBe(stepId);expect(saved.stepDraft!.form).toEqual(form);expect(await counts()).toEqual(before);expect(saved.status).toBe('running');
    expect((await sku.preview(wh,id)).planError).toContain('要么');expect((await sku.preview(wh,id)).specs[0].warehouse[0].qty).toBe(.123456);
    await expect(flow.pass(wh,id,{revision:saved.revision,stepId,form})).rejects.toThrow(/要么/);
    await expect(flow.saveStepDraft(wh,id,{revision:initial.revision,stepId,form})).rejects.toThrow();
    await expect(flow.saveStepDraft(wh,id,{revision:saved.revision,stepId,form:{...form,note:'仓'.repeat(1001)}})).rejects.toThrow();
    const invalid={config:[{lines:[{role:'package',baseCodeId:ids.appleBc,qty:1}],notRequired:{}}]};await expect(flow.saveStepDraft(wh,id,{revision:saved.revision,stepId,form:invalid})).rejects.toThrow(/不能当作/);
    expect((await flow.detail(wh,id)).revision).toBe(saved.revision);expect((await flow.detail(wh,id)).stepDraft!.form).toEqual(form);
    const event=jest.spyOn(flow,'event').mockRejectedValueOnce(new Error('合成事件失败'));await expect(flow.saveStepDraft(wh,id,{revision:saved.revision,stepId,form:{...form,note:'不应留下'}})).rejects.toThrow('合成事件失败');event.mockRestore();expect((await flow.detail(wh,id)).stepDraft!.form).toEqual(form);
    const parallel=await Promise.allSettled([1,2].map(value=>flow.saveStepDraft(wh,id,{revision:saved.revision,stepId,form:{...form,note:`并发${value}`}})));expect(parallel.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const ordinary=await toWarehouse([qspec('普通流程没有暂存能力',ids.pearBc,nextQty())]);await expect(flow.saveStepDraft(wh,ordinary.id,{revision:ordinary.revision,stepId:ordinary.activeStep!.id,form})).rejects.toThrow(/不支持/);
    const foreign={...wh,companyId:ops.companyId+99999};await expect(flow.saveStepDraft(foreign,id,{revision:saved.revision+1,stepId,form})).rejects.toThrow();
  });

  it('仓库来源库取真实已提交步骤及原主品事实，后续运营修改不改写来源；只准当前仓库办理人且成本独立ACL',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),quantity=nextQty();
    const made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('历史提交来源',ids.pearBc,quantity)])]});const id=made.runs[0].id;await flow.submitApplicationDraft(ops,id,made.runs[0].revision,key());let detail=await flow.detail(wh,id);await flow.saveStepDraft(wh,id,{revision:detail.revision,stepId:detail.activeStep!.id,form:{config:[whLines()],note:'真实仓库历史说明',_skuSource:{specs:[qspec('伪造来源',ids.appleBc,1)]}}});detail=await flow.detail(wh,id);const review=await flow.pass(wh,id,{revision:detail.revision,stepId:detail.activeStep!.id,form:{config:[whLines()],note:'真实仓库历史说明'}});
    const target=await toWarehouse([qspec('来源库当前待办',ids.appleBc,nextQty())]);const allowed=await sku.reuseLibrary(wh,target.id);const historical=allowed.rows.find(row=>row.runId===id)!;expect(historical.main).toMatchObject([{baseCodeId:ids.pearBc,qty:quantity}]);expect(historical.note).toBe('真实仓库历史说明');expect(allowed.references.every(ref=>!Object.hasOwn(ref,'costCents'))).toBe(true);expect((await sku.reuseLibrary({...wh,permissions:{isCompanyAdmin:false,allow:['product.cost.view'],deny:[]}},target.id)).references.some(ref=>Object.hasOwn(ref,'costCents'))).toBe(true);
    await flow.returnBack(fin,id,{revision:review.revision,stepId:review.activeStep!.id,reason:'退回调整'});detail=await flow.detail(wh,id);await flow.returnBack(wh,id,{revision:detail.revision,stepId:detail.activeStep!.id,reason:'运营改主品'});detail=await flow.detail(ops,id);await flow.saveApplicationDraft(ops,id,detail.revision,{specs:[qspec('现主品已经改为苹果',ids.appleBc,nextQty())]});expect((await sku.reuseLibrary(wh,target.id)).rows.find(row=>row.runId===id)?.main).toMatchObject([{baseCodeId:ids.pearBc,qty:quantity}]);
    const oldStep=await ds.manager.findOneByOrFail(FlowStep,{companyId:ops.companyId,runId:id,stepKey:'warehouse',action:'pass'});const oldForm={...oldStep.form};delete oldForm._skuSource;oldStep.form=oldForm;await ds.manager.save(FlowStep,oldStep);expect((await sku.reuseLibrary(wh,target.id)).rows.some(row=>row.runId===id)).toBe(false);
    await expect(sku.reuseLibrary(ops,target.id)).rejects.toThrow(/当前仓库/);await expect(sku.reuseLibrary(admin,target.id)).rejects.toThrow(/当前仓库/);await expect(sku.reuseLibrary(wh2,target.id)).rejects.toThrow();await expect(sku.reuseLibrary({...wh,companyId:wh.companyId+99999},target.id)).rejects.toThrow();await expect(sku.reuseLibrary(wh,undefined)).rejects.toThrow();
    const box=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:ids.boxBc});await ds.manager.update(ResourceRecord,{companyId:ops.companyId,id:ids.boxBc},{archivedAt:new Date()});try{expect((await sku.reuseLibrary(wh,target.id)).references.find(ref=>ref.id===ids.boxBc)?.available).toBe(false);}finally{await ds.manager.update(ResourceRecord,{companyId:ops.companyId,id:ids.boxBc},{archivedAt:box.archivedAt});}
  });

  it('真实HTTP仓库暂存DTO/来源库拒绝越公司字段及非办理人，成功只增revision不流转',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('HTTP仓库保存',ids.pearBc,nextQty())])]});const id=made.runs[0].id;await flow.submitApplicationDraft(ops,id,made.runs[0].revision,key());const detail=await flow.detail(wh,id);let actor=wh;
    const module=await Test.createTestingModule({controllers:[FlowController,SkuApplyController],providers:[{provide:FlowService,useValue:flow},{provide:SkuApplyService,useValue:sku},{provide:SkuBatchService,useValue:batch},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile(),app=module.createNestApplication();app.use((req:{user?:AuthUser},_res:unknown,next:()=>void)=>{req.user=actor;next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');const base=await app.getUrl(),body={revision:detail.revision,stepId:detail.activeStep!.id,form:{config:[{lines:[],notRequired:{}}],note:'HTTP真实暂存'}};
    try{const send=(path:string,method='GET',value?:unknown)=>fetch(base+path,{method,headers:{'content-type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});expect((await send(`/flow/runs/${id}/step-draft`,'PUT',{...body,companyId:999})).status).toBe(400);actor=ops;expect((await send(`/flow/runs/${id}/step-draft`,'PUT',body)).status).toBe(403);expect((await send(`/flow/sku-apply/history-config?sourceLibrary=true&runId=${id}`)).status).toBe(403);actor=wh;expect((await send(`/flow/sku-apply/history-config?sourceLibrary=true&runId=${id}&companyId=999`)).status).toBe(400);const response=await send(`/flow/runs/${id}/step-draft`,'PUT',body);expect(response.status).toBe(200);const result=await response.json() as {revision:number;activeStep:{id:number};status:string};expect(result).toMatchObject({revision:detail.revision+1,status:'running',activeStep:{id:detail.activeStep!.id}});}finally{await app.close();}
  });

  it('查重保持只读且核当前办理人/版本；仅提交事务留真实快照，现价变化不改历史，保存/退回清除',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('真实提交快照',ids.pearBc,nextQty())])]});const id=made.runs[0].id;
    const read=()=>ds.manager.findOneByOrFail(FlowRun,{companyId:ops.companyId,id}),before=await read();await sku.preview(ops,id,before.revision);expect((await read()).payload).not.toHaveProperty('_review');expect((await read()).revision).toBe(before.revision);await expect(sku.preview(stranger,id,before.revision)).rejects.toThrow(/当前节点/);await expect(sku.preview(ops,id,before.revision+1)).rejects.toThrow();
    await flow.submitApplicationDraft(ops,id,before.revision,key());let detail=await flow.detail(wh,id);expect(detail).toHaveProperty('inspection.stage','apply');expect(JSON.stringify(detail)).not.toContain('totalCostCents');const applySnapshot=JSON.parse(JSON.stringify((await read()).payload._review));await sku.preview(wh,id,detail.revision);expect((await read()).payload._review).toEqual(applySnapshot);await expect(sku.preview(ops,id,detail.revision)).rejects.toThrow(/当前节点/);
    await flow.saveStepDraft(wh,id,{revision:detail.revision,stepId:detail.activeStep!.id,form:{config:[whLines()]}});expect((await read()).payload).not.toHaveProperty('_review');detail=await flow.detail(wh,id);await flow.pass(wh,id,{revision:detail.revision,stepId:detail.activeStep!.id,form:{config:[whLines()]}});const snapshot=JSON.parse(JSON.stringify((await read()).payload._review));expect(snapshot.stage).toBe('warehouse');expect((await flow.detail(fin,id))).toHaveProperty('inspection.specs.0.totalCostCents',snapshot.specs[0].totalCostCents);expect(JSON.stringify(await flow.detail(ops,id))).not.toContain('totalCostCents');
    const base=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:ids.pearBc}),product=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:Number(base.data.productId)}),price=Number(product.data.purchasePrice);await resources.update(admin,'finance-products',product.id,{purchasePrice:price+100});try{expect((await flow.detail(fin,id))).toHaveProperty('inspection.specs.0.totalCostCents',snapshot.specs[0].totalCostCents);expect((await read()).payload._review).toEqual(snapshot);const current=await sku.preview(fin,id,(await read()).revision);expect(current.specs[0].totalCost).not.toBe(snapshot.specs[0].totalCostCents);const review=await flow.detail(fin,id);await expect(flow.pass(fin,id,{revision:review.revision,stepId:review.activeStep!.id,form:{confirmed:true}})).rejects.toThrow(/发生了变化|还没验证/);await flow.returnBack(fin,id,{revision:review.revision,stepId:review.activeStep!.id,reason:'来源变动退回'});expect((await read()).payload).not.toHaveProperty('_review');}finally{await resources.update(admin,'finance-products',product.id,{purchasePrice:price});await resources.changeStatus(admin,'finance-base-codes',base.id,'verified');}
  });

  it('提交快照新增/复用标记只取同次真实preview，旧快照缺字段不猜且金额ACL不变',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),quantity=nextQty(),spec={...qspec('新增事实',ids.pearBc,quantity),brandId:ids.mainBrand};
    const make=async(value:unknown)=>flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([value])]});
    const first=await make(spec);await flow.submitApplicationDraft(ops,first.runs[0].id,first.runs[0].revision,key());let review=await whPass(wh,await flow.detail(wh,first.runs[0].id),[whLines()]);expect(review).toHaveProperty('inspection.specs.0.targets.0.existing',false);await flow.pass(fin,review.id,{revision:review.revision,stepId:review.activeStep!.id,form:{confirmed:true}});
    const second=await make({...spec,name:'复用事实',reuseReason:'确认复用已生成编码'}),secondId=second.runs[0].id,checked=await sku.preview(ops,secondId,second.runs[0].revision);expect(checked.generatedDuplicates?.length).toBeGreaterThan(0);await expect(flow.submitApplicationDraft(ops,secondId,second.runs[0].revision,key())).rejects.toThrow(/二次确认/);await flow.submitApplicationDraft(ops,secondId,second.runs[0].revision,key(),{token:checked.duplicateToken!,confirmed:true,reason:'已核对并继续复用'});let warehouse=await flow.detail(wh,secondId);warehouse=await flow.saveStepDraft(wh,secondId,{revision:warehouse.revision,stepId:warehouse.activeStep!.id,form:{config:[whLines()]}});const checkedWarehouse=await sku.preview(wh,secondId,warehouse.revision);review=await flow.pass(wh,secondId,{revision:warehouse.revision,stepId:warehouse.activeStep!.id,form:{config:[whLines()]},confirmation:{token:checkedWarehouse.duplicateToken!,confirmed:true,reason:'仓库已核对并复用'}});ids.duplicateRun=review.id;expect(review).toHaveProperty('inspection.specs.0.targets.0.existing',true);const publicView=await flow.detail(ops,review.id);expect(publicView).toHaveProperty('inspection.specs.0.targets.0.existing',true);expect(JSON.stringify(publicView)).not.toContain('totalCostCents');
    const row=await ds.manager.findOneByOrFail(FlowRun,{companyId:ops.companyId,id:review.id}),old=row.payload._review as {specs:Array<{targets:Array<{existing?:boolean}>}>};for(const item of old.specs)for(const target of item.targets)delete target.existing;await ds.manager.save(FlowRun,row);expect(await flow.detail(fin,row.id)).not.toHaveProperty('inspection.specs.0.targets.0.existing');
  });

  it('重复SKU二次确认绑定真实资料和版本，缺确认/假token拒绝；审核末步失败回滚，重复并发只审核一次',async()=>{
    const id=ids.duplicateRun,detail=await flow.detail(fin,id),checked=await sku.preview(fin,id,detail.revision);expect(checked.generatedDuplicates?.length).toBeGreaterThan(0);const proof={token:checked.duplicateToken!,confirmed:true,reason:'财务已核对已有SKU并继续申请'},command={revision:detail.revision,stepId:detail.activeStep!.id,form:{confirmed:true}};
    await expect(flow.pass(fin,id,command)).rejects.toThrow(/二次确认/);await expect(flow.pass(fin,id,{...command,confirmation:{...proof,confirmed:false}})).rejects.toThrow(/二次确认/);await expect(flow.pass(fin,id,{...command,confirmation:{...proof,token:'0'.repeat(64)}})).rejects.toThrow(/二次确认/);await expect(flow.pass(fin,id,{...command,confirmation:{...proof,reason:' '}})).rejects.toThrow(/二次确认/);await expect(flow.pass({...fin,companyId:fin.companyId+99999},id,{...command,confirmation:proof})).rejects.toThrow();
    const auditCount=()=>ds.manager.count(AuditLog,{where:{companyId:fin.companyId,resourceType:'flow_run',resourceId:String(id),action:'flow.application-duplicate.confirm'}}),before=await auditCount();const event=jest.spyOn(flow,'event').mockRejectedValueOnce(new Error('合成审核末步失败'));try{await expect(flow.pass(fin,id,{...command,confirmation:proof})).rejects.toThrow('合成审核末步失败');}finally{event.mockRestore();}expect(await auditCount()).toBe(before);expect((await ds.manager.findOneByOrFail(FlowRun,{companyId:fin.companyId,id})).payload).not.toHaveProperty('_created');expect((await flow.detail(fin,id)).revision).toBe(detail.revision);
    const results=await Promise.allSettled([1,2].map(()=>flow.pass(fin,id,{...command,confirmation:proof})));expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await auditCount()).toBe(before+1);expect((await flow.detail(fin,id)).status).toBe('completed');const audit=await ds.manager.findOneByOrFail(AuditLog,{companyId:fin.companyId,resourceType:'flow_run',resourceId:String(id),action:'flow.application-duplicate.confirm',actorId:fin.id});expect(audit.detail).toMatchObject({actorId:fin.id,reason:proof.reason});
  });

  it('仓库复用来源上下文由真实同公司已提交步骤建立，保存重开/再保存/提交保留，伪造名字与假来源无效；人工读真实unitId',async()=>{
    const source=await toWarehouse([qspec('真实复用历史标题',ids.pearBc,nextQty())]);await whPass(wh,source,[whLines()]);const target=await toWarehouse([qspec('普通申请默认无暂存',ids.appleBc,nextQty())]);
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('可信复用目标',ids.appleBc,nextQty())])]});const id=made.runs[0].id;await flow.submitApplicationDraft(ops,id,made.runs[0].revision,key());let current=await flow.detail(wh,id);const row=(await sku.reuseLibrary(wh,id)).rows.find(row=>row.runId===source.id)!;expect(row).toBeDefined();
    const form={config:[whLines()],note:'原说明',reuseInfo:{sourceName:'客户端伪造来源',sourceId:'假来源'}};current=await flow.saveStepDraft(wh,id,{revision:current.revision,stepId:current.activeStep!.id,form,draftContext:{reuseSourceId:row.id}});expect(current).toHaveProperty('stepDraft.form.reuseInfo.sourceName','真实复用历史标题');expect(current).toHaveProperty('stepDraft.form.reuseInfo.sourceId',row.id);expect(current).toHaveProperty('stepDraft.form.reuseInfo.statuses.package','copied');const reopened=await flow.detail(wh,id);expect(reopened.stepDraft!.form.reuseInfo).toEqual(current.stepDraft!.form.reuseInfo);
    current=await flow.saveStepDraft(wh,id,{revision:current.revision,stepId:current.activeStep!.id,form});expect(current).toHaveProperty('stepDraft.form.reuseInfo.sourceName','真实复用历史标题');await expect(flow.saveStepDraft(wh,id,{revision:current.revision,stepId:current.activeStep!.id,form,draftContext:{reuseSourceId:'999999999:0'}})).rejects.toThrow(/来源不存在/);await expect(flow.saveStepDraft(wh,id,{revision:current.revision,stepId:current.activeStep!.id,form,draftContext:{reuseSourceId:row.id,sourceName:'伪造'}})).rejects.toThrow(/不支持/);expect((await flow.detail(wh,id)).revision).toBe(current.revision);
    const review=await flow.pass(wh,id,{revision:current.revision,stepId:current.activeStep!.id,form});expect(review.steps.find(step=>step.key==='warehouse'&&step.action==='pass')?.form).toHaveProperty('reuseInfo.sourceName','真实复用历史标题');expect((await sku.preview(fin,id)).specs[0].warehouse.find(line=>line.role==='labor')?.spec).toBe('元/个');const rawLabor=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:ids.labor});expect(rawLabor.data).not.toHaveProperty('unitName');
    await expect(flow.saveStepDraft(wh,target.id,{revision:target.revision,stepId:target.activeStep!.id,form,draftContext:{reuseSourceId:row.id}})).rejects.toThrow(/不支持/);
  });

  it('原SKU审核先等同公司资料事务完成再开始读来源，不在RR旧快照上发布',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('公司锁真实并发',ids.pearBc,nextQty())])]});const id=made.runs[0].id;await flow.submitApplicationDraft(ops,id,made.runs[0].revision,key());const review=await whPass(wh,await flow.detail(wh,id),[whLines()]),base=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:ids.pearBc}),product=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:Number(base.data.productId)}),price=Number(product.data.purchasePrice),holder=ds.createQueryRunner();await holder.connect();await holder.startTransaction();await holder.manager.findOneOrFail(Company,{where:{id:ops.companyId},lock:{mode:'pessimistic_write'}});
    let reached!:()=>void;const requested=new Promise<void>(resolve=>{reached=resolve;}),factory=ds.createQueryRunner.bind(ds),spies:Array<jest.SpyInstance>=[];const runnerSpy=jest.spyOn(ds,'createQueryRunner').mockImplementation((...args)=>{const runner=factory(...args),query=runner.query.bind(runner);spies.push(jest.spyOn(runner,'query').mockImplementation((sql,...params)=>{if(typeof sql==='string'&&sql.includes('`companies`')&&/FOR UPDATE/i.test(sql))reached();return query(sql,...params);}));return runner;});let deadline:ReturnType<typeof setTimeout>|undefined;
    const pending=flow.pass(fin,id,{revision:review.revision,stepId:review.activeStep!.id,form:{confirmed:true}});pending.catch(()=>undefined);
    try{await Promise.race([requested,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('未观察到真实公司锁请求')),2000);})]);if(deadline)clearTimeout(deadline);await resources.updateRecord(holder.manager,admin,'finance-products',product.id,{purchasePrice:price+100},'并发改价');await holder.commitTransaction();await expect(pending).rejects.toThrow(/还没验证|发生了变化/);expect((await ds.manager.findOneByOrFail(FlowRun,{companyId:ops.companyId,id})).payload).not.toHaveProperty('_created');expect((await flow.detail(fin,id)).status).toBe('running');}finally{if(deadline)clearTimeout(deadline);if(holder.isTransactionActive)await holder.rollbackTransaction();await holder.release();runnerSpy.mockRestore();for(const spy of spies)spy.mockRestore();await resources.update(admin,'finance-products',product.id,{purchasePrice:price});await resources.changeStatus(admin,'finance-base-codes',base.id,'verified');}
  });

  it('仅财务退回仓库保留原原因/复用上下文；运营保存清现行确认但不删实际行/说明或历史Step',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('运营修订清确认',ids.appleBc,nextQty())])]});const id=made.runs[0].id;await flow.submitApplicationDraft(ops,id,made.runs[0].revision,key());let current=await flow.detail(wh,id);current=await flow.saveStepDraft(wh,id,{revision:current.revision,stepId:current.activeStep!.id,form:{config:[whLines()],note:'保留的仓库说明'}});let review=await flow.pass(wh,id,{revision:current.revision,stepId:current.activeStep!.id,form:{config:[whLines()],note:'保留的仓库说明'}});const original=await ds.manager.findOneByOrFail(FlowStep,{companyId:ops.companyId,runId:id,stepKey:'warehouse',action:'pass'}),history=JSON.parse(JSON.stringify(original.form));
    await flow.returnBack(fin,id,{revision:review.revision,stepId:review.activeStep!.id,reason:'只退回仓库核对'});current=await flow.detail(wh,id);expect(current.stepDraft!.form).toMatchObject({config:[{notRequired:{other:'没有其他物料'}}],note:'保留的仓库说明'});await flow.returnBack(wh,id,{revision:current.revision,stepId:current.activeStep!.id,reason:'运营补充需求'});let operation=await flow.detail(ops,id);const specs=operation.payload.specs as Array<{name:string;main:Array<{baseCodeId:number;qty:number}>;gift:unknown[]}>;await flow.saveApplicationDraft(ops,id,operation.revision,{specs:[{...specs[0],note:'新运营需求'}]});operation=await flow.detail(ops,id);await flow.resubmit(ops,id,{revision:operation.revision,payload:operation.payload});current=await flow.detail(wh,id);expect((current.stepDraft!.form.config as Array<{lines:unknown[];notRequired:object}>)[0].lines).toHaveLength(3);expect(current.stepDraft!.form).toMatchObject({config:[{notRequired:{}}],note:'保留的仓库说明'});expect((await sku.preview(wh,id,current.revision)).planError).toContain('要么');expect((await ds.manager.findOneByOrFail(FlowStep,{companyId:ops.companyId,id:original.id})).form).toEqual(history);
  });

  it('原申请审核同事务保留缺配置同步意图、retry不发送；真正入队异常回滚审核和生成',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'});
    const ready=async()=>{const made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('审批内同步',ids.appleBc,nextQty())])]});await flow.submitApplicationDraft(ops,made.runs[0].id,made.runs[0].revision,key());const run=await flow.detail(wh,made.runs[0].id);return flow.pass(wh,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{config:[whLines()]}});};
    let run=await ready();const completed=await flow.pass(fin,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{confirmed:true},comment:'真实审核备注'});expect(completed.status).toBe('completed');ids.intentRun=run.id;
    const stored=await ds.manager.findOneByOrFail(FlowRun,{companyId:ops.companyId,id:run.id}),created=stored.payload._created as Array<{bundleId:number}>;
    for(const item of created){const job=await ds.manager.findOneOrFail(OutboxJob,{where:{companyId:ops.companyId,resourceId:item.bundleId,resourceType:'finance-bundles'},order:{id:'DESC'}});expect(job).toMatchObject({status:'failed',attempts:0,payloadJson:{approvalIntent:{runId:run.id},blockedIntent:true}});expect(job.payloadJson.enqueueIssues).toEqual(expect.arrayContaining([expect.objectContaining({code:'configuration_unavailable'})]));expect(await outbox.retry(fin,job.id)).toMatchObject({blocked:true});expect((await ds.manager.findOneByOrFail(OutboxJob,{id:job.id,companyId:ops.companyId})).attempts).toBe(0);}
    expect(completed).toMatchObject({syncIntents:created.map(item=>({bundleId:item.bundleId,state:'blocked_intent'}))});expect((await ds.manager.findOneByOrFail(FlowStep,{companyId:ops.companyId,runId:run.id,stepKey:'review',action:'pass'})).comment).toBe('真实审核备注');
    run=await ready();const before=await ds.manager.count(ResourceRecord,{where:{companyId:ops.companyId,type:'finance-bundles'}}),jobs=await ds.manager.count(OutboxJob,{where:{companyId:ops.companyId}});const failing=jest.spyOn(outbox,'enqueue').mockRejectedValueOnce(new Error('合成事务入队故障'));
    try{await expect(flow.pass(fin,run.id,{revision:run.revision,stepId:run.activeStep!.id,form:{confirmed:true}})).rejects.toThrow('合成事务入队故障');}finally{failing.mockRestore();}
    expect((await flow.detail(fin,run.id)).status).toBe('running');expect(await ds.manager.count(ResourceRecord,{where:{companyId:ops.companyId,type:'finance-bundles'}})).toBe(before);expect(await ds.manager.count(OutboxJob,{where:{companyId:ops.companyId}})).toBe(jobs);expect(await ds.manager.count(FlowStep,{where:{companyId:ops.companyId,runId:run.id,stepKey:'review',action:'pass'}})).toBe(0);
  });

  it('已登记意图配置修好才可retry，发送前售价变化保留待处理且不发；再核对重试沿原队列发送',async()=>{
    const run=await ds.manager.findOneByOrFail(FlowRun,{companyId:ops.companyId,id:ids.intentRun}),created=run.payload._created as Array<{bundleId:number}>,id=created[0].bundleId;
    const job=await ds.manager.findOneOrFail(OutboxJob,{where:{companyId:ops.companyId,resourceType:'finance-bundles',resourceId:id},order:{id:'DESC'}}),fake=new FakeJstSender();fake.targetKey='synthetic-sku-target';outbox.setSender(fake);
    try{
      const lines=await ds.manager.findBy(ResourceRecord,{companyId:ops.companyId,type:'finance-bundle-lines'});for(const line of lines.filter(item=>item.data.bundleId===id&&typeof item.data.baseCodeId==='number')){const code=await ds.manager.findOneByOrFail(ResourceRecord,{companyId:ops.companyId,id:Number(line.data.baseCodeId)});await ds.transaction(em=>resources.patchData(em,admin,'finance-base-codes',code.id,{jstUploadedCode:code.data.code},'合成已上传事实'));}
      await resources.update(admin,'finance-bundles',id,{manualFreight:200,marginOverridePercent:20,overrideReason:'合成同步资料核对'});await outbox.setSwitch(admin,true,'仅合成FakeSender');const retried=await outbox.retry(fin,job.id);expect((await ds.manager.findOneByOrFail(OutboxJob,{companyId:ops.companyId,id:job.id})).payloadJson.enqueueIssues).toEqual([]);expect(retried).toMatchObject({blocked:false});const queued=await ds.manager.findOneByOrFail(OutboxJob,{companyId:ops.companyId,id:job.id});expect(queued).toMatchObject({status:'pending',attempts:0,payloadJson:{blockedIntent:false,targetKey:'synthetic-sku-target'}});
      await outbox.enqueue(admin,'finance-base-codes',[ids.boxBc]);const ordinary=await ds.manager.findOneOrFail(OutboxJob,{where:{companyId:ops.companyId,resourceType:'finance-base-codes',resourceId:ids.boxBc,status:'pending'},order:{id:'DESC'}});
      fake.configured=false;expect(await outbox.processCompany(ops.companyId)).toMatchObject({blocked:true,sent:0});expect((await ds.manager.findOneByOrFail(OutboxJob,{companyId:ops.companyId,id:job.id}))).toMatchObject({status:'failed',attempts:0,payloadJson:{blockedIntent:true,targetKey:'synthetic-sku-target',enqueueIssues:[{code:'configuration_unavailable',message:expect.any(String)}]}});expect((await ds.manager.findOneByOrFail(OutboxJob,{companyId:ops.companyId,id:ordinary.id})).status).toBe('pending');expect(fake.sent).toHaveLength(0);
      fake.configured=true;await outbox.retry(fin,job.id);outbox.setSender({configured:true,targetKey:fake.targetKey,forCompany:async()=>{throw new ExternalConfigurationError('合成授权已过期');},send:fake.send.bind(fake)});expect(await outbox.processCompany(ops.companyId)).toMatchObject({blocked:true,sent:0});expect((await ds.manager.findOneByOrFail(OutboxJob,{companyId:ops.companyId,id:job.id}))).toMatchObject({status:'failed',attempts:0,payloadJson:{blockedIntent:true,enqueueIssues:[{code:'configuration_unavailable',message:'合成授权已过期'}]}});expect(fake.sent).toHaveLength(0);
      outbox.setSender(fake);await outbox.retry(fin,job.id);outbox.setSender({configured:true,forCompany:async()=>{throw new Error('合成数据库或网络读取异常');},send:fake.send.bind(fake)});await expect(outbox.processCompany(ops.companyId)).rejects.toThrow('合成数据库或网络读取异常');expect((await ds.manager.findOneByOrFail(OutboxJob,{companyId:ops.companyId,id:job.id}))).toMatchObject({status:'pending',attempts:0,payloadJson:{blockedIntent:false}});outbox.setSender(fake);
      await resources.update(admin,'finance-bundles',id,{manualFreight:400,overrideReason:'合成核对后资料变化'});await outbox.processCompany(ops.companyId);expect(fake.sent.filter(item=>item.payload.sku_id===queued.payloadJson.sku_id)).toHaveLength(0);const blocked=await ds.manager.findOneByOrFail(OutboxJob,{companyId:ops.companyId,id:job.id});expect(blocked).toMatchObject({status:'failed',attempts:0,payloadJson:{blockedIntent:true,enqueueIssues:[{code:'payload_changed',message:expect.any(String)}]}});
      expect(await outbox.retry(fin,job.id)).toMatchObject({blocked:false});await outbox.processCompany(ops.companyId);expect((await ds.manager.findOneByOrFail(OutboxJob,{companyId:ops.companyId,id:job.id})).status).toBe('done');expect(fake.sent.filter(item=>item.payload.sku_id===queued.payloadJson.sku_id)).toHaveLength(1);
    }finally{await outbox.setSwitch(admin,false,'合成测试结束');outbox.setSender(new UnconfiguredSender());}
  });

  it('未提交草稿专用废除拒绝校验owner/company/version/500字，并发终态不留TODO或通知',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([{name:'未填完整的草稿',main:[],gift:[]}])]});const id=made.runs[0].id,revision=made.runs[0].revision;
    await expect(flow.stopApplicationDraft(stranger,id,revision,'cancel','不能代办')).rejects.toThrow();await expect(flow.stopApplicationDraft({...ops,companyId:stranger.companyId+1000000},id,revision,'reject','跨公司')).rejects.toThrow();await expect(flow.stopApplicationDraft(ops,id,revision,'cancel','长'.repeat(501))).rejects.toThrow('500');await expect(flow.stop(ops,id,'cancel',{revision,stepId:(await flow.detail(ops,id)).activeStep!.id,reason:'普通入口拒绝草稿'})).rejects.toThrow();
    const notifications=await ds.manager.count(Notification,{where:{companyId:ops.companyId}}),jobs=await ds.manager.count(OutboxJob,{where:{companyId:ops.companyId}});const result=await Promise.allSettled([flow.stopApplicationDraft(ops,id,revision,'cancel','草稿废除原因'),flow.stopApplicationDraft(ops,id,revision,'reject','草稿拒绝原因')]);expect(result.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(result.filter(row=>row.status==='rejected')).toHaveLength(1);const stored=await ds.manager.findOneByOrFail(FlowRun,{companyId:ops.companyId,id});expect(['cancelled','rejected']).toContain(stored.status);expect(stored.revision).toBe(revision+1);expect(stored.currentStepKey).toBeNull();expect(await ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:id}})).toBe(0);expect(await ds.manager.count(Notification,{where:{companyId:ops.companyId}})).toBe(notifications);expect(await ds.manager.count(OutboxJob,{where:{companyId:ops.companyId}})).toBe(jobs);expect(await ds.manager.count(FlowEvent,{where:{companyId:ops.companyId,runId:id,action:stored.status==='cancelled'?'cancel':'reject'}})).toBe(1);await expect(flow.submitApplicationDraft(ops,id,revision,key())).rejects.toThrow();
  });

  it('真实HTTP提交备注/确认白名单和500字边界，草稿专用stop拒绝普通入口及非本人并保留原因',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'}),made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',definitionId:definition.id,confirmations:{referenceSearched:true},requestKey:key(),payloads:[payload([qspec('HTTP提交备注',ids.pearBc,nextQty())]),payload([{name:'HTTP草稿终止',main:[],gift:[]}])]});let actor=ops;
    const module=await Test.createTestingModule({controllers:[FlowController,SkuApplyController],providers:[{provide:FlowService,useValue:flow},{provide:SkuApplyService,useValue:sku},{provide:SkuBatchService,useValue:batch},{provide:APP_GUARD,useClass:PermissionsGuard}]}).compile(),app=module.createNestApplication();app.use((req:{user?:AuthUser},_res:unknown,next:()=>void)=>{req.user=actor;next();});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');const url=await app.getUrl(),id=made.runs[0].id,revision=made.runs[0].revision,submit={revision,requestKey:key()};
    try{const send=(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const path=`/flow/runs/${id}/draft/submit`;
      expect((await send(path,{...submit,comment:'长'.repeat(501)})).status).toBe(400);expect((await send(path,{...submit,confirmation:{token:'a'.repeat(64),confirmed:true,reason:'长'.repeat(501)}})).status).toBe(400);expect((await send(path,{...submit,confirmation:{token:'a'.repeat(64),confirmed:true,reason:'原因',companyId:ops.companyId}})).status).toBe(400);expect((await send(path,{...submit,revision:revision+1})).status).toBe(409);
      expect((await send(path,{...submit,comment:'备'.repeat(500)})).status).toBe(201);const first=await ds.manager.findOneByOrFail(FlowStep,{companyId:ops.companyId,runId:id,stepKey:'apply',action:'submit'});expect(first.comment).toBe('备'.repeat(500));
      const stopped=made.runs[1],draft=await flow.detail(ops,stopped.id),body={revision:stopped.revision,kind:'reject',reason:'HTTP原草稿拒绝原因'},stopPath=`/flow/runs/${stopped.id}/draft/stop`;
      expect((await send(stopPath,{...body,companyId:ops.companyId})).status).toBe(400);expect((await send(stopPath,{...body,reason:'长'.repeat(501)})).status).toBe(400);expect((await send(`/flow/runs/${stopped.id}/reject`,{revision:stopped.revision,stepId:draft.activeStep!.id,reason:body.reason})).status).toBe(409);actor=stranger;expect((await send(stopPath,body)).status).toBe(403);actor=ops;expect((await send(stopPath,body)).status).toBe(201);expect((await send(stopPath,body)).status).toBe(409);expect((await ds.manager.findOneByOrFail(FlowStep,{companyId:ops.companyId,runId:stopped.id,stepKey:'apply'})).comment).toBe(body.reason);
    }finally{await app.close();}
  });

  it('草稿提交沿原路径却复核真实当前同key同type处理人时限，类型变化整次拒绝且保持draft',async()=>{
    const definition=await ds.manager.findOneByOrFail(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'});
    const made=await flow.createApplicationDrafts(ops,{templateKey:'sku-batch-apply',confirmations:{referenceSearched:true},definitionId:definition.id,requestKey:key(),payloads:[payload([qspec('当前处理人复核',ids.pearBc,nextQty())]),payload([qspec('类型变更复核',ids.pearBc,nextQty())])]});
    const snapshot=(await ds.manager.findOneByOrFail(FlowRun,{id:made.runs[0].id,companyId:ops.companyId})).stepsSnapshot;
    const updated=[step('apply','现运营','submit'),{...step('warehouse','现仓库','execute',wh2.id),dueMinutes:420},step('review','现财务','finance',fin.id),step('end','现结束','end')];
    await flow.saveDraft(admin,'sku-batch-apply',updated,[]);await flow.publish(admin,'sku-batch-apply');
    await flow.submitApplicationDraft(ops,made.runs[0].id,made.runs[0].revision,key());const started=await flow.detail(ops,made.runs[0].id);expect(started.activeStep?.recipients).toEqual([{id:wh2.id,name:'仓库二'}]);expect(started.activeStep?.key).toBe('warehouse');expect(started.activeStep?.dueAt).toBeTruthy();expect((await ds.manager.findOneByOrFail(FlowRun,{id:started.id,companyId:ops.companyId})).stepsSnapshot).toEqual(snapshot);
    await ds.manager.update(FlowDefinition,{companyId:ops.companyId,templateKey:'sku-batch-apply',status:'active'},{steps:[step('apply','现运营','submit'),step('warehouse','现仓库','finance',wh2.id),step('review','现财务','finance',fin.id),step('end','现结束','end')]});
    await expect(flow.submitApplicationDraft(ops,made.runs[1].id,made.runs[1].revision,key())).rejects.toThrow(/类型|节点/);expect((await flow.detail(ops,made.runs[1].id)).status).toBe('draft');expect(await ds.manager.count(WorkItem,{where:{companyId:ops.companyId,runId:made.runs[1].id}})).toBe(0);
  });

});

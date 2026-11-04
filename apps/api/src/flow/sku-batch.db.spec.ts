/** SKU 申请汇总：汇总待办、批量办理、整单退回、个别规格退回并重新提交。RESOURCE_DB_TEST=1 TEST_DB_NAME=xxx npx jest --runInBand sku-batch */
import 'reflect-metadata';
import {ValidationPipe} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {APP_GUARD} from '@nestjs/core';
import {PermissionsGuard} from '../common/permissions.guard';
import {FlowController} from './flow.controller';
import {SkuApplyController} from './sku-apply.controller';
import * as crypto from 'crypto';
import { DataSource, In } from 'typeorm';
import type { StepDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, FormDraft, FlowDefinition, FlowRun, FlowStep, FlowEvent, WorkItem, OutboxJob, Notification, ResourceRecord, User } from '../entities';
import { FeishuNoticeService } from '../outbox/feishu-notice.service';
import { OutboxService } from '../outbox/outbox.service';
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
    const outbox = new OutboxService(ds, resources);
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
    const zero = { zeroValueReason: '运费：无\n装卸费：无' };
    const baseCode = async (productData: Record<string, unknown>, code: string) => {
      const p = await resources.create(admin, 'finance-products', { ...productData, freight: 0, handlingFee: 0, ...zero });
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
      expect((await send('/flow/runs/drafts','POST',{...input,companyId:999})).status).toBe(400);const response=await send('/flow/runs/drafts','POST',input);expect(response.status).toBe(201);const created=await response.json() as {batchKey:string;headerVersion:string;runs:Array<{id:number;revision:number}>};
      const removed=await send(`/flow/runs/${created.runs[0].id}/draft`,'DELETE',{revision:created.runs[0].revision,reason:'HTTP删除到零'});expect(removed.status).toBe(200);const removal=await removed.json() as {headerVersion:string};
      const pageResponse=await send(`/flow/runs?view=started&templateKey=sku-batch-apply&groupSku=true&keyword=${encodeURIComponent(title)}&page=1&pageSize=1`,'GET');expect(pageResponse.status).toBe(200);expect(await pageResponse.json()).toMatchObject({total:1,rows:[{batchRef:created.batchKey,specCount:0}]});
      const boardResponse=await send(`/flow/sku-apply/applications/${created.batchKey}`,'GET');expect(boardResponse.status).toBe(200);expect(await boardResponse.json()).toMatchObject({total:0,items:[],applicationHeader:{headerVersion:removal.headerVersion}});
      const prefix=`/flow/application-drafts/sku-batch-apply/${created.batchKey}`,add={headerVersion:removal.headerVersion,requestKey:key(),payloads:[{specs:[{name:'HTTP后来规格'}]}]};expect((await send(`${prefix}/items`,'POST',{...add,headerVersion:'0'.repeat(64)})).status).toBe(409);const added=await send(`${prefix}/items`,'POST',add);expect(added.status).toBe(201);const out=await added.json() as {headerVersion:string;runs:Array<{id:number;revision:number}>};
      expect((await send(`${prefix}/shared`,'PUT',{headerVersion:out.headerVersion,expected:out.runs.map(row=>({...row,companyId:999})),payload:{platformIds:[ids.tb]}})).status).toBe(400);expect((await send(`${prefix}/shared`,'PUT',{headerVersion:out.headerVersion,expected:out.runs,payload:{platformIds:[ids.tb]}})).status).toBe(200);
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

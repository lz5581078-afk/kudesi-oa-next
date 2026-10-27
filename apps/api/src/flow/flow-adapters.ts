import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type { FlowTemplate } from '@kudesi/shared';
import { FlowRun, ResourceRecord } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { ResourcesService } from '../resources/resources.service';
import type { OutboxService } from '../outbox/outbox.service';
import { skuBatchApply } from './sku-apply';

/**
 * 业务适配器：流程引擎只管流转，业务规则（能不能发起、办理时要做什么、能不能退回废除）由适配器声明。
 * 适配器里不写办理人和顺序——那些在流程定义里，由管理员配置。
 * 适配器的副作用都用引擎传进来的事务 em，和流程流转同成同败。
 */
export interface FlowServices {
  resources: ResourcesService;
  docs: FinanceDocumentsService;
  /** 商品组合编码的批量生成服务（SKU 批量申请的财务步骤调用）；老流程用不到，所以可空 */
  bundles?: BundleToolsService;
  /** 出站队列：外部写入只能走它 */
  outbox?: OutboxService;
}

export interface StartContext extends FlowServices {
  em: EntityManager;
  user: AuthUser;
  payload: Record<string, unknown>;
}

export interface StepContext extends FlowServices {
  em: EntityManager;
  user: AuthUser;
  run: FlowRun;
  /** 发起时的表单（含引擎写入的以下划线开头的业务痕迹） */
  payload: Record<string, unknown>;
  stepKey: string;
  /** 本步办理时填的表单 */
  form: Record<string, unknown>;
}

/** 事务提交之后的上下文：用于必须等数据真正提交才能做的事（如加入出站队列，它用独立连接读已提交的数据） */
export interface AfterCommitContext extends FlowServices {
  user: AuthUser;
  runId: number;
  companyId: number;
  requesterId: number;
  payload: Record<string, unknown>;
  /** 非事务的普通连接 */
  db: EntityManager;
}

export interface FlowAdapter {
  key: string;
  title(em: EntityManager, companyId: number, payload: Record<string, unknown>): Promise<string>;
  validateStart?(ctx: StartContext): Promise<void>;
  /** 业务日期型截止（如预计归还日）；返回 null 表示按定义里的时限 */
  stepDueAt?(stepKey: string, payload: Record<string, unknown>): Date | null;
  beforePass?(ctx: StepContext): Promise<void>;
  onPass?(ctx: StepContext): Promise<void>;
  /** 返回不能退回的原因；null 表示可以退回 */
  returnBlocked?(ctx: StepContext): string | null;
  /** 返回不能废除/拒绝/撤回的原因；null 表示可以 */
  cancelBlocked?(ctx: StepContext): string | null;
  onFinish?(ctx: StepContext, outcome: 'completed' | 'cancelled' | 'rejected'): Promise<void>;
  /** 办理通过并且事务已提交之后调用；失败不影响已办理的结果（适配器自己负责提醒） */
  afterCommit?(ctx: AfterCommitContext): Promise<void>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const endOfDay = (d: string) => new Date(`${d}T23:59:59+08:00`);

/** 引擎替业务办理的动作（登记借用记录、生成并过账费用单）用公司级权限执行：办理人有这一步的办理权，就等于授权了这一步里的业务动作。 */
const asEngine = (user: AuthUser): AuthUser => ({ ...user, permissions: { isCompanyAdmin: true, allow: [], deny: [] } });

async function record(em: EntityManager, companyId: number, type: string, id: unknown) {
  const n = num(id);
  return n === null ? null : em.findOne(ResourceRecord, { where: { companyId, type, id: n } });
}

const ITEM_LABEL: Record<string, string> = { original: '正本', copy: '副本', official: '公章', finance: '财务章', legal: '法人章', invoice: '发票章' };

const licenseBorrow: FlowAdapter = {
  key: 'license-borrow',
  async title(em, companyId, p) {
    const lic = await record(em, companyId, 'licenses', p.licenseId);
    return `借用${ITEM_LABEL[str(p.item)] ?? ''} · ${lic?.title ?? ''}`.slice(0, 200);
  },
  async validateStart({ em, user, payload }) {
    const lic = await record(em, user.companyId, 'licenses', payload.licenseId);
    if (!lic) throw new BadRequestException('营业执照不存在');
    if (['cancelled', 'inactive'].includes(lic.status)) throw new BadRequestException(`营业执照「${lic.title}」已${lic.status === 'cancelled' ? '注销' : '停用'}，不能借用`);
    if (str(payload.expectedReturnAt) < str(payload.borrowedAt)) throw new BadRequestException('预计归还日期不能早于借用日期');
    const out = await em.query(
      `SELECT id FROM resource_records WHERE company_id = ? AND type = 'license-borrows' AND status = 'borrowed'
         AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.licenseId')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.item')) = ? LIMIT 1`,
      [user.companyId, String(payload.licenseId), str(payload.item)],
    );
    if (out.length) throw new BadRequestException(`「${lic.title}」的${ITEM_LABEL[str(payload.item)]}目前已经借出，还没归还`);
    const busy = await em.query(
      `SELECT id FROM flow_runs WHERE company_id = ? AND template_key = 'license-borrow' AND status = 'running'
         AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.licenseId')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.item')) = ? LIMIT 1`,
      [user.companyId, String(payload.licenseId), str(payload.item)],
    );
    if (busy.length) throw new BadRequestException(`已经有一条在办的借用申请（#${busy[0].id}），请等它办完`);
  },
  stepDueAt(stepKey, p) {
    return stepKey === 'receive_back' && str(p.expectedReturnAt) ? endOfDay(str(p.expectedReturnAt)) : null;
  },
  async onPass({ em, user, run, payload, stepKey, form, resources }) {
    if (stepKey === 'handover') {
      // 借用人填的是名字：公司里有唯一同名在职员工就记成员工，否则当外部人员
      const named = await em.query("SELECT id FROM users WHERE company_id = ? AND status = 'active' AND name = ?", [user.companyId, str(payload.borrower)]);
      const rec = await resources.createRecord(em, asEngine(user), 'license-borrows', {
        licenseId: payload.licenseId, item: payload.item, ...(named.length === 1 ? { borrowerUserId: Number(named[0].id) } : { borrowerName: payload.borrower }), purpose: payload.purpose,
        borrowedAt: payload.borrowedAt, expectedReturnAt: payload.expectedReturnAt, note: str(form.note) || undefined,
      }, `流程 #${run.id} 交接登记`);
      payload._borrowRecordId = rec.id;
    }
    if (stepKey === 'receive_back') {
      const id = num(payload._borrowRecordId);
      if (id === null) throw new BadRequestException('找不到这次借用的登记记录');
      await resources.patchData(em, asEngine(user), 'license-borrows', id, { returnedAt: form.returnedAt }, `流程 #${run.id} 归还确认`);
      await resources.setStatusChecked(em, asEngine(user), 'license-borrows', id, 'returned', `流程 #${run.id} 归还确认`);
    }
  },
  returnBlocked({ stepKey }) {
    return stepKey === 'receive_back' ? '已经交接出库，不能退回；归还后直接办理“确认归还”即可' : null;
  },
  cancelBlocked({ payload }) {
    return num(payload._borrowRecordId) !== null ? '已经登记借出，不能废除；请先办理“确认归还”' : null;
  },
};

const expenseRequest: FlowAdapter = {
  key: 'expense-request',
  async title(em, companyId, p) {
    const fee = await record(em, companyId, 'finance-fee-items', p.feeItemId);
    return `费用申请 · ${fee?.title ?? ''} ¥${((num(p.amountCents) ?? 0) / 100).toFixed(2)}`.slice(0, 200);
  },
  async validateStart({ em, user, payload }) {
    const fee = await record(em, user.companyId, 'finance-fee-items', payload.feeItemId);
    if (!fee) throw new BadRequestException('费用项目不存在');
    if (fee.status === 'inactive') throw new BadRequestException(`费用项目「${fee.title}」已停用`);
    if (fee.data.direction !== 'expense') throw new BadRequestException('只能选“支出”方向的费用项目');
    if ((num(payload.amountCents) ?? 0) <= 0) throw new BadRequestException('金额必须大于 0');
  },
  async beforePass({ em, user, stepKey, form }) {
    if (stepKey !== 'pay') return;
    const bank = await record(em, user.companyId, 'bank-accounts', form.bankAccountId);
    if (!bank) throw new BadRequestException('付款账户不存在');
    if (bank.status === 'inactive') throw new BadRequestException(`付款账户「${bank.title}」已停用`);
  },
  cancelBlocked({ payload }) {
    return num(payload._docId) !== null ? '费用已经付款记账，不能废除；如要冲回请到费用单里红冲' : null;
  },
};

/** 取声明里写的来源：'payload.xxx' 或 'form.xxx' */
function pick(ref: string | undefined, payload: Record<string, unknown>, form: Record<string, unknown>): unknown {
  if (!ref) return undefined;
  const [src, key] = ref.split('.');
  return (src === 'payload' ? payload : form)[key];
}

/**
 * 按模板里的“自动记账声明”（FlowTemplate.posting）生成财务单据：同一条流程同一个声明只会生成一张（sourceKey 幂等），
 * 单据在引擎的事务里创建，流转失败时一起回滚。引擎不再认识任何具体流程。
 */
export async function postDeclared(ctx: StepContext, t: FlowTemplate): Promise<void> {
  const d = t.posting;
  if (!d) return;
  const { em, user, run, payload, form, docs } = ctx;
  const actor = asEngine(user);
  const date = str(pick(d.date, payload, form));
  const bankAccountId = num(pick(d.bankAccountId, payload, form));
  const feeItemId = num(pick(d.feeItemId, payload, form));
  const amountCents = num(pick(d.amountCents, payload, form));
  if (!date || !bankAccountId || !feeItemId || !amountCents || amountCents <= 0) throw new BadRequestException('自动记账需要的日期、付款账户、费用项目、金额没有填全');
  const refNo = str(pick(d.refNo, payload, form)).trim() || null;
  const memoPart = str(pick(d.memo, payload, form)).slice(0, 200);
  const draft = await docs.createDraft(actor, {
    type: d.docType, date, bankAccountId, refNo,
    lines: [{ feeItemId, qty: 1, unitPriceCents: amountCents, memo: memoPart }],
  }, { memo: `流程 #${run.id} ${run.title}${refNo ? `，凭证 ${refNo}` : ''}`.slice(0, 500), sourceKey: `flow:${run.id}:${d.at}` }, em);
  const finalDoc = d.post ? await docs.post(actor, draft.id, em) : draft;
  payload._docId = finalDoc.id;
  payload._docNo = finalDoc.docNo;
}

export const FLOW_ADAPTERS: Record<string, FlowAdapter> = { [licenseBorrow.key]: licenseBorrow, [expenseRequest.key]: expenseRequest, [skuBatchApply.key]: skuBatchApply };

import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { afterSalesTypeLabel, appealTypeLabel, APPEAL_TYPES, AFTER_SALES_TYPES, todayInChina } from '@kudesi/shared';
import { AfterSalesCase, CaseLog, OrderAppeal, ResourceRecord } from '../entities';
import type { FlowAdapter } from '../flow/flow-adapters';

/**
 * 售后工单、订单申诉的业务规则（接入统一流程引擎）。
 * 谁办、几步、多久都在流程定义里由管理员配置；这里只声明：能不能发起、发起时建业务记录、办理时要登记什么。
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const endOfDay = (d: string) => new Date(`${d}T23:59:59+08:00`);
const pad = (n: number) => String(n).padStart(6, '0');

export async function storeOf(em: EntityManager, companyId: number, id: unknown) {
  const n = num(id);
  if (n === null) return null;
  return em.findOne(ResourceRecord, { where: { companyId, type: 'stores', id: n } });
}

const log = (em: EntityManager, companyId: number, targetType: string, targetId: number, userId: number | null, content: string, kind = 'system') =>
  em.insert(CaseLog, { companyId, targetType, targetId, userId, kind, content: content.slice(0, 1000) });

async function mustStore(em: EntityManager, companyId: number, id: unknown) {
  const store = await storeOf(em, companyId, id);
  if (!store) throw new BadRequestException('店铺不存在');
  return store;
}

export const afterSalesAdapter: FlowAdapter = {
  key: 'after-sales',
  async title(em, companyId, p) {
    const store = await storeOf(em, companyId, p.storeId);
    return `售后 · ${afterSalesTypeLabel(str(p.caseType))} · ${str(p.orderNo)}${store ? ` · ${store.title}` : ''}`.slice(0, 200);
  },
  async validateStart({ em, user, payload }) {
    await mustStore(em, user.companyId, payload.storeId);
    if (!str(payload.orderNo).trim()) throw new BadRequestException('请填写订单号');
    if (!AFTER_SALES_TYPES.some((t) => t.value === payload.caseType)) throw new BadRequestException('售后类型不对');
    if ((num(payload.amountCents) ?? 0) < 0) throw new BadRequestException('申请金额不能是负数');
    if (str(payload.dueDate) && str(payload.dueDate) < todayInChina()) throw new BadRequestException('要求办结日期不能早于今天');
    const dup = await em.query(
      `SELECT c.case_no AS caseNo FROM after_sales_cases c JOIN flow_runs r ON r.id = c.run_id
        WHERE c.company_id = ? AND c.order_no = ? AND c.case_type = ? AND r.status = 'running' LIMIT 1`,
      [user.companyId, str(payload.orderNo).trim(), str(payload.caseType)],
    );
    if (dup.length) throw new BadRequestException(`订单 ${str(payload.orderNo).trim()} 已有处理中的「${afterSalesTypeLabel(str(payload.caseType))}」工单（${dup[0].caseNo}），请勿重复登记`);
  },
  async onStart({ em, user, payload, run }) {
    const ins = await em.insert(AfterSalesCase, {
      companyId: run.companyId, runId: run.id, storeId: num(payload.storeId)!, orderNo: str(payload.orderNo).trim(), buyerName: str(payload.buyerName).trim() || null,
      caseType: str(payload.caseType), amountCents: num(payload.amountCents) ?? 0, reason: str(payload.reason).trim(), dueDate: str(payload.dueDate) || null,
      createdBy: user.id, attachments: [],
    } as never);
    const id = Number(ins.identifiers[0].id);
    await em.update(AfterSalesCase, { id }, { caseNo: `SH${pad(id)}` });
    await log(em, run.companyId, 'after_sales', id, user.id, '登记工单');
  },
  async onResubmit({ em, payload, run }) {
    await em.update(AfterSalesCase, { runId: run.id, companyId: run.companyId }, {
      storeId: num(payload.storeId)!, orderNo: str(payload.orderNo).trim(), buyerName: str(payload.buyerName).trim() || null, caseType: str(payload.caseType),
      amountCents: num(payload.amountCents) ?? 0, reason: str(payload.reason).trim(), dueDate: str(payload.dueDate) || null,
    });
  },
  stepDueAt(stepKey, p) {
    return stepKey === 'handle' && str(p.dueDate) ? endOfDay(str(p.dueDate)) : null;
  },
  async onPass({ em, user, run, stepKey, form }) {
    const c = await em.findOne(AfterSalesCase, { where: { runId: run.id, companyId: run.companyId } });
    if (!c) return;
    if (stepKey === 'handle') {
      await em.update(AfterSalesCase, { id: c.id }, { resolution: str(form.resolution).trim(), refundCents: num(form.refundCents) });
      await log(em, run.companyId, 'after_sales', c.id, user.id, `处理完成：${str(form.resolution).trim()}${num(form.refundCents) ? `（实际 ¥${(num(form.refundCents)! / 100).toFixed(2)}）` : ''}`);
    }
    if (stepKey === 'review') await log(em, run.companyId, 'after_sales', c.id, user.id, '主管复核通过');
  },
  async onFinish({ em, user, run }, outcome) {
    const c = await em.findOne(AfterSalesCase, { where: { runId: run.id, companyId: run.companyId } });
    if (!c) return;
    await em.update(AfterSalesCase, { id: c.id }, { finishedAt: new Date() });
    await log(em, run.companyId, 'after_sales', c.id, user.id, outcome === 'completed' ? '工单办结' : outcome === 'rejected' ? '工单被主管拒绝' : '工单已废除/撤回');
  },
};

const APPEAL_VALUES: readonly string[] = APPEAL_TYPES.map((t) => t.value);

export const appealAdapter: FlowAdapter = {
  key: 'order-appeal',
  async title(em, companyId, p) {
    const store = await storeOf(em, companyId, p.storeId);
    return `申诉 · ${appealTypeLabel(str(p.appealType))} · ${str(p.orderNo)}${store ? ` · ${store.title}` : ''}`.slice(0, 200);
  },
  async validateStart({ em, user, payload }) {
    await mustStore(em, user.companyId, payload.storeId);
    const type = str(payload.appealType);
    if (!APPEAL_VALUES.includes(type)) throw new BadRequestException('申诉类型不对');
    if (!str(payload.orderNo).trim()) throw new BadRequestException('请填写订单号');
    if ((num(payload.amountCents) ?? 0) < 0) throw new BadRequestException('涉及金额不能是负数');
    if (str(payload.deadlineDate) && str(payload.deadlineDate) < todayInChina()) throw new BadRequestException('平台申诉截止日已经过了，不能再登记；如平台还给了新的期限，请填新的日期');
    const parentId = num(payload.parentId);
    if (type === 'reconsider') {
      if (parentId === null) throw new BadRequestException('复议要选择被驳回的原申诉');
      const parent = await em.findOne(OrderAppeal, { where: { id: parentId, companyId: user.companyId } });
      if (!parent) throw new BadRequestException('原申诉不存在');
      if (parent.result !== 'rejected') throw new BadRequestException('只有平台已驳回的申诉才能复议');
      if (parent.storeId !== num(payload.storeId) || parent.orderNo !== str(payload.orderNo).trim()) throw new BadRequestException('复议的店铺、订单要和原申诉一致');
      const busy = await em.query(
        `SELECT a.appeal_no AS appealNo FROM order_appeals a JOIN flow_runs r ON r.id = a.run_id WHERE a.company_id = ? AND a.parent_id = ? AND r.status = 'running' LIMIT 1`,
        [user.companyId, parentId],
      );
      if (busy.length) throw new BadRequestException(`这条申诉已经有一条在办的复议（${busy[0].appealNo}）`);
    } else if (parentId !== null) throw new BadRequestException('只有“申诉复议”才需要选原申诉');
    const dup = await em.query(
      `SELECT a.appeal_no AS appealNo FROM order_appeals a JOIN flow_runs r ON r.id = a.run_id
        WHERE a.company_id = ? AND a.order_no = ? AND a.appeal_type = ? AND r.status = 'running' LIMIT 1`,
      [user.companyId, str(payload.orderNo).trim(), type],
    );
    if (dup.length) throw new BadRequestException(`订单 ${str(payload.orderNo).trim()} 已有在办的「${appealTypeLabel(type)}」（${dup[0].appealNo}），请勿重复登记`);
  },
  async onStart({ em, user, payload, run }) {
    const ins = await em.insert(OrderAppeal, {
      companyId: run.companyId, runId: run.id, storeId: num(payload.storeId)!, appealType: str(payload.appealType), orderNo: str(payload.orderNo).trim(),
      amountCents: num(payload.amountCents) ?? 0, reason: str(payload.reason).trim(), deadlineAt: str(payload.deadlineDate) ? endOfDay(str(payload.deadlineDate)) : null,
      parentId: num(payload.parentId), createdBy: user.id, evidence: [],
    } as never);
    const id = Number(ins.identifiers[0].id);
    await em.update(OrderAppeal, { id }, { appealNo: `SS${pad(id)}` });
    await log(em, run.companyId, 'appeal', id, user.id, num(payload.parentId) ? '登记复议' : '登记申诉');
  },
  async onResubmit({ em, payload, run }) {
    await em.update(OrderAppeal, { runId: run.id, companyId: run.companyId }, {
      storeId: num(payload.storeId)!, appealType: str(payload.appealType), orderNo: str(payload.orderNo).trim(), amountCents: num(payload.amountCents) ?? 0,
      reason: str(payload.reason).trim(), deadlineAt: str(payload.deadlineDate) ? endOfDay(str(payload.deadlineDate)) : null, parentId: num(payload.parentId),
    });
  },
  /** 平台倒计时：提交平台这一步的截止就是平台给的期限 */
  stepDueAt(stepKey, p) {
    return stepKey === 'submit' && str(p.deadlineDate) ? endOfDay(str(p.deadlineDate)) : null;
  },
  async beforePass({ em, run, stepKey, form }) {
    if (stepKey === 'review' || stepKey === 'submit') {
      const a = await em.findOne(OrderAppeal, { where: { runId: run.id, companyId: run.companyId } });
      if (!a || !(a.evidence ?? []).length) throw new BadRequestException(stepKey === 'review' ? '还没有上传举证凭证，复核不能通过；请先在申诉详情里上传凭证' : '提交平台前必须有有效凭证，请先在申诉详情里上传凭证');
    }
    if (stepKey === 'result' && form.result === 'rejected' && !str(form.resultNote).trim()) throw new BadRequestException('平台驳回时请写结果说明（平台给的理由），方便决定要不要复议');
  },
  async onPass({ em, user, run, stepKey, form }) {
    const a = await em.findOne(OrderAppeal, { where: { runId: run.id, companyId: run.companyId } });
    if (!a) return;
    if (stepKey === 'review') await log(em, run.companyId, 'appeal', a.id, user.id, '举证复核通过');
    if (stepKey === 'submit') {
      await em.update(OrderAppeal, { id: a.id }, { platformAppealNo: str(form.platformAppealNo).trim(), submittedAt: str(form.submittedAt) });
      await log(em, run.companyId, 'appeal', a.id, user.id, `已提交平台，平台申诉单号 ${str(form.platformAppealNo).trim()}`);
    }
    if (stepKey === 'result') {
      await em.update(OrderAppeal, { id: a.id }, { result: form.result as 'approved' | 'rejected', resultNote: str(form.resultNote).trim() || null });
      await log(em, run.companyId, 'appeal', a.id, user.id, `平台结果：${form.result === 'approved' ? '申诉通过' : '申诉驳回'}${str(form.resultNote).trim() ? `（${str(form.resultNote).trim()}）` : ''}`);
    }
  },
  async onFinish({ em, user, run }, outcome) {
    const a = await em.findOne(OrderAppeal, { where: { runId: run.id, companyId: run.companyId } });
    if (!a) return;
    await em.update(OrderAppeal, { id: a.id }, { finishedAt: new Date() });
    await log(em, run.companyId, 'appeal', a.id, user.id, outcome === 'completed' ? '申诉办结' : outcome === 'rejected' ? '申诉被主管拒绝' : '申诉已废除/撤回');
  },
  returnBlocked({ stepKey }) {
    return stepKey === 'result' ? '已经提交平台，不能退回；平台有结果后直接登记结果即可' : null;
  },
};

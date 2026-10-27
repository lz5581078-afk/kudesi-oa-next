import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord, User } from '../entities';
import { assertFamilyFree, EXCLUSIVE_TEMPLATE, EXCLUSIVE_TYPE, grantExclusive, parsePeriod } from '../resources/product-exclusive';
import type { FlowAdapter } from './flow-adapters';

/**
 * 专属品领取流程的业务规则。谁审批、几步、多久，都在流程定义里由管理员配置；
 * 这里只声明：能不能发起、审批通过时要生成专属记录。
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const asEngine = (user: AuthUser): AuthUser => ({ ...user, permissions: { isCompanyAdmin: true, allow: [], deny: [] } });
const nameOf = async (em: EntityManager, companyId: number, id: number) => (await em.findOne(User, { where: { id, companyId }, select: ['id', 'name'] }))?.name ?? '';

export const productExclusive: FlowAdapter = {
  key: EXCLUSIVE_TEMPLATE,
  async title(em, companyId, p) {
    const bc = await em.findOne(ResourceRecord, { where: { id: Number(p.baseCodeId), companyId, type: 'finance-base-codes' }, select: ['id', 'title', 'data'] });
    return `专属品领取 · ${str(bc?.data.name) || bc?.title || ''}`.slice(0, 200);
  },
  async validateStart({ em, user, payload }) {
    if (!str(payload.reason).trim()) throw new BadRequestException('请填写领取原因');
    await assertFamilyFree(em, user.companyId, payload.baseCodeId, null);
  },
  async beforePass({ em, run, stepKey, form }) {
    if (stepKey !== 'approve') return;
    parsePeriod(form);
    await assertFamilyFree(em, run.companyId, run.payload.baseCodeId, run.id);
  },
  async onPass({ em, user, run, payload, stepKey, form, resources }) {
    if (stepKey !== 'approve') return;
    const actor = asEngine(user);
    const grant = await grantExclusive(em, (values) => resources.createRecord(em, actor, EXCLUSIVE_TYPE, values, `流程 #${run.id} 审批通过`), {
      companyId: run.companyId, runId: run.id, baseCodeId: Number(payload.baseCodeId), ownerId: run.requesterId, ownerName: await nameOf(em, run.companyId, run.requesterId),
      approverId: user.id, approverName: await nameOf(em, run.companyId, user.id), ...parsePeriod(form),
    });
    payload._grantId = grant.id;
  },
  cancelBlocked({ payload }) {
    return typeof payload._grantId === 'number' ? '专属已经生效，不能废除；到“专属品”里取消专属' : null;
  },
};

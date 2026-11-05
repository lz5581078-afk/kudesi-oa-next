import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ResourceRecord } from '../entities';
import { asEngine, type FlowAdapter } from './flow-adapters';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function account(em: EntityManager, companyId: number, id: unknown, lock = false) {
  const n = num(id);
  return n === null ? null : em.findOne(ResourceRecord, { where: { companyId, type: 'self-media', id: n }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
}

/** 同一平台下不能有别的账号叫这个名字 */
async function nameTaken(em: EntityManager, companyId: number, record: ResourceRecord, name: string) {
  const rows = await em.query(
    `SELECT id FROM resource_records WHERE company_id=? AND type='self-media' AND id<>? AND title=?
       AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.platform'))=? LIMIT 1`,
    [companyId, record.id, name, str(record.data.platform)]);
  return rows.length > 0;
}

/**
 * 账号名称改名：流程只管审批和流转；最后一步“人事部通过”办理通过时，由这里在同一事务里把资料里的自媒体账号名称改掉，
 * 并写资料变更日志（谁、哪条流程）。改名前再校验一次，账号被停用、新名称被别的账号占用都会让这一步失败，不会改一半。
 */
export const accountRename: FlowAdapter = {
  key: 'account-rename',
  async title(em, companyId, p) {
    const rec = await account(em, companyId, p.accountId);
    return `账号改名 · ${rec?.title ?? ''} → ${str(p.newName).trim()}`.slice(0, 200);
  },
  async validateStart({ em, user, payload }) {
    const rec = await account(em, user.companyId, payload.accountId);
    if (!rec) throw new BadRequestException('自媒体账号不存在');
    if (rec.status === 'inactive') throw new BadRequestException(`账号「${rec.title}」已停用，不能改名`);
    const name = str(payload.newName).trim();
    if (!name) throw new BadRequestException('请填写新账号名称');
    if (name === rec.title) throw new BadRequestException('新名称和现在的名称一样，不需要改名');
    if (await nameTaken(em, user.companyId, rec, name)) throw new BadRequestException(`同一平台下已经有叫「${name}」的账号`);
    const busy = await em.query(
      `SELECT id FROM flow_runs WHERE company_id=? AND template_key='account-rename' AND status='running'
         AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.accountId'))=? LIMIT 1`, [user.companyId, String(rec.id)]);
    if (busy.length) throw new BadRequestException(`这个账号已经有一条在办的改名申请（#${busy[0].id}），请等它办完`);
  },
  async onPass({ em, user, run, payload, stepKey, resources }) {
    if (stepKey !== 'hr_confirm') return;
    const rec = await account(em, user.companyId, payload.accountId, true);
    if (!rec) throw new BadRequestException('自媒体账号已不存在，不能改名');
    if (rec.status === 'inactive') throw new BadRequestException(`账号「${rec.title}」已停用，不能改名；请退回或拒绝这条申请`);
    const name = str(payload.newName).trim();
    if (await nameTaken(em, user.companyId, rec, name)) throw new ConflictException(`同一平台下已经有叫「${name}」的账号，请退回让申请人重新选名称`);
    payload._oldName = rec.title;
    await resources.patchData(em, asEngine(user), 'self-media', rec.id, { name }, `流程 #${run.id} 账号改名：${rec.title} → ${name}`, false, true);
    payload._renamedAt = new Date().toISOString();
  },
};

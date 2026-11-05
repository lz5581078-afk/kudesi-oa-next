import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ResourceRecord } from '../entities';
import { asEngine, type FlowAdapter } from './flow-adapters';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const BLOCKED = ['inactive', 'cancelled'];

async function store(em: EntityManager, companyId: number, id: unknown, lock = false) {
  const n = num(id);
  return n === null ? null : em.findOne(ResourceRecord, { where: { companyId, type: 'stores', id: n }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
}
/** 同一平台下不能有别的店铺叫这个名字 */
async function nameTaken(em: EntityManager, companyId: number, record: ResourceRecord, name: string) {
  const rows = await em.query(
    `SELECT id FROM resource_records WHERE company_id=? AND type='stores' AND id<>? AND title=? AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.platform'))=? LIMIT 1`,
    [companyId, record.id, name, str(record.data.platform)]);
  return rows.length > 0;
}

/**
 * 店铺改名：平台后台由申请人改、聚水潭由人事部门手动改（OA 对聚水潭只读，不做任何外部写入）。
 * 最后一步“人事部聚水潭改名并通过”办理通过时，在同一事务里把 OA 店铺档案的名称改掉，
 * 已关联聚水潭的店铺同步“已关联聚水潭店铺名称”，旧名记入“曾用名”，并写资料变更日志。
 */
export const storeRename: FlowAdapter = {
  key: 'store-rename',
  async title(em, companyId, p) {
    const rec = await store(em, companyId, p.storeId);
    return `店铺改名 · ${rec?.title ?? ''} → ${str(p.newName).trim()}`.slice(0, 200);
  },
  async validateStart({ em, user, payload }) {
    const rec = await store(em, user.companyId, payload.storeId);
    if (!rec) throw new BadRequestException('店铺不存在');
    if (BLOCKED.includes(rec.status)) throw new BadRequestException(`店铺「${rec.title}」已${rec.status === 'cancelled' ? '注销' : '停用'}，不能改名`);
    const name = str(payload.newName).trim();
    if (!name) throw new BadRequestException('请填写新店铺名');
    if (name === rec.title) throw new BadRequestException('新名称和现在的名称一样，不需要改名');
    if (await nameTaken(em, user.companyId, rec, name)) throw new BadRequestException(`同一平台下已经有叫「${name}」的店铺`);
    const busy = await em.query(
      `SELECT id FROM flow_runs WHERE company_id=? AND template_key='store-rename' AND status='running' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.storeId'))=? LIMIT 1`,
      [user.companyId, String(rec.id)]);
    if (busy.length) throw new BadRequestException(`这家店铺已经有一条在办的改名申请（#${busy[0].id}），请等它办完`);
  },
  async onPass({ em, user, run, payload, stepKey, resources }) {
    if (stepKey !== 'jst_rename') return;
    const rec = await store(em, user.companyId, payload.storeId, true);
    if (!rec) throw new BadRequestException('店铺档案已不存在，不能改名');
    if (BLOCKED.includes(rec.status)) throw new BadRequestException(`店铺「${rec.title}」已${rec.status === 'cancelled' ? '注销' : '停用'}，不能改名；请退回或拒绝这条申请`);
    const name = str(payload.newName).trim();
    if (await nameTaken(em, user.companyId, rec, name)) throw new ConflictException(`同一平台下已经有叫「${name}」的店铺，请退回让申请人重新选名称`);
    const old = rec.title;
    const former = [...new Set([old, ...str(rec.data.formerNames).split('、').filter(Boolean)])].join('、').slice(0, 1000);
    const patch: Record<string, unknown> = { name, formerNames: former };
    if (str(rec.data.jushuitanShopId)) patch.jushuitanShopName = name; // 聚水潭已由人事手动改成新名，快照同步
    payload._oldName = old;
    await resources.patchData(em, asEngine(user), 'stores', rec.id, patch, `流程 #${run.id} 店铺改名：${old} → ${name}`, false, true);
    payload._renamedAt = new Date().toISOString();
  },
};

import { EntityManager } from 'typeorm';
import { todayShanghai, workforceLoginBlock } from '@kudesi/shared';
import { ResourceRecord, User } from '../entities';

/**
 * 兼职/临时工合作期外不能登录（旧系统 CONTRACT_STATE_SQL + loginBlockMessage）：
 * 登录时和每次带令牌的请求都检查，所以合作结束日期后的第二天起，已登录的也会被挡住。
 * 正式员工、没有建档的兼职/临时工（人员档案里直接建的）不受限制。
 */
export async function workforceBlockFor(em: EntityManager, user: Pick<User, 'id' | 'companyId' | 'employmentType'>, today: string = todayShanghai()): Promise<string | null> {
  if (!user.employmentType || user.employmentType === 'regular') return null;
  const record = await em
    .createQueryBuilder(ResourceRecord, 'r')
    .where("r.company_id = :c AND r.type = 'workforce' AND r.archived_at IS NULL", { c: user.companyId })
    .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.userId')) = :u", { u: String(user.id) })
    .getOne();
  return record ? workforceLoginBlock(record.data, record.status, today) : null;
}

/** 有兼职/临时工账号但还没建档的人（档案页顶部提示用）：不受合作期控制，建议尽快补档案。 */
export async function unfiledWorkforce(em: EntityManager, companyId: number): Promise<Array<{ id: number; name: string; account: string | null; employmentType: string }>> {
  const people = await em.find(User, { where: [{ companyId, employmentType: 'part_time', status: 'active' }, { companyId, employmentType: 'temp', status: 'active' }], select: ['id', 'name', 'account', 'employmentType'], order: { id: 'ASC' } });
  if (!people.length) return [];
  const records = await em.find(ResourceRecord, { where: { companyId, type: 'workforce' }, select: ['id', 'data'] });
  const filed = new Set(records.map((r) => Number(r.data.userId)));
  return people.filter((p) => !filed.has(p.id)).map((p) => ({ id: p.id, name: p.name, account: p.account, employmentType: p.employmentType }));
}

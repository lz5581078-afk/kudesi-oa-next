import { EntityManager, In } from 'typeorm';
import type { ResourceDef } from '@kudesi/shared';
import { Department, ResourceRecord, User } from '../entities';

/**
 * 店铺与账号类资料的读时派生字段（不存库，列表和详情读的时候现算）：
 * - 自媒体 / 备忘：运营部门、负责人部门取自“运营人/负责人”当前所在的部门（旧页面按这个部门给列表分组）；
 * - 自媒体：“账号属性”摘要 = 平台专属属性里已填的前两项（旧列表的“账号属性”列）。
 * 密码是否已维护（旧列表的“密码：已维护/未设置”）由 ResourcesService 按 secretConfigured 补上。
 */
const DEPT_FIELD: Record<string, { user: string; dept: string }> = {
  'self-media': { user: 'operatorUserId', dept: 'operatorDeptId' },
  memos: { user: 'ownerUserId', dept: 'ownerDeptId' },
};

export const hasAccountDerive = (def: ResourceDef) => def.key in DEPT_FIELD;

const fmtMoney = (cents: number) => `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** 自媒体账号属性摘要：当前平台的专属字段（含绑定手机号、推广费余额）里已填的前两项，“标签：值 / 标签：值” */
export function selfMediaPropSummary(def: ResourceDef, data: Record<string, unknown>): string {
  const platform = String(data.platform ?? '');
  const parts: string[] = [];
  for (const f of def.fields) {
    if (f.group !== '平台专属属性' || f.key === 'followers' || f.key === 'propSummary') continue;
    if (f.showWhen && !f.showWhen.in.includes(platform)) continue;
    const v = data[f.key];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    parts.push(`${f.label}：${f.type === 'money' && typeof v === 'number' ? fmtMoney(v) : String(v)}`);
    if (parts.length === 2) break;
  }
  return parts.join(' / ');
}

export async function deriveAccountFields(em: EntityManager, companyId: number, def: ResourceDef, records: ResourceRecord[]): Promise<Map<number, { data: Record<string, unknown>; labels: Record<string, string> }>> {
  const out = new Map<number, { data: Record<string, unknown>; labels: Record<string, string> }>();
  const cfg = DEPT_FIELD[def.key];
  if (!cfg) return out;
  const userIds = [...new Set(records.map((r) => Number(r.data[cfg.user])).filter((n) => Number.isInteger(n) && n > 0))];
  const users = userIds.length ? await em.find(User, { where: { companyId, id: In(userIds) }, select: ['id', 'departmentId'] }) : [];
  const deptOf = new Map(users.map((u) => [u.id, u.departmentId]));
  const deptIds = [...new Set(users.map((u) => u.departmentId).filter((n): n is number => typeof n === 'number'))];
  const deptName = new Map((deptIds.length ? await em.find(Department, { where: { companyId, id: In(deptIds) }, select: ['id', 'name'] }) : []).map((d) => [d.id, d.name]));
  for (const r of records) {
    const row: Record<string, unknown> = {};
    const labels: Record<string, string> = {};
    const dept = deptOf.get(Number(r.data[cfg.user]));
    if (typeof dept === 'number') { row[cfg.dept] = dept; labels[cfg.dept] = deptName.get(dept) ?? `部门 #${dept}`; }
    if (def.key === 'self-media') { const sum = selfMediaPropSummary(def, r.data); if (sum) row.propSummary = sum; }
    out.set(r.id, { data: row, labels });
  }
  return out;
}

import type { EntityManager } from 'typeorm';

/**
 * 逾期提醒去重。同一个待办的“逾期”会被三路各自发提醒：逾期扫描（scanOverdue）、督促时效的超时提醒、三级超时升级（主管/老板）。
 * 约定：
 *  - 升级类提醒（发给办理人以外的人）：同一个待办、同一个人只发一次，不管来自哪一路；
 *  - 办理人本人的“已逾期”提醒：节点配了督促时效的“超时后每隔 M 分钟再提醒”，就由督促提醒负责，逾期扫描不再重复发。
 * 记录落在 flow_reminder_logs（唯一键 work_item_id + kind），INSERT IGNORE 抢到才发。
 */
export const escalateKind = (userId: number) => `esc:${userId}`;
export const SELF_OVERDUE_KIND = 'self-over';

/** 抢占一条提醒记录：抢到（第一次）返回 true；已经发过返回 false */
export async function claimNotice(em: EntityManager, companyId: number, workItemId: number, kind: string): Promise<boolean> {
  const r = await em.query('INSERT IGNORE INTO flow_reminder_logs (company_id, work_item_id, kind) VALUES (?, ?, ?)', [companyId, workItemId, kind]);
  return Number(r.affectedRows) === 1;
}

/** 升级对象去重：去掉办理人本人，以及这个待办已经通知过升级的人；返回这次真正要通知的人（同时占位） */
export async function claimEscalations(em: EntityManager, companyId: number, workItemId: number, assigneeId: number, userIds: number[]): Promise<number[]> {
  const out: number[] = [];
  for (const uid of [...new Set(userIds)]) {
    if (uid === assigneeId) continue;
    if (await claimNotice(em, companyId, workItemId, escalateKind(uid))) out.push(uid);
  }
  return out;
}

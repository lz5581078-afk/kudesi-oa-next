import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { LIVE_DEFAULT_RULES, createChecker, liveRulesFromStored, liveToText, liveVersionFor, type LiveRules } from '@kudesi/shared';
import type { AuthUser } from '../common/auth.decorators';

/** 业务提示：状态冲突 409、参数不对 400、没权限 403、不存在 404。 */
export function liveFail(message: string, status: 400 | 403 | 404 | 409 = 409): never {
  if (status === 400) throw new BadRequestException(message);
  if (status === 403) throw new ForbiddenException(message);
  if (status === 404) throw new NotFoundException(message);
  throw new ConflictException(message);
}

/** 当前时间（测试可以替换）；业务时间一律按北京时间墙钟存取 */
export const liveClock = { now: (): Date => new Date() };

export const num = (v: unknown): number => Number(v ?? 0);
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const idOf = (v: unknown): number | null => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
export const text = (v: unknown, max = 500): string => String(v ?? '').trim().slice(0, max);
/** 北京时间当前墙钟 'YYYY-MM-DD HH:mm:ss' */
export const wallNow = (now: Date): string => liveToText(now)!;
export const can = (user: AuthUser, key: string) => createChecker(user.permissions)(key);

/** 事务里锁住公司行：直播的写操作（排场、上下播、审核、月结）按公司串行，避免并发重叠。 */
export async function lockCompany(em: EntityManager, companyId: number) {
  await em.query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [companyId]);
}

export const SESSION_SELECT = `SELECT s.*, DATE_FORMAT(s.session_date,'%Y-%m-%d') session_day, DATE_FORMAT(s.start_at,'%Y-%m-%d %H:%i:%s') start_text,
    DATE_FORMAT(s.end_at,'%Y-%m-%d %H:%i:%s') end_text, DATE_FORMAT(s.submitted_at,'%Y-%m-%d %H:%i:%s') submitted_text, DATE_FORMAT(s.approved_at,'%Y-%m-%d %H:%i:%s') approved_text,
    a.name anchor_name, c.name control_name, o.name operator_name, ap.name approver_name,
    DATE_FORMAT(sc.start_at,'%Y-%m-%d %H:%i:%s') schedule_start, DATE_FORMAT(sc.end_at,'%Y-%m-%d %H:%i:%s') schedule_end
    FROM live_sessions s JOIN users a ON a.id = s.anchor_user_id AND a.company_id = s.company_id
    LEFT JOIN users c ON c.id = s.control_user_id AND c.company_id = s.company_id
    LEFT JOIN users o ON o.id = s.operator_user_id AND o.company_id = s.company_id
    LEFT JOIN users ap ON ap.id = s.approved_by AND ap.company_id = s.company_id
    LEFT JOIN live_schedules sc ON sc.id = s.schedule_id AND sc.company_id = s.company_id`;

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function sessionRow(em: EntityManager, companyId: number, id: number, lock = false): Promise<Row> {
  const [row] = await em.query(`${SESSION_SELECT} WHERE s.company_id = ? AND s.id = ?${lock ? ' FOR UPDATE OF s' : ''}`, [companyId, id]);
  if (!row) liveFail('直播场次不存在', 404);
  return row;
}

export async function reportsOf(em: EntityManager, companyId: number, sessionId: number): Promise<Row[]> {
  return em.query(`SELECT r.*, DATE_FORMAT(r.end_at,'%Y-%m-%d %H:%i:%s') end_text FROM live_session_reports r WHERE r.company_id = ? AND r.session_id = ? ORDER BY r.id`, [companyId, sessionId]);
}

/** 公司里某月已进入结算审批或已结算：不能再新增场次或提成。 */
export async function closedMonth(em: EntityManager, companyId: number, month: string, lock = false): Promise<boolean> {
  const rows = await em.query(`SELECT id FROM live_settlements WHERE company_id = ? AND month = ? AND status IN ('submitted','approved')${lock ? ' FOR UPDATE' : ''}`, [companyId, month]);
  return rows.length > 0;
}

/** 规则版本（只读）：按场次日期取当天生效的最新版本。 */
export async function ruleVersions(em: EntityManager, companyId: number): Promise<Array<{ id: number; effectiveFrom: string; rules: LiveRules; note: string | null; createdAt: string; creatorName: string | null; usedCount: number }>> {
  const rows: Row[] = await em.query(`SELECT v.id, DATE_FORMAT(v.effective_from,'%Y-%m-%d') effective_from, v.rules_json, v.note, DATE_FORMAT(v.created_at,'%Y-%m-%d %H:%i:%s') created_text, e.name creator_name,
      (SELECT COUNT(*) FROM live_commission_records c WHERE c.company_id = v.company_id AND c.rule_version_id = v.id) used_count
      FROM live_commission_rule_versions v LEFT JOIN users e ON e.id = v.created_by AND e.company_id = v.company_id WHERE v.company_id = ? ORDER BY v.effective_from DESC, v.id DESC`, [companyId]);
  return rows.map((r) => ({ id: Number(r.id), effectiveFrom: r.effective_from, rules: liveRulesFromStored(r.rules_json), note: r.note, createdAt: r.created_text, creatorName: r.creator_name, usedCount: Number(r.used_count) }));
}
export const versionOn = (versions: Awaited<ReturnType<typeof ruleVersions>>, day: string) => liveVersionFor(versions, day);

/** 公司开通和种子脚本调用：写入初始提成规则（2026-01-01 起生效）；已有任何版本则不动。 */
export async function ensureDefaultLiveRules(em: EntityManager, companyId: number): Promise<boolean> {
  const [has] = await em.query('SELECT id FROM live_commission_rule_versions WHERE company_id = ? LIMIT 1', [companyId]);
  if (has) return false;
  await em.query('INSERT INTO live_commission_rule_versions (company_id, effective_from, rules_json, note, created_by) VALUES (?, ?, ?, ?, NULL)', [companyId, '2026-01-01', JSON.stringify(LIVE_DEFAULT_RULES), '系统初始规则（直播管理规格确认版）']);
  return true;
}

/** 员工所在岗位（主岗位 + 兼任）的岗位类型。 */
export async function positionTypesOf(em: EntityManager, companyId: number, userId: number): Promise<Set<string>> {
  const [u]: Row[] = await em.query("SELECT position_id, extra_position_ids FROM users WHERE company_id = ? AND id = ? AND status = 'active'", [companyId, userId]);
  if (!u) return new Set();
  const extra = typeof u.extra_position_ids === 'string' ? JSON.parse(u.extra_position_ids) : u.extra_position_ids;
  const ids = [u.position_id, ...(Array.isArray(extra) ? extra : [])].filter((v) => v !== null && v !== undefined).map(Number);
  if (!ids.length) return new Set();
  const rows: Row[] = await em.query(`SELECT DISTINCT workspace_type FROM positions WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [companyId, ...ids]);
  return new Set(rows.map((r) => String(r.workspace_type)));
}

export interface LegacyRef { legacyRef: { type: string; id: string } }
export interface LegacyFile { field: string; id: string; name: string; locator: string; contentHash?: string }
export interface LegacyArchiveInfo { at?: string; by?: string; reason?: string; fromStatus?: string }
export interface LegacyLink { id: string; relation: string; sourceType: string; sourceId: string; targetType: string; targetId: string; validFrom?: string; validTo?: string; purpose?: string }
export interface LegacyRecord { id: string; type: string; archive?: LegacyArchiveInfo; data: Record<string, unknown>; status?: string; sourceUpdatedAt?: string; aliasName?: string; notices?: string[]; files?: LegacyFile[] }
/** 旧直播管理表的原始行，键是去掉 live_ 前缀的表名（commission_rule_versions、schedules、sessions、session_products、session_reports、session_orders、commission_records、wage_records、settlements、settlement_lines、settlement_refunds） */
export type LegacyLive = Partial<Record<'commission_rule_versions' | 'schedules' | 'sessions' | 'session_products' | 'session_reports' | 'session_orders' | 'commission_records' | 'wage_records' | 'settlements' | 'settlement_lines' | 'settlement_refunds', Array<Record<string, any>>>>;
export interface LegacyArchive {
  company: { id: number; name: string };
  departments: Array<Record<string, any>>;
  positions: Array<Record<string, any>>;
  employees: Array<Record<string, any>>;
  employeeOverrides?: Array<Record<string, any>>;
  /** 旧岗位档案条目（position_duties：职责/培训/考核…）和员工薪酬记录（employee_compensation_records：调薪/工资/奖惩） */
  positionDuties?: Array<Record<string, any>>;
  compensationRecords?: Array<Record<string, any>>;
  positionPermissions: Array<Record<string, any>>;
  employeePositions: Array<Record<string, any>>;
  records: LegacyRecord[];
  /** 旧直播管理数据（排场、场次、下播报告、订单、规则版本、提成、工资、结算） */
  live?: LegacyLive;
  /** 旧 resource_links 里没有落成字段/子资源的关联（合作人⇄执照/店铺/银行、执照关联运营、手机号关联等），新系统以手动关联迁入 */
  links?: LegacyLink[];
  exclusions: Array<{ type: string; id: string; reason: string }>;
  loadFile(locator: string): Promise<Buffer>;
}
export function legacyRef(type: string, id: unknown): LegacyRef | undefined {
  return id === null || id === undefined || id === '' ? undefined : { legacyRef: { type, id: String(id) } };
}
/** 十进制字符串精确换算；无法用整数分表示时明确拒绝，不用浮点静默舍入。 */
export function exactCents(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!m || /[1-9]/.test((m[3] ?? '').slice(2))) throw new Error('金额超出整数分表示范围');
  const amount = BigInt(m[2]) * 100n + BigInt(((m[3] ?? '') + '00').slice(0, 2));
  if (amount > 99999999999n) throw new Error('金额超出字段范围');
  return Number(amount) * (m[1] ? -1 : 1);
}

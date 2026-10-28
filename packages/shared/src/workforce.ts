/**
 * 兼职与临时工（旧系统“资料 → 兼职与临时工”）的业务规则：前后端共用，只定义一次。
 * - 合作状态：停用优先；其余按合作开始/结束日期（北京时间今天）算，结束日期当天仍可登录，次日起不能登录；
 * - 登录拦截文案、期限校验、计薪方式与时薪同步规则。
 */

export type WorkforceEmployment = 'part_time' | 'temp';
export type WorkforcePayMethod = 'hourly' | 'daily' | 'monthly' | 'piece';
export type WorkforceCooperation = 'working' | 'pending' | 'ended' | 'inactive';

export const WORKFORCE_EMPLOYMENT_LABELS: Readonly<Record<WorkforceEmployment, string>> = { part_time: '兼职', temp: '临时工' };
export const WORKFORCE_PAY_LABELS: Readonly<Record<WorkforcePayMethod, string>> = { hourly: '计时', daily: '计天', monthly: '计月', piece: '计件' };
export const WORKFORCE_PAY_UNITS: Readonly<Record<WorkforcePayMethod, string>> = { hourly: '元/小时', daily: '元/天', monthly: '元/月', piece: '元/件' };
export const WORKFORCE_COOPERATION_LABELS: Readonly<Record<WorkforceCooperation, string>> = { working: '合作中', pending: '待开始', ended: '合作已到期', inactive: '已停用' };

/** 单价上限：1000 万元（分）。旧系统同样是 0 到 1000 万。 */
export const WORKFORCE_MAX_PAY_CENTS = 10_000_000 * 100;
/** 五类附件合计每人最多个数（旧系统 MAX_ATTACHMENTS_PER_PERSON） */
export const WORKFORCE_MAX_FILES = 20;
export const WORKFORCE_FILE_FIELDS = ['contractFiles', 'identityFiles', 'paymentFiles', 'qualificationFiles', 'otherFiles'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 真实存在的日期（2026-02-30 这类会被 JS 自动顺延的日期不算） */
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** 合作状态。停用优先；没填开始日期不算“待开始”（档案校验保证开始日期必填）。 */
export function workforceCooperation(data: Record<string, unknown>, status: string, today: string): WorkforceCooperation {
  if (status === 'inactive') return 'inactive';
  const end = data.contractEndDate;
  const start = data.contractStartDate;
  if (isDate(end) && end < today) return 'ended';
  if (isDate(start) && start > today) return 'pending';
  return 'working';
}

/** 合作期外不能登录时给本人看的话（密码正确之后才返回，不泄露账号是否存在）。 */
export const WORKFORCE_LOGIN_BLOCK: Readonly<Record<'ended' | 'pending', string>> = {
  ended: '合作期已结束，账号已停用，请联系管理员。',
  pending: '合作期尚未开始，暂时不能登录，请联系管理员。',
};

/** 登录拦截：只有“已到期”“待开始”拦截；停用的员工账号本身已是停用。 */
export function workforceLoginBlock(data: Record<string, unknown>, status: string, today: string): string | null {
  const state = workforceCooperation(data, status, today);
  return state === 'ended' || state === 'pending' ? WORKFORCE_LOGIN_BLOCK[state] : null;
}

/** 期限与单价校验（保存时服务端和表单共用）；返回第一个错误，没有则 null。 */
export function validateWorkforceTerms(v: { employmentType?: unknown; contractStartDate?: unknown; contractEndDate?: unknown; payRate?: unknown }): string | null {
  if (v.employmentType !== 'part_time' && v.employmentType !== 'temp') return '用工类型必须是兼职或临时工';
  if (!isDate(v.contractStartDate)) return '请填写合作开始日期';
  const hasEnd = v.contractEndDate !== undefined && v.contractEndDate !== null && v.contractEndDate !== '';
  if (v.employmentType === 'temp' && !hasEnd) return '临时工必须填写合作结束日期';
  if (hasEnd) {
    if (!isDate(v.contractEndDate)) return '合作结束日期格式不正确';
    if (v.contractEndDate < v.contractStartDate) return '合作结束日期不能早于开始日期';
  }
  if (typeof v.payRate === 'number' && (!Number.isInteger(v.payRate) || v.payRate < 0 || v.payRate > WORKFORCE_MAX_PAY_CENTS)) return '单价需要是 0 到 1000 万元之间的数字';
  return null;
}

/** 档案里的计薪是否要同步成员工时薪：只有“计时”且单价大于 0（直播主播工资默认时薪的取数口径，和旧系统 archiveHourlyRate 一致）。 */
export function workforceHourlyCents(payMethod: unknown, payRate: unknown): number | null {
  return payMethod === 'hourly' && typeof payRate === 'number' && Number.isInteger(payRate) && payRate > 0 ? payRate : null;
}

/** 列表/详情上的计薪文字：如“200.00 元/天”。 */
export function workforcePayText(payMethod: unknown, payRate: unknown): string {
  if (typeof payRate !== 'number') return '';
  const unit = WORKFORCE_PAY_UNITS[payMethod as WorkforcePayMethod] ?? '';
  return `${(payRate / 100).toFixed(2)} ${unit}`.trim();
}

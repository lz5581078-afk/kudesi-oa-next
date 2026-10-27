/**
 * 任务中心：手工任务和周期任务。
 * 周期任务按北京时间的“日期”判断今天要不要生成；每个（周期任务, 日期）只会生成一条（schedule_key 幂等）。
 */
export type RoutineFrequency = 'daily' | 'weekly' | 'monthly';
export const ROUTINE_FREQUENCY_LABEL: Record<RoutineFrequency, string> = { daily: '每天', weekly: '每周', monthly: '每月' };
export const WEEKDAY_LABEL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

export interface RoutineRule {
  frequency: RoutineFrequency;
  /** 每周：1 = 周一 … 7 = 周日 */
  weekday?: number | null;
  /** 每月：1–28 号（不用 29–31，避免小月没有这一天） */
  monthDay?: number | null;
}

/** yyyy-mm-dd 是周几：1 = 周一 … 7 = 周日（按日历日期算，和时区无关）。 */
export function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

export function routineMatches(rule: RoutineRule, ymd: string): boolean {
  if (rule.frequency === 'daily') return true;
  if (rule.frequency === 'weekly') return weekdayOf(ymd) === rule.weekday;
  return Number(ymd.slice(8, 10)) === rule.monthDay;
}

export function validateRoutine(rule: RoutineRule, title: string, dueDays: number): string[] {
  const errors: string[] = [];
  if (!title.trim() || title.length > 150) errors.push('任务标题必填，不超过 150 字');
  if (!['daily', 'weekly', 'monthly'].includes(rule.frequency)) errors.push('请选择频率');
  if (rule.frequency === 'weekly' && !(Number.isInteger(rule.weekday) && (rule.weekday as number) >= 1 && (rule.weekday as number) <= 7)) errors.push('请选择周几');
  if (rule.frequency === 'monthly' && !(Number.isInteger(rule.monthDay) && (rule.monthDay as number) >= 1 && (rule.monthDay as number) <= 28)) errors.push('每月几号只能选 1 到 28 号');
  if (!Number.isInteger(dueDays) || dueDays < 1 || dueDays > 30) errors.push('完成期限是 1 到 30 天');
  return errors;
}

/** 北京时间 ymd 当天 23:59:59 之后再加 plusDays-1 天，作为截止时间。 */
export function dueEndOfDay(ymd: string, days: number): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days - 1, 23, 59, 59) - 8 * 3600_000);
}

// ---------- 监督、复核、延期、反馈模板（旧任务系统的逻辑） ----------

/** 任务状态：open 办理中；reviewing 已提交等监督人复核；abnormal 负责人按异常提交，等监督人处理；done / cancelled 已结束。 */
export type TaskStatus = 'open' | 'reviewing' | 'abnormal' | 'done' | 'cancelled';
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { open: '办理中', reviewing: '待复核', abnormal: '异常待处理', done: '已完成', cancelled: '已取消' };

export interface FeedbackField { key: string; label: string; type: 'text' | 'number' | 'amount' | 'select' | 'date'; options?: string[] }
/** 反馈模板：负责人提交任务时要填的内容。旧系统四种；“截图”类字段在旧系统只是占位文本框，这里改成“截图说明”文本。 */
export const TASK_FEEDBACK_PRESETS: Record<string, { name: string; fields: FeedbackField[] }> = {
  simple: { name: '通用反馈', fields: [{ key: 'result', label: '处理结果', type: 'text' }, { key: 'note', label: '补充说明', type: 'text' }] },
  customer_store_check: { name: '客服店铺数量检查', fields: [{ key: 'storeCount', label: '店铺数量', type: 'number' }, { key: 'screenshot', label: '检查截图说明', type: 'text' }, { key: 'abnormalNote', label: '异常说明', type: 'text' }] },
  operation_daily: { name: '运营日报', fields: [{ key: 'salesAmount', label: '销售额', type: 'amount' }, { key: 'promotionFee', label: '推广费', type: 'amount' }, { key: 'todayActions', label: '今日动作', type: 'text' }, { key: 'problemNote', label: '问题反馈', type: 'text' }, { key: 'screenshot', label: '截图说明', type: 'text' }] },
  phone_check: { name: '手机号畅通检查', fields: [{ key: 'phoneNumber', label: '手机号', type: 'text' }, { key: 'isConnected', label: '是否畅通', type: 'select', options: ['畅通', '不畅通'] }, { key: 'rechargeStatus', label: '充值状态', type: 'select', options: ['正常', '待充值', '已停机'] }, { key: 'abnormalNote', label: '异常说明', type: 'text' }] },
};
export const DEFAULT_FEEDBACK_PRESET = 'simple';

/** 校验负责人提交的反馈：至少填一项；数字/金额要是数字；下拉要在选项里；只认模板里的字段。 */
export function validateFeedback(preset: string | null | undefined, payload: Record<string, unknown>): string[] {
  const def = TASK_FEEDBACK_PRESETS[preset ?? DEFAULT_FEEDBACK_PRESET];
  if (!def) return ['反馈模板不存在'];
  const errors: string[] = [];
  const known = new Set(def.fields.map((f) => f.key));
  for (const k of Object.keys(payload)) if (!known.has(k)) errors.push(`没有“${k}”这个反馈项`);
  let filled = 0;
  for (const f of def.fields) {
    const raw = payload[f.key];
    const v = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!v) continue;
    filled += 1;
    if (v.length > 500) errors.push(`${f.label}不超过 500 字`);
    if ((f.type === 'number' || f.type === 'amount') && !/^-?\d+(\.\d+)?$/.test(v)) errors.push(`${f.label}要填数字`);
    if (f.type === 'select' && !(f.options ?? []).includes(v)) errors.push(`${f.label}请从选项里选`);
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`${f.label}日期格式不对`);
  }
  if (filled === 0) errors.push('请至少填写一项反馈内容');
  return errors;
}

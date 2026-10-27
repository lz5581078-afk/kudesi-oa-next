/**
 * 售后工单、订单申诉、兜底监督的共用定义：类型、状态、剩余时间、监督规则默认值、文字预填。
 * 业务流转（谁办、几步、多久）一律走统一流程引擎（flow.ts 里的 after-sales / order-appeal 模板），这里只放展示与规则用的纯函数。
 * 金额一律整数分。
 */
import type { Option } from './resources';

export const AFTER_SALES_TEMPLATE = 'after-sales';
export const APPEAL_TEMPLATE = 'order-appeal';

export const AFTER_SALES_TYPES: readonly Option[] = [
  { value: 'refund_only', label: '仅退款' },
  { value: 'return_refund', label: '退货退款' },
  { value: 'exchange', label: '换货' },
  { value: 'resend', label: '补发' },
  { value: 'compensation', label: '补偿' },
  { value: 'other', label: '其他' },
];
export const afterSalesTypeLabel = (v: string | null | undefined) => AFTER_SALES_TYPES.find((t) => t.value === v)?.label ?? v ?? '';

/** 申诉类型：沿用旧系统“申诉入口”的 9 类，及其中 5 类“申诉记录”页签。 */
export interface AppealTypeDef { value: string; label: string; detail: string; compact?: boolean; tab?: boolean }
export const APPEAL_TYPES: readonly AppealTypeDef[] = [
  { value: 'after_sale', label: '售后申诉', detail: '可申诉商家无责的纠纷退款、赔付退款及消费者退货异常的极速退款。', tab: true },
  { value: 'negative_experience', label: '消费者负向体验申诉', detail: '用于负向体验补偿、服务体验异常等场景。', tab: true },
  { value: 'abnormal_order', label: '异常单申诉', detail: '申诉非正常消费者目的或买家原因导致无法正常发货及其它异常订单。', tab: true },
  { value: 'violation', label: '违规申诉', detail: '查看并申诉虚假发货、虚假轨迹等物流违规及其它违规情况。', tab: true },
  { value: 'malicious_complaint', label: '恶意投诉申诉', detail: '对恶意投诉、恶意索赔等进行举证和处理记录。', tab: true },
  { value: 'promotion_fee', label: '推广软件服务费申诉', detail: '推广服务费异常、扣费异常等申诉记录。', compact: true },
  { value: 'malicious_buyer', label: '投诉消费者不合理行为', detail: '恶意下单、异常投诉、疑似薅羊毛行为记录。', compact: true },
  { value: 'force_majeure', label: '不可抗力事件反馈', detail: '物流、天气、平台异常等不可抗力反馈与公告。', compact: true },
  { value: 'reconsider', label: '申诉复议', detail: '对失败申诉进行复议，记录复议结果和责任人。', compact: true },
];
export const appealTypeLabel = (v: string | null | undefined) => APPEAL_TYPES.find((t) => t.value === v)?.label ?? v ?? '';
/** 每家店每月平台给的复议次数（旧系统界面显示“本月申诉复议权益 x/3”），只做提示，不在系统里强拦。 */
export const APPEAL_RECONSIDER_MONTHLY = 3;

/** 工单/申诉当前阶段（由流程运行状态和当前步骤推出，不另存一份）。 */
export type CaseStage = 'handling' | 'reviewing' | 'returned' | 'to_submit' | 'submitted' | 'completed' | 'rejected' | 'cancelled';
export const CASE_STAGE_LABEL: Record<CaseStage, string> = {
  handling: '处理中', reviewing: '待复核', returned: '被退回', to_submit: '待提交平台', submitted: '已申诉待结果',
  completed: '已办结', rejected: '已驳回', cancelled: '已取消',
};
export const CASE_STAGE_TONE: Record<CaseStage, 'warn' | 'ok' | 'bad' | 'muted'> = {
  handling: 'warn', reviewing: 'warn', returned: 'bad', to_submit: 'warn', submitted: 'warn', completed: 'ok', rejected: 'bad', cancelled: 'muted',
};

export function caseStage(template: 'after-sales' | 'order-appeal', runStatus: string, stepKey: string | null): CaseStage {
  if (runStatus === 'completed') return 'completed';
  if (runStatus === 'rejected') return 'rejected';
  if (runStatus === 'cancelled') return 'cancelled';
  if (stepKey === 'apply') return 'returned';
  if (template === 'order-appeal') {
    if (stepKey === 'submit') return 'to_submit';
    if (stepKey === 'result') return 'submitted';
    return 'reviewing';
  }
  return stepKey === 'handle' ? 'handling' : 'reviewing';
}
export const isOpenStage = (s: CaseStage) => !['completed', 'rejected', 'cancelled'].includes(s);

export type AppealResult = 'approved' | 'rejected';
export const APPEAL_RESULT_LABEL: Record<AppealResult, string> = { approved: '申诉通过', rejected: '申诉驳回' };

// ---------- 剩余时间 ----------
const HOUR = 3600e3;
export type DueTone = 'late' | 'soon' | 'ok' | 'done' | 'none';
/** 距截止的文字：已超时 3 小时 / 还剩 5 小时 / 还剩 2 天；已办结的不再倒计时；6 小时内算“即将到期”。 */
export function dueState(dueAt: string | Date | null | undefined, open: boolean, now = Date.now()): { text: string; tone: DueTone } {
  if (!open) return { text: '已办结', tone: 'done' };
  const due = dueAt ? new Date(dueAt).getTime() : NaN;
  if (!Number.isFinite(due)) return { text: '不限时', tone: 'none' };
  const diff = due - now;
  const abs = Math.abs(diff);
  const span = abs >= 24 * HOUR ? `${Math.floor(abs / (24 * HOUR))} 天` : abs >= HOUR ? `${Math.floor(abs / HOUR)} 小时` : `${Math.max(1, Math.floor(abs / 60000))} 分钟`;
  if (diff < 0) return { text: `已超时 ${span}`, tone: 'late' };
  return { text: `还剩 ${span}`, tone: diff < SOON_MS ? 'soon' : 'ok' };
}
export const SOON_MS = 6 * HOUR;

// ---------- 文字预填（旧系统“截图/文字识别”里文字这一半：服务端只做预填，不自动建单） ----------
export interface AfterSalesPrefill { orderNo: string; caseType: string; amountCents: number | null; reason: string }
/** 从买家发来的售后文字里认出订单号、类型、金额、原因；认不出的留空，让客服自己填。 */
export function parseAfterSalesText(text: string): AfterSalesPrefill {
  const t = text ?? '';
  const orderNo = t.match(/[A-Za-z]{0,4}\d{6,}(?:-\d+)?/)?.[0] ?? '';
  const m = t.match(/(?:金额|退款|¥|￥)\s*[:：]?\s*(\d+(?:\.\d{1,2})?)/);
  const caseType = /仅退款/.test(t) ? 'refund_only' : /换货/.test(t) ? 'exchange' : /补发|漏发|少发/.test(t) ? 'resend' : /补偿|赔付/.test(t) ? 'compensation' : /退货|退款/.test(t) ? 'return_refund' : 'other';
  const reasonKw = ['物流异常', '物流', '尺寸不合适', '尺寸', '质量问题', '质量', '发错货', '少件', '破损', '不想要', '拍错'];
  const kw = reasonKw.find((k) => t.includes(k));
  const reason = kw ?? t.replace(/\s+/g, ' ').trim().slice(0, 120);
  return { orderNo, caseType, amountCents: m ? Math.round(Number(m[1]) * 100) : null, reason };
}
/** 高金额工单要主管复核（旧系统提示“高金额，需要主管审核”，阈值 1000 元）。 */
export const HIGH_AMOUNT_CENTS = 100_000;

// ---------- 兜底监督 ----------
export type SupervisionTarget = 'after_sales' | 'appeal' | 'flow' | 'task';
export const SUPERVISION_TARGET_LABEL: Record<SupervisionTarget, string> = { after_sales: '售后工单', appeal: '订单申诉', flow: '流程待办', task: '任务' };
export type ExceptionSource = SupervisionTarget | 'manual';
export const EXCEPTION_SOURCE_LABEL: Record<ExceptionSource, string> = { ...SUPERVISION_TARGET_LABEL, manual: '手工登记' };
export type Severity = 'urgent' | 'important' | 'normal';
export const SEVERITY_LABEL: Record<Severity, string> = { urgent: '紧急', important: '重要', normal: '一般' };

export interface SupervisionRuleDef {
  targetType: SupervisionTarget;
  name: string;
  /** 逾期多少分钟后登记为异常（0 = 一逾期就登记） */
  overdueMinutes: number;
  /** 逾期多少分钟后升级到主管可见（L2） */
  supervisorVisibleMinutes: number;
  /** 逾期多少分钟后升级到老板可见（L3） */
  bossVisibleMinutes: number;
  abnormalCondition: string;
  /** 关闭异常必须写原因 */
  closeRequiresReason: boolean;
  status: 'active' | 'inactive';
}
/** 没有自定义规则时用这一组（旧系统 supervision_rules 的默认口径：老板 1440 分钟可见，关闭要写原因）。 */
export const DEFAULT_SUPERVISION_RULES: readonly SupervisionRuleDef[] = [
  { targetType: 'after_sales', name: '售后工单超时', overdueMinutes: 0, supervisorVisibleMinutes: 0, bossVisibleMinutes: 1440, abnormalCondition: '售后工单超过本环节时限仍未办结', closeRequiresReason: true, status: 'active' },
  { targetType: 'appeal', name: '订单申诉超时', overdueMinutes: 0, supervisorVisibleMinutes: 0, bossVisibleMinutes: 1440, abnormalCondition: '申诉环节超过平台倒计时或本环节时限', closeRequiresReason: true, status: 'active' },
  { targetType: 'flow', name: '流程待办超时', overdueMinutes: 0, supervisorVisibleMinutes: 60, bossVisibleMinutes: 1440, abnormalCondition: '流程待办超过环节时限未办理', closeRequiresReason: true, status: 'active' },
  { targetType: 'task', name: '任务逾期', overdueMinutes: 0, supervisorVisibleMinutes: 60, bossVisibleMinutes: 1440, abnormalCondition: '任务超过截止时间未完成', closeRequiresReason: true, status: 'active' },
];

/** 逾期多久对应第几级：L1 员工自己，L2 主管，L3 老板。 */
export function escalationLevel(overdueMinutes: number, rule: Pick<SupervisionRuleDef, 'supervisorVisibleMinutes' | 'bossVisibleMinutes'>): 1 | 2 | 3 {
  if (overdueMinutes >= rule.bossVisibleMinutes) return 3;
  if (overdueMinutes >= rule.supervisorVisibleMinutes) return 2;
  return 1;
}

/** 给首页/老板总控台用的汇总（服务端 SupervisionService.summary 的返回形状）。 */
export interface ServiceSummary {
  asOf: string;
  afterSales: { open: number; overdue: number; dueSoon: number; openAmountCents: number; overdueAmountCents: number };
  appeals: { open: number; overdue: number; dueSoon: number; toSubmit: number; openAmountCents: number };
  tasks: { pending: number; overdue: number; completed: number; total: number };
  flows: { running: number; overdue: number };
  exceptions: { open: number; urgent: number; escalated: number };
}

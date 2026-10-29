import type { ExpiryState, RechargeState } from '@kudesi/shared';

export const PHONE_CYCLE_LABEL: Record<string, string> = { monthly: '月付', quarterly: '季付', yearly: '年付' };
export const BB_CYCLE_LABEL: Record<string, string> = { monthly: '月付', yearly: '年付' };
export const USER_KIND_LABEL: Record<string, string> = { use: '使用', external: '外部使用', partner: '合作', keeper: '保管' };

export type Tone = 'bad' | 'warn' | 'ok' | 'muted';

export function rechargeText(state: RechargeState, days: number | null): { tone: Tone; text: string } {
  if (state === 'none' || days === null) return { tone: 'muted', text: '未排期' };
  if (state === 'overdue') return { tone: 'bad', text: `逾期 ${-days} 天` };
  if (days === 0) return { tone: 'warn', text: '今天要充' };
  return { tone: state === 'soon' ? 'warn' : 'muted', text: `${days} 天后` };
}

export function expiryText(state: ExpiryState, days: number | null): { tone: Tone; text: string } {
  if (state === 'none' || days === null) return { tone: 'muted', text: '未填到期日' };
  if (state === 'expired') return { tone: 'bad', text: `已到期 ${-days} 天` };
  if (days === 0) return { tone: 'warn', text: '今天到期' };
  return { tone: state === 'soon' ? 'warn' : 'muted', text: `${days} 天后到期` };
}

/** 整数分 → ¥1,234.50；没有金额显示“未设” */
export const yuan = (cents: number | null | undefined) => (typeof cents === 'number' && Number.isFinite(cents) ? `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '未设');
export const shortDate = (d: string | null) => (d ? d.slice(5) : '—');

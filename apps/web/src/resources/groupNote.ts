import { monthlyEquivalentCents } from '@kudesi/shared';
import type { ResourceDto } from './api';

/** 分组条上的补充说明：宽带按区域分组时显示这个区域的月均费用合计（年付折算成月，整数分） */
export function groupNote(type: string, rows: ResourceDto[]): string | undefined {
  if (type !== 'broadband') return undefined;
  let total = 0;
  let known = 0;
  for (const r of rows) {
    const amount = r.data.amount;
    if (typeof amount !== 'number') continue;
    total += monthlyEquivalentCents(amount, typeof r.data.cycle === 'string' ? r.data.cycle : 'monthly') ?? 0;
    known++;
  }
  if (!known) return undefined;
  return `月均 ¥${(total / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

import { nextRechargeDate, type LedgerBroadbandRow, type LedgerPhoneRow } from '@kudesi/shared';
import { yuanToCents } from '../../finance/common';
import { BB_CYCLE_LABEL, PHONE_CYCLE_LABEL, yuan } from './format';
import type { RowEdit } from './feeApi';

/** 一次修改里的表单：use 里勾了的项才会写入（批量时是“改这一项”，单条时全部预勾） */
export interface PhoneForm {
  carrier: string; plan: string; fee: string; feeCycle: string; cycleDays: string;
  parentId: number | null; parentLabel: string;
}
export interface BroadbandForm {
  fee: string; cycle: string; expiresAt: string; locationId: number | null; phoneId: number | null; phoneLabel: string;
}
export type UseMap = Record<string, boolean>;
export interface Change { id: number; title: string; lines: string[]; edit: RowEdit }
export type Built = { error: string } | { changes: Change[] };

/** 把表单和勾选项变成逐行的修改预览；任何一项不合法就整体报错（不会部分写入） */
export function buildPhoneChanges(rows: LedgerPhoneRow[], form: PhoneForm, use: UseMap, today: string, opts: { single?: boolean } = {}): Built {
  if (!rows.length) return { error: '请先选择要修改的号码' };
  let fee: number | null = null;
  if (use.fee) {
    fee = yuanToCents(form.fee);
    if (fee === null || Number.isNaN(fee) || fee < 0) return { error: '费用金额不合法（元，最多两位小数）' };
  }
  const blankDays = use.cycleDays && opts.single && form.cycleDays.trim() === '';
  if (use.cycleDays && !blankDays && !(Number.isInteger(Number(form.cycleDays)) && Number(form.cycleDays) >= 1 && Number(form.cycleDays) <= 3650)) return { error: '充值周期应在 1 到 3650 天之间' };
  if (use.plan && !opts.single && !form.plan.trim()) return { error: '套餐名不能为空' };
  const changes: Change[] = [];
  for (const r of rows) {
    const data: Record<string, unknown> = {};
    const lines: string[] = [];
    const put = (key: string, label: string, next: unknown, before: string, after: string) => { data[key] = next; lines.push(`${label}：${before || '空'} → ${after || '空'}`); };
    if (use.carrier && (form.carrier.trim() || null) !== r.carrier) put('carrier', '运营商', form.carrier.trim() || null, r.carrier ?? '', form.carrier.trim());
    if (use.plan && form.plan.trim() !== (r.plan ?? '')) put('plan', '套餐', form.plan.trim(), r.plan ?? '', form.plan.trim());
    if (use.fee && fee !== r.feeCents) put('monthlyFee', '费用', fee, r.feeCents == null ? '' : yuan(r.feeCents), yuan(fee));
    if (use.feeCycle && form.feeCycle !== r.feeCycle) put('feeCycle', '费用周期', form.feeCycle, PHONE_CYCLE_LABEL[r.feeCycle] ?? r.feeCycle, PHONE_CYCLE_LABEL[form.feeCycle] ?? form.feeCycle);
    if (use.cycleDays && !blankDays && Number(form.cycleDays) !== r.cycleDays) put('rechargeCycleDays', '充值周期(天)', Number(form.cycleDays), r.cycleDays ? String(r.cycleDays) : '', form.cycleDays);
    if (use.parent && form.parentId !== r.parentId) {
      if (form.parentId === r.id) return { error: `${r.number}：主卡不能选自己` };
      if (form.parentId !== null && r.childCount > 0) return { error: `${r.number} 下面还有 ${r.childCount} 张子卡，不能再设为子卡；请先把它们改挂到别的主卡` };
      put('parentPhoneId', '主卡', form.parentId, r.parentNumber ?? '无（主卡）', form.parentId === null ? '无（设为主卡）' : form.parentLabel);
    }
    if (use.recharge) {
      const cycle = use.cycleDays ? Number(form.cycleDays) : r.cycleDays;
      data.lastRechargeAt = today;
      lines.push(`最后充值：${r.lastRechargeAt ?? '空'} → ${today}，下次充值日 ${nextRechargeDate({ lastRechargeAt: today, rechargeCycleDays: cycle })}`);
    }
    if (lines.length) changes.push({ id: r.id, title: r.number, lines, edit: { id: r.id, version: r.version, title: r.number, data } });
  }
  if (!changes.length) return { error: '没有需要修改的内容（先勾选“改这一项”并填写新值）' };
  return { changes };
}

export function buildBroadbandChanges(rows: LedgerBroadbandRow[], form: BroadbandForm, use: UseMap): Built {
  if (!rows.length) return { error: '请先选择要修改的宽带' };
  let fee: number | null = null;
  if (use.fee) {
    fee = yuanToCents(form.fee);
    if (fee === null || Number.isNaN(fee) || fee < 0) return { error: '费用金额不合法（元，最多两位小数）' };
  }
  if (use.expiresAt && form.expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(form.expiresAt)) return { error: '到期日格式应为 年-月-日' };
  if (use.phoneId && form.phoneId === null && rows.some((r) => r.phoneId !== null)) return { error: '宽带必须绑定手机号，请选择一个号码' };
  const changes: Change[] = [];
  for (const r of rows) {
    const data: Record<string, unknown> = {};
    const lines: string[] = [];
    const put = (key: string, label: string, next: unknown, before: string, after: string) => { data[key] = next; lines.push(`${label}：${before || '空'} → ${after || '空'}`); };
    if (use.fee && fee !== r.amountCents) put('amount', '金额', fee, r.amountCents == null ? '' : yuan(r.amountCents), yuan(fee));
    if (use.cycle && form.cycle !== r.cycle) put('cycle', '周期', form.cycle, BB_CYCLE_LABEL[r.cycle] ?? r.cycle, BB_CYCLE_LABEL[form.cycle] ?? form.cycle);
    if (use.expiresAt && (form.expiresAt || null) !== r.expiresAt) put('expiresAt', '到期日', form.expiresAt || null, r.expiresAt ?? '', form.expiresAt);
    if (use.locationId && form.locationId !== r.locationId) put('locationId', '使用区域', form.locationId, r.location ?? '未指定区域', form.locationId === null ? '未指定区域' : '已选区域');
    if (use.phoneId && form.phoneId !== r.phoneId) put('phoneId', '绑定手机号', form.phoneId, r.phoneNumber ?? '未绑定', form.phoneLabel);
    if (lines.length) changes.push({ id: r.id, title: r.account, lines, edit: { id: r.id, version: r.version, title: r.account, data } });
  }
  if (!changes.length) return { error: '没有需要修改的内容（先勾选“改这一项”并填写新值）' };
  return { changes };
}

export function phoneFormOf(r?: LedgerPhoneRow): PhoneForm {
  return { carrier: r?.carrier ?? '', plan: r?.plan ?? '', fee: r?.feeCents != null ? (r.feeCents / 100).toFixed(2) : '', feeCycle: r?.feeCycle ?? 'monthly', cycleDays: r?.cycleDays ? String(r.cycleDays) : r ? '' : '30', parentId: r?.parentId ?? null, parentLabel: r?.parentNumber ?? '' };
}
export function broadbandFormOf(r?: LedgerBroadbandRow): BroadbandForm {
  return { fee: r?.amountCents != null ? (r.amountCents / 100).toFixed(2) : '', cycle: r?.cycle ?? 'monthly', expiresAt: r?.expiresAt ?? '', locationId: r?.locationId ?? null, phoneId: r?.phoneId ?? null, phoneLabel: r?.phoneNumber ?? '' };
}

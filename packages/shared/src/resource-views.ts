/**
 * 店铺与账号类资料的“按日期实时计算”的视图（旧系统 store-parts.jsx / phones.jsx / account-services.jsx 的行为）：
 * - 聚水潭授权到期三级：已过期 / 15 天内 / 30 天内（只算“已连接”的店铺）；
 * - 备忘到期、手机号充值：到期日由日期实时算，不改状态；
 * - 列表上的快捷筛选（虚拟筛选，条件在服务端按日期算，不是存下来的字段）。
 */
import { RESOURCE_DEFS, type Option } from './resources';
import { daysBetweenDates } from './expiry';

export type DueLevel = 'expired' | 'urgent' | 'soon';

export interface DueState {
  level: DueLevel;
  /** 距今天数，负数 = 已过期 */
  left: number;
  text: string;
}

/** 聚水潭授权：已过期；15 天内（含当天）；16~30 天内；更远不提示。只算已连接。 */
export function jushuitanDue(data: Record<string, unknown>, today: string): DueState | null {
  if (data.jushuitan !== 'connected') return null;
  const date = typeof data.jushuitanExpireAt === 'string' ? data.jushuitanExpireAt : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const left = daysBetweenDates(today, date);
  if (left < 0) return { level: 'expired', left, text: `已过期 ${-left} 天` };
  if (left <= 15) return { level: 'urgent', left, text: left === 0 ? '今天到期' : `${left} 天后到期` };
  if (left <= 30) return { level: 'soon', left, text: `${left} 天后到期` };
  return null;
}

/** 普通到期日：过期，或 N 天内到期（备忘 30 天、手机号充值 7 天）。停用的不提示。 */
export function dueWithin(date: unknown, days: number, today: string, status?: string): DueState | null {
  if (status === 'inactive' || status === 'cancelled') return null;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const left = daysBetweenDates(today, date);
  if (left < 0) return { level: 'expired', left, text: `已过期 ${-left} 天` };
  if (left <= days) return { level: 'urgent', left, text: left === 0 ? '今天到期' : `${left} 天后到期` };
  return null;
}

export const PHONE_RECHARGE_DAYS = 7;
export const MEMO_DUE_DAYS = 30;

/** 列表里日期列旁边的到期提示（只对旧系统有提示的几个日期列） */
export function dueBadgeFor(type: string, fieldKey: string, data: Record<string, unknown>, status: string, today: string): DueState | null {
  if (type === 'stores' && fieldKey === 'jushuitanExpireAt') return jushuitanDue(data, today);
  if (type === 'memos' && fieldKey === 'endAt') return dueWithin(data.endAt, MEMO_DUE_DAYS, today, status);
  if (type === 'software' && fieldKey === 'renewAt') return dueWithin(data.renewAt, MEMO_DUE_DAYS, today, status);
  if (type === 'phones' && fieldKey === 'nextRechargeAt') return dueWithin(data.nextRechargeAt, PHONE_RECHARGE_DAYS, today, status);
  return null;
}

export interface ViewFilterDef {
  key: string;
  label: string;
  options: readonly Option[];
}

const storePlatformOptions = (): Option[] => {
  const f = RESOURCE_DEFS.find((d) => d.key === 'stores')?.fields.find((x) => x.key === 'platform');
  return (f?.options ?? []).map((o) => ({ value: o.value, label: `绑定了${o.label}店铺` }));
};

/** 虚拟筛选：列表上方的下拉，条件在服务端实时计算（见 api 的 view-filters.ts） */
export function viewFiltersOf(type: string): ViewFilterDef[] {
  const computed = (RESOURCE_DEFS.find((d) => d.key === type)?.computedFilters ?? []).map((f) => ({ key: f.key, label: f.label, options: f.options.map((o) => ({ value: o.value, label: o.label })) }));
  return [...hardViewFilters(type), ...computed];
}

function hardViewFilters(type: string): ViewFilterDef[] {
  switch (type) {
    case 'stores':
      return [
        { key: 'jstExpiry', label: '聚水潭到期', options: [{ value: 'expired', label: '授权已过期' }, { value: 'urgent', label: '15 天内到期' }, { value: 'soon', label: '16~30 天内到期' }] },
        { key: 'legacyOwner', label: '历史负责人', options: [{ value: 'unassigned', label: '有历史负责人但未指派' }] },
      ];
    case 'phones':
      return [
        { key: 'card', label: '主卡/子卡', options: [{ value: 'main', label: '只看主卡' }, { value: 'sub', label: '只看子卡' }] },
        { key: 'storePlatform', label: '店铺平台', options: [...storePlatformOptions(), { value: '__none', label: '没有绑定店铺' }] },
        { key: 'recharge', label: '充值', options: [{ value: 'soon', label: `即将充值（${PHONE_RECHARGE_DAYS} 天内，含已逾期）` }] },
      ];
    case 'memos':
      return [{ key: 'memoView', label: '快捷视图', options: [{ value: 'domain', label: '域名' }, { value: 'dueSoon', label: `即将到期（${MEMO_DUE_DAYS} 天内）` }, { value: 'expired', label: '已过期' }] }];
    case 'finance-base-codes':
      // 旧系统 display_hidden：真实编码有马甲时，验证通过后在列表里隐藏（马甲代表它），详情里仍能看到
      return [{ key: 'realView', label: '真实编码', options: [{ value: 'foldVerified', label: '隐藏已验证且有马甲的真实编码' }] }];
    default:
      return [];
  }
}

/**
 * 导入文件里的手机号常被 Excel 弄坏：="138…" 公式写法、138…​.0、科学计数法（1.38E+10）、带空格横线。
 * 还原成纯数字文本（旧系统 normalizePhoneNumberText）。
 */
export function normalizePhoneImportText(value: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const formula = raw.match(/^="?([^"]+)"?$/);
  const text = formula ? formula[1].trim() : raw;
  if (/^\d+(\.0+)?$/.test(text)) return text.replace(/\.0+$/, '');
  if (/^\d+(?:\.\d+)?e\+?\d+$/i.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return n.toFixed(0);
  }
  return text.replace(/[^\d]/g, '');
}

/** 手机号导入表里“各平台店铺”列的表头：<平台>编号、<平台>店铺 */
export function phoneStoreImportColumns(): Array<{ platform: string; label: string; noHeader: string; nameHeader: string }> {
  const f = RESOURCE_DEFS.find((d) => d.key === 'stores')?.fields.find((x) => x.key === 'platform');
  return (f?.options ?? []).map((o) => ({ platform: o.value, label: o.label, noHeader: `${o.label}编号`, nameHeader: `${o.label}店铺` }));
}

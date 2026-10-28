import { dueBadgeFor, dueWithin, todayShanghai, workforcePayText, type FieldDef, type ResourceDef } from '@kudesi/shared';
import type { ResourceDto } from './api';
import { CopyButton, isCopyable } from './CopyValue';
import { displayValue } from './format';

type Fact = string | { label: string; text: (r: ResourceDto) => string; copy?: boolean; hideEmpty?: boolean };

/** 详情顶部的“关键信息”：旧系统卷宗每类资料头部放 3~4 项最常看的内容（号码、归属、负责人、到期日），不用翻分区。字段 key 即该字段，对象是组合值。 */
export const KEY_FACTS: Record<string, Fact[]> = {
  licenses: ['creditCode', 'legalPerson', { label: '年审', text: (r) => (r.data.annualAuditDay ? `每年 ${String(r.data.annualAuditDay)}` : '') }, { label: '执照存放', text: (r) => r.refLabels.locationId ?? '' }],
  qualifications: ['licenseId', 'certNo', 'expiresAt', 'type'],
  trademarks: ['classNo', 'registrationNo', 'licenseId', 'validUntil'],
  'tax-profiles': ['licenseId', 'taxpayerNo', 'taxType', 'taxAuthority'],
  partners: ['phone', 'contactName', 'contactUserId', 'partnerType'],
  'bank-accounts': ['accountNo', 'keeperUserId', 'currentBalance', 'licenseId', { label: '关联店铺', hideEmpty: true, text: (r) => r.refLabels.storeId ?? '' }],
  phones: [
    'usageType',
    { label: '保管 / 使用', text: (r) => r.refLabels.userId || String(r.data.externalUser ?? '') || r.refLabels.partnerId || r.refLabels.keeperUserId || String(r.data.keeperName ?? '') },
    'carrier',
    'nextRechargeAt',
  ],
  stores: ['platform', 'storeNo', { label: '当前运营', text: (r) => r.refLabels.operatorUserId || (r.data.legacyOwnerName ? `未指派（历史负责人：${String(r.data.legacyOwnerName)}）` : r.data.claimStatus === 'public' ? '公共店铺' : '未指派') }, 'licenseId'],
  wechat: ['wechatNo', 'userId', 'purpose', 'phoneId'],
  broadband: ['locationId', 'bandwidth', 'amount', 'phoneId'],
  'self-media': ['accountNo', 'operatorUserId', 'phoneId', 'platform'],
  memos: ['kind', 'loginName', 'ownerUserId', 'endAt'],
  software: ['account', 'storeId', 'renewAt', 'annualFee'],
  'fixed-assets': ['assetNo', 'userId', 'locationId', 'categoryId'],
  locations: ['locationType', 'code', 'scope'],
  archives: ['archiveNo', 'locationId', 'keeperUserId', 'archiveType'],
  'duty-groups': ['scope', 'leaderUserId'],
  workforce: ['employmentType', 'cooperation', 'positionName', 'contractStartDate', 'contractEndDate', { label: '计薪', hideEmpty: true, text: (r) => workforcePayText(r.data.payMethod, r.data.payRate) }], // 没有薪资权限的人，服务端不返回计薪，这一项不显示
};

const DATE_EXPIRY = new Set(['expiresAt', 'validUntil', 'endAt', 'renewAt', 'nextRechargeAt']);

function dueText(type: string, key: string, r: ResourceDto, today: string): { text: string; bad: boolean } | null {
  const badge = dueBadgeFor(type, key, r.data, r.status, today);
  if (badge) return { text: badge.text, bad: badge.level === 'expired' };
  if (!DATE_EXPIRY.has(key)) return null;
  const d = dueWithin(r.data[key], 30, today, r.status);
  return d ? { text: d.text, bad: d.level === 'expired' } : null;
}

export function KeyFacts({ def, record, canSee }: { def: ResourceDef; record: ResourceDto; canSee?: (f: FieldDef) => boolean }) {
  const specs = KEY_FACTS[def.key];
  if (!specs) return null;
  const today = todayShanghai();
  const items = specs.filter((spec) => typeof spec === 'string' || !spec.hideEmpty || spec.text(record)).map((spec) => {
    if (typeof spec !== 'string') return { key: spec.label, label: spec.label, text: spec.text(record), copy: spec.copy ?? false, due: null as ReturnType<typeof dueText> };
    const f = def.fields.find((x) => x.key === spec);
    if (!f || (canSee && !canSee(f))) return null;
    return { key: f.key, label: f.label, text: displayValue(f, record), copy: isCopyable(def, f), due: dueText(def.key, f.key, record, today) };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  if (items.length === 0) return null;
  return (
    <dl className="key-facts" aria-label="关键信息">
      {items.map((it) => (
        <div key={it.key}>
          <dt>{it.label}</dt>
          <dd>
            {it.text ? <span className={it.copy ? 'mono' : undefined}>{it.text}</span> : <span className="muted">未填写</span>}
            {it.copy && <> <CopyButton value={it.text} label={it.label} /></>}
            {it.due && <> <span className={`pill ${it.due.bad ? 'bad' : 'warn'}`}>{it.due.text}</span></>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

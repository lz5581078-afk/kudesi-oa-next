/**
 * 手工关联的“关系类型”：旧系统（relation-registry.js 里 storage=link 的 15 种关系 + types.js 里的显示名）
 * 按“当前资料类型 + 目标资料类型”给出不同的选项，默认第一个。
 * 存进 resource_links.relation_kind 的是“正向名称”（source 看 target 的叫法）；从另一边看，显示反向名称。
 */
export interface RelationKindDef {
  key: string;
  /** 正向：source 资料看 target 资料叫什么 */
  source: string;
  target: string;
  label: string;
  /** 反向：target 资料看 source 资料叫什么 */
  reverse: string;
  constraint?: string;
}

export const RELATION_KIND_DEFS: readonly RelationKindDef[] = [
  { key: 'phone_store', source: 'phones', target: 'stores', label: '绑定店铺', reverse: '绑定手机号', constraint: '同一手机号在同一平台只允许关联一个店铺' },
  { key: 'phone_license', source: 'phones', target: 'licenses', label: '关联营业执照', reverse: '关联手机号' },
  { key: 'phone_self_media', source: 'phones', target: 'self-media', label: '绑定自媒体账号', reverse: '绑定手机号' },
  { key: 'phone_wechat', source: 'phones', target: 'wechat', label: '绑定微信号', reverse: '绑定手机号' },
  { key: 'bank_store', source: 'bank-accounts', target: 'stores', label: '关联店铺', reverse: '银行账户' },
  { key: 'partner_profile_license', source: 'partners', target: 'licenses', label: '关联营业执照', reverse: '合作人' },
  { key: 'partner_profile_store', source: 'partners', target: 'stores', label: '关联店铺', reverse: '合作人' },
  { key: 'partner_bank', source: 'partners', target: 'bank-accounts', label: '关联银行账户', reverse: '合作人' },
  { key: 'trademark_store_authorization', source: 'trademarks', target: 'stores', label: '授权店铺', reverse: '授权商标' },
  { key: 'self_media_store', source: 'self-media', target: 'stores', label: '关联店铺', reverse: '自媒体账号' },
  { key: 'store_wechat', source: 'stores', target: 'wechat', label: '关联微信号', reverse: '关联店铺' },
  { key: 'account_service_license', source: 'memos', target: 'licenses', label: '关联营业执照', reverse: '账号与服务' },
  { key: 'account_service_store', source: 'memos', target: 'stores', label: '关联店铺', reverse: '账号与服务' },
  { key: 'account_service_phone', source: 'memos', target: 'phones', label: '绑定手机号', reverse: '绑定的账号与服务' },
  { key: 'license_operator', source: 'licenses', target: 'user', label: '关联运营', reverse: '关联营业执照' },
];

/** 旧数据里的通用类型（新系统早期版本写过），继续认得 */
export const LEGACY_RELATION_KINDS = ['使用', '授权', '保管', '其他'] as const;
/** 两类资料之间旧系统没有定义关系时的通用名称（旧 manual_related） */
export const GENERIC_RELATION_KIND = '手工关联';

/** 当前资料 type 关联到 target 时可选的关系类型；value 是存库的正向名称，label 是从当前资料看的叫法。第一个是默认。 */
export function relationKindOptions(type: string, target: string): Array<{ value: string; label: string; hint?: string }> {
  const out: Array<{ value: string; label: string; hint?: string }> = [];
  for (const d of RELATION_KIND_DEFS) {
    if (d.source === type && d.target === target) out.push({ value: d.label, label: d.label, hint: d.constraint });
    else if (d.source === target && d.target === type) out.push({ value: d.label, label: d.reverse, hint: d.constraint });
  }
  return out.length ? out : [{ value: GENERIC_RELATION_KIND, label: GENERIC_RELATION_KIND }];
}

/** 存库名称 → 从 viewerType 这一边看到的显示名；认不出（历史数据）原样显示 */
export function relationKindLabel(kind: string | null | undefined, viewerType: string, otherType: string): string {
  if (!kind) return '';
  const hit = RELATION_KIND_DEFS.find((d) => d.label === kind && ((d.source === viewerType && d.target === otherType) || (d.source === otherType && d.target === viewerType)));
  if (!hit) return kind;
  return hit.source === viewerType && hit.target === otherType ? hit.label : hit.reverse;
}

/** 这个名称是不是认得的关系类型（服务端校验用）；给了两端类型时还要这一对资料确实有这种关系 */
export function isKnownRelationKind(kind: string, type?: string, target?: string): boolean {
  if ((LEGACY_RELATION_KINDS as readonly string[]).includes(kind) || kind === GENERIC_RELATION_KIND) return true;
  if (type && target) return relationKindOptions(type, target).some((o) => o.value === kind);
  return RELATION_KIND_DEFS.some((d) => d.label === kind);
}

import { CopyButton } from '../fin-ui';
import { FRESH_HINT, FRESH_PILL, fmtUpdated, freshnessTone } from '../freshness';

export const KIND_LABEL: Record<string, string> = { company_public: '公司公户', company_card: '公司银行卡', cashier_account: '出纳账户', store_public: '店铺公户', store_personal_card: '店铺个人卡', legal_person_card: '法人卡', other: '其他' };
export const STORE_KINDS = ['store_public', 'store_personal_card'];
export const has = (text: string, kw: string) => !kw.trim() || kw.trim().split(/\s+/).every((w) => text.toLowerCase().includes(w.toLowerCase()));

/** 更新时间标签：越久没更新颜色越重，鼠标放上去说明档位（沿用旧版 1/2/3/7/15/30 天档位） */
export function Fresh({ at, now }: { at: string | null | undefined; now: number }) {
  const tone = freshnessTone(at, now);
  return <span className={`pill ${FRESH_PILL[tone]}`} title={FRESH_HINT[tone]}>{fmtUpdated(at)}</span>;
}

/** 银行账号沿用资料查看权限直接显示；密码类字段仍走各自的专门权限。 */
export function AccountNo({ value, canView }: { value?: string; canView: boolean }) {
  if (!canView) return <span className="muted">无查看权限</span>;
  if (value === undefined) return <span className="muted">未能读取</span>;
  return value ? <span className="mono">{value} <CopyButton text={value} label="账号" /></span> : <span className="muted">未填写</span>;
}

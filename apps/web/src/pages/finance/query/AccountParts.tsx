import { useState } from 'react';
import { ApiError } from '../../../api/client';
import { resourceApi } from '../../../resources/api';
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

/** 账号/卡号：平时不显示；点“显示”才向服务器取明文（要有查看明文权限，并会留下查看记录），取到后可以一键复制 */
export function AccountNo({ id }: { id: number }) {
  const [value, setValue] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (value !== null) return <span className="mono">{value} <CopyButton text={value} label="账号" /> <button type="button" className="link-button" onClick={() => setValue(null)}>隐藏</button></span>;
  return <span><button type="button" className="link-button" disabled={busy} aria-label="显示账号" onClick={() => { setBusy(true); setErr(''); resourceApi.reveal('bank-accounts', id, 'accountNo').then((r) => setValue(r.value)).catch((e) => setErr(e instanceof ApiError ? e.message : '无法查看')).finally(() => setBusy(false)); }}>{busy ? '读取中…' : '显示账号'}</button>{err && <small className="neg"> {err}</small>}</span>;
}

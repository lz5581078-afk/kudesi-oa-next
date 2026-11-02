import { useEffect, useState } from 'react';
import { resourceApi, type StoreJstShop } from './api';

export function StoreJstSelect({ value, onChange, currentName, autoFocus = false }: {
  value: string; onChange: (value: string) => void; currentName?: string; autoFocus?: boolean;
}) {
  const [shops, setShops] = useState<StoreJstShop[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [keyword, setKeyword] = useState('');
  useEffect(() => {
    let active = true;
    setError(''); setShops(null);
    resourceApi.jushuitanShops().then(rows => { if (active) setShops(rows); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : '店铺列表加载失败'); });
    return () => { active = false; };
  }, [attempt]);
  const matched = (shops ?? []).filter(s => s.id === value || `${s.name} ${s.id}`.toLowerCase().includes(keyword.trim().toLowerCase()));
  return <div>
    <input aria-label="搜索聚水潭店铺" placeholder="搜索店铺名称或编号" value={keyword} onChange={e => setKeyword(e.target.value)} />
    <select aria-label="聚水潭店铺关联" autoFocus={autoFocus} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">未关联（不选或解除关联）</option>
      {value && !shops?.some(s => s.id === value) && <option value={value}>{currentName || `原关联店铺（${value}）`}</option>}
      {matched.map(s => <option key={s.id} value={s.id}>{s.name}（{s.id}）</option>)}
    </select>
    {!shops && !error && <small role="status">正在加载聚水潭店铺…</small>}
    {shops?.length === 0 && <small role="status">当前公司授权范围内没有聚水潭店铺，请联系管理员检查接口授权。</small>}
    {shops && shops.length > 0 && !matched.length && <small role="status">没有匹配的聚水潭店铺</small>}
    {error && <div role="alert">{error} <button type="button" onClick={() => setAttempt(n => n + 1)}>重试加载</button></div>}
  </div>;
}

export function storeJstText(data: Record<string, unknown>) {
  const id = String(data.jushuitanShopId ?? '').trim();
  return id ? `已关联 · ${data.jushuitanShopName || id}` : '未关联';
}

export function StoreJstBadge({ data }: { data: Record<string, unknown> }) {
  return <span title={storeJstText(data)} style={{ maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }} className={`pill ${String(data.jushuitanShopId ?? '').trim() ? 'ok' : 'warn'}`}>{storeJstText(data)}</span>;
}

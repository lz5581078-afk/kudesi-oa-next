import { useMemo, useState } from 'react';
import type { StoreOption } from './serviceApi';

/** 选店铺：先在框里输入名称缩小范围，再从下拉里选（店铺多的时候不用翻一长串）。 */
export function StorePicker({ stores, value, onChange, label = '店铺' }: { stores: StoreOption[]; value: number | ''; onChange: (id: number | '') => void; label?: string }) {
  const [kw, setKw] = useState('');
  const shown = useMemo(() => {
    const k = kw.trim().toLowerCase();
    const list = k ? stores.filter((s) => `${s.name} ${s.platform ?? ''} ${s.operatorName}`.toLowerCase().includes(k)) : stores;
    // 已选中的店铺始终保留在选项里
    return value && !list.some((s) => s.id === value) ? [...list, ...stores.filter((s) => s.id === value)] : list;
  }, [stores, kw, value]);
  return (
    <div className="svc-store-pick">
      {stores.length > 8 && <input type="search" aria-label={`搜索${label}`} placeholder="输入店铺名搜索" value={kw} onChange={(e) => setKw(e.target.value)} />}
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}>
        <option value="">（请选择{label}）</option>
        {shown.map((s) => <option key={s.id} value={s.id}>{s.name}{s.platform ? ` · ${s.platform}` : ''}{s.operatorName ? ` · 运营 ${s.operatorName}` : ''}</option>)}
      </select>
    </div>
  );
}

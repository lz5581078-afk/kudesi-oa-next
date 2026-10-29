import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { monthlyEquivalentCents } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';
import { useResourceCan } from './useResourceCan';

/**
 * 区域位置下面的“这个区域使用的宽带”：宽带账号资料里的“使用区域”选了这个区域（或它下面的房间）的宽带，
 * 点宽带打开它的档案。数据就是宽带账号资料本身，没有另存。
 */
export function AreaBroadband({ areaIds, version }: { areaIds: number[]; version: number }) {
  const can = useResourceCan('broadband');
  const [items, setItems] = useState<ResourceDto[]>([]);
  const key = areaIds.join(',');
  useEffect(() => {
    if (!can('view') || areaIds.length === 0) { setItems([]); return; }
    let alive = true;
    resourceApi.list('broadband', { pageSize: 200 }).then((r) => alive && setItems(r.items.filter((b) => typeof b.data.locationId === 'number' && areaIds.includes(b.data.locationId)))).catch(() => alive && setItems([]));
    return () => { alive = false; };
  }, [key, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (items.length === 0) return null;
  const monthly = items.reduce((n, b) => n + (typeof b.data.amount === 'number' ? monthlyEquivalentCents(b.data.amount, String(b.data.cycle ?? 'monthly')) ?? 0 : 0), 0);
  return (
    <div className="lb-here" aria-label="这个区域使用的宽带">
      <span>这个区域使用的宽带 · 月均 ¥{(monthly / 100).toFixed(2)}</span>
      {items.map((b) => (
        <Link key={b.id} className="lb-asset" to={`/resource/broadband?open=${b.id}`} title="打开宽带账号档案">
          {b.title}<small>{[b.data.bandwidth, b.refLabels.phoneId].filter(Boolean).join(' · ')}</small>
        </Link>
      ))}
    </div>
  );
}

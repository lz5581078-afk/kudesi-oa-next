import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { ArchiveList } from './ArchiveList';
import { assetApi, type LocationContentGroup } from './api';
import type { ArchiveRow, Counts } from './locationColumns';

/** 其他资料也把这个位置当存放位置（证照正副本、U 盾、手机号、开户档案…）：旧页面没有，这里补在档案下面。 */
function OtherUsage({ id }: { id: number }) {
  const [groups, setGroups] = useState<LocationContentGroup[] | null>(null);
  useEffect(() => {
    let alive = true;
    setGroups(null);
    assetApi.locationContents(id).then((g) => alive && setGroups(g.filter((x) => !['locations', 'archives', 'fixed-assets'].includes(x.type)))).catch((e) => { if (alive && !(e instanceof ApiError)) setGroups(null); });
    return () => { alive = false; };
  }, [id]);
  if (!groups || groups.length === 0) return null;
  return (
    <div className="lb-other-box">
      <strong>其他资料也放在这里</strong>
      {groups.map((g) => (
        <p key={g.type} className="lb-other"><b>{g.typeLabel}（{g.items.length}）</b>：{g.items.slice(0, 12).map((it) => `${it.title}${it.slots.length && !['存放位置', '位置'].includes(it.slots[0]) ? `（${it.slots.join('、')}）` : ''}`).join('、')}{g.items.length > 12 ? ' 等' : ''}</p>
      ))}
    </div>
  );
}

/** 页面下半部分：档案列表，跟着上面选中的区域位置或储物空间过滤，行内借出/遗失/在库。 */
export function LocationArchives(p: {
  /** 当前范围的文字：全部档案 / 总部楼 / 二楼 / 财务室 */
  scopeText: string;
  rows: ArchiveRow[];
  counts: Counts;
  /** 选中的位置（0 = 没选位置） */
  locationId: number;
  /** 选中位置有下级时才显示“含下级” */
  hasKids: boolean;
  deep: boolean;
  onDeep: (v: boolean) => void;
  where: (a: ArchiveRow) => string;
  canCreate: boolean;
  canStatus: boolean;
  canViewAssets: boolean;
  onNew: () => void;
  onOpenLocation: () => void;
  onOpenArchive: (id: number) => void;
  onChanged: (message?: string) => void;
}) {
  return (
    <section className="lb-panel lb-arch" aria-label="档案">
      <header className="lb-ph">
        <div>
          <strong>档案</strong>
          <span>{p.scopeText}：{p.rows.length} 份{p.counts.alerts > 0 && <em className="lb-warn"> · 借出或遗失 {p.counts.alerts} 份</em>}{p.canViewAssets && p.locationId > 0 && p.counts.assets > 0 ? ` · 固定资产 ${p.counts.assets} 件` : ''}</span>
        </div>
        <div className="lb-ph-acts">
          {p.hasKids && <label className="lb-deep"><input type="checkbox" checked={p.deep} onChange={(e) => p.onDeep(e.target.checked)} /> 含下级</label>}
          {p.locationId > 0 && <button type="button" className="res-btn sm" onClick={p.onOpenLocation}>位置详情</button>}
          {p.canCreate && p.locationId > 0 && <button type="button" className="res-btn sm primary" onClick={p.onNew}>＋ 在这里放档案</button>}
        </div>
      </header>
      <ArchiveList rows={p.rows} where={p.where} canStatus={p.canStatus} onOpen={p.onOpenArchive} onChanged={p.onChanged} searchable={p.rows.length > 6}
        empty={p.locationId > 0 ? '这里还没有放档案。' : '还没有档案。点“新增档案”，登记编号、关联资料和存放位置。'} />
      {p.locationId > 0 && <OtherUsage id={p.locationId} />}
    </section>
  );
}

import { useMemo } from 'react';
import { childrenMap, descendantIds, pathOf, type TreeNode } from './treeNodes';
import type { AssetRow } from './locationColumns';

/**
 * 选固定资产：先按资产分类一级级收窄，再从下面的资产里点一项。
 * 选中的资产会在下面展开它内部的储物空间（柜层、抽屉、档案盒）。
 */
export function StoragePicker({ categories, assets, categoryId, assetId, spaceCount, onCategory, onAsset, onOpenAsset }: {
  categories: readonly TreeNode[];
  assets: readonly AssetRow[];
  categoryId: number;
  assetId: number;
  spaceCount: (assetId: number) => number;
  onCategory: (id: number) => void;
  onAsset: (id: number) => void;
  onOpenAsset?: (id: number) => void;
}) {
  const live = useMemo(() => categories.filter((c) => c.status !== 'inactive'), [categories]);
  const kids = useMemo(() => childrenMap(live), [live]);
  const byId = useMemo(() => new Map(live.map((c) => [c.id, c])), [live]);
  const path = useMemo(() => pathOf(categoryId, byId), [categoryId, byId]);
  const countOf = (id: number) => { const ids = new Set(descendantIds(id, kids)); return assets.filter((a) => ids.has(a.categoryId)).length; };
  const columns = [{ title: '一级分类', rows: kids.get(0) ?? [] }, ...path.map((c, i) => ({ title: `${i + 2}级分类`, rows: kids.get(c.id) ?? [] })).filter((c) => c.rows.length)];
  const candidates = useMemo(() => {
    if (!categoryId) return assets;
    const ids = new Set(descendantIds(categoryId, kids));
    return assets.filter((a) => ids.has(a.categoryId));
  }, [assets, categoryId, kids]);
  const picked = assets.find((a) => a.id === assetId);

  return (
    <div className="sp">
      <div className="sp-cats">
        <div className="sp-cur">
          <span>资产分类</span>
          <strong>{path.length ? path.map((c) => c.title).join(' / ') : '全部分类'}</strong>
          {categoryId > 0 && <button type="button" className="link-button" onClick={() => onCategory(0)}>查看全部</button>}
        </div>
        {live.length === 0 ? <p className="muted sp-none">还没有资产分类，请先到固定资产页建立。</p> : (
          <div className="sp-cols">
            {columns.map((col) => (
              <div className="sp-col" key={col.title}>
                <strong>{col.title}</strong>
                {col.rows.map((c) => (
                  <button key={c.id} type="button" className={categoryId === c.id ? 'on' : ''} aria-pressed={categoryId === c.id} onClick={() => onCategory(categoryId === c.id ? 0 : c.id)}>
                    <span>{c.title}</span><small>{countOf(c.id)} 个资产</small>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="sp-assets">
        <div className="sp-cur">
          <span>选择固定资产</span>
          <strong>{picked ? `${picked.assetNo || '未编号'} · ${picked.title}` : '未选择'}</strong>
          {picked && onOpenAsset && <button type="button" className="link-button" onClick={() => onOpenAsset(picked.id)}>资产详情</button>}
        </div>
        <div className="sp-opts">
          {candidates.map((a) => {
            const n = spaceCount(a.id);
            return (
              <button key={a.id} type="button" className={assetId === a.id ? 'on' : ''} aria-pressed={assetId === a.id} onClick={() => onAsset(a.id)}>
                <span>{a.assetNo || '未编号'} · {a.title}</span>
                <small>{a.categoryLabel || '未设置分类'} / {a.locationLabel || '未设置位置'}{n ? ` · ${n} 个空间` : ''}</small>
              </button>
            );
          })}
          {candidates.length === 0 && <p className="muted sp-none">当前分类下没有可选的固定资产。</p>}
        </div>
      </div>
    </div>
  );
}

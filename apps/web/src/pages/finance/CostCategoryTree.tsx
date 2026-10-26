import { useState } from 'react';
import { pct } from './common';
import type { CostTableData } from './financeApi';

/** 成本表左侧的分类目录：每个分类的组合数（含下级）、继承到的利润率，有权限的人可以直接设置分类利润率。 */
export function CostCategoryTree({ data, selected, onSelect, onEdit }: {
  data: Pick<CostTableData, 'categories' | 'defaultMargin' | 'allTotal' | 'canEdit'>;
  selected: number | null; onSelect: (id: number | null) => void;
  /** id = 0 表示“全部默认” */
  onEdit: (target: { id: number; name: string; ownPercent: number | null; revision: string }) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const kids = (parent: number | null) => data.categories.filter((c) => c.parentId === parent);
  const toggle = (id: number) => setCollapsed((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const branch = (parent: number | null, depth: number, seen: Set<number>): JSX.Element[] =>
    kids(parent).filter((c) => !seen.has(c.id)).map((c) => {
      const hasKids = kids(c.id).length > 0;
      return (
        <div key={c.id}>
          <div className={`cost-category${selected === c.id ? ' selected' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}>
            {hasKids
              ? <button type="button" className="cost-category-toggle" aria-label={`${collapsed.has(c.id) ? '展开' : '收起'}${c.name}`} aria-expanded={!collapsed.has(c.id)} onClick={() => toggle(c.id)}>{collapsed.has(c.id) ? '▸' : '▾'}</button>
              : <span className="cost-category-toggle" />}
            <button type="button" className="cost-category-select" aria-pressed={selected === c.id} onClick={() => onSelect(c.id)}>
              <span>{c.name} <small>{c.count}</small></span>
              <small>{pct(c.percent)} · {c.ownPercent === null ? (c.percent === null ? '未设置' : '继承') : '分类设置'}</small>
            </button>
            {data.canEdit && <button type="button" className="link-button" aria-label={`设置${c.name}利润率`} onClick={() => onEdit({ id: c.id, name: c.name, ownPercent: c.ownPercent, revision: c.revision })}>设置</button>}
          </div>
          {!collapsed.has(c.id) && branch(c.id, depth + 1, new Set([...seen, c.id]))}
        </div>
      );
    });
  return (
    <nav className="cost-directory" aria-label="成本分类目录">
      <h2>分类目录</h2>
      <div className={`cost-category${selected === null ? ' selected' : ''}`}>
        <span className="cost-category-toggle" />
        <button type="button" className="cost-category-select" aria-pressed={selected === null} onClick={() => onSelect(null)}>
          <span>全部 <small>{data.allTotal}</small></span>
          <small>默认利润率 {pct(data.defaultMargin.percent)}</small>
        </button>
        {data.canEdit && <button type="button" className="link-button" aria-label="设置全部默认利润率" onClick={() => onEdit({ id: 0, name: '全部默认', ownPercent: data.defaultMargin.percent, revision: data.defaultMargin.revision })}>设置</button>}
      </div>
      {branch(null, 0, new Set())}
    </nav>
  );
}

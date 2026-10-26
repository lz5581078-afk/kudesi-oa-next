import { useMemo, useState } from 'react';
import type { CatalogGroup } from '@kudesi/shared';

/** 权限勾选器：按分组展示，组内可全选；values 是已选的权限键。disabledKeys 里的项只读（例如岗位已有的）。 */
export function PermissionPicker({ catalog, values, onChange, readOnly, hintKeys, hintLabel }: {
  catalog: CatalogGroup[]; values: string[]; onChange: (next: string[]) => void; readOnly?: boolean;
  /** 这些键在别处已经拥有（例如岗位权限），只做提示 */
  hintKeys?: string[]; hintLabel?: string;
}) {
  const [filter, setFilter] = useState('');
  const set = useMemo(() => new Set(values), [values]);
  const hint = useMemo(() => new Set(hintKeys ?? []), [hintKeys]);
  const toggle = (key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    onChange([...next].sort());
  };
  const words = filter.trim().toLowerCase();
  return (
    <div className="perm-picker">
      <input type="search" aria-label="筛选权限" placeholder="筛选权限，例如：店铺、导出" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {catalog.map((g) => {
        const items = g.items.filter((i) => !words || i.label.toLowerCase().includes(words) || g.label.toLowerCase().includes(words));
        if (items.length === 0) return null;
        const allOn = items.every((i) => set.has(i.key));
        return (
          <fieldset key={g.id}>
            <legend>
              {g.label}
              {!readOnly && (
                <button type="button" className="link-button" onClick={() => onChange(allOn ? values.filter((k) => !items.some((i) => i.key === k)) : [...new Set([...values, ...items.map((i) => i.key)])].sort())}>
                  {allOn ? '取消本组' : '全选本组'}
                </button>
              )}
            </legend>
            <div className="perm-grid">
              {items.map((i) => (
                <label key={i.key} className="check-line">
                  <input type="checkbox" checked={set.has(i.key)} disabled={readOnly} onChange={(e) => toggle(i.key, e.target.checked)} />
                  <span>{i.label}</span>
                  {hint.has(i.key) && <small className="muted"> {hintLabel ?? '已拥有'}</small>}
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

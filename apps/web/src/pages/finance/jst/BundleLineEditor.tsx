import { Fragment, useEffect, useState } from 'react';
import { BUNDLE_ROLES, COST_BUCKETS, COST_TREATMENTS, UNIT_OPTIONS } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import type { LineInput } from './jstApi';

/** 组合构成的行编辑器（批量生成、构成修订共用）：用途、基础编码/人工、数量，展开后还有旧系统 BOM 行的其余字段。 */
export interface LineRow extends LineInput { label: string }

export const ROLE_LABEL: Record<string, string> = Object.fromEntries(BUNDLE_ROLES.map((o) => [o.value, o.label]));
const SELECTABLE_ROLES = BUNDLE_ROLES.filter((o) => o.value !== 'labor');

/** 搜已验证的基础编码 */
export function CodePick({ value, label, onPick }: { value?: number; label: string; onPick: (id: number, label: string) => void }) {
  const [text, setText] = useState(label);
  const [items, setItems] = useState<ResourceDto[]>([]);
  const [open, setOpen] = useState(false);
  const search = (kw: string) => resourceApi.list('finance-base-codes', { keyword: kw, status: 'verified', pageSize: 15 }).then((r) => setItems(r.items)).catch(() => setItems([]));
  return (
    <div className="pick">
      <input aria-label="基础编码" value={text} placeholder="搜已验证的基础编码" onFocus={() => { setOpen(true); void search(text); }} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => { setText(e.target.value); setOpen(true); void search(e.target.value); }} />
      {open && (
        <ul className="pick-list" role="listbox">
          {items.length === 0 && <li className="muted">没有找到已验证的基础编码</li>}
          {items.map((i) => <li key={i.id}><button type="button" role="option" aria-selected={i.id === value} onMouseDown={(e) => e.preventDefault()} onClick={() => { setText(i.title); onPick(i.id, i.title); setOpen(false); }}>{i.title} <span className="muted">{String(i.data.name ?? '')}</span></button></li>)}
        </ul>
      )}
    </div>
  );
}

/** 选人工项目 */
function LaborPick({ value, onPick }: { value?: number; onPick: (id: number, label: string) => void }) {
  const [items, setItems] = useState<ResourceDto[]>([]);
  useEffect(() => { resourceApi.list('finance-labor-costs', { pageSize: 100, status: 'active' }).then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  return (
    <select aria-label="人工项目" value={value ?? ''} onChange={(e) => { const it = items.find((i) => i.id === Number(e.target.value)); if (it) onPick(it.id, it.title); }}>
      <option value="">选择人工项目</option>
      {items.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
    </select>
  );
}

const NO_JST_ROLES = ['labor'];

export function LineEditor({ rows, onChange, lockGifts, allowLabor }: { rows: LineRow[]; onChange: (r: LineRow[]) => void; lockGifts?: boolean; allowLabor?: boolean }) {
  const [more, setMore] = useState<number | null>(null);
  const set = (i: number, patch: Partial<LineRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const roles = allowLabor ? BUNDLE_ROLES : SELECTABLE_ROLES;
  return (
    <div>
      <table className="data-table">
        <thead><tr><th>用途</th><th>基础编码 / 人工</th><th>数量</th><th>单位</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const locked = lockGifts && r.role === 'gift';
            const labor = r.role === 'labor';
            return (
              <Fragment key={i}>
                <tr>
                  <td><select aria-label="用途" disabled={locked} value={r.role} onChange={(e) => set(i, { role: e.target.value, ...(e.target.value === 'labor' ? { baseCodeId: undefined, label: '' } : { laborId: undefined }) })}>{roles.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></td>
                  <td>{locked ? r.label : labor ? <LaborPick value={r.laborId} onPick={(id, label) => set(i, { laborId: id, label })} /> : <CodePick value={r.baseCodeId} label={r.label} onPick={(id, label) => set(i, { baseCodeId: id, label })} />}</td>
                  <td><input aria-label="数量" type="number" min={0.001} step="any" style={{ width: 80 }} disabled={locked} value={r.qty} onChange={(e) => set(i, { qty: Number(e.target.value) })} /></td>
                  <td>{labor ? '—' : <select aria-label="单位" disabled={locked} value={r.unit ?? ''} onChange={(e) => set(i, { unit: e.target.value || undefined })}><option value="">按档案</option>{UNIT_OPTIONS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select>}</td>
                  <td>
                    <button type="button" className="link-button" aria-expanded={more === i} onClick={() => setMore(more === i ? null : i)}>更多</button>{' '}
                    {!locked && <button type="button" className="link-button" onClick={() => onChange(rows.filter((_, k) => k !== i))}>去掉</button>}
                  </td>
                </tr>
                {more === i && (
                  <tr><td colSpan={5}>
                    <div className="form-grid">
                      <label>损耗率(%)<input aria-label="损耗率" type="number" min={0} step="any" disabled={locked} value={r.lossRate ?? ''} onChange={(e) => set(i, { lossRate: e.target.value === '' ? undefined : Number(e.target.value) })} /><small className="muted">只记录，不改变成本和重量合计</small></label>
                      <label className="check"><input type="checkbox" aria-label="必需" disabled={locked} checked={r.isRequired !== false} onChange={(e) => set(i, { isRequired: e.target.checked })} /> 必需</label>
                      {!NO_JST_ROLES.includes(r.role) && <label className="check"><input type="checkbox" aria-label="进入聚水潭组合装" disabled={locked} checked={r.includeInJst ?? (r.role === 'main' || r.role === 'gift')} onChange={(e) => set(i, { includeInJst: e.target.checked })} /> 进入聚水潭组合装</label>}
                      <label>成本归集<select aria-label="成本归集" disabled={locked} value={r.costBucket ?? ''} onChange={(e) => set(i, { costBucket: e.target.value || undefined })}><option value="">按用途默认</option>{COST_BUCKETS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
                      <label>成本处理<select aria-label="成本处理" disabled={locked} value={r.costTreatment ?? ''} onChange={(e) => set(i, { costTreatment: e.target.value || undefined })}><option value="">计入</option>{COST_TREATMENTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select><small className="muted">只记录，成本合计仍按全部行累加</small></label>
                      <label>排序<input aria-label="排序" type="number" min={0} step={1} disabled={locked} value={r.sortOrder ?? ''} onChange={(e) => set(i, { sortOrder: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                      <label>生效日<input aria-label="生效日" type="date" disabled={locked} value={r.effectiveFrom ?? ''} onChange={(e) => set(i, { effectiveFrom: e.target.value || undefined })} /></label>
                      <label>失效日<input aria-label="失效日" type="date" disabled={locked} value={r.effectiveTo ?? ''} onChange={(e) => set(i, { effectiveTo: e.target.value || undefined })} /></label>
                      <label className="wide">备注<input aria-label="行备注" maxLength={200} disabled={locked} value={r.note ?? ''} onChange={(e) => set(i, { note: e.target.value || undefined })} /></label>
                    </div>
                  </td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <button type="button" className="secondary-button small" onClick={() => onChange([...rows, { role: rows.length ? 'gift' : 'main', qty: 1, label: '' }])}>＋ 加一行</button>
      {allowLabor && <> <button type="button" className="secondary-button small" onClick={() => onChange([...rows, { role: 'labor', qty: 1, label: '' }])}>＋ 加人工</button></>}
    </div>
  );
}

/** 提交给接口的行：去掉显示用的 label 和空值 */
export function toLineInput(r: LineRow): LineInput {
  const { label: _l, ...rest } = r;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== '' && v !== null)) as unknown as LineInput;
}

/** 组合分类：只能选组合分类树里的最末级分类（带路径）。 */
export function BundleCategorySelect({ value, onChange }: { value: number | ''; onChange: (id: number | '') => void }) {
  const [opts, setOpts] = useState<Array<{ id: number; path: string }>>([]);
  useEffect(() => {
    resourceApi.categoryTree('finance-bundles', { field: 'bundleCategoryId', tab: 'bundle' }).then((t) => {
      const byId = new Map(t.nodes.map((n) => [n.id, n]));
      const parents = new Set(t.nodes.map((n) => n.parentId).filter(Boolean));
      const path = (id: number) => { const names: string[] = []; for (let n = byId.get(id), i = 0; n && i < 8; n = byId.get(n.parentId), i++) names.unshift(n.title); return names.join(' / '); };
      setOpts(t.nodes.filter((n) => !parents.has(n.id) && n.status === 'active').map((n) => ({ id: n.id, path: path(n.id) })).sort((a, b) => a.path.localeCompare(b.path, 'zh')));
    }).catch(() => setOpts([]));
  }, []);
  return (
    <select aria-label="组合分类" value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}>
      <option value="">（请选择最末级分类）</option>
      {opts.map((o) => <option key={o.id} value={o.id}>{o.path}</option>)}
    </select>
  );
}

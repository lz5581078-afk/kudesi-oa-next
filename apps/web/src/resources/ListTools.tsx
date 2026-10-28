import type { FieldDef, ResourceDef } from '@kudesi/shared';
import { ChevronDown, CloseIcon, ColumnsIcon, DensityIcon, FilterIcon } from './ResIcons';
import { ToolPop } from './ToolPop';
import type { Density } from './listPrefs';

type Opt = { id: number | string; label: string };
type ViewFilter = { key: string; label: string; options: readonly { value: string; label: string }[]; optionsFrom?: string };

export interface FilterState {
  fields: FieldDef[];
  viewFilters: ViewFilter[];
  vals: Record<string, string>;
  opts: Record<string, Opt[]>;
  deptOpts: Array<{ value: string; label: string }>;
  status: string;
  statuses: ResourceDef['statuses'];
  hasExpiry: boolean;
  expiring: boolean;
  archivable: boolean;
  archived: boolean;
  archivedCount?: number;
  hiddenLabels: string[];
  showHidden: boolean;
  canShowHidden: boolean;
}

export interface FilterActions {
  setVal: (key: string, value: string) => void;
  setStatus: (v: string) => void;
  setExpiring: (v: boolean) => void;
  setArchived: (v: boolean) => void;
  setShowHidden: (v: boolean) => void;
  clearAll: () => void;
}

/** 筛选浮层：所有下拉筛选和开关都收在这里，工具条上只留一个按钮和已生效数量。 */
export function FilterPop({ state: s, actions: a, count, filtered, extra }: { state: FilterState; actions: FilterActions; count: number; filtered: boolean; extra?: React.ReactNode }) {
  return (
    <ToolPop
      label={`筛选${count ? ` ${count}` : ''}`}
      className={`res-btn${count ? ' on' : ''}`}
      panelClass="res-filter"
      trigger={<><FilterIcon /><span className="lbl">筛选</span>{count > 0 && <b className="res-badge">{count}</b>}</>}
    >
      {(close) => (
        <>
          <div className="res-pop-body">
            <div className="res-filter-grid">
              {extra}
              {s.fields.map((f) => (
                <label key={f.key}><span>{f.label}</span>
                  <select aria-label={f.label} value={s.vals[f.key] ?? ''} onChange={(e) => a.setVal(f.key, e.target.value)}>
                    <option value="">全部</option>
                    {(s.opts[f.key] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </label>
              ))}
              {s.viewFilters.map((v) => (
                <label key={v.key}><span>{v.label}</span>
                  <select aria-label={v.label} value={s.vals[v.key] ?? ''} onChange={(e) => a.setVal(v.key, e.target.value)}>
                    <option value="">全部</option>
                    {(v.optionsFrom === 'departments' ? s.deptOpts : v.options).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
              ))}
              <label><span>状态</span>
                <select aria-label="状态" value={s.status} onChange={(e) => a.setStatus(e.target.value)}>
                  <option value="">全部</option>
                  {s.statuses.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select>
              </label>
            </div>
            {(s.hasExpiry || s.archivable || (s.canShowHidden && !s.status && !s.archived)) && (
              <div className="res-filter-flags">
                {s.hasExpiry && <button type="button" className={`res-toggle${s.expiring ? ' on' : ''}`} aria-pressed={s.expiring} onClick={() => a.setExpiring(!s.expiring)}>即将到期</button>}
                {s.archivable && <button type="button" className={`res-toggle${s.archived ? ' on' : ''}`} aria-pressed={s.archived} onClick={() => a.setArchived(!s.archived)}>已归档{s.archivedCount !== undefined ? ` ${s.archivedCount}` : ''}</button>}
                {s.canShowHidden && !s.status && !s.archived && (
                  <label className="check"><input type="checkbox" checked={s.showHidden} onChange={(e) => a.setShowHidden(e.target.checked)} /> 显示{s.hiddenLabels.join('/')}</label>
                )}
              </div>
            )}
          </div>
          <div className="res-pop-foot">
            <button type="button" className="link-button" disabled={!filtered} onClick={a.clearAll}>清除全部筛选</button>
            <button type="button" className="res-btn primary sm" onClick={close}>完成</button>
          </div>
        </>
      )}
    </ToolPop>
  );
}

/** 已生效的筛选以小标签显示，点 ✕ 单独去掉一项。 */
export interface Chip { key: string; text: string; clear: () => void }
export function ActiveChips({ chips, summary, onClearAll }: { chips: Chip[]; summary: string; onClearAll: () => void }) {
  return (
    <div className="res-chips" role="status" aria-live="polite">
      {chips.map((c) => (
        <span key={c.key} className="res-chip">{c.text}<button type="button" aria-label={`清除${c.text}`} onClick={c.clear}><CloseIcon size={11} /></button></span>
      ))}
      <span className="res-chips-sum">{summary}</span>
      <button type="button" className="link-button" onClick={onClearAll}>清除搜索和筛选</button>
    </div>
  );
}

export function ColumnsPop({ fields, picked, onChange, defaults }: { fields: FieldDef[]; picked: string[]; onChange: (keys: string[]) => void; defaults: FieldDef[] }) {
  return (
    <ToolPop label="显示列" trigger={<><ColumnsIcon /><span className="lbl">显示列</span></>} panelClass="res-cols">
      {() => (
        <>
          <div className="res-pop-body res-cols-list">
            {fields.map((f) => (
              <label key={f.key} className="check">
                <input type="checkbox" checked={picked.includes(f.key)} onChange={(e) => onChange(e.target.checked ? [...picked, f.key] : picked.filter((k) => k !== f.key))} />
                {f.label}
              </label>
            ))}
          </div>
          <div className="res-pop-foot">
            <button type="button" className="link-button" onClick={() => onChange(fields.map((f) => f.key))}>全部显示</button>
            <button type="button" className="link-button" onClick={() => onChange(defaults.map((f) => f.key))}>恢复默认</button>
          </div>
        </>
      )}
    </ToolPop>
  );
}

export function DensityButton({ density, onChange }: { density: Density; onChange: (d: Density) => void }) {
  const compact = density === 'compact';
  return (
    <button type="button" className="res-btn icon" aria-label={compact ? '行高：紧凑（点击切换为舒适）' : '行高：舒适（点击切换为紧凑）'} aria-pressed={!compact} title={compact ? '行高：紧凑' : '行高：舒适'} onClick={() => onChange(compact ? 'comfortable' : 'compact')}>
      <DensityIcon compact={compact} />
    </button>
  );
}

export function MorePop({ label = '更多', children }: { label?: string; children: React.ReactNode }) {
  return (
    <ToolPop label={label} align="right" trigger={<><span>{label}</span><ChevronDown /></>} panelClass="res-more">
      {(close) => <div className="res-pop-body res-more-list" role="menu" onClick={close}>{children}</div>}
    </ToolPop>
  );
}

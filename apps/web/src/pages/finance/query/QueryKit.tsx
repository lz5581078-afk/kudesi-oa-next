import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { downloadCsv, useIsMobile } from '../fin-ui';

/**
 * 实时查询页共用组件（库存查询、现金银行查询、未完全结算收付款单、收付款结算明细表共用一套版式）：
 * 页头（标题+说明+刷新/导出）→ 查询条件条（查询/重置）→ 汇总卡 → 一个或多个面板（可折叠）→ 表格（可分组、合计行、手机端卡片）。
 * 只做展示，不参与金额计算；金额一律由调用方传入整数分后用 money() 格式化。
 */

export function QueryPage({ title, subtitle, actions, children, className }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`qk${className ? ` ${className}` : ''}`}>
      <header className="qk-head">
        <div><h1>{title}</h1>{subtitle && <p className="muted">{subtitle}</p>}</div>
        {actions && <div className="qk-head-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/** 面板：标题 + 右上角操作；collapsed 为 true 时只显示 collapsedHint（旧版“展开 N 个账户”的折叠形式） */
export function QueryPanel({ title, hint, actions, collapsed, collapsedHint, always, children }: { title: string; hint?: ReactNode; actions?: ReactNode; collapsed?: boolean; collapsedHint?: ReactNode; always?: ReactNode; children?: ReactNode }) {
  return (
    <section className="qk-panel" aria-label={title}>
      <div className="qk-panel-head"><h2>{title}</h2>{hint && <span className="muted qk-hint">{hint}</span>}{actions && <div className="qk-panel-actions">{actions}</div>}</div>
      {always}
      {collapsed ? <p className="muted qk-collapsed">{collapsedHint}</p> : children}
    </section>
  );
}

export function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={`qk-field${wide ? ' wide' : ''}`}><span>{label}</span>{children}</label>;
}

/** 查询条件条：回车或点“查询”才发请求；“重置”清空条件并重新查询。live 模式（本地过滤）不显示“查询”。 */
export function FilterBar({ children, onQuery, onReset, busy, live, extra, title = '查询条件' }: { children: ReactNode; onQuery?: () => void; onReset: () => void; busy?: boolean; live?: boolean; extra?: ReactNode; title?: string }) {
  const submit = (e: FormEvent) => { e.preventDefault(); onQuery?.(); };
  return (
    <form className="qk-panel qk-filter" aria-label={title} onSubmit={submit}>
      <div className="qk-filter-grid">
        {children}
        <div className="qk-filter-actions">
          {!live && <button type="submit" className="primary-button" disabled={busy}>{busy ? '查询中…' : '查询'}</button>}
          <button type="button" className="secondary-button" onClick={onReset}>重置</button>
          {extra}
        </div>
      </div>
    </form>
  );
}

export interface Card { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'accent'; hint?: string }
export function SummaryCards({ items }: { items: Card[] }) {
  return (
    <div className="qk-cards" aria-label="汇总">
      {items.map((c) => <div key={c.label} className={`qk-card${c.tone ? ` ${c.tone}` : ''}`} title={c.hint}><span className="muted">{c.label}</span><strong>{c.value}</strong></div>)}
    </div>
  );
}

export interface Col<R> {
  key: string; head: string;
  cell: (r: R) => ReactNode;
  num?: boolean;
  /** 合计行/分组小计：返回要显示的内容；不给就留空 */
  sum?: (rows: R[]) => ReactNode;
  /** 导出 CSV 用的值；不给就不导出这一列（操作列、按钮列） */
  csv?: (r: R) => string | number | null | undefined;
  /** 手机卡片上作为卡片标题 */
  primary?: boolean;
  /** 手机卡片上不显示（操作列用 action 单独放卡片底部） */
  action?: boolean;
}

export interface GroupBy<R> { key: (r: R) => string; label: (key: string, rows: R[]) => ReactNode }

/**
 * 查询表格：可选分组（分组行可折叠，带小计）、合计行、行选中；手机宽度下换成卡片列表（标题 + 字段对 + 操作）。
 */
export function QueryTable<R>({ cols, rows, rowKey, empty, loading, group, foot = true, footLabel, selectedKey, onRowClick, caption }: {
  cols: Array<Col<R>>; rows: R[] | null; rowKey: (r: R) => string | number; empty: ReactNode; loading?: ReactNode;
  group?: GroupBy<R> | null; foot?: boolean; footLabel?: (rows: R[]) => ReactNode; selectedKey?: string | number | null; onRowClick?: (r: R) => void; caption?: string;
}) {
  const mobile = useIsMobile();
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    if (!rows || !group) return null;
    const m = new Map<string, R[]>();
    for (const r of rows) { const k = group.key(r); m.set(k, [...(m.get(k) ?? []), r]); }
    return [...m.entries()];
  }, [rows, group]);
  const hasSum = cols.some((c) => c.sum);
  const firstSum = cols.findIndex((c) => c.sum);
  const span = firstSum > 0 ? firstSum : cols.length;
  if (rows === null) return <p className="muted qk-state" role="status">{loading ?? '正在读取…'}</p>;
  if (rows.length === 0) return <p className="muted qk-state qk-empty">{empty}</p>;
  const toggle = (k: string) => setClosed((c) => ({ ...c, [k]: !c[k] }));
  const sel = (r: R) => selectedKey !== undefined && selectedKey !== null && selectedKey === rowKey(r);

  if (mobile) {
    const card = (r: R) => {
      const main = cols.find((c) => c.primary) ?? cols[0];
      return (
        <li key={rowKey(r)} className={`qk-mcard${sel(r) ? ' selected' : ''}`} onClick={onRowClick ? () => onRowClick(r) : undefined}>
          <div className="qk-mcard-title">{main.cell(r)}</div>
          <dl>{cols.filter((c) => c !== main && !c.action).map((c) => <div key={c.key}><dt>{c.head}</dt><dd className={c.num ? 'num' : undefined}>{c.cell(r)}</dd></div>)}</dl>
          {cols.some((c) => c.action) && <div className="qk-mcard-actions">{cols.filter((c) => c.action).map((c) => <span key={c.key}>{c.cell(r)}</span>)}</div>}
        </li>
      );
    };
    const totals = foot && hasSum && (
      <li className="qk-mcard qk-mtotal"><div className="qk-mcard-title">{footLabel ? footLabel(rows) : `合计（${rows.length} 行）`}</div>
        <dl>{cols.filter((c) => c.sum).map((c) => <div key={c.key}><dt>{c.head}</dt><dd className="num">{c.sum!(rows)}</dd></div>)}</dl></li>
    );
    return (
      <ul className="qk-mlist" aria-label={caption}>
        {groups ? groups.map(([k, list]) => (
          <li key={k} className="qk-mgroup">
            <button type="button" className="qk-ghead" aria-expanded={!closed[k]} onClick={() => toggle(k)}>{closed[k] ? '▸' : '▾'} {group!.label(k, list)}</button>
            {!closed[k] && <ul>{list.map(card)}</ul>}
          </li>
        )) : rows.map(card)}
        {totals}
      </ul>
    );
  }

  const row = (r: R) => (
    <tr key={rowKey(r)} className={sel(r) ? 'selected' : undefined} aria-selected={onRowClick ? sel(r) : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}>
      {cols.map((c) => <td key={c.key} className={c.num ? 'num' : undefined}>{c.cell(r)}</td>)}
    </tr>
  );
  return (
    <div className="table-scroll qk-table"><table className="data-table" aria-label={caption}>
      <thead><tr>{cols.map((c) => <th key={c.key} className={c.num ? 'num' : undefined}>{c.head}</th>)}</tr></thead>
      <tbody>
        {groups ? groups.flatMap(([k, list]) => [
          <tr key={`g-${k}`} className="qk-grow">
            <td colSpan={span}>
              <button type="button" className="qk-ghead" aria-expanded={!closed[k]} onClick={() => toggle(k)}>{closed[k] ? '▸' : '▾'} {group!.label(k, list)}</button>
            </td>
            {cols.slice(span).map((c) => <td key={c.key} className={c.num ? 'num' : undefined}>{c.sum ? c.sum(list) : ''}</td>)}
          </tr>,
          ...(closed[k] ? [] : list.map(row)),
        ]) : rows.map(row)}
      </tbody>
      {foot && hasSum && <tfoot><tr>{cols.map((c, i) => <th key={c.key} className={c.num ? 'num' : undefined}>{i === 0 ? (footLabel ? footLabel(rows) : `合计（${rows.length} 行）`) : c.sum ? c.sum(rows) : ''}</th>)}</tr></tfoot>}
    </table></div>
  );
}

/** 分组方式切换（平铺 / 按某一维度分组） */
export function GroupSwitch({ value, options, onChange }: { value: string; options: Array<[string, string]>; onChange: (v: string) => void }) {
  return (
    <div className="chips" role="group" aria-label="分组方式">
      {options.map(([k, l]) => <button key={k} type="button" className={`chip${value === k ? ' active' : ''}`} aria-pressed={value === k} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  );
}

/** 按列配置导出当前结果（带 BOM 的 CSV）；没有 csv 的列不导出 */
export function ExportButton<R>({ name, cols, rows, label = '导出当前结果' }: { name: string; cols: Array<Col<R>>; rows: R[] | null | undefined; label?: string }) {
  const ex = cols.filter((c) => c.csv);
  return <button type="button" className="secondary-button small" disabled={!rows?.length} onClick={() => downloadCsv(name, ex.map((c) => c.head), (rows ?? []).map((r) => ex.map((c) => c.csv!(r))))}>{label}</button>;
}

/** 数据时间：页面最近一次读取到数据的时刻（旧版“快照时间”） */
export function stamp(d: Date | null): string {
  return d ? d.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '';
}

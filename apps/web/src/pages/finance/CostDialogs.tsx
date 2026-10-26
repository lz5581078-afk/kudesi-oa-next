import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { money, pct } from './common';
import { financeApi, type CostCategory, type CostRow, type CostSnapshotRow, type PricingHistoryRow } from './financeApi';

export const ROLE: Record<string, string> = { main: '主品', gift: '赠品', package: '包装', label: '标签', instruction: '说明书', other: '其他物料', labor: '人工' };
export const METHOD: Record<string, string> = {
  provincial_majority_mean_plus_10_percent: '按各省最低报价的多数均值 ×1.1', provincial_upper_trimmed_mean_plus_10_percent: '去掉最高 20% 后均值 ×1.1（6kg 以上）',
  manual_override: '运费段手工覆盖', split_parcel_sum: '超过单包上限，拆包相加', 手工填写: '本组合手工填写',
};
const when = (s: string) => new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');
const kg = (g: number | null) => (g === null ? '未设置' : `${Number((g / 1000).toFixed(3))} kg`);

/** 成本组成 / 重量组成：这个组合的成本和重量是怎么由各个构成加起来的 */
export function BreakdownDialog({ row, kind, onClose }: { row: CostRow; kind: 'cost' | 'weight'; onClose: () => void }) {
  const cost = kind === 'cost';
  const lines = cost ? row.lines : row.lines.filter((l) => l.role !== 'labor');
  return (
    <div className="modal-backdrop" role="presentation"><div className="modal card wide" role="dialog" aria-label={`${cost ? '成本' : '重量'}组成明细`}>
      <div className="modal-head between"><strong>{cost ? '成本组成' : '重量组成'} · {row.code}</strong><button type="button" className="icon-button" aria-label="关闭组成明细" onClick={onClose}>✕</button></div>
      <div className="modal-body">
        <p className="muted">{row.name}</p>
        {row.issues.length > 0 && <ul>{row.issues.map((i) => <li key={i} className="bad-text">{i}</li>)}</ul>}
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>类型</th><th>组成项目</th><th className="num">数量</th><th className="num">{cost ? '单位成本' : '单件重量'}</th><th className="num">{cost ? '成本小计' : '重量小计'}</th></tr></thead>
          <tbody>
            {lines.length === 0 && <tr><td colSpan={5} className="empty-state muted">暂无组成明细</td></tr>}
            {lines.map((l, i) => (
              <tr key={i}><td>{ROLE[l.role] ?? l.role}</td><td><strong>{l.name}</strong><div className="muted">{l.code}</div></td><td className="num">{l.qty}</td>
                <td className="num">{cost ? money(l.unitCostCents) : l.unitWeightG === null ? '—' : `${l.unitWeightG} g`}</td>
                <td className="num">{cost ? money(l.subtotalCents) : `${l.weightG} g`}</td></tr>
            ))}
          </tbody>
        </table></div>
        <div className="between"><span>{cost ? '成本表成本（发货前）' : '成本表计费重量'}</span><strong>{cost ? money(row.preShipCostCents) : row.weightG === null ? '未设置' : `${row.weightG} g（${kg(row.weightG)}）`}</strong></div>
      </div>
      <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
    </div></div>
  );
}

export type EditTarget =
  | { kind: 'sku'; row: CostRow }
  | { kind: 'category'; id: number; name: string; ownPercent: number | null; revision: string };

/** 维护售价（单个组合：使用快递、单品利润率）或设置分类利润率。保存要写原因；别人先改过会被拒绝。 */
export function PricingEditDialog({ target, categories, onClose, onSaved, onConflict }: {
  target: EditTarget; categories: CostCategory[]; onClose: () => void; onSaved: () => void; onConflict: () => void;
}) {
  const sku = target.kind === 'sku' ? target.row : null;
  const own = sku ? (sku.marginOverride ? sku.marginPercent : null) : target.kind === 'category' ? target.ownPercent : null;
  const [carrier, setCarrier] = useState(sku?.carrierName ?? '');
  const [override, setOverride] = useState(own !== null);
  const [percent, setPercent] = useState(own === null ? '' : String(Number(own.toFixed(6))));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [saving, onClose]);

  const title = sku ? '维护售价' : '分类利润率';
  const subtitle = sku ? sku.name : target.kind === 'category' ? target.name : '';
  const catInherit = target.kind === 'category' && target.id > 0 ? categories.find((c) => c.id === target.id) : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    let profitPercent: number | null = null;
    if (override) {
      const t = percent.trim();
      const n = Number(t);
      if (!/^\d+(\.\d{1,6})?$/.test(t) || !Number.isFinite(n) || n >= 100) { setError('利润率必须在 0% 到 100% 之间（不含 100%），最多保留 6 位小数'); return; }
      profitPercent = n;
    }
    setSaving(true);
    try {
      if (sku) await financeApi.saveCostPricing(sku.bundleId, { revision: sku.revision, carrierName: carrier.trim(), profitPercent, reason: reason.trim() });
      else if (target.kind === 'category') await financeApi.saveCategoryMargin(target.id, { revision: target.revision, profitPercent, reason: reason.trim() });
      onSaved();
    } catch (err) {
      setError(msg(err));
      if (err instanceof ApiError && err.status === 409) onConflict();
    }
    setSaving(false);
  }

  return (
    <div className="modal-backdrop" role="presentation"><div className="modal card small" role="dialog" aria-label={title}>
      <div className="modal-head between"><div><strong>{title}</strong><div className="muted">{subtitle}</div></div><button type="button" className="icon-button" aria-label="关闭售价维护" disabled={saving} onClick={onClose}>✕</button></div>
      <form onSubmit={submit} noValidate>
        <div className="modal-body">
          {sku && (
            <>
              <div className="stats">
                <div className="stat"><span className="muted">发货前成本</span><strong>{money(sku.preShipCostCents)}</strong></div>
                <div className="stat"><span className="muted">计费重量</span><strong>{kg(sku.weightG)}</strong></div>
                <div className="stat"><span className="muted">预估运费</span><strong>{money(sku.freightCents)}</strong></div>
              </div>
              <p className="muted">{sku.freightMethod ? `运费来源：${METHOD[sku.freightMethod] ?? sku.freightMethod}` : '缺少运费预估'}。运费统一按重量段价格表估算，这里不能改；“使用快递”只是备注。</p>
              <label>使用快递<input maxLength={80} value={carrier} onChange={(e) => setCarrier(e.target.value)} /></label>
            </>
          )}
          <label className="check-line"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />{sku ? '单独设置利润率' : '设置本级利润率'}</label>
          {override
            ? <label>利润率（%）<input autoFocus required type="number" min="0" max="99.999999" step="0.000001" value={percent} onChange={(e) => setPercent(e.target.value)} /></label>
            : <p className="muted">{sku ? `继承：${sku.inheritedMargin.source} · ${pct(sku.inheritedMargin.percent)}` : target.kind === 'category' && target.id > 0 ? `使用最近上级分类的利润率（现在是 ${pct(catInherit?.percent)}，来自${catInherit?.source ?? '全部默认'}）；上级都没设置时使用全部默认。` : '没有设置分类或单品利润率的组合不计算最低售价。'}</p>}
          {sku && override && <button type="button" className="link-button" onClick={() => setOverride(false)}>恢复分类默认</button>}
          <label>修改原因<textarea required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：大客户专价、成本上涨后调整" /></label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={saving || !reason.trim()}>{saving ? '保存中…' : '确认保存并生效'}</button>
        </div>
      </form>
    </div></div>
  );
}

const fmt = (k: string, v: number | null) => (v === null ? '—' : k === 'weightG' ? `${v}g` : k === 'marginPercent' ? pct(v) : money(v));

/** 一个组合自己的成本历史：成本变更（每次成本、重量、运费、利润率、最低售价变化）+ 售价维护（使用快递、单品利润率） */
export function SkuHistoryDialog({ row, onClose }: { row: CostRow; onClose: () => void }) {
  const [tab, setTab] = useState<'changes' | 'pricing'>('changes');
  const [data, setData] = useState<{ changes: { total: number; rows: CostSnapshotRow[] }; pricing: { total: number; rows: PricingHistoryRow[] } } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { financeApi.skuCostHistory(row.bundleId).then(setData).catch((e) => setError(msg(e))); }, [row.bundleId]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation"><div className="modal card wide" role="dialog" aria-label="SKU成本历史">
      <div className="modal-head between"><div><strong>{row.name}</strong><div className="muted">{row.code}</div></div><button type="button" className="icon-button" aria-label="关闭成本历史" onClick={onClose}>✕</button></div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'changes'} className={`tab${tab === 'changes' ? ' active' : ''}`} onClick={() => setTab('changes')}>成本变更记录{data ? `（${data.changes.total}）` : ''}</button>
        <button type="button" role="tab" aria-selected={tab === 'pricing'} className={`tab${tab === 'pricing' ? ' active' : ''}`} onClick={() => setTab('pricing')}>售价维护记录{data ? `（${data.pricing.total}）` : ''}</button>
      </div>
      <div className="modal-body">
        {error && <div role="alert" className="notice error">{error}</div>}
        {tab === 'changes' && data && (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>时间</th><th>版本</th><th className="num">发货前成本</th><th className="num">运费</th><th className="num">最低售价</th><th>相比上一版</th><th>操作人 / 原因</th></tr></thead>
            <tbody>
              {data.changes.rows.length === 0 && <tr><td colSpan={7} className="empty-state muted">暂无成本变更记录</td></tr>}
              {data.changes.rows.map((r) => (
                <tr key={r.id}><td>{when(r.createdAt)}</td><td>v{r.revision}</td><td className="num">{fmt('p', r.preShipCostCents)}</td><td className="num">{fmt('f', r.freightCents)}</td><td className="num">{fmt('m', r.minPriceCents)}</td>
                  <td>{r.revision === 1 ? <span className="muted">首版</span> : r.changes.map((c) => <div key={c.field}>{c.label}：{fmt(c.field, c.before)} → <strong>{fmt(c.field, c.after)}</strong></div>)}</td>
                  <td>{r.actorName}<div className="muted">{r.reason}</div></td></tr>
              ))}
            </tbody>
          </table></div>
        )}
        {tab === 'pricing' && data && (
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>时间</th><th>使用快递</th><th>单品利润率</th><th>操作人</th><th>修改原因</th></tr></thead>
            <tbody>
              {data.pricing.rows.length === 0 && <tr><td colSpan={5} className="empty-state muted">暂无售价维护记录</td></tr>}
              {data.pricing.rows.map((r) => (
                <tr key={r.id}><td>{when(r.createdAt)}</td><td>{r.beforeCarrier || '未指定'} → <strong>{r.afterCarrier || '未指定'}</strong></td>
                  <td>{r.beforePercent === null ? '继承' : pct(r.beforePercent)} → <strong>{r.afterPercent === null ? '继承' : pct(r.afterPercent)}</strong></td><td>{r.actorName}</td><td>{r.reason}</td></tr>
              ))}
            </tbody>
          </table></div>
        )}
        {!data && !error && <p className="muted">正在读取…</p>}
      </div>
    </div></div>
  );
}

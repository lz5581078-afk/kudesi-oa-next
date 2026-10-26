import { useEffect, useState } from 'react';
import { WAREHOUSE_GROUPS, WAREHOUSE_ROLE_LABEL, type SkuSpec, type WarehouseGroupKey, type WarehouseLine, type WarehouseSpec } from '@kudesi/shared';
import { ApiError, api } from '../../api/client';

/** SKU 批量申请的表单与预览。申请从“申请中心”发起，预览显示在流程详情里；这里不是独立页面。 */

export const SKU_TEMPLATE = 'sku-batch-apply';
interface Opt { id: number; code: string; name: string; spec?: string }
type Kind = 'main' | 'gift' | 'package' | 'label' | 'other' | 'labor';

export const skuApi = {
  meta: () => api<{ scenarios: Array<{ id: number; name: string }>; platforms: Array<{ id: number; name: string }> }>('/flow/sku-apply/options?kind=meta'),
  options: (kind: Kind, keyword: string) => api<{ items: Opt[] }>(`/flow/sku-apply/options?kind=${kind}&keyword=${encodeURIComponent(keyword)}`),
  names: (ids: number[]) => api<{ items: Opt[] }>(`/flow/sku-apply/options?kind=names&ids=${ids.join(',')}`),
  preview: (runId: number) => api<SkuPreviewDto>(`/flow/sku-apply/runs/${runId}/preview`),
};

/** 搜索并选一个商品/人工项目。每次最多列 30 条，不显示成本。 */
function ItemPicker({ kind, label, onPick }: { kind: Kind; label: string; onPick: (o: Opt) => void }) {
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState('');
  const [items, setItems] = useState<Opt[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const t = setTimeout(() => { skuApi.options(kind, kw).then((r) => alive && setItems(r.items)).catch((e) => alive && setErr(e instanceof ApiError ? e.message : '加载失败')); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [open, kw, kind]);
  if (!open) return <button type="button" className="link-button" onClick={() => setOpen(true)}>＋ {label}</button>;
  return (
    <div className="sku-picker">
      <input type="search" autoFocus placeholder="输入编码或名称搜索" aria-label={`搜索${label}`} value={kw} onChange={(e) => setKw(e.target.value)} />
      <button type="button" className="link-button" onClick={() => { setOpen(false); setKw(''); }}>收起</button>
      {err && <span role="alert" className="muted">{err}</span>}
      <ul className="sku-picker-list">
        {items === null ? <li className="muted">加载中…</li> : items.length === 0 ? <li className="muted">没有找到（只能选已验证的）</li> : items.map((o) => (
          <li key={o.id}><button type="button" onClick={() => { onPick(o); setOpen(false); setKw(''); }}><strong>{o.code}</strong> {o.name}{o.spec ? <small className="muted"> · {o.spec}</small> : null}</button></li>
        ))}
      </ul>
    </div>
  );
}

type Names = Record<number, string>;
const nameOf = (names: Names, id: number | undefined) => (id && names[id]) || (id ? `商品 #${id}` : '');

function LineRows({ lines, names, onChange }: { lines: Array<{ baseCodeId: number; qty: number }>; names: Names; onChange: (l: Array<{ baseCodeId: number; qty: number }>) => void }) {
  return (
    <ul className="sku-lines">
      {lines.map((l, i) => (
        <li key={`${l.baseCodeId}-${i}`}>
          <span>{nameOf(names, l.baseCodeId)}</span>
          <input type="number" min={1} step={1} aria-label="数量" value={l.qty} onChange={(e) => onChange(lines.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} />
          <button type="button" className="link-button" aria-label="去掉" onClick={() => onChange(lines.filter((_, j) => j !== i))}>去掉</button>
        </li>
      ))}
    </ul>
  );
}

/** 运营填：申请名称、场景、平台、规格清单（每个规格 = 主商品 + 赠品）。 */
export function SkuApplyFields({ values, onChange }: { values: Record<string, unknown>; onChange: (key: string, v: unknown) => void }) {
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof skuApi.meta>> | null>(null);
  const [names, setNames] = useState<Names>({});
  const specs = (Array.isArray(values.specs) ? values.specs : []) as SkuSpec[];
  const platformIds = (Array.isArray(values.platformIds) ? values.platformIds : []) as number[];
  useEffect(() => { skuApi.meta().then(setMeta).catch(() => setMeta({ scenarios: [], platforms: [] })); }, []);
  // 重新提交时，已有的商品要显示名称
  useEffect(() => {
    const need = [...new Set(specs.flatMap((s) => [...s.main, ...s.gift].map((l) => l.baseCodeId)))].filter((id) => !names[id]);
    if (need.length) skuApi.names(need).then((r) => setNames((cur) => ({ ...cur, ...Object.fromEntries(r.items.map((o) => [o.id, `${o.code} ${o.name}`])) }))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.specs]);
  const setSpecs = (next: SkuSpec[]) => onChange('specs', next);
  const patch = (i: number, p: Partial<SkuSpec>) => setSpecs(specs.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const pick = (i: number, role: 'main' | 'gift', o: Opt) => {
    setNames((cur) => ({ ...cur, [o.id]: `${o.code} ${o.name}` }));
    const cur = specs[i][role];
    patch(i, { [role]: cur.some((l) => l.baseCodeId === o.id) ? cur : [...cur, { baseCodeId: o.id, qty: 1 }] } as Partial<SkuSpec>);
  };
  return (
    <div className="sku-form">
      <div className="form-grid">
        <label className="wide"><span>申请名称<b className="req"> *</b></span><input value={String(values.batchName ?? '')} maxLength={140} placeholder="例如：10 月新品组合" onChange={(e) => onChange('batchName', e.target.value)} /></label>
        <label><span>销售场景<b className="req"> *</b></span>
          <select value={String(values.scenarioId ?? '')} onChange={(e) => onChange('scenarioId', e.target.value ? Number(e.target.value) : '')}>
            <option value="">（请选择）</option>
            {meta?.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <small className="muted">整张申请的所有规格都用这个场景</small>
        </label>
        <div className="wide"><span>销售平台<b className="req"> *</b></span>
          <div className="check-list" role="group" aria-label="销售平台">
            {meta?.platforms.map((p) => (
              <label key={p.id} className="check"><input type="checkbox" checked={platformIds.includes(p.id)} onChange={(e) => onChange('platformIds', e.target.checked ? [...platformIds, p.id] : platformIds.filter((x) => x !== p.id))} />{p.name}</label>
            ))}
          </div>
          <small className="muted">每个规格在每个选中的平台各生成一个商品组合编码</small>
        </div>
      </div>
      <h4 className="section-title">规格清单（{specs.length} 个，最多 100 个）</h4>
      {specs.map((s, i) => (
        <section key={i} className="sku-spec card">
          <div className="between">
            <label className="grow"><span>规格 {i + 1} 名称</span><input value={s.name} maxLength={100} onChange={(e) => patch(i, { name: e.target.value })} /></label>
            <button type="button" className="link-button" onClick={() => setSpecs(specs.filter((_, j) => j !== i))}>删除这个规格</button>
          </div>
          <div className="sku-cols">
            <div><strong>主商品（必填）</strong><LineRows lines={s.main} names={names} onChange={(l) => patch(i, { main: l })} /><ItemPicker kind="main" label="添加主商品" onPick={(o) => pick(i, 'main', o)} /></div>
            <div><strong>赠品</strong><LineRows lines={s.gift} names={names} onChange={(l) => patch(i, { gift: l })} /><ItemPicker kind="gift" label="添加赠品" onPick={(o) => pick(i, 'gift', o)} /></div>
          </div>
          <label><span>备注（选填）</span><input value={s.note ?? ''} maxLength={500} onChange={(e) => patch(i, { note: e.target.value })} /></label>
          <label><span>已有相同组合时，为什么还要申请（选填）</span><input value={s.reuseReason ?? ''} maxLength={500} placeholder="系统里已有主商品、赠品相同的编码时必须填写" onChange={(e) => patch(i, { reuseReason: e.target.value })} /></label>
        </section>
      ))}
      <button type="button" className="secondary-button" disabled={specs.length >= 100} onClick={() => setSpecs([...specs, { name: '', main: [], gift: [] }])}>＋ 添加规格</button>
      <label className="wide"><span>备注</span><textarea rows={2} maxLength={500} value={String(values.note ?? '')} onChange={(e) => onChange('note', e.target.value)} /></label>
    </div>
  );
}

const emptyWh = (): WarehouseSpec => ({ lines: [], notRequired: {} });

/** 仓库填：每个规格的包装、标签/说明书、其他打包材料、人工。每类要么选好，要么写明不需要的原因。 */
export function SkuWarehouseFields({ specs, values, onChange }: { specs: SkuSpec[]; values: Record<string, unknown>; onChange: (key: string, v: unknown) => void }) {
  const config = specs.map((_, i) => ((values.config as WarehouseSpec[] | undefined)?.[i] ?? emptyWh()));
  const [names, setNames] = useState<Record<string, string>>({});
  const set = (i: number, w: WarehouseSpec) => onChange('config', config.map((c, j) => (j === i ? w : c)));
  const kindOf = (g: WarehouseGroupKey): Kind => g;
  return (
    <div className="sku-form">
      {specs.map((s, i) => {
        const w = config[i];
        return (
          <section key={i} className="sku-spec card">
            <strong>规格：{s.name}</strong>
            {WAREHOUSE_GROUPS.map((g) => {
              const mine = w.lines.map((l, idx) => ({ l, idx })).filter(({ l }) => g.roles.includes(l.role));
              return (
                <div key={g.key} className="sku-group">
                  <span className="sku-group-title">{g.label}</span>
                  <ul className="sku-lines">
                    {mine.map(({ l, idx }) => (
                      <li key={idx}>
                        <span>{names[`${g.key}:${l.baseCodeId ?? `L${l.laborId}`}`] ?? (l.role === 'labor' ? `人工 #${l.laborId}` : `商品 #${l.baseCodeId}`)}</span>
                        {g.key === 'label' && (
                          <select aria-label="类别" value={l.role} onChange={(e) => set(i, { ...w, lines: w.lines.map((x, j) => (j === idx ? { ...x, role: e.target.value as WarehouseLine['role'] } : x)) })}>
                            <option value="label">标签</option><option value="instruction">说明书</option>
                          </select>
                        )}
                        <input type="number" min={0.001} step="any" aria-label="数量" value={l.qty} onChange={(e) => set(i, { ...w, lines: w.lines.map((x, j) => (j === idx ? { ...x, qty: Number(e.target.value) } : x)) })} />
                        <button type="button" className="link-button" onClick={() => set(i, { ...w, lines: w.lines.filter((_, j) => j !== idx) })}>去掉</button>
                      </li>
                    ))}
                  </ul>
                  <ItemPicker kind={kindOf(g.key)} label={`添加${g.label}`} onPick={(o) => {
                    const role: WarehouseLine['role'] = g.key;
                    setNames((cur) => ({ ...cur, [`${g.key}:${g.key === 'labor' ? `L${o.id}` : o.id}`]: `${o.code} ${o.name}` }));
                    const line: WarehouseLine = g.key === 'labor' ? { role, laborId: o.id, qty: 1 } : { role, baseCodeId: o.id, qty: 1 };
                    set(i, { ...w, lines: [...w.lines, line], notRequired: { ...w.notRequired, [g.key]: undefined } });
                  }} />
                  {mine.length === 0 && (
                    <label className="sku-why"><span>不需要{g.label}的原因<b className="req"> *</b></span>
                      <input value={w.notRequired[g.key] ?? ''} maxLength={200} placeholder="没有选物料时必须写明原因" onChange={(e) => set(i, { ...w, notRequired: { ...w.notRequired, [g.key]: e.target.value } })} />
                    </label>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

export interface SkuPreviewDto {
  runId: number; status: string; batchName: string; scenario: string; platforms: Array<{ id: number; name: string }>; warehouseDone: boolean; canCost: boolean; planError: string; costNote: string;
  specs: Array<{
    name: string; note: string; reuseReason: string; weightG: number; totalCost?: number; notRequired: Partial<Record<WarehouseGroupKey, string>>;
    lines: PreviewLine[]; warehouse: PreviewLine[];
    targets: Array<{ platformName: string; code: string; name: string; reuse: { code: string } | null }>;
    created: Array<{ bundleId: number; code: string; reused: boolean }>;
  }>;
}
interface PreviewLine { roleLabel: string; code: string; name: string; qty: number; weightG: number | null; cost?: number | null }
const yuan = (c: number) => `¥${(c / 100).toFixed(2)}`;

/** 流程详情里的规格明细：会生成（或已生成）哪些编码、物料、重量，有成本权限的人还能看到成本。 */
export function SkuPreview({ runId, refreshKey }: { runId: number; refreshKey: number }) {
  const [data, setData] = useState<SkuPreviewDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { skuApi.preview(runId).then(setData).catch((e) => setError(e instanceof ApiError ? e.message : '规格明细加载失败')); }, [runId, refreshKey]);
  if (error) return <p role="alert" className="muted">{error}</p>;
  if (!data) return <p className="muted">正在加载规格明细…</p>;
  const lineTable = (lines: PreviewLine[]) => (
    <table className="data-table compact">
      <thead><tr><th>类别</th><th>编码</th><th>名称</th><th className="num">数量</th><th className="num">重量(克)</th>{data.canCost && <th className="num">单价成本</th>}</tr></thead>
      <tbody>{lines.map((l, i) => (
        <tr key={i}><td>{l.roleLabel}</td><td className="mono">{l.code}</td><td>{l.name}</td><td className="num">{l.qty}</td><td className="num">{l.weightG ?? '—'}</td>{data.canCost && <td className="num">{l.cost == null ? '—' : yuan(l.cost)}</td>}</tr>
      ))}</tbody>
    </table>
  );
  return (
    <div className="sku-preview">
      <p className="muted">销售场景：{data.scenario} · 销售平台：{data.platforms.map((p) => p.name).join('、')} · {data.warehouseDone ? '仓库已提交配置' : '仓库还没有提交配置'}</p>
      {data.planError && <div role="alert" className="notice error">{data.planError}</div>}
      {data.specs.map((s) => (
        <section key={s.name} className="sku-spec card">
          <strong>{s.name}</strong>
          <span className="muted"> · 总重量 {s.weightG} 克{data.canCost && s.totalCost !== undefined ? ` · 物料成本 ${yuan(s.totalCost)}（${data.costNote}）` : ''}</span>
          {s.note && <div className="muted">备注：{s.note}</div>}
          {s.reuseReason && <div className="muted">已有相同组合，仍申请的原因：{s.reuseReason}</div>}
          {lineTable([...s.lines, ...s.warehouse])}
          {Object.entries(s.notRequired).map(([k, why]) => <div key={k} className="muted">不需要{WAREHOUSE_GROUPS.find((g) => g.key === k)?.label ?? WAREHOUSE_ROLE_LABEL[k as keyof typeof WAREHOUSE_ROLE_LABEL]}：{why}</div>)}
          {s.created.length > 0 ? (
            <p>已生成商品组合编码：{s.created.map((c) => <span key={c.bundleId} className="pill ok mono" style={{ marginRight: 6 }}>{c.code}{c.reused ? '（沿用已有）' : ''}</span>)}</p>
          ) : s.targets.length > 0 && (
            <table className="data-table compact">
              <thead><tr><th>平台</th><th>将生成的组合编码</th><th>组合名称</th><th>状态</th></tr></thead>
              <tbody>{s.targets.map((t) => <tr key={t.code}><td>{t.platformName}</td><td className="mono">{t.code}</td><td>{t.name}</td><td>{t.reuse ? '沿用已有编码' : '新建'}</td></tr>)}</tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { WAREHOUSE_GROUPS, WAREHOUSE_ROLE_LABEL, type SkuSpec, type WarehouseGroupKey, type WarehouseLine, type WarehouseSpec } from '@kudesi/shared';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../../api/client';

/** SKU 批量申请的表单与预览。申请从“申请中心”发起，预览显示在流程详情里；这里不是独立页面。 */

export const SKU_TEMPLATE = 'sku-batch-apply';
interface Opt { id: number; code: string; name: string; spec?: string }
type Kind = 'main' | 'gift' | 'package' | 'label' | 'other' | 'labor';

export const skuApi = {
  meta: () => api<{ scenarios: Array<{ id: number; name: string }>; platforms: Array<{ id: number; name: string }>; bundleCategories?: Array<{ id: number; name: string }> }>('/flow/sku-apply/options?kind=meta'),
  options: (kind: Kind, keyword: string) => api<{ items: Opt[] }>(`/flow/sku-apply/options?kind=${kind}&keyword=${encodeURIComponent(keyword)}`),
  names: (ids: number[]) => api<{ items: Opt[] }>(`/flow/sku-apply/options?kind=names&ids=${ids.join(',')}`),
  preview: (runId: number) => api<SkuPreviewDto>(`/flow/sku-apply/runs/${runId}/preview`),
  history: (mainIds: number[], keyword = '') => api<HistoryDto>(`/flow/sku-apply/history-config?mainIds=${mainIds.join(',')}&keyword=${encodeURIComponent(keyword)}`),
  startSplit: (payload: Record<string, unknown>, requestKey: string) => api<{ batchKey: string; runs: Array<{ id: number; specName: string }>; failed: Array<{ specName: string; message: string }> }>('/flow/sku-apply/start-split', { method: 'POST', body: { payload, requestKey } }),
  batch: (key: string) => api<{ batchKey: string; total: number; items: Array<{ id: number; specName: string; status: string; currentStep: string }> }>(`/flow/sku-apply/batches/${encodeURIComponent(key)}`),
};
export interface BatchItem { runId: number; revision: number; stepId?: number | null }
export interface BatchBoard {
  ref: string; batchKey: string | null; batchName: string; requesterName: string; total: number; runCount: number;
  counts: { running: number; completed: number; ended: number; returned: number; mine: number };
  me: { isRequester: boolean; holdStepKey: string | null; holdStepName: string; holdCount: number; canReturnAll: boolean };
  items: Array<{ runId: number; specIndex: number; specName: string; specCount: number; runStatus: string; revision: number; stepId: number | null; stepKey: string | null; stepName: string; enteredVia: string | null; dueAt: string | null; overdue: boolean; recipients: string[]; mine: boolean; canResubmit: boolean; returnReason: string | null; returnedBy: string | null; returnedAt: string | null }>;
  history: Array<{ id: number; runId: number; action: string; note: string | null; actorName: string; createdAt: string; specNames: string[] }>;
}
export interface BatchOutcome { results: Array<{ runId: number; ok: boolean; message?: string }>; ok: number; failed: number }
export const skuBatchApi = {
  board: (ref: string) => api<BatchBoard>(`/flow/sku-apply/applications/${encodeURIComponent(ref)}`),
  act: (b: { ref: string; action: 'pass' | 'return' | 'reject' | 'cancel' | 'resubmit'; items: Array<{ runId: number; revision: number; stepId?: number }>; comment?: string; form?: Record<string, unknown> }) => api<BatchOutcome>('/flow/sku-apply/applications/act', { method: 'POST', body: b }),
  returnAll: (b: { ref: string; items: Array<{ runId: number; revision: number; stepId?: number }>; reason: string }) => api<{ ok: true; count: number }>('/flow/sku-apply/applications/return-all', { method: 'POST', body: b }),
  returnSpecs: (b: { runId: number; revision: number; stepId: number; specs: string[]; reason: string }) => api<{ ok: true; ref: string; newRunId: number; split: boolean }>('/flow/sku-apply/applications/return-specs', { method: 'POST', body: b }),
};
export interface HistoryDto { items: Array<{ runId: number; title: string; specName: string; exact: boolean; status: string; config: WarehouseSpec }>; names: Record<string, string> }

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
  useEffect(() => { skuApi.meta().then(setMeta).catch(() => setMeta({ scenarios: [], platforms: [], bundleCategories: [] })); }, []);
  // 重新提交时，已有的商品要显示名称
  useEffect(() => {
    const need = [...new Set(specs.flatMap((s) => [...s.main, ...s.gift].map((l) => l.baseCodeId)))].filter((id) => !names[id]);
    if (need.length) skuApi.names(need).then((r) => setNames((cur) => ({ ...cur, ...Object.fromEntries(r.items.map((o) => [o.id, `${o.code} ${o.name}`])) }))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.specs]);
  const [series, setSeries] = useState<Record<number, string>>({});
  const [seriesError, setSeriesError] = useState('');
  const setSpecs = (next: SkuSpec[]) => onChange('specs', next);
  /** 数量系列（旧系统“批量生成规格”）：以这个规格为模板，按 1,2,5,10 这样的数量各生成一个规格，赠品照旧，仓库组成之后再配 */
  function makeSeries(i: number) {
    const base = specs[i];
    const nums = (series[i] ?? '').split(/[,，\s]+/).filter(Boolean).map(Number);
    if (base.main.length !== 1) { setSeriesError('数量系列要求这个规格只有一个主商品'); return; }
    if (!nums.length || nums.length > 30 || nums.some((n) => !Number.isSafeInteger(n) || n <= 0) || new Set(nums).size !== nums.length) { setSeriesError('请输入 1 到 30 个不重复的正整数，用逗号分隔'); return; }
    if (specs.length + nums.length > 100) { setSeriesError('规格总数不能超过 100 个'); return; }
    const made = nums.map((n): SkuSpec => ({ ...base, name: `${base.name || '规格'} · ${n}件`, main: [{ ...base.main[0], qty: n }], gift: base.gift.map((l) => ({ ...l })), reuseReason: '' }));
    setSeriesError('');
    setSeries((cur) => ({ ...cur, [i]: '' }));
    setSpecs([...specs.slice(0, i + 1), ...made, ...specs.slice(i + 1)]);
  }
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
        <label className="wide"><span>组合分类<b className="req"> *</b></span>
          <select aria-label="组合分类" value={String(values.bundleCategoryId ?? '')} onChange={(e) => onChange('bundleCategoryId', e.target.value ? Number(e.target.value) : '')}>
            <option value="">（请选择最末级分类）</option>
            {meta?.bundleCategories?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <small className="muted">组合分类树里的最末级分类；生成的组合都归到这个分类，成本表分类利润率按它汇总</small>
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
            <span className="row-actions">
              <button type="button" className="link-button" disabled={specs.length >= 100} onClick={() => setSpecs([...specs.slice(0, i + 1), { ...s, name: s.name ? `${s.name}（副本）` : '', main: s.main.map((l) => ({ ...l })), gift: s.gift.map((l) => ({ ...l })), reuseReason: '' }, ...specs.slice(i + 1)])}>复制这个规格</button>
              <button type="button" className="link-button" onClick={() => { if ((s.name || s.main.length || s.gift.length) && !window.confirm(`确定删除规格 ${i + 1}${s.name ? `「${s.name}」` : ''}？已选的商品会一起去掉。`)) return; setSpecs(specs.filter((_, j) => j !== i)); }}>删除这个规格</button>
            </span>
          </div>
          <div className="sku-cols">
            <div><strong>主商品（必填）</strong><LineRows lines={s.main} names={names} onChange={(l) => patch(i, { main: l })} /><ItemPicker kind="main" label="添加主商品" onPick={(o) => pick(i, 'main', o)} /></div>
            <div><strong>赠品</strong><LineRows lines={s.gift} names={names} onChange={(l) => patch(i, { gift: l })} /><ItemPicker kind="gift" label="添加赠品" onPick={(o) => pick(i, 'gift', o)} /></div>
          </div>
          {s.main.length === 1 && (
            <div className="sku-series row-actions">
              <input aria-label={`规格 ${i + 1} 数量系列`} placeholder="数量系列，如 1, 2, 5, 10" value={series[i] ?? ''} onChange={(e) => setSeries((cur) => ({ ...cur, [i]: e.target.value }))} />
              <button type="button" className="secondary-button small" disabled={!(series[i] ?? '').trim() || specs.length >= 100} onClick={() => makeSeries(i)}>按数量生成规格</button>
            </div>
          )}
          <label><span>备注（选填）</span><input value={s.note ?? ''} maxLength={500} onChange={(e) => patch(i, { note: e.target.value })} /></label>
          <label><span>已有相同组合时，为什么还要申请（选填）</span><input value={s.reuseReason ?? ''} maxLength={500} placeholder="系统里已有主商品、赠品相同的编码时必须填写" onChange={(e) => patch(i, { reuseReason: e.target.value })} /></label>
        </section>
      ))}
      {seriesError && <div role="alert" className="notice error">{seriesError}</div>}
      <button type="button" className="secondary-button" disabled={specs.length >= 100} onClick={() => setSpecs([...specs, { name: '', main: [], gift: [] }])}>＋ 添加规格</button>
      {specs.length > 1 && (
        <label className="check sku-split"><input type="checkbox" checked={values.splitSpecs === true} onChange={(e) => onChange('splitSpecs', e.target.checked)} /> 每个规格独立办理（拆成 {specs.length} 条流程，仓库、财务可以各自先办先走；同批可互相查看）</label>
      )}
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
  const [hist, setHist] = useState<{ index: number; kw: string; data: HistoryDto | null; error: string } | null>(null);
  const [reused, setReused] = useState<Record<number, string>>({});
  async function openHistory(i: number, kw = '') {
    setHist({ index: i, kw, data: null, error: '' });
    try { setHist({ index: i, kw, data: await skuApi.history(specs[i].main.map((l) => l.baseCodeId), kw), error: '' }); }
    catch (e) { setHist({ index: i, kw, data: null, error: e instanceof ApiError ? e.message : '历史配置加载失败' }); }
  }
  function applyHistory(i: number, h: HistoryDto['items'][number], data: HistoryDto) {
    if (config[i].lines.length && !window.confirm('将替换这个规格已选的包装、标签、打包材料、人工和“不需要”的原因，确定？')) return;
    setNames((cur) => {
      const next = { ...cur };
      for (const l of h.config.lines) {
        const g = WAREHOUSE_GROUPS.find((x) => x.roles.includes(l.role))!;
        next[`${g.key}:${l.role === 'labor' ? `L${l.laborId}` : l.baseCodeId}`] = data.names[l.role === 'labor' ? `l${l.laborId}` : `b${l.baseCodeId}`] ?? '';
      }
      return next;
    });
    set(i, { lines: h.config.lines.map((l) => ({ ...l })), notRequired: { ...h.config.notRequired } });
    setReused((cur) => ({ ...cur, [i]: `来自申请 #${h.runId}「${h.specName}」`.slice(0, 80) }));
    setHist(null);
  }
  return (
    <div className="sku-form">
      {specs.map((s, i) => {
        const w = config[i];
        return (
          <section key={i} className="sku-spec card">
            <div className="between"><strong>规格：{s.name}</strong>
              <button type="button" className="link-button" aria-label={`复用规格 ${s.name} 的历史仓库配置`} onClick={() => void openHistory(i)}>复用历史配置</button>
              {specs.length > 1 && <button type="button" className="link-button" aria-label={`把规格 ${s.name} 的配置套用到其他规格`} onClick={() => {
                const others = config.filter((_, j) => j !== i);
                if (others.some((c) => c.lines.length) && !window.confirm('其他规格已选的包装、标签等会被覆盖，确定套用？')) return;
                onChange('config', config.map((c, j) => (j === i ? c : { lines: w.lines.map((l) => ({ ...l })), notRequired: { ...w.notRequired } })));
              }}>套用到其他规格</button>}
            </div>
            {hist?.index === i && (
              <div className="sku-history card">
                <div className="between"><strong>复用历史仓库配置</strong><button type="button" className="link-button" onClick={() => setHist(null)}>收起</button></div>
                <p className="muted">默认列出主商品相同的规格；也可以按规格名或申请名搜索。复用后请逐项核对，提交时仍会按现在的规则完整校验。</p>
                <input type="search" aria-label="搜索历史规格" placeholder="按规格名或申请名搜索" value={hist.kw} onChange={(e) => void openHistory(i, e.target.value)} />
                {hist.error && <div role="alert" className="notice error">{hist.error}</div>}
                {!hist.data && !hist.error && <p className="muted">加载中…</p>}
                {hist.data && hist.data.items.length === 0 && <p className="muted">没有找到配置过的规格</p>}
                <ul className="sku-lines">
                  {hist.data?.items.map((h) => (
                    <li key={`${h.runId}-${h.specName}`}>
                      <span>{h.specName} <small className="muted">· 申请 #{h.runId}{h.exact ? ' · 主商品相同' : ''} · {h.config.lines.length} 项物料</small></span>
                      <button type="button" className="link-button" aria-label={`填入申请 #${h.runId} 的配置`} onClick={() => applyHistory(i, h, hist.data!)}>填入</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {reused[i] && <div className="notice" role="status">已复用历史配置（{reused[i]}），请逐项核对。</div>}
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
  batch?: { key: string; index: number | null; total: number | null } | null;
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
      {data.batch && <BatchPeers batchKey={data.batch.key} runId={runId} index={data.batch.index} total={data.batch.total} />}
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

/** 拆开办理的同一批申请：每个规格现在到哪一步了 */
function BatchPeers({ batchKey, runId, index, total }: { batchKey: string; runId: number; index: number | null; total: number | null }) {
  const [list, setList] = useState<Awaited<ReturnType<typeof skuApi.batch>> | null>(null);
  useEffect(() => { skuApi.batch(batchKey).then(setList).catch(() => setList(null)); }, [batchKey]);
  const STATUS: Record<string, string> = { running: '办理中', completed: '已完成', cancelled: '已废除', rejected: '被拒绝' };
  return (
    <div className="notice sku-batch" aria-label="同批申请">
      <strong>独立办理：第 {index ?? '?'} / {total ?? '?'} 个规格</strong>
      {' '}<Link to={`/workbench/todos?batch=${encodeURIComponent(batchKey)}`} className="link-button">打开申请汇总（批量办理）</Link>
      {list && (
        <ul className="plain-list">
          {list.items.map((it) => <li key={it.id}>#{it.id} {it.specName} · {it.status === 'running' ? `停在「${it.currentStep}」` : STATUS[it.status] ?? it.status}{it.id === runId ? '（当前）' : ''}</li>)}
        </ul>
      )}
    </div>
  );
}

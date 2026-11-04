import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardList, RefreshCw } from 'lucide-react';
import { sortRecommendationRules } from '@kudesi/shared';
import { useAuth } from '../../../auth/AuthContext';
import { money } from '../common';
import { QueryTable, type Col } from '../query/QueryKit';
import { expressApi, type ZoneRule, type ZoneRunSummary } from './expressApi';
import { useExpressWorkspace } from './ExpressWorkspaceContext';
import { zoneCsvLines } from './zoneCsv';
import './zoneRuns.css';
const when = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const weightText = (row: ZoneRule) => row.weightStart === row.weightEnd ? `${row.weightStart}kg` : `${row.weightStartOperator === '>' ? '>' : '≥'} ${row.weightStart}kg${row.weightEnd === '' ? '' : ` 且 ${row.weightEndOperator === '<' ? '<' : '≤'} ${row.weightEnd}kg`}`;
const priceText = (row: ZoneRule) => row.priceLabel || money(row.amount);
const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
type Active = ZoneRunSummary & { rules: ZoneRule[] | null };

/** A saved run is opened explicitly. Its rules remain a snapshot until the user generates a new run. */
export function ZoneRunsPage() {
  const workspace = useExpressWorkspace();
  const { can } = useAuth();
  const canGenerate = can('resource.finance-express-prices.edit');
  const [ownCooperating, setOwnCooperating] = useState<number | null>(null);
  const cooperating = workspace?.cooperatingVersionCount ?? ownCooperating;
  const [maxW, setMaxW] = useState('30'), [page, setPage] = useState(1), [mobilePage, setMobilePage] = useState(1);
  const [runs, setRuns] = useState<{ items: ZoneRunSummary[]; total: number } | null>(null);
  const [active, setActive] = useState<Active | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const initialized = useRef(false), mounted = useRef(true), listRequest = useRef(0), detailRequest = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; listRequest.current++; detailRequest.current++; }; }, []);
  useEffect(() => {
    if (workspace) return;
    let current = true;
    void expressApi.tree().then(result => { if (current) setOwnCooperating(result.carriers.flatMap(carrier => carrier.branches).filter(branch => branch.versions.some(version => version.isCurrent && version.cooperationStatus === 'active')).length); }).catch(() => { if (current) setOwnCooperating(null); });
    return () => { current = false; };
  }, [Boolean(workspace)]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(async (p: number) => {
    const request = ++listRequest.current;
    try {
      const result = await expressApi.zoneRuns(p, 5);
      if (!mounted.current || request !== listRequest.current) return;
      setRuns(result); setError('');
      if (!initialized.current) { initialized.current = true; if (result.items[0]) setMaxW(String(result.items[0].maxWeightKg)); }
    } catch (e) { if (mounted.current && request === listRequest.current) setError((e as Error).message || '读取失败'); }
  }, []);
  useEffect(() => { void load(page); }, [load, page]);
  const open = useCallback(async (run: ZoneRunSummary) => {
    const request = ++detailRequest.current;
    setActive({ ...run, rules: null }); setMobilePage(1); setError('');
    try { const result = await expressApi.zoneRun(run.id); if (mounted.current && request === detailRequest.current) setActive(result); }
    catch (e) { if (mounted.current && request === detailRequest.current) { setActive(null); setError((e as Error).message || '结果读取失败'); } }
  }, []);
  async function generate() {
    const value = Number(maxW);
    if (!Number.isFinite(value) || value <= 0 || value > 1000) return setError('最高重量要在 0 到 1000 公斤之间');
    if (busy) return;
    setBusy(true); setError('');
    try { const result = await expressApi.generateZone(value); setPage(1); await load(1); await open(result); workspace?.refreshCounts(); }
    catch (e) { setError((e as Error).message || '生成失败'); }
    finally { setBusy(false); }
  }
  function exportCsv() {
    if (!active?.rules) return;
    const blob = new Blob(['﻿' + zoneCsvLines(active.rules).map(row => row.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const anchor = document.createElement('a'); const url = URL.createObjectURL(blob); anchor.href = url; anchor.download = `聚水潭快递分区建议-第${active.sequence}次.csv`; anchor.click(); URL.revokeObjectURL(url);
  }
  const rules = active?.rules ? sortRecommendationRules(active.rules) : null;
  const columns: Col<ZoneRule>[] = [
    { key: 'name', head: '建议规则名称', cell: row => <span className="express-zone-main-text">{row.suggestedRuleName}<small>可直接作为聚水潭规则名称的起点</small></span>, csv: row => row.suggestedRuleName },
    { key: 'jst', head: '聚水潭快递公司', cell: row => row.jstLogisticsName || <b>待维护映射</b>, csv: row => row.jstLogisticsName },
    { key: 'province', head: '限定到达省份', cell: row => row.provinceScope, csv: row => row.provinceScope },
    { key: 'weight', head: '预估订单重量', cell: weightText, csv: weightText, sortValue: row => row.weightStart },
    { key: 'price', head: '最低标准运费', cell: priceText, csv: priceText },
    { key: 'source', head: 'OA来源', cell: row => <span className="express-zone-main-text">{row.carrierName}<small>{row.branchName} · {row.versionName}</small></span>, csv: row => `${row.carrierName} ${row.branchName} ${row.versionName}` },
    { key: 'confirm', head: '聚水潭仍需确认', cell: () => '平台/店铺 · 优先级或低价优先 · 到达判断 · 禁发地区', csv: () => '平台/店铺 · 优先级或低价优先 · 到达判断 · 禁发地区' },
  ];
  const pageCount = Math.max(1, Math.ceil((runs?.total ?? 0) / 5));
  return <section className="express-zone-runs">{workspace ? <header className="express-panel-heading"><div className="express-panel-title"><ClipboardList size={18} aria-hidden="true" /><h2>聚水潭快递分区建议</h2></div></header> : <h1>分区建议</h1>}
    {error && <div className="express-zone-error" role="alert">{error}</div>}
    {!active ? <>
      <div className="express-zone-head"><div><strong>生成记录</strong><span>每次生成保留当时的价格结果。资料变更后需重新生成；建议仅供人工核对，不会写入聚水潭。</span></div><div className="express-zone-generation"><label>生成上限<span><input aria-label="分区建议最高重量（kg）" type="number" min="0" step="any" value={maxW} disabled={!canGenerate || busy} onChange={e => { initialized.current = true; setMaxW(e.target.value); setError(''); }} /><span>kg</span></span></label>{canGenerate && <button type="button" className="primary-button" disabled={busy || !cooperating} onClick={() => void generate()}><RefreshCw size={15} aria-hidden="true" />{busy ? '生成中…' : '生成分区建议'}</button>}</div></div>
      {cooperating === 0 && <div className="express-zone-notice">当前没有合作中的价格版本。可先在网点的价格版本中设置合作状态。</div>}
      {!runs ? <p className="muted">读取中…</p> : runs.items.length ? <div className="express-zone-list"><div className="express-zone-list-header" aria-hidden="true"><span>生成记录</span><span>合作中价格表</span><span>可推荐组合</span><span>分区规则</span><span>操作</span></div>{runs.items.map(run => <div key={run.id} className="express-zone-list-row"><div><strong>第 {run.sequence} 次</strong><small>{when(run.createdAt)}</small><small>生成上限 {run.maxWeightKg}kg</small></div><span><b>{run.cooperatingVersionCount}</b><small>合作版本</small></span><span><b>{run.combinationCount}</b><small>推荐组合</small></span><span><b>{run.ruleCount}</b><small>分区规则</small></span><button type="button" className="secondary-button small" aria-label={`查看第${run.sequence}次详情`} onClick={() => void open(run)}>查看详情</button></div>)}<div className="express-zone-pagination"><span>共 {runs.total} 条 · 第 {page}/{pageCount} 页</span><div><button type="button" className="secondary-button small" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><button type="button" className="secondary-button small" disabled={page >= pageCount} onClick={() => setPage(value => value + 1)}>下一页</button></div></div></div> : <div className="empty-state"><strong>还没有生成记录</strong><p>设置合作中的价格版本后，生成第一份分区建议。</p></div>}
    </> : <>
      <div className="express-zone-head"><div><button type="button" className="express-zone-back" onClick={() => { detailRequest.current++; setActive(null); setError(''); }}>返回生成记录</button><strong>第 {active.sequence} 次分区建议</strong><span>{when(active.createdAt)} 生成</span><span>生成上限 {active.maxWeightKg}kg</span><span>{active.cooperatingVersionCount} 份合作中价格表 · {active.combinationCount} 个可推荐组合 · {active.ruleCount} 条分区规则</span></div><button type="button" className="secondary-button" disabled={!rules} onClick={exportCsv}>导出聚水潭录入清单</button></div>
      <div className="express-zone-notice">此处是生成时的结果快照。请人工核对平台、店铺、优先级和禁发地区后再录入聚水潭。</div>
      <div className="express-zone-guide" aria-label="分区建议生成说明"><strong>这份分区建议怎么来的</strong><ol><li>只看生成当天合作中、日期有效且允许该重量发货的价格表；对每个省、每个重量段，选报价最低的快递和网点。</li><li>把快递网点、重量范围和报价相同的省份合并为一条建议；同一家快递如果价格或重量段不同，会分成多条。下表默认按“快递公司／网点 → 重量从轻到重 → 省份”排列，导出清单也按这个默认顺序。</li><li>这是人工录入聚水潭的参考清单，不会自动写入。规则名称只是起点；同名规则请加省份区分。录入前核对快递公司映射、到达省份、重量边界、平台／店铺、优先级及禁发地区；首重续重报价按实际重量计费，不要当作固定运费。临时加收未计入。</li></ol></div>
      <div className="express-zone-desktop"><QueryTable key={active.id} cols={columns} rows={rules} rowKey={row => `${row.suggestedRuleName}:${row.provinceScope}:${row.weightStart}`} empty="没有分区规则" foot={false} caption="分区建议规则" controls={{ storageKey: `express-zone-run:${active.id}`, pageSize: 30, searchPlaceholder: '搜索建议规则、聚水潭快递、省份或网点' }} /></div>
      <div className="express-zone-mobile">{rules ? rules.slice((mobilePage - 1) * 30, mobilePage * 30).map((row, i) => <article key={i}><strong>{row.suggestedRuleName}</strong><div><span>聚水潭快递</span><b>{row.jstLogisticsName || '待维护映射'}</b></div><div><span>到达省份</span><b>{row.provinceScope}</b></div><div><span>重量段</span><b>{weightText(row)}</b></div><div><span>最低标准运费</span><b>{priceText(row)}</b></div><div><span>OA来源</span><b>{row.carrierName} / {row.branchName} / {row.versionName}</b></div></article>) : <p>读取中…</p>}{rules && rules.length > 30 && <div className="express-zone-pagination"><span>第 {mobilePage}/{Math.ceil(rules.length / 30)} 页 · 每页 30 条</span><div><button type="button" disabled={mobilePage <= 1} onClick={() => setMobilePage(value => value - 1)}>上一页</button><button type="button" disabled={mobilePage * 30 >= rules.length} onClick={() => setMobilePage(value => value + 1)}>下一页</button></div></div>}</div>
    </>}
  </section>;
}

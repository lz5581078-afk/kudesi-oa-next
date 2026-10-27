import { Fragment, useEffect, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { CopyButton } from '../../../resources/CopyValue';
import { Pager } from '../common';
import { jstApi } from './jstApi';

interface Item {
  signature: string; id: number; type: string; code: string; name: string; state: string; uploadedCode: string | null; replacing: boolean;
  current: Record<string, unknown>; uploaded: Record<string, unknown> | null; diff: Array<{ field: string; uploaded: unknown; current: unknown }>;
  records: Array<{ id: number; kind: string; status: string; attempts: number; lastError: string | null; createdAt: string; doneAt: string | null }>;
}
const STATE: Record<string, [string, string]> = { not_synced: ['未同步', 'warn'], queued: ['排队中', 'warn'], confirming: ['等待回查确认', 'warn'], synced: ['已同步', 'ok'], failed: ['同步失败', 'bad'], incomplete: ['资料待补齐', 'bad'] };
const KIND: Record<string, string> = { bundle_price_update: '同步基本售价', category_sync: '同步分类',  base_code_upsert: '上传基础编码', base_code_replace: '改码上传', base_code_disable: '停用旧编码', bundle_upsert: '上传组合', bundle_replace: '组合改码上传', bundle_disable: '停用组合', normal_product_upload: '商品资料上传' };
const FIELD: Record<string, string> = { sku_id: '商品编码', i_id: '款式编码', name: '名称', short_name: '简称', properties_value: '颜色及规格', c_name: '分类', brand: '品牌', unit: '单位', weight: '重量(kg)', cost_price: '成本价', purchase_price: '采购价', code: '组合编码', lines: '构成' };
const RECORD_STATUS: Record<string, string> = { pending: '待发送', sending: '发送中', done: '已完成', failed: '失败', cancelled: '已取消' };
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

/**
 * 同步清单：已验证的编码，对照上次真正上传的内容看差异、状态和同步记录。
 * 改码（现在的编码和聚水潭上已有的不同）必须先确认旧码已处理；所有操作都只是加入队列，不直接发送。
 */
export function JstSyncItems({ onQueued }: { onQueued: () => void }) {
  const { user, can } = useAuth();
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const [type, setType] = useState('finance-base-codes');
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [data, setData] = useState<{ total: number; rows: Item[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [ack, setAck] = useState<number[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [checked, setChecked] = useState(false);
  const [stateFilter, setStateFilter] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [summary, setSummary] = useState<{ total: number; counts: Record<string, number> } | null>(null);
  const kwq = keyword ? `&keyword=${encodeURIComponent(keyword)}` : '';
  const load = () => {
    void api<{ total: number; counts: Record<string, number> }>(`/finance/jst-sync/items/summary?type=${type}${kwq}`).then((r) => setSummary(r && r.counts ? r : null)).catch(() => setSummary(null));
    return api<{ total: number; rows: Item[] }>(`/finance/jst-sync/items?type=${type}&page=${page}&pageSize=20${kwq}${stateFilter ? `&state=${stateFilter}` : ''}`).then(setData).catch((e) => setError(msg(e)));
  };
  useEffect(() => { void load(); }, [type, page, keyword, stateFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  // 基础编码的同步只有公司管理员；组合装的同步维护是独立权限
  const canSync = type === 'finance-bundles' ? can('finance.bundle-sync.manage') : isAdmin;
  const eligible = (it: Item) => ['not_synced', 'failed'].includes(it.state) || it.diff.length > 0;
  const rows = data?.rows ?? [];
  const selectable = rows.filter(eligible).slice(0, 50);
  const allPicked = selectable.length > 0 && selectable.every((it) => picked.includes(it.id));
  const chosen = (data?.rows ?? []).filter((it) => picked.includes(it.id));
  const needAck = chosen.some((it) => it.replacing && !ack.includes(it.id));
  async function enqueue() {
    setError(''); setNotice('');
    try {
      const r = await jstApi.enqueue(type, chosen.map((it) => ({ id: it.id, signature: it.signature })), chosen.some((it) => it.replacing));
      setNotice(`加入队列 ${r.queued} 条，已在队列里 ${r.skipped} 条（只排队，不会立刻发送）`);
      setPicked([]); setChecked(false);
      await load(); onQueued();
    } catch (e) { setError(msg(e)); }
  }
  return (
    <section className="card">
      <h2>同步清单</h2>
      <div className="toolbar">
        <select aria-label="资料类型" value={type} onChange={(e) => { setType(e.target.value); setPage(1); setOpen(null); setPicked([]); setChecked(false); }}><option value="finance-base-codes">基础编码</option><option value="finance-bundles">商品组合</option></select>
        <input aria-label="搜索清单" placeholder="搜索编码或名称" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
        <select aria-label="同步状态" value={stateFilter} onChange={(e) => { setStateFilter(e.target.value); setPage(1); }}>
          <option value="">全部状态</option>
          {Object.entries(STATE).map(([k, [label]]) => <option key={k} value={k}>{label}{summary?.counts[k] ? `（${summary.counts[k]}）` : ''}</option>)}
        </select>
        {(keyword || stateFilter) && <button type="button" className="secondary-button small" onClick={() => { setKeyword(''); setStateFilter(''); setPage(1); }}>清除筛选</button>}
      </div>
      {summary && summary.total > 0 && <p className="muted" aria-label="状态汇总">共 {summary.total} 条已验证：{Object.entries(summary.counts).map(([k, n]) => `${STATE[k]?.[0] ?? k} ${n}`).join(' · ')}</p>}
      {error && <div role="alert" className="notice error">{error}</div>}
      {notice && <div role="status" className="notice ok">{notice}</div>}
      {canSync && picked.length > 0 && (
        <div className="notice">
          <strong>已选 {chosen.length} 条（一次最多 50 条）</strong>
          <div className="row-actions">
            <label className="check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> 我已核对这 {chosen.length} 条要上传的内容</label>
            <button type="button" className="primary-button" disabled={!checked || chosen.length === 0 || chosen.length > 50 || needAck} onClick={() => void enqueue()}>加入同步队列</button>
          </div>
        </div>
      )}
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th style={{ width: 28 }}>{canSync && selectable.length > 0 && <input type="checkbox" aria-label="全选本页可同步的" checked={allPicked} onChange={(e) => { setChecked(false); setPicked(e.target.checked ? [...new Set([...picked, ...selectable.map((it) => it.id)])].slice(0, 50) : picked.filter((id) => !selectable.some((it) => it.id === id))); }} />}</th><th>编码</th><th>名称</th><th>状态</th><th>和上次上传的差异</th><th>改码确认</th></tr></thead>
        <tbody>
          {data && rows.length === 0 && <tr><td colSpan={6} className="muted center">{stateFilter ? '没有这个状态的资料' : '没有已验证的资料'}</td></tr>}
          {rows.map((it) => (
            <Fragment key={it.id}>
              <tr>
                <td>{canSync && eligible(it) && <input type="checkbox" aria-label={`选择 ${it.code}`} checked={picked.includes(it.id)} disabled={!picked.includes(it.id) && picked.length >= 50} onChange={(e) => { setChecked(false); setPicked(e.target.checked ? [...picked, it.id] : picked.filter((x) => x !== it.id)); }} />}</td>
                <td><button type="button" className="link-button" onClick={() => setOpen(open === it.id ? null : it.id)}>{open === it.id ? '▾' : '▸'} {it.code}</button><CopyButton value={it.code} label="编码" /></td>
                <td>{it.name}</td>
                <td><span className={`pill ${STATE[it.state]?.[1] ?? 'warn'}`}>{STATE[it.state]?.[0] ?? it.state}</span></td>
                <td>{it.diff.length ? it.diff.map((d) => FIELD[d.field] ?? d.field).join('、') : it.uploaded ? '没有差异' : '还没上传过'}</td>
                <td>
                  {it.replacing && canSync && <label className="check"><input type="checkbox" checked={ack.includes(it.id)} onChange={(e) => setAck(e.target.checked ? [...ack, it.id] : ack.filter((x) => x !== it.id))} /> 已处理旧码「{it.uploadedCode}」的库存、在途订单、组合装及店铺映射，确认禁用旧编码并创建新编码</label>}
                </td>
              </tr>
              {open === it.id && (
                <tr><td colSpan={6}>
                  <div className="split-2">
                    <div><strong>现在要上传的内容</strong><table className="data-table"><tbody>{Object.entries(it.current).filter(([k]) => FIELD[k]).map(([k, v]) => <tr key={k}><th style={{ width: 110 }}>{FIELD[k]}</th><td>{show(v)}</td></tr>)}</tbody></table></div>
                    <div><strong>上次上传的内容</strong>{it.uploaded ? <table className="data-table"><tbody>{Object.entries(it.uploaded).filter(([k]) => FIELD[k]).map(([k, v]) => <tr key={k} className={it.diff.some((d) => d.field === k) ? 'selected' : undefined}><th style={{ width: 110 }}>{FIELD[k]}</th><td>{show(v)}</td></tr>)}</tbody></table> : <p className="muted">还没上传过</p>}</div>
                  </div>
                  <strong>同步记录</strong>
                  <table className="data-table"><thead><tr><th>时间</th><th>操作</th><th>结果</th><th>说明</th></tr></thead>
                    <tbody>{it.records.length === 0 && <tr><td colSpan={4} className="muted center">还没有记录</td></tr>}
                      {it.records.map((r) => <tr key={r.id}><td>{new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}</td><td>{KIND[r.kind] ?? r.kind}</td><td>{RECORD_STATUS[r.status] ?? r.status}（尝试 {r.attempts} 次）</td><td className="bad-text">{r.lastError}</td></tr>)}
                    </tbody></table>
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table></div>
      <Pager page={page} total={data?.total ?? 0} pageSize={20} onPage={setPage} />
    </section>
  );
}

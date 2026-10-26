import { Fragment, useEffect, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { Pager } from '../common';

interface Item {
  id: number; type: string; code: string; name: string; state: string; uploadedCode: string | null; replacing: boolean;
  current: Record<string, unknown>; uploaded: Record<string, unknown> | null; diff: Array<{ field: string; uploaded: unknown; current: unknown }>;
  records: Array<{ id: number; kind: string; status: string; attempts: number; lastError: string | null; createdAt: string; doneAt: string | null }>;
}
const STATE: Record<string, [string, string]> = { not_synced: ['未同步', 'warn'], queued: ['排队中', 'warn'], confirming: ['等待回查确认', 'warn'], synced: ['已同步', 'ok'], failed: ['同步失败', 'bad'], incomplete: ['资料待补齐', 'bad'] };
const KIND: Record<string, string> = { base_code_upsert: '上传基础编码', base_code_replace: '改码上传', base_code_disable: '停用旧编码', bundle_upsert: '上传组合', bundle_replace: '组合改码上传', bundle_disable: '停用组合', normal_product_upload: '商品资料上传' };
const FIELD: Record<string, string> = { sku_id: '商品编码', i_id: '款式编码', name: '名称', short_name: '简称', properties_value: '颜色及规格', c_name: '分类', brand: '品牌', unit: '单位', weight: '重量(kg)', cost_price: '成本价', purchase_price: '采购价', code: '组合编码', lines: '构成' };
const RECORD_STATUS: Record<string, string> = { pending: '待发送', sending: '发送中', done: '已完成', failed: '失败', cancelled: '已取消' };
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

/**
 * 同步清单：已验证的编码，对照上次真正上传的内容看差异、状态和同步记录。
 * 改码（现在的编码和聚水潭上已有的不同）必须先确认旧码已处理；所有操作都只是加入队列，不直接发送。
 */
export function JstSyncItems({ onQueued }: { onQueued: () => void }) {
  const { user } = useAuth();
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const [type, setType] = useState('finance-base-codes');
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [data, setData] = useState<{ total: number; rows: Item[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [ack, setAck] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => api<{ total: number; rows: Item[] }>(`/finance/jst-sync/items?type=${type}&page=${page}&pageSize=20${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ''}`).then(setData).catch((e) => setError(msg(e)));
  useEffect(() => { void load(); }, [type, page, keyword]); // eslint-disable-line react-hooks/exhaustive-deps
  async function enqueue(it: Item) {
    setError(''); setNotice('');
    try {
      const r = await api<{ queued: number; skipped: number }>('/finance/jst-sync/enqueue', { method: 'POST', body: { type, ids: [it.id], replaceConfirmed: ack.includes(it.id) } });
      setNotice(r.queued ? `「${it.code}」已加入队列（只排队，不会立刻发送）` : `「${it.code}」已经在队列里了`);
      await load(); onQueued();
    } catch (e) { setError(msg(e)); }
  }
  return (
    <section className="card">
      <h2>同步清单</h2>
      <div className="toolbar">
        <select aria-label="资料类型" value={type} onChange={(e) => { setType(e.target.value); setPage(1); setOpen(null); }}><option value="finance-base-codes">基础编码</option><option value="finance-bundles">商品组合</option></select>
        <input aria-label="搜索清单" placeholder="搜索编码或名称" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {notice && <div role="status" className="notice ok">{notice}</div>}
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>编码</th><th>名称</th><th>状态</th><th>和上次上传的差异</th><th /></tr></thead>
        <tbody>
          {data?.rows.length === 0 && <tr><td colSpan={5} className="muted center">没有已验证的资料</td></tr>}
          {data?.rows.map((it) => (
            <Fragment key={it.id}>
              <tr>
                <td><button type="button" className="link-button" onClick={() => setOpen(open === it.id ? null : it.id)}>{open === it.id ? '▾' : '▸'} {it.code}</button></td>
                <td>{it.name}</td>
                <td><span className={`pill ${STATE[it.state]?.[1] ?? 'warn'}`}>{STATE[it.state]?.[0] ?? it.state}</span></td>
                <td>{it.diff.length ? it.diff.map((d) => FIELD[d.field] ?? d.field).join('、') : it.uploaded ? '没有差异' : '还没上传过'}</td>
                <td>
                  {it.replacing && isAdmin && <label className="check"><input type="checkbox" checked={ack.includes(it.id)} onChange={(e) => setAck(e.target.checked ? [...ack, it.id] : ack.filter((x) => x !== it.id))} /> 已处理旧码「{it.uploadedCode}」的库存、在途订单、组合装及店铺映射，确认禁用旧编码并创建新编码</label>}
                  {isAdmin && (['not_synced', 'failed'].includes(it.state) || it.diff.length > 0) ? <button type="button" className="secondary-button small" disabled={it.replacing && !ack.includes(it.id)} onClick={() => void enqueue(it)}>{it.replacing ? '改码上传' : '加入队列'}</button> : null}
                </td>
              </tr>
              {open === it.id && (
                <tr><td colSpan={5}>
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

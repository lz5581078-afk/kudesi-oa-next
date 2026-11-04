import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../../auth/AuthContext';
import { useCostIdentityKey } from '../CostIdentityBoundary';
import { QueryTable, type Col } from '../query/QueryKit';
import { ReferenceSearch } from '../query/ReferenceSearch';
import { jstApi } from './jstApi';
import { JstUploadDialog } from './JstUploadDialog';
import { COVERAGE } from './jstUploadFields';
import './jstUpload.css';

type Logs = Awaited<ReturnType<typeof jstApi.uploadLogs>>;
const STATUS: Record<string, string> = { queued: '待发送', success: '成功', failed: '失败' };
export function JstUploadPage() {
  const identity = useCostIdentityKey();
  return <JstUploadWorkspace key={identity} />;
}
function JstUploadWorkspace() {
  const { user, can } = useAuth();
  const canUpload = !!user?.permissions.isCompanyAdmin && (can?.('product.cost.edit') ?? true);
  const [open, setOpen] = useState(false), [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState({ keyword: '', page: 1 });
  const [logs, setLogs] = useState<Logs | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true), request = useRef(0), currentQuery = useRef(query); currentQuery.current = query;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  const load = useCallback(async (next: typeof query) => {
    const ticket = ++request.current; setLoading(true); setError('');
    try { const result = await jstApi.uploadLogs({ page: next.page, keyword: next.keyword || undefined }); if (mounted.current && ticket === request.current) setLogs(result); }
    catch (failure) { if (mounted.current && ticket === request.current) setError((failure as Error).message || '上传记录读取失败'); }
    finally { if (mounted.current && ticket === request.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(query); }, [query, load]);
  const rows = logs?.rows ?? [];
  const columns: Col<Logs['rows'][number]>[] = [
    { key: 'skuId', head: '商品编码', cell: row => <strong>{row.skuId || '-'}</strong>, csv: row => row.skuId },
    { key: 'status', head: '状态', cell: row => <span className={`jst-upload-badge ${row.status}`}>{STATUS[row.status] ?? row.status}</span>, sortValue: row => row.status },
    { key: 'message', head: '提示信息', cell: row => row.message || '-', csv: row => row.message },
    { key: 'createdAt', head: '上传时间', cell: row => new Date(row.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), sortValue: row => row.createdAt },
  ];
  const coverageColumns: Col<string[]>[] = [
    { key: 'sheet', head: '模板页', cell: row => <strong>{row[0]}</strong>, csv: row => row[0] },
    { key: 'fields', head: '主要字段', cell: row => row[1], csv: row => row[1] },
    { key: 'coverage', head: 'API 覆盖判断', cell: row => row[2], csv: row => row[2] },
  ];
  return <div className="jst-maintenance-page">
    <section className="jst-maintenance-panel"><header><div><h2>聚水潭资料维护</h2><p>集中维护聚水潭商品、库存、仓位等基础资料；当前先开放商品资料上传能力。</p></div></header></section>
    <section className="jst-maintenance-panel"><header><div><h3>商品资料上传</h3><p>小板块：点击按钮填写商品资料并上传。主页面记录上传状态、提示信息和处理时间。</p></div><div className="row-actions"><button type="button" className="secondary-button" disabled={loading} onClick={() => void load(currentQuery.current)}>{loading ? '刷新中...' : '刷新记录'}</button>{canUpload && <button type="button" className="primary-button" onClick={() => setOpen(true)}>上传普通商品资料</button>}</div></header>
      <form className="jst-upload-search" onSubmit={event => { event.preventDefault(); const next = { keyword: keyword.trim(), page: 1 }; if (query.keyword === next.keyword && query.page === 1) void load(next); else setQuery(next); }}><ReferenceSearch label="搜索上传记录" value={keyword} onChange={setKeyword} placeholder="搜索商品编码或提示信息" /><button type="submit" className="secondary-button">搜索</button></form>
      {error && <div role="alert" className="jst-upload-message error">{error}</div>}
      {rows.length ? <QueryTable cols={columns} rows={rows} rowKey={row => row.id} caption="商品上传记录" empty="还没有普通商品资料上传记录。" foot={false} controls={{ storageKey: 'jst-maintenance.upload-logs', searchable: false, pageSize: 30 }} /> : <div className="jst-upload-empty"><span>{loading ? '正在加载上传记录...' : '还没有普通商品资料上传记录。'}</span></div>}
      <div className="jst-upload-pagination"><button type="button" className="secondary-button" disabled={loading || query.page <= 1} onClick={() => setQuery(value => ({ ...value, page: value.page - 1 }))}>上一页</button><span>第 {query.page} 页，共 {logs?.total ?? 0} 条</span><button type="button" className="secondary-button" disabled={loading || query.page * 30 >= (logs?.total ?? 0)} onClick={() => setQuery(value => ({ ...value, page: value.page + 1 }))}>下一页</button></div>
    </section>
    <section className="jst-maintenance-panel"><header><div><h3>导入模板字段对照</h3><p>根据你提供的“商品及库存管理-导入模板.xlsx”和实测结果整理。</p></div></header><QueryTable cols={coverageColumns} rows={COVERAGE} rowKey={row => row[0]} caption="导入模板字段对照" empty="" foot={false} controls={{ storageKey: 'jst-maintenance.template-coverage', searchable: false, pageSize: 30 }} /></section>
    {open && canUpload && <JstUploadDialog onClose={() => setOpen(false)} onQueued={() => { if (mounted.current) { const next = { ...currentQuery.current, page: 1 }; if (currentQuery.current.page === 1) void load(next); else setQuery(next); } }} />}
  </div>;
}

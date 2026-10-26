import { useCallback, useEffect, useMemo, useState } from 'react';
import { DOC_DIRECTION_LABEL, DOC_STATUS_LABEL, DOC_TYPES, DOC_TYPE_MAP, type DocType } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DocDetail } from './DocDetail';
import { DocForm } from './DocForm';
import { DOC_STATUS_TONE, Pager, money } from './common';
import { financeApi, type BatchResult, type DocList } from './financeApi';

const PAGE_SIZE = 20;

/**
 * 单据列表：草稿中心（对应管家婆〖业务草稿〗）、经营历程、以及制单页下面“最近的某种单据”共用。
 * 草稿中心：批量过账 / 批量复制 / 批量删除；经营历程：批量复制为草稿、财务审核状态；都能按制单人、单据类型、状态筛选。
 */
export function DocumentsPage({ scope, embedded }: { scope: 'drafts' | 'history' | DocType; embedded?: boolean }) {
  const { can, user } = useAuth();
  const def = DOC_TYPE_MAP.get(scope as DocType);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [docType, setDocType] = useState('');
  const [direction, setDirection] = useState('');
  const [mine, setMine] = useState(false);
  const [audited, setAudited] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DocList | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ title: string; r: BatchResult } | null>(null);

  useEffect(() => { setKeyword(''); setStatus(''); setDocType(''); setDirection(''); setMine(false); setAudited(''); setFrom(''); setTo(''); setPage(1); setSelected(null); setData(null); setChecked(new Set()); }, [scope]);
  const load = useCallback(() => {
    setError('');
    financeApi.docs({ scope, status, from, to, keyword, docType: docType || undefined, direction: direction || undefined, creatorId: mine ? user?.id : undefined, audited: audited || undefined, page }).then((d) => { setData(d); setChecked(new Set()); }).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [scope, status, from, to, keyword, docType, direction, mine, audited, page, user?.id]);
  useEffect(() => { load(); }, [load]);

  const isCenter = scope === 'drafts' || scope === 'history';
  const title = def?.label ?? (scope === 'drafts' ? '草稿中心' : '经营历程');
  const statuses = scope === 'drafts' ? ['draft', 'issued'] : scope === 'history' ? ['posted', 'reversed'] : ['draft', 'issued', 'posted', 'reversed'];
  const rows = data?.rows ?? [];
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  const toggle = (id: number) => setChecked((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const typeOptions = useMemo(() => DOC_TYPES.filter((d) => can(`finance.doc-${d.type}.view`) || d.type === 'withdrawal'), [can]);

  const batch = async (action: 'post' | 'delete' | 'copy', label: string) => {
    if (checked.size === 0) { setError('请先勾选单据'); return; }
    if (action === 'delete' && !window.confirm(`确定删除勾选的 ${checked.size} 张草稿吗？`)) return;
    setBusy(true); setError('');
    try {
      const r = await financeApi.batch(action, [...checked]);
      setResult({ title: `${label}：成功 ${r.okCount} 张，失败 ${r.failCount} 张`, r });
      load();
    } catch (e) { setError(e instanceof ApiError ? e.message : '操作失败'); } finally { setBusy(false); }
  };

  const cols = 9 + (isCenter ? 2 : 0) + (scope === 'history' ? 3 : 0);
  return (
    <div className={selected ? 'split' : undefined}>
      <div className="split-main">
        <div className="page-head between">
          {embedded ? <span /> : <h1>{title}</h1>}
          {def && !embedded && can('finance.docs.create') && <button type="button" className="primary-button" onClick={() => setCreating(true)}>+ 新建{def.label}</button>}
        </div>
        {scope === 'history' && data && (
          <div className="metric-row" aria-label="汇总">
            <div className="metric"><span className="muted">单据数量</span><strong>{data.total} 条</strong></div>
            <div className="metric"><span className="muted">收入合计</span><strong>{money(data.incomeCents ?? 0)}</strong></div>
            <div className="metric"><span className="muted">支出合计</span><strong>{money(data.expenseCents ?? 0)}</strong></div>
            <div className="metric"><span className="muted">净额</span><strong className={(data.incomeCents ?? 0) - (data.expenseCents ?? 0) < 0 ? 'neg' : ''}>{money((data.incomeCents ?? 0) - (data.expenseCents ?? 0))}</strong></div>
          </div>
        )}
        {scope === 'drafts' && data && (
          <div className="metric-row" aria-label="汇总">
            <div className="metric"><span className="muted">{scope === 'drafts' ? '待处理单据' : '已过账单据'}</span><strong>{data.total} 张</strong></div>
            <div className="metric"><span className="muted">单据金额合计</span><strong>{money(data.amountCents)}</strong></div>
            <div className="metric"><span className="muted">当场收付合计</span><strong>{money(data.paidCents)}</strong></div>
          </div>
        )}
        <div className="toolbar">
          <input className="search-box" type="search" aria-label="搜索单号或备注" placeholder="搜索单号、备注" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
          {isCenter && (
            <select aria-label="单据类型" value={docType} onChange={(e) => { setDocType(e.target.value); setPage(1); }}>
              <option value="">所有单据类型</option>
              {typeOptions.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}
            </select>
          )}
          {scope === 'history' && (
            <select aria-label="收支方向" value={direction} onChange={(e) => { setDirection(e.target.value); setPage(1); }}>
              <option value="">全部方向</option>
              {Object.entries(DOC_DIRECTION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          )}
          <select aria-label="状态" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">全部状态</option>
            {statuses.map((s) => <option key={s} value={s}>{DOC_STATUS_LABEL[s as keyof typeof DOC_STATUS_LABEL]}</option>)}
          </select>
          {scope === 'history' && (
            <select aria-label="财务审核" value={audited} onChange={(e) => { setAudited(e.target.value); setPage(1); }}>
              <option value="">财务审核：全部</option><option value="yes">已审核</option><option value="no">未审核</option>
            </select>
          )}
          {isCenter && <label className="check-line"><input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); setPage(1); }} />只看我制的单</label>}
          <input type="date" aria-label="开始日期" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
          <span className="muted">至</span>
          <input type="date" aria-label="结束日期" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
        </div>
        {isCenter && (
          <div className="toolbar" aria-label="批量操作">
            <span className="muted">已勾选 {checked.size} 张</span>
            {scope === 'drafts' && can('finance.docs.post') && <button type="button" className="primary-button small" disabled={busy || checked.size === 0} onClick={() => batch('post', '批量过账')}>批量过账</button>}
            {can('finance.docs.create') && <button type="button" className="secondary-button small" disabled={busy || checked.size === 0} onClick={() => batch('copy', scope === 'history' ? '批量复制为草稿' : '批量复制')}>{scope === 'history' ? '批量复制为草稿' : '批量复制'}</button>}
            {scope === 'drafts' && can('finance.docs.delete') && <button type="button" className="ghost-button danger-text" disabled={busy || checked.size === 0} onClick={() => batch('delete', '批量删除')}>批量删除</button>}
          </div>
        )}
        {error && <div role="alert" className="notice error">{error}</div>}
        {result && (
          <div role="status" className={`notice ${result.r.failCount ? 'warn' : 'ok'}`}>
            <div className="between"><strong>{result.title}</strong><button type="button" className="link-button" onClick={() => setResult(null)}>知道了</button></div>
            {result.r.results.filter((x) => !x.ok).map((x) => <div key={x.id}>{x.docNo}：{x.error}</div>)}
          </div>
        )}
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {isCenter && <th><input type="checkbox" aria-label="全选本页" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.id)))} /></th>}
                <th>单号</th>{!def && <th>类型</th>}<th>日期</th>{scope === 'history' && <th>方向</th>}<th>往来对象</th><th>金额</th><th>收付款账户</th><th>收付款金额</th><th>状态</th>{scope === 'history' && <th>财务审核</th>}<th>经办人</th><th>制单人</th>{scope === 'history' && <th>来源</th>}<th>备注</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.length === 0 && <tr><td colSpan={cols + 2} className="empty-state muted">没有单据</td></tr>}
              {rows.map((r) => (
                <tr key={r.id} className={selected === r.id ? 'selected' : undefined} onClick={() => setSelected(r.id)} style={{ cursor: 'pointer' }}>
                  {isCenter && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`勾选 ${r.docNo}`} checked={checked.has(r.id)} onChange={() => toggle(r.id)} /></td>}
                  <td className="mono"><button type="button" className="link-button" onClick={() => setSelected(r.id)}>{r.docNo}</button></td>
                  {!def && <td>{r.typeLabel}</td>}
                  <td>{r.docDate}</td>{scope === 'history' && <td>{DOC_DIRECTION_LABEL[r.direction ?? 'internal']}</td>}<td>{r.partyName ?? ''}</td>
                  <td className={`num ${r.amountCents < 0 ? 'neg' : ''}`}>{money(r.amountCents)}</td>
                  <td>{r.bankName ?? ''}</td><td className="num">{r.paidCents ? money(r.paidCents) : ''}</td>
                  <td><span className={`pill ${DOC_STATUS_TONE[r.status]}`}>{DOC_STATUS_LABEL[r.status]}</span></td>
                  {scope === 'history' && <td>{r.auditedAt ? <span className="pill ok">已审核</span> : <span className="muted">未审核</span>}</td>}
                  <td>{r.handler ?? ''}</td><td>{r.createdByName}</td>{scope === 'history' && <td>{r.source ?? ''}</td>}<td>{r.memo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && <Pager page={page} total={data.total} pageSize={PAGE_SIZE} onPage={setPage} />}
      </div>
      {selected && <DocDetail key={selected} id={selected} onClose={() => setSelected(null)} onChanged={load} />}
      {creating && def && <DocForm type={def.type} onClose={() => setCreating(false)} onSaved={(d) => { setCreating(false); setSelected(d.id); load(); }} />}
    </div>
  );
}

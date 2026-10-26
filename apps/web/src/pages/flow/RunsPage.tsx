import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RUN_STATUS_LABEL } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { Pager } from '../finance/common';
import { RunDetail } from './RunDetail';
import { RUN_TONE, flowApi, fmtTime, type RunList, type TemplateInfo } from './flowApi';

/** 我发起的 / 抄送我的 / 流程总览：同一张列表，只是范围不同（总览要流程总览权限，服务端把关）。 */
export function RunsPage({ view }: { view: 'started' | 'cc' | 'all' }) {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [keyword, setKeyword] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [page, setPage] = useState(1);
  const [list, setList] = useState<RunList | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [error, setError] = useState('');
  const open = Number(params.get('run')) || null;

  const load = useCallback(() => {
    flowApi.runs({ view, status, templateKey, keyword, overdue, page }).then(setList).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [view, status, templateKey, keyword, overdue, page]);
  useEffect(load, [load]);
  useEffect(() => { flowApi.templates().then(setTemplates).catch(() => undefined); }, []);
  const title = view === 'started' ? '我发起的' : view === 'cc' ? '抄送我的' : '流程总览';

  return (
    <div>
      <div className="page-head"><h1>{title}</h1></div>
      <div className="toolbar">
        <input placeholder="搜索标题" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
        <select value={templateKey} onChange={(e) => { setTemplateKey(e.target.value); setPage(1); }}>
          <option value="">全部类型</option>
          {templates.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">全部状态</option>
          {Object.entries(RUN_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="check-line"><input type="checkbox" checked={overdue} onChange={(e) => { setOverdue(e.target.checked); setPage(1); }} />只看已逾期</label>
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>标题</th><th>类型</th><th>发起人</th><th>状态</th><th>当前步骤</th><th>当前办理人</th><th>截止</th><th>发起时间</th></tr></thead>
        <tbody>
          {list?.rows.length === 0 && <tr><td colSpan={8} className="empty-state muted">没有流程</td></tr>}
          {list?.rows.map((r) => (
            <tr key={r.id}>
              <td><button type="button" className="link-button" onClick={() => setParams({ run: String(r.id) })}>{r.title}</button></td>
              <td>{r.templateLabel}</td><td>{r.requesterName}</td>
              <td><span className={`pill ${RUN_TONE[r.status] ?? ''}`}>{RUN_STATUS_LABEL[r.status as keyof typeof RUN_STATUS_LABEL]}</span></td>
              <td>{r.stepName ?? ''}</td><td>{r.handlers.join('、')}</td>
              <td>{r.dueAt && r.status === 'running' ? <span className={r.overdue ? 'pill bad' : ''}>{fmtTime(r.dueAt)}{r.overdue && ' 已逾期'}</span> : ''}</td>
              <td>{fmtTime(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {list && <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={setPage} />}
      {open && <RunDetail id={open} onClose={() => setParams({})} onChanged={load} />}
    </div>
  );
}

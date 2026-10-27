import { useEffect, useState } from 'react';
import { formatMinutes } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { designerApi, type DirectoryRow, type LedgerDto, type LedgerRow } from './designerApi';
import { fmtYuan, yuanToCents } from './designerUi';
import { fmtTime } from './flowApi';
import { TimeoutPolicyEditor } from './TimeoutPolicyEditor';
import './designer.css';

type Tab = 'default' | 'flow' | 'ledger';
const PENALTY_LABEL: Record<string, string> = { pending: '待确认', confirmed: '已确认', waived: '已免除' };
const INCIDENT_LABEL: Record<string, string> = { open: '超时中', closed: '已办完', cancelled: '已取消' };

/** 超时与处罚：公司默认规则、流程独立规则、超时事件与处罚台账。 */
export function TimeoutsPage() {
  const { can } = useAuth();
  const canManage = can('flow.templates.manage');
  const [tab, setTab] = useState<Tab>(() => { try { const v = localStorage.getItem('flow.timeouts.tab'); return v === 'flow' || v === 'ledger' ? v : 'default'; } catch { return 'default'; } });
  const [dirty, setDirty] = useState(false);
  const go = (t: Tab) => {
    if (t === tab) return;
    if (dirty && !window.confirm('规则有尚未保存的修改，切换会丢弃。确定切换吗？')) return;
    setDirty(false); setTab(t);
    try { localStorage.setItem('flow.timeouts.tab', t); } catch { /* 记不住就算了 */ }
  };
  return (
    <div>
      <div className="page-head"><h1>超时与处罚</h1></div>
      <div className="tabs" role="tablist">
        {([['default', '默认超时规则'], ['flow', '流程独立规则'], ['ledger', '超时与处罚台账']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" className={tab === k ? 'tab active' : 'tab'} onClick={() => go(k)}>{l}</button>
        ))}
      </div>
      <section className="card" style={{ padding: 16 }}>
        {tab === 'default' && <TimeoutPolicyEditor templateKey="" canManage={canManage} onDirty={setDirty} />}
        {tab === 'flow' && <FlowScope canManage={canManage} onDirty={setDirty} />}
        {tab === 'ledger' && <Ledger />}
      </section>
    </div>
  );
}

function FlowScope({ canManage, onDirty }: { canManage: boolean; onDirty: (d: boolean) => void }) {
  const [rows, setRows] = useState<DirectoryRow[]>([]);
  const [key, setKey] = useState('');
  useEffect(() => { designerApi.directory().then((d) => { setRows(d.templates); setKey((k) => k || d.templates[0]?.key || ''); }).catch(() => undefined); }, []);
  return (
    <div>
      <label>选择流程
        <select aria-label="选择流程" value={key} onChange={(e) => setKey(e.target.value)}>
          {rows.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
      </label>
      {key && <TimeoutPolicyEditor templateKey={key} canManage={canManage} onDirty={onDirty} />}
    </div>
  );
}

function Ledger() {
  const [data, setData] = useState<LedgerDto | null>(null);
  const [rows, setRows] = useState<DirectoryRow[]>([]);
  const [templateKey, setTemplateKey] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [err, setErr] = useState('');
  const [decide, setDecide] = useState<LedgerRow | null>(null);
  const [notice, setNotice] = useState('');
  const load = () => { setErr(''); return designerApi.ledger({ templateKey, status: status === 'all' ? undefined : status, page }).then(setData).catch((e) => setErr(e instanceof ApiError ? e.message : '加载失败')); };
  useEffect(() => { void load(); }, [templateKey, status, page]);
  useEffect(() => { designerApi.directory().then((d) => setRows(d.templates)).catch(() => undefined); }, []);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div>
      <div className="toolbar" style={{ padding: 0, border: 0 }}>
        <label>流程<select aria-label="按流程筛选" value={templateKey} onChange={(e) => { setTemplateKey(e.target.value); setPage(1); }}><option value="">全部流程</option>{rows.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
        <label>状态<select aria-label="按状态筛选" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="all">全部</option><option value="open">超时中</option><option value="pending">处罚待确认</option><option value="confirmed">处罚已确认</option><option value="waived">处罚已免除</option>
        </select></label>
        <button type="button" className="secondary-button" onClick={() => void load()}>刷新</button>
      </div>
      {notice && <div role="status" className="notice ok">{notice}</div>}
      {err && <div role="alert" className="notice error">{err} <button type="button" className="link-button" onClick={() => void load()}>重试</button></div>}
      {!data && !err && <p className="muted" role="status">正在加载台账…</p>}
      {data && data.rows.length === 0 && <div className="empty-state"><strong>还没有超时记录</strong><span className="muted">步骤超过处理时限后会自动记在这里；处罚需要先在规则里启用。</span></div>}
      {data && data.rows.length > 0 && (
        <div className="table-scroll"><table className="data-table compact">
          <thead><tr><th>事项</th><th>流程</th><th>办理人</th><th>时限</th><th>超时</th><th>通知</th><th>处罚</th><th>操作</th></tr></thead>
          <tbody>{data.rows.map((r) => (
            <tr key={r.id}>
              <td>{r.title}<div className="muted small">#{r.runId}</div></td>
              <td>{r.templateLabel}</td>
              <td>{r.assigneeName}{!r.soleOwner && <div className="muted small">共享收件，不计处罚</div>}</td>
              <td>{fmtTime(r.dueAt)}</td>
              <td><span className={`pill ${r.status === 'open' ? 'bad' : ''}`}>{INCIDENT_LABEL[r.status] ?? r.status}</span><div className="muted small">{formatMinutes(r.overdueMinutes)}</div></td>
              <td>{r.notifications.length === 0 ? <span className="muted">—</span> : r.notifications.map((n) => <div key={n.level} className={n.error ? 'late-text small' : 'small'}>{n.level === 'supervisor' ? '主管' : '老板'}：{n.error ?? '已通知'}</div>)}</td>
              <td>{r.penaltyId ? <><span className={`pill ${r.penaltyStatus === 'pending' ? 'warn' : r.penaltyStatus === 'confirmed' ? 'bad' : ''}`}>{PENALTY_LABEL[r.penaltyStatus ?? ''] ?? r.penaltyStatus}</span><div className="small">计算 {fmtYuan(r.calculatedCents)}{r.penaltyStatus !== 'pending' && <> · 实际 {fmtYuan(r.confirmedCents)}</>}</div>{r.penaltyReason && <div className="muted small">{r.penaltyReason}</div>}</> : <span className="muted">—</span>}</td>
              <td>{r.penaltyStatus === 'pending' && data.canDecide ? <button type="button" className="link-button" onClick={() => setDecide(r)}>确认/免除</button> : null}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {data && data.total > data.pageSize && (
        <div className="pager">
          <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="muted">第 {page} / {pages} 页，共 {data.total} 条</span>
          <button type="button" className="secondary-button" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
      {decide && <DecideDialog row={decide} onClose={() => setDecide(null)} onDone={(m) => { setDecide(null); setNotice(m); void load(); }} />}
    </div>
  );
}

function DecideDialog({ row, onClose, onDone }: { row: LedgerRow; onClose: () => void; onDone: (m: string) => void }) {
  const [status, setStatus] = useState<'confirmed' | 'waived'>('confirmed');
  const [amount, setAmount] = useState(String((row.calculatedCents ?? 0) / 100));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const cents = status === 'waived' ? 0 : yuanToCents(amount);
  const bad = !reason.trim() || (status === 'confirmed' && (cents === null || cents < 0 || cents > (row.calculatedCents ?? 0)));
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="处理处罚" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { await designerApi.decide(row.penaltyId!, { status, amountCents: cents ?? 0, reason: reason.trim(), revision: row.penaltyRevision ?? 0 }); onDone(status === 'waived' ? '处罚已免除' : '处罚已确认'); }
        catch (x) { setErr(x instanceof ApiError ? x.message : '操作失败'); } finally { setBusy(false); }
      }}>
        <div className="modal-head"><strong>处理处罚 · {row.assigneeName}</strong></div>
        <div className="modal-body">
          <p className="muted">{row.title}，超时 {formatMinutes(row.overdueMinutes)}，系统计算 {fmtYuan(row.calculatedCents)}。</p>
          {err && <div role="alert" className="notice error">{err}</div>}
          <label className="check-line"><input type="radio" name="d" checked={status === 'confirmed'} onChange={() => setStatus('confirmed')} />确认处罚</label>
          {status === 'confirmed' && <label>实际金额（元，不超过计算金额）<input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}
          <label className="check-line"><input type="radio" name="d" checked={status === 'waived'} onChange={() => setStatus('waived')} />免除</label>
          <label>原因（必填）<textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || bad}>提交</button></div>
      </form>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SEVERITY_LABEL, SUPERVISION_TARGET_LABEL, type SupervisionRuleDef } from '@kudesi/shared';
import { fmtTime } from '../flow/flowApi';
import { money } from '../finance/common';
import { errText } from './CaseParts';
import { serviceApi, type ExceptionRow, type LogRow, type SupervisionOverview } from './serviceApi';

const LEVEL = ['', 'L1 员工', 'L2 主管', 'L3 老板'];
const SOURCE: Record<string, string> = { after_sales: '售后', appeal: '申诉', flow: '流程', task: '任务', manual: '手工登记' };

/** 兜底监督：把超时的售后/申诉/流程待办/任务和手工登记的异常集中起来，按逾期时长升级给主管、老板，关闭要写原因。 */
export function SupervisionPage() {
  const [data, setData] = useState<SupervisionOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<ExceptionRow | null>(null);
  const [registering, setRegistering] = useState(false);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    serviceApi.supervision().then((d) => { setData(d); setError(''); }).catch((e) => setError(errText(e, '加载失败'))).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  async function scan() {
    setScanning(true); setNotice('');
    try {
      const r = await serviceApi.supScan();
      setNotice(`扫描完成：新登记 ${r.created} 条，升级 ${r.escalated} 条，自动解除 ${r.resolved} 条。`);
      load();
    } catch (e) { setError(errText(e, '扫描失败')); } finally { setScanning(false); }
  }
  const s = data?.summary;
  return (
    <div className="svc-page supervision-page">
      <div className="page-head">
        <div><h1>兜底监督</h1><p className="muted">每 5 分钟自动扫描一次：超时未办的售后、申诉、流程待办和任务会登记为异常，逾期越久级别越高（L1 员工、L2 主管、L3 老板）。</p></div>
        <div className="row-actions">
          {data && <span className="muted">数据时间 {fmtTime(data.asOf)}</span>}
          {data?.canManage && <button type="button" className="secondary-button" disabled={scanning} onClick={scan}>{scanning ? '扫描中…' : '立即扫描'}</button>}
          <button type="button" className="secondary-button" onClick={() => setRegistering(true)}>手工登记异常</button>
          <button type="button" className="secondary-button" disabled={loading} onClick={load}>{loading ? '刷新中…' : '刷新'}</button>
        </div>
      </div>
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      {notice && <div role="status" className="notice ok-notice toast-line"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>✕</button></div>}
      <div className="metric-row" aria-label="监督概况">
        <div className={`metric${s?.exceptions.open ? ' svc-metric-late' : ''}`}><span>未关闭异常</span><strong>{s?.exceptions.open ?? '—'}</strong><small className="muted">紧急 {s?.exceptions.urgent ?? 0} · 已升级 {s?.exceptions.escalated ?? 0}</small></div>
        <div className="metric"><span>售后在办 / 逾期</span><strong>{s ? `${s.afterSales.open} / ${s.afterSales.overdue}` : '—'}</strong><small className="muted">逾期金额 {s ? money(s.afterSales.overdueAmountCents) : '—'}</small></div>
        <div className="metric"><span>申诉在办 / 逾期</span><strong>{s ? `${s.appeals.open} / ${s.appeals.overdue}` : '—'}</strong><small className="muted">待提交平台 {s?.appeals.toSubmit ?? 0}</small></div>
        <div className="metric"><span>任务待办 / 逾期</span><strong>{s ? `${s.tasks.pending} / ${s.tasks.overdue}` : '—'}</strong><small className="muted">已完成 {s?.tasks.completed ?? 0}</small></div>
        <div className="metric"><span>流程进行中 / 超时</span><strong>{s ? `${s.flows.running} / ${s.flows.overdue}` : '—'}</strong></div>
      </div>

      <section className="card svc-section">
        <div className="card-head"><strong>待处理异常</strong><span className="muted">{data ? `${data.exceptions.length} 条` : ''}</span></div>
        <div className="table-scroll"><table className="data-table stack-mobile">
          <thead><tr><th>级别</th><th>异常</th><th>来源</th><th>责任人</th><th>应办时间</th><th>登记时间</th><th /></tr></thead>
          <tbody>
            {loading && !data && <tr><td colSpan={7} className="empty-state muted">正在加载…</td></tr>}
            {data?.exceptions.length === 0 && <tr><td colSpan={7} className="empty-state muted"><strong>没有未处理的异常</strong><span>超时的售后、申诉、流程待办和任务会自动出现在这里，也可以手工登记。</span></td></tr>}
            {data?.exceptions.map((x) => (
              <tr key={x.id} className={x.level >= 3 ? 'late' : undefined} aria-label={`异常 ${x.title}`}>
                <td data-label="级别"><span className={`pill ${x.severity === 'urgent' ? 'bad' : x.severity === 'important' ? 'warn' : ''}`}>{SEVERITY_LABEL[x.severity]}</span> <span className="sub-line">{LEVEL[x.level] ?? ''}</span></td>
                <td data-label="异常" className="cell-title"><button type="button" className="link-button" onClick={() => setView(x)}>{x.title}</button>{x.storeName && <span className="sub-line">{x.storeName}</span>}</td>
                <td data-label="来源">{SOURCE[x.sourceType] ?? x.sourceType}</td>
                <td data-label="责任人">{x.ownerName || '—'}</td>
                <td data-label="应办时间">{x.dueAt ? fmtTime(x.dueAt) : '—'}</td>
                <td data-label="登记时间">{fmtTime(x.createdAt)}</td>
                <td className="row-actions"><button type="button" className="secondary-button small" onClick={() => setView(x)}>处理</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      <div className="svc-cols">
        <section className="card svc-section">
          <div className="card-head"><strong>员工待办排行</strong><span className="muted">按逾期数排序</span></div>
          <div className="table-scroll"><table className="data-table stack-mobile">
            <thead><tr><th>员工</th><th className="num">待办</th><th className="num">逾期</th><th className="num">异常</th></tr></thead>
            <tbody>
              {data?.people.length === 0 && <tr><td colSpan={4} className="empty-state muted">没有待办记录</td></tr>}
              {data?.people.map((p) => <tr key={p.id}><td data-label="员工">{p.name}{p.title && <span className="sub-line">{p.title}</span>}{p.status !== 'active' && <span className="pill warn">已停用</span>}</td><td data-label="待办" className="num">{p.pending}</td><td data-label="逾期" className={`num${p.overdue ? ' late-text' : ''}`}>{p.overdue}</td><td data-label="异常" className="num">{p.exceptions}</td></tr>)}
            </tbody>
          </table></div>
        </section>
        <section className="card svc-section">
          <div className="card-head"><strong>无人负责提醒</strong><span className="muted">待办落在已停用/不存在的人身上</span></div>
          <ul className="svc-list">
            {data?.assignmentAlerts.length === 0 && <li className="muted">没有无人负责的待办。</li>}
            {data?.assignmentAlerts.map((a) => <li key={`${a.kind}${a.id}`}><strong>{a.title}</strong><span className="muted"> · 当前归属 {a.ownerName || '无人'}{a.dueAt ? ` · 应办 ${fmtTime(a.dueAt)}` : ''}</span>{a.runId && <> <Link to={`/workbench/started?run=${a.runId}`}>查看流程</Link></>}</li>)}
          </ul>
        </section>
      </div>

      <Rules rules={data?.rules ?? []} canManage={!!data?.canManage} onSaved={(t) => { setNotice(`已保存“${t}”的监督规则。`); load(); }} />

      <section className="card svc-section">
        <div className="card-head"><strong>已关闭异常</strong><span className="muted">最近 {data?.closed.length ?? 0} 条</span></div>
        <div className="table-scroll"><table className="data-table stack-mobile">
          <thead><tr><th>异常</th><th>来源</th><th>关闭原因</th><th>关闭人</th><th>关闭时间</th></tr></thead>
          <tbody>
            {data?.closed.length === 0 && <tr><td colSpan={5} className="empty-state muted">还没有关闭过的异常</td></tr>}
            {data?.closed.map((x) => <tr key={x.id}><td data-label="异常" className="cell-title"><button type="button" className="link-button" onClick={() => setView(x)}>{x.title}</button></td><td data-label="来源">{SOURCE[x.sourceType] ?? x.sourceType}</td><td data-label="关闭原因">{x.closeReason || '—'}</td><td data-label="关闭人">{x.closedByName || '系统'}</td><td data-label="关闭时间">{x.closedAt ? fmtTime(x.closedAt) : '—'}</td></tr>)}
          </tbody>
        </table></div>
      </section>

      {view && <ExceptionModal x={view} onClose={() => setView(null)} onChanged={load} />}
      {registering && <RegisterModal onClose={() => setRegistering(false)} onDone={() => { setRegistering(false); setNotice('已登记异常。'); load(); }} />}
    </div>
  );
}

function ExceptionModal({ x, onClose, onChanged }: { x: ExceptionRow; onClose: () => void; onChanged: () => void }) {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isOpen = x.status === 'open';
  const load = useCallback(() => { serviceApi.supDetail(x.id).then((d) => setLogs(d.logs)).catch((e) => setError(errText(e, '加载失败'))); }, [x.id]);
  useEffect(load, [load]);
  async function follow() {
    if (!note.trim()) return setError('请写跟进内容');
    setBusy(true); setError('');
    try { await serviceApi.supFollow(x.id, note.trim()); setNote(''); load(); } catch (e) { setError(errText(e, '保存失败')); } finally { setBusy(false); }
  }
  async function close() {
    if (!reason.trim()) return setError('关闭异常必须写原因');
    setBusy(true); setError('');
    try { await serviceApi.supClose(x.id, reason.trim()); onChanged(); onClose(); } catch (e) { setError(errText(e, '关闭失败')); } finally { setBusy(false); }
  }
  const link = x.sourceType === 'after_sales' && x.sourceId ? `/after-sales/table?case=${x.sourceId}` : x.sourceType === 'appeal' && x.sourceId ? `/after-sales/appeals?store=all&appeal=${x.sourceId}` : x.runId ? `/workbench/started?run=${x.runId}` : null;
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="异常详情" style={{ width: 'min(720px, 100%)' }}>
        <div className="modal-head between"><div><strong>{x.title}</strong> <span className="pill">{SEVERITY_LABEL[x.severity]}</span> <span className="pill">{LEVEL[x.level]}</span></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <dl className="kv-grid">
            <div><dt>来源</dt><dd>{SOURCE[x.sourceType] ?? x.sourceType}</dd></div>
            <div><dt>责任人</dt><dd>{x.ownerName || '—'}</dd></div>
            <div><dt>店铺</dt><dd>{x.storeName || '—'}</dd></div>
            <div><dt>状态</dt><dd>{isOpen ? '未关闭' : `已关闭${x.closeReason ? `：${x.closeReason}` : ''}`}</dd></div>
            {x.detail && <div className="wide"><dt>说明</dt><dd>{x.detail}</dd></div>}
          </dl>
          {link && <p><Link to={link}>打开源头记录</Link></p>}
          <h3 className="section-title">跟进记录</h3>
          <ul className="svc-list">{logs.length === 0 && <li className="muted">还没有跟进记录。</li>}{logs.map((l) => <li key={l.id}><strong>{l.userName}</strong> <span className="muted">{fmtTime(l.createdAt)}</span><div>{l.content}</div></li>)}</ul>
          {isOpen && (
            <div className="svc-follow">
              <textarea aria-label="跟进内容" rows={2} maxLength={500} placeholder="写下处理进展" value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="button" className="secondary-button" disabled={busy} onClick={follow}>添加跟进</button>
            </div>
          )}
          {isOpen && closing && <label className="wide"><span>关闭原因<b className="req"> *</b></span><textarea aria-label="关闭原因" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          {isOpen && x.canClose && (closing ? <button type="button" className="primary-button" disabled={busy} onClick={close}>确认关闭</button> : <button type="button" className="primary-button" onClick={() => setClosing(true)}>关闭异常</button>)}
        </div>
      </div>
    </div>
  );
}

function RegisterModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [severity, setSeverity] = useState('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    if (!title.trim()) return setError('请写异常标题');
    setBusy(true); setError('');
    try { await serviceApi.supRegister({ title: title.trim(), detail: detail.trim() || undefined, severity }); onDone(); } catch (e) { setError(errText(e, '登记失败')); } finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card" role="dialog" aria-label="手工登记异常" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="modal-head between"><strong>手工登记异常</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-grid">
            <label className="wide"><span>异常标题<b className="req"> *</b></span><input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label>
            <label><span>严重程度</span><select value={severity} onChange={(e) => setSeverity(e.target.value)}>{Object.entries(SEVERITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="wide"><span>说明</span><textarea rows={3} maxLength={1000} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
          </div>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '登记中…' : '登记'}</button></div>
      </form>
    </div>
  );
}

function Rules({ rules, canManage, onSaved }: { rules: SupervisionRuleDef[]; canManage: boolean; onSaved: (name: string) => void }) {
  const [editing, setEditing] = useState<SupervisionRuleDef | null>(null);
  return (
    <section className="card svc-section">
      <div className="card-head"><strong>监督规则</strong><span className="muted">{canManage ? '可修改' : '只读（修改需要监督管理权限）'}</span></div>
      <div className="table-scroll"><table className="data-table stack-mobile">
        <thead><tr><th>对象</th><th>异常条件</th><th className="num">逾期登记（分钟）</th><th className="num">主管可见（分钟）</th><th className="num">老板可见（分钟）</th><th>关闭须写原因</th><th>状态</th>{canManage && <th />}</tr></thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.targetType}>
              <td data-label="对象" className="cell-title">{r.name}<span className="sub-line">{SUPERVISION_TARGET_LABEL[r.targetType]}</span></td>
              <td data-label="异常条件">{r.abnormalCondition}</td>
              <td data-label="逾期登记" className="num">{r.overdueMinutes}</td><td data-label="主管可见" className="num">{r.supervisorVisibleMinutes}</td><td data-label="老板可见" className="num">{r.bossVisibleMinutes}</td>
              <td data-label="关闭须写原因">{r.closeRequiresReason ? '是' : '否'}</td>
              <td data-label="状态">{r.status === 'active' ? <span className="pill ok">启用</span> : <span className="pill">停用</span>}</td>
              {canManage && <td className="row-actions"><button type="button" className="secondary-button small" onClick={() => setEditing(r)}>编辑</button></td>}
            </tr>
          ))}
        </tbody>
      </table></div>
      {editing && <RuleForm rule={editing} onClose={() => setEditing(null)} onSaved={() => { onSaved(editing.name); setEditing(null); }} />}
    </section>
  );
}

function RuleForm({ rule, onClose, onSaved }: { rule: SupervisionRuleDef; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ overdueMinutes: String(rule.overdueMinutes), supervisorVisibleMinutes: String(rule.supervisorVisibleMinutes), bossVisibleMinutes: String(rule.bossVisibleMinutes), abnormalCondition: rule.abnormalCondition, closeRequiresReason: rule.closeRequiresReason, status: rule.status });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    const nums = [f.overdueMinutes, f.supervisorVisibleMinutes, f.bossVisibleMinutes].map((v) => Number(v));
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) return setError('分钟数请填不小于 0 的整数');
    if (nums[2] < nums[1]) return setError('老板可见时间不能早于主管可见时间');
    setBusy(true); setError('');
    try { await serviceApi.supSaveRule(rule.targetType, { overdueMinutes: nums[0], supervisorVisibleMinutes: nums[1], bossVisibleMinutes: nums[2], abnormalCondition: f.abnormalCondition, closeRequiresReason: f.closeRequiresReason, status: f.status }); onSaved(); } catch (e) { setError(errText(e, '保存失败')); } finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card" role="dialog" aria-label="编辑监督规则" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="modal-head between"><strong>编辑规则：{rule.name}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-grid">
            <label><span>逾期多少分钟登记</span><input inputMode="numeric" value={f.overdueMinutes} onChange={(e) => setF({ ...f, overdueMinutes: e.target.value })} /></label>
            <label><span>主管可见（分钟）</span><input inputMode="numeric" value={f.supervisorVisibleMinutes} onChange={(e) => setF({ ...f, supervisorVisibleMinutes: e.target.value })} /></label>
            <label><span>老板可见（分钟）</span><input inputMode="numeric" value={f.bossVisibleMinutes} onChange={(e) => setF({ ...f, bossVisibleMinutes: e.target.value })} /></label>
            <label><span>状态</span><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as 'active' | 'inactive' })}><option value="active">启用</option><option value="inactive">停用</option></select></label>
            <label className="wide"><span>异常条件说明</span><input value={f.abnormalCondition} maxLength={200} onChange={(e) => setF({ ...f, abnormalCondition: e.target.value })} /></label>
            <label className="check"><input type="checkbox" checked={f.closeRequiresReason} onChange={(e) => setF({ ...f, closeRequiresReason: e.target.checked })} /> 关闭异常必须写原因</label>
          </div>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div>
      </form>
    </div>
  );
}

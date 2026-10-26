import { useCallback, useEffect, useState } from 'react';
import type { CompanyApplicationDto } from '@kudesi/shared';
import { api } from '../../api/client';
import { fmtDateTime } from './format';

const STATUS: Record<CompanyApplicationDto['status'], string> = { pending: '待审核', approved: '已开通', rejected: '已驳回' };

export function ApplicationsPage() {
  const [rows, setRows] = useState<CompanyApplicationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<CompanyApplicationDto | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api<CompanyApplicationDto[]>('/platform/company-applications'));
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : '读取失败' });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (row: CompanyApplicationDto, action: () => Promise<string>) => {
    setBusyId(row.id);
    setMessage(null);
    try {
      setMessage({ kind: 'ok', text: await action() });
      await load();
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : '操作失败' });
    } finally {
      setBusyId(null);
    }
  };

  const approve = (row: CompanyApplicationDto) =>
    run(row, async () => {
      const r = await api<{ companyName: string; adminAccount: string }>(`/platform/company-applications/${row.id}/approve`, { method: 'POST', body: {} });
      return `已开通：${r.companyName}，企业管理员账号：${r.adminAccount}`;
    });

  const reject = async () => {
    if (!rejecting) return;
    const row = rejecting;
    await run(row, async () => {
      await api(`/platform/company-applications/${row.id}/reject`, { method: 'POST', body: { reason } });
      setRejecting(null);
      setReason('');
      return `已驳回：${row.companyName}`;
    });
  };

  const pending = rows.filter((r) => r.status === 'pending').length;
  return (
    <>
      <div className="page-head">
        <h1>企业申请审核</h1>
        <div className="toolbar-inline">
          <span className="muted-text">待审核 {pending} · 共 {rows.length} 份</span>
          <button type="button" className="secondary-button" onClick={() => void load()}>刷新</button>
        </div>
      </div>
      {message && <div role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'notice error' : 'notice'}>{message.text}</div>}
      <div className="card table-scroll">
        <table className="data-table">
          <thead>
            <tr><th>申请公司</th><th>联系人</th><th>管理员账号</th><th>申请说明</th><th>申请时间</th><th>状态</th><th>处理结果</th><th>操作</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.companyName}</td>
                <td>{r.contactName}{r.contactTitle ? `（${r.contactTitle}）` : ''}</td>
                <td>{r.contactPhone}</td>
                <td title={r.remark ?? ''}>{r.remark ?? '-'}</td>
                <td>{fmtDateTime(r.createdAt)}</td>
                <td>{STATUS[r.status]}</td>
                <td>
                  {r.status === 'approved' && `${r.approvedCompanyName ?? '-'} · ${fmtDateTime(r.reviewedAt)}`}
                  {r.status === 'rejected' && `${r.rejectReason ?? ''} · ${r.reviewedByName ?? ''}`}
                  {r.status === 'pending' && '-'}
                </td>
                <td>
                  {r.status === 'pending' ? (
                    <span className="toolbar-inline">
                      <button type="button" className="primary-button" disabled={busyId === r.id} onClick={() => void approve(r)}>通过并开通</button>
                      <button type="button" className="secondary-button danger" disabled={busyId === r.id} onClick={() => { setRejecting(r); setReason(''); }}>驳回</button>
                    </span>
                  ) : <span className="muted-text">已处理</span>}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && <tr><td colSpan={8} className="muted-text">还没有企业申请</td></tr>}
            {loading && <tr><td colSpan={8} className="muted-text">正在读取…</td></tr>}
          </tbody>
        </table>
      </div>
      {rejecting && (
        <div className="modal-backdrop">
          <div className="card modal small" role="dialog" aria-modal="true" aria-label="驳回申请">
            <div className="modal-head"><strong>驳回：{rejecting.companyName}</strong></div>
            <div className="modal-body">
              <label>驳回原因<textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} placeholder="会保留在申请记录里" /></label>
            </div>
            <div className="modal-foot">
              <button type="button" className="secondary-button" onClick={() => setRejecting(null)}>取消</button>
              <button type="button" className="primary-button" disabled={!reason.trim() || busyId === rejecting.id} onClick={() => void reject()}>确认驳回</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

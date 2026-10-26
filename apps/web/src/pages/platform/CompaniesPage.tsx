import { useCallback, useEffect, useState } from 'react';
import type { PlatformCompanyDto } from '@kudesi/shared';
import { api } from '../../api/client';
import { fmtDateTime } from './format';

export function CompaniesPage() {
  const [rows, setRows] = useState<PlatformCompanyDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api<PlatformCompanyDto[]>('/platform/companies'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (row: PlatformCompanyDto) => {
    const next = row.status === 'active' ? 'suspended' : 'active';
    if (next === 'suspended' && !window.confirm(`停用「${row.name}」后，该公司所有员工立即无法登录。确定停用吗？`)) return;
    setBusyId(row.id);
    setError(null);
    try {
      await api(`/platform/companies/${row.id}/status`, { method: 'POST', body: { status: next } });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>企业管理</h1>
        <button type="button" className="secondary-button" onClick={() => void load()}>刷新</button>
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="card table-scroll">
        <table className="data-table">
          <thead>
            <tr><th>公司</th><th>企业管理员账号</th><th>员工数</th><th>开通时间</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.adminAccounts.join('、') || '-'}</td>
                <td>{r.userCount}</td>
                <td>{fmtDateTime(r.createdAt)}</td>
                <td>{r.status === 'active' ? '正常' : '已停用'}</td>
                <td>
                  <button type="button" className={r.status === 'active' ? 'secondary-button danger' : 'secondary-button'} disabled={busyId === r.id} onClick={() => void toggle(r)}>
                    {r.status === 'active' ? '停用' : '恢复'}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && <tr><td colSpan={6} className="muted-text">还没有公司</td></tr>}
            {loading && <tr><td colSpan={6} className="muted-text">正在读取…</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

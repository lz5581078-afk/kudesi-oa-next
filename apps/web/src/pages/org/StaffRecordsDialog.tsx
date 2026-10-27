import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { orgApi, type CompRecord, type StaffDto, type StaffRecords } from './orgApi';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : '操作失败');
const yuan = (cents: number) => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN') : '—');

type TabKey = 'hr' | 'groups' | 'salary' | 'payroll' | 'reward' | 'penalty' | 'tasks' | 'flows' | 'handover';

const SOURCE: Record<string, string> = { manual: '手动加入', position: '岗位自动', import: '导入' };
const HR_ACTION: Record<string, string> = {
  'user.create': '创建账号', 'user.update': '修改档案', 'user.disable': '停用', 'user.enable': '启用', 'user.handover': '工作交接',
  'user.reset_password': '重置密码', 'user.overrides': '调整个人权限',
};

function CompTable({ rows, empty }: { rows: CompRecord[]; empty: string }) {
  if (rows.length === 0) return <p className="muted pad">{empty}</p>;
  return (
    <table className="data-table">
      <thead><tr><th>事项</th><th>金额（元）</th><th>生效/所属期</th><th>说明</th><th>操作人</th><th>时间</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}><td>{r.title}</td><td>{yuan(r.amount)}</td><td>{r.effectiveDate ?? r.payPeriod ?? '—'}</td><td>{r.reason ?? '—'}</td><td>{r.actorName ?? '—'}</td><td>{when(r.createdAt)}</td></tr>
      ))}</tbody>
    </table>
  );
}

/** 员工的人员记录：人事记录、薪资变更、工资发放、奖励、处罚、任务、流程、交接；也可以在这里手动交接。 */
export function StaffRecordsDialog({ staff, all, canHandover, canSalary, onClose }: { staff: StaffDto; all: StaffDto[]; canHandover: boolean; canSalary: boolean; onClose: () => void }) {
  const [data, setData] = useState<StaffRecords | null>(null);
  const [tab, setTab] = useState<TabKey>('hr');
  const [error, setError] = useState('');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => orgApi.staffRecords(staff.id).then((d) => { setData(d); setError(''); }).catch((e) => setError(errText(e)));
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff.id]);

  async function handover() {
    setNotice(''); setError('');
    try {
      const r = await orgApi.handover(staff.id, { ...(target ? { targetUserId: Number(target) } : {}), reason: reason.trim() || undefined });
      setNotice(`已交给 ${r.toUserName}：待办 ${r.workItems}、流程节点 ${r.flowSteps}、周期任务 ${r.routines}`);
      await load();
    } catch (e) { setError(errText(e)); }
  }

  const tabs: Array<[TabKey, string]> = [
    ['hr', '人事记录'], ['groups', '职责组'], ...(canSalary ? ([['salary', '薪资变更'], ['payroll', '工资发放'], ['reward', '奖励'], ['penalty', '处罚']] as Array<[TabKey, string]>) : []),
    ['tasks', '任务'], ['flows', '流程'], ['handover', '交接'],
  ];
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card wide" role="dialog" aria-label={`${staff.name}的人员记录`}>
        <div className="modal-head"><strong>人员记录：{staff.name}</strong></div>
        <div className="modal-body">
          <div className="tabs" role="tablist">
            {tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{label}</button>)}
          </div>
          {error && <div role="alert" className="notice error">{error}</div>}
          {!data && !error && <p className="muted pad">加载中…</p>}
          {data && tab === 'hr' && (data.hrLogs.length === 0 ? <p className="muted pad">暂无人事记录</p> : (
            <table className="data-table"><thead><tr><th>时间</th><th>事项</th><th>操作人</th></tr></thead>
              <tbody>{data.hrLogs.map((l) => <tr key={l.id}><td>{when(l.createdAt)}</td><td>{HR_ACTION[l.action] ?? l.action}</td><td>{l.actorName ?? '—'}</td></tr>)}</tbody></table>
          ))}
          {data && tab === 'groups' && (data.dutyGroups.length === 0 ? <p className="muted pad">还没有加入任何职责组（在“资料 → 职责组 → 成员”里维护）</p> : (
            <table className="data-table"><thead><tr><th>职责组</th><th>组内角色</th><th>来源</th><th>加入</th><th>退出</th><th>状态</th></tr></thead>
              <tbody>{data.dutyGroups.map((g) => <tr key={g.id}><td>{g.groupName}</td><td>{g.role ?? '—'}</td><td>{SOURCE[g.source] ?? g.source}</td><td>{g.startedAt ?? '—'}</td><td>{g.endedAt ?? '—'}</td><td>{g.status === 'exited' ? '已退出' : '在组'}</td></tr>)}</tbody></table>
          ))}
          {data && tab === 'salary' && <CompTable rows={data.salaryChanges} empty="暂无薪资变更" />}
          {data && tab === 'payroll' && <CompTable rows={data.payrollRecords} empty="暂无工资发放记录" />}
          {data && tab === 'reward' && <CompTable rows={data.rewardRecords} empty="暂无奖励记录" />}
          {data && tab === 'penalty' && <CompTable rows={data.penaltyRecords} empty="暂无处罚记录" />}
          {data && tab === 'tasks' && (data.tasks.length === 0 ? <p className="muted pad">暂无任务</p> : (
            <table className="data-table"><thead><tr><th>任务</th><th>状态</th><th>负责人</th><th>创建人</th><th>截止</th></tr></thead>
              <tbody>{data.tasks.map((t) => <tr key={t.id}><td>{t.title}</td><td>{t.status}</td><td>{t.assigneeName ?? '—'}</td><td>{t.createdByName ?? '—'}</td><td>{when(t.dueAt)}</td></tr>)}</tbody></table>
          ))}
          {data && tab === 'flows' && (data.flows.length === 0 ? <p className="muted pad">暂无流程记录</p> : (
            <table className="data-table"><thead><tr><th>流程/节点</th><th>类型</th><th>状态</th><th>时间</th></tr></thead>
              <tbody>{data.flows.map((f) => <tr key={f.id}><td>{f.title}</td><td>{f.kind}</td><td>{f.action ?? f.status}</td><td>{when(f.createdAt)}</td></tr>)}</tbody></table>
          ))}
          {data && tab === 'handover' && (
            <div>
              {canHandover && staff.status === 'active' && (
                <div className="toolbar">
                  <select aria-label="接收人" value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">（自动：直属上级或同岗位同事）</option>
                    {all.filter((x) => x.status === 'active' && x.id !== staff.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  <input aria-label="交接原因" placeholder="交接原因（选填）" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button type="button" className="secondary-button" onClick={() => void handover()}>把手上的工作交接出去</button>
                </div>
              )}
              {notice && <div className="notice">{notice}</div>}
              {data.handovers.length === 0 ? <p className="muted pad">暂无交接记录</p> : (
                <table className="data-table"><thead><tr><th>时间</th><th>交出</th><th>接收</th><th>内容</th><th>原因</th><th>操作人</th></tr></thead>
                  <tbody>{data.handovers.map((h) => <tr key={h.id}><td>{when(h.createdAt)}</td><td>{h.fromName ?? '—'}</td><td>{h.toName ?? '—'}</td><td>待办 {h.workItems} / 流程 {h.flowSteps} / 周期 {h.routines}</td><td>{h.reason ?? '—'}</td><td>{h.actorName ?? '—'}</td></tr>)}</tbody></table>
              )}
            </div>
          )}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
      </div>
    </div>
  );
}

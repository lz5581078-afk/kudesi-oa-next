import { useEffect, useState } from 'react';
import type { CatalogGroup, DeskAccessPlan } from '@kudesi/shared';
import { orgApi } from './orgApi';
import { errText } from './OrgDialogs';

export function DeskAccessDialog({ catalog, onClose, onApplied }: { catalog: CatalogGroup[]; onClose: () => void; onApplied: () => void }) {
  const [plan, setPlan] = useState<DeskAccessPlan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const labels = new Map(catalog.flatMap((g) => g.items.map((i) => [i.key, i.label] as const)));
  useEffect(() => { let active = true; orgApi.deskAccessPreview().then((p) => { if (active) setPlan(p); }).catch((e) => { if (active) setError(errText(e)); }); return () => { active = false; }; }, []);
  async function apply() {
    if (!plan || !accepted || busy || done) return;
    setBusy(true); setError('');
    try { await orgApi.applyDeskAccess(plan.fingerprint); setDone(true); onApplied(); }
    catch (e) { setError(errText(e)); setAccepted(false); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation"><section className="modal card" role="dialog" aria-label="按岗位配置功能权限" style={{ width: 'min(1000px, calc(100vw - 32px))' }}>
    <div className="modal-head"><strong>按岗位工作台配置功能权限</strong></div>
    <div className="modal-body">
      {done ? <p role="status">配置已保存。员工刷新页面后按主岗位及兼岗使用对应功能，具体办理权限仍由流程决定。</p> : <>
        <p>岗位决定能进入的功能；新增、修改、审核和过账等动作仍由流程节点及办理人规则决定，不批量开放全局操作权限。</p>
        {!plan && !error && <p role="status">正在生成调整预览…</p>}
        {plan && <>
          <p><strong>{plan.companyName}</strong>：调整 {plan.changedPositions} 个岗位；清除 {plan.changedStaff} 名员工的个人额外授权或拒绝，改按主岗、兼岗继承。</p>
          <p>人事部及其下级部门、相关员工与兼任岗位的原权限保留。公司管理员身份、停用员工和未分配岗位员工的个人权限保留。</p>
          <div className="table-wrap"><table className="data-table"><thead><tr><th>部门 / 岗位</th><th>权限数量</th><th>功能 / 变化</th></tr></thead><tbody>
            {plan.positions.map((p) => <tr key={p.id}><td>{p.departmentName}<br /><strong>{p.name}</strong></td><td>{p.before.length} → {p.after.length}{p.preserved && <span>（保留）</span>}</td><td>{p.preserved ? '原权限不变' : <details><summary>查看功能及调整明细</summary><p>{p.pages.join('、')}</p><p>增加：{p.added.map((k) => labels.get(k) ?? k).join('、') || '无'}</p><p>移除：{p.removed.map((k) => labels.get(k) ?? k).join('、') || '无'}</p></details>}</td></tr>)}
          </tbody></table></div>
          <details><summary>查看个人权限调整名单</summary><ul>{plan.staff.map((u) => <li key={u.id}>{u.name}：{u.reason}{!u.preserved && `（清除 ${u.before.length} 项）`}</li>)}</ul></details>
          <label className="check"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />我已核对岗位与个人权限调整，人事部原授权保持不变</label>
        </>}
      </>}
      {error && <p role="alert" className="notice error">{error}。请关闭后重新预览。</p>}
    </div>
    <div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{done ? '完成' : '取消'}</button>{!done && <button type="button" className="primary-button" disabled={!plan || !accepted || busy || !!error} onClick={apply}>{busy ? '正在保存…' : '确认按预览配置'}</button>}</div>
  </section></div>;
}

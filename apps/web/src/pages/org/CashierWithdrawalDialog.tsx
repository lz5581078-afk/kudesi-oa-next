import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import type { DeskAccessPlan } from '@kudesi/shared';
import { orgApi } from './orgApi';
import { errText } from './OrgDialogs';

export function CashierWithdrawalDialog({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const [plan, setPlan] = useState<DeskAccessPlan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let active = true;
    orgApi.cashierPreview().then((p) => { if (active) setPlan(p); }).catch((e) => { if (active) setError(errText(e)); });
    return () => { active = false; };
  }, []);
  async function apply() {
    if (!plan || busy || done || error) return;
    setBusy(true);
    try { await orgApi.applyCashier(plan.fingerprint); setDone(true); onApplied(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }
  return createPortal(<div className="modal-backdrop"><section className="modal card" role="dialog" aria-modal="true" aria-label="补齐出纳提现权限">
    <div className="modal-head"><strong>补齐出纳提现权限</strong></div>
    <div className="modal-body">
      {error && <p role="alert" className="notice error">{error}，请关闭后重新预览。</p>}
      {done ? <p role="status">已补齐岗位权限。出纳刷新页面后生效；个人限制仍然保留。</p> : <>
        <p>给当前公司的有效出纳岗位增加店铺提现入口、店铺登录管理和受控远程协助。保留原岗位权限及员工个人拒绝，不修改其他岗位。</p>
        {!plan && !error && <p role="status">正在读取岗位…</p>}
        {plan && <><strong>{plan.companyName}</strong>
          <ul>{plan.positions.map((p) => <li key={p.id}>{p.name}：{p.added.length ? `增加 ${p.added.length} 项` : '权限已齐全'}</li>)}</ul>
          {!plan.positions.length && <p>当前公司没有岗位类型为“出纳”的启用岗位。</p>}
        </>}
      </>}
    </div>
    <div className="modal-foot">
      <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{done ? '完成' : '取消'}</button>
      {!done && <button type="button" className="primary-button" disabled={!plan?.changedPositions || busy || !!error} onClick={() => void apply()}>{busy ? '保存中…' : '确认补齐出纳权限'}</button>}
    </div>
  </section></div>, document.body);
}

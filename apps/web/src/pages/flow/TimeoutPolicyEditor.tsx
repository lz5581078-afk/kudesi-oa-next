import { useEffect, useState } from 'react';
import { PENALTY_MODE_LABEL, type TimeoutNotifications, type TimeoutPenalty, type TimeoutPolicy } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { loadRefOptions } from '../../resources/RecordForm';
import { designerApi, type PolicyDto } from './designerApi';
import { centsToYuan, yuanToCents } from './designerUi';

type Opt = { value: number; label: string };


/**
 * 超时规则编辑：公司默认 / 某个流程 / 某个节点。流程和节点层每一段可以“沿用上一层”，不沿用才填自己的。
 * 金额界面用元，保存成整数分。保存带版本号：别人先改了会提示重新读取。
 */
export function TimeoutPolicyEditor({ templateKey, nodeKey = '', canManage, onDirty }: { templateKey: string; nodeKey?: string; canManage: boolean; onDirty?: (d: boolean) => void }) {
  const [dto, setDto] = useState<PolicyDto | null>(null);
  const [draft, setDraft] = useState<Partial<TimeoutPolicy>>({});
  const [users, setUsers] = useState<Opt[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const isDefault = templateKey === '';

  const load = () => designerApi.policy(templateKey, nodeKey).then((d) => { setDto(d); setDraft(JSON.parse(JSON.stringify(d.policy))); }).catch((e) => setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '加载失败' }));
  useEffect(() => { setMsg(null); setDto(null); void load(); }, [templateKey, nodeKey]);
  useEffect(() => { loadRefOptions('user').then(setUsers).catch(() => undefined); }, []);
  const dirty = !!dto && JSON.stringify(draft) !== JSON.stringify(dto.policy);
  useEffect(() => { onDirty?.(dirty); }, [dirty]);

  if (!dto) return <p className="muted" role="status">{msg ? msg.text : '正在加载超时规则…'}</p>;
  const editable = canManage && dto.canManage;
  const scopeName = isDefault ? '公司默认' : nodeKey ? '节点独立' : '流程独立';
  const inherited = dto.inherited;
  const n = draft.notifications;
  const p = draft.penalties;
  const setN = (patch: Partial<TimeoutNotifications>) => setDraft((d) => ({ ...d, notifications: { ...(d.notifications ?? inherited.policy.notifications), ...patch } }));
  const setP = (patch: Partial<TimeoutPenalty>) => setDraft((d) => ({ ...d, penalties: { ...(d.penalties ?? inherited.policy.penalties), ...patch } }));
  const sel = (id: number | null) => (id ? String(id) : '');

  async function save() {
    setBusy(true); setMsg(null);
    try { await designerApi.savePolicy(templateKey, nodeKey, draft, dto!.revision); setMsg({ kind: 'ok', text: `${scopeName}超时规则已保存，新产生的超时事件按新规则处理` }); await load(); }
    catch (e) { setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '保存失败' }); }
    finally { setBusy(false); }
  }

  return (
    <div className="fd-policy">
      {msg && <div role={msg.kind === 'error' ? 'alert' : 'status'} className={`notice ${msg.kind}`}>{msg.text}</div>}
      <p className="muted">
        规则分三层：公司默认 → 流程独立 → 节点独立，后面的覆盖前面的（通知和处罚各管各的）。当前编辑：<strong>{scopeName}</strong>。
        {!isDefault && ' 选“沿用”表示这一段用上一层的规则。'}
      </p>

      <fieldset className="fd-section">
        <legend>通知规则（超时后通知主管和老板）</legend>
        {!isDefault && (
          <label className="check-line"><input type="checkbox" disabled={!editable} checked={n == null} onChange={(e) => setDraft((d) => ({ ...d, notifications: e.target.checked ? null : { ...inherited.policy.notifications } }))} />沿用上一层（{inherited.sources.notifications}）</label>
        )}
        {n != null && (
          <div className="form-grid">
            <label className="check-line"><input type="checkbox" disabled={!editable} checked={n.enabled} onChange={(e) => setN({ enabled: e.target.checked })} />启用超时通知</label>
            <label>超时多少分钟通知主管<input type="number" min={1} disabled={!editable} value={n.supervisorAfterMinutes} onChange={(e) => setN({ supervisorAfterMinutes: Number(e.target.value) })} /></label>
            <label>主管接收人
              <select disabled={!editable} value={n.supervisorReceiver} onChange={(e) => setN({ supervisorReceiver: e.target.value as TimeoutNotifications['supervisorReceiver'] })}>
                <option value="manager">办理人的上级（没有则部门主管）</option>
                <option value="employee">指定员工</option>
              </select>
            </label>
            {n.supervisorReceiver === 'employee' && (
              <label>指定主管<select aria-label="指定主管" disabled={!editable} value={sel(n.supervisorUserId)} onChange={(e) => setN({ supervisorUserId: e.target.value ? Number(e.target.value) : null })}><option value="">（请选择）</option>{users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select></label>
            )}
            <label>超时多少分钟通知老板<input type="number" min={1} disabled={!editable} value={n.bossAfterMinutes} onChange={(e) => setN({ bossAfterMinutes: Number(e.target.value) })} /></label>
            <label>老板接收人
              <select disabled={!editable} value={n.bossReceiver} onChange={(e) => setN({ bossReceiver: e.target.value as TimeoutNotifications['bossReceiver'] })}>
                <option value="admins">公司管理员</option>
                <option value="employee">指定员工</option>
              </select>
            </label>
            {n.bossReceiver === 'employee' && (
              <label>指定老板<select aria-label="指定老板" disabled={!editable} value={sel(n.bossUserId)} onChange={(e) => setN({ bossUserId: e.target.value ? Number(e.target.value) : null })}><option value="">（请选择）</option>{users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select></label>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="fd-section">
        <legend>处罚规则（只对有明确个人办理人的步骤计算，计算结果要人工确认）</legend>
        {!isDefault && (
          <label className="check-line"><input type="checkbox" disabled={!editable} checked={p == null} onChange={(e) => setDraft((d) => ({ ...d, penalties: e.target.checked ? null : { ...inherited.policy.penalties } }))} />沿用上一层（{inherited.sources.penalties}）</label>
        )}
        {p != null && (
          <div className="form-grid">
            <label className="check-line"><input type="checkbox" disabled={!editable} checked={p.enabled} onChange={(e) => setP({ enabled: e.target.checked })} />启用超时处罚</label>
            <label>处罚方式
              <select disabled={!editable} value={p.mode} onChange={(e) => setP({ mode: e.target.value as TimeoutPenalty['mode'] })}>
                {(Object.keys(PENALTY_MODE_LABEL) as Array<TimeoutPenalty['mode']>).map((m) => <option key={m} value={m}>{PENALTY_MODE_LABEL[m]}</option>)}
              </select>
            </label>
            <label>计次单位
              <select disabled={!editable} value={p.unit} onChange={(e) => setP({ unit: e.target.value as TimeoutPenalty['unit'] })}>
                <option value="task">每条待办一次</option>
                <option value="node">每个步骤一次（同一步骤多次办理只计一次）</option>
              </select>
            </label>
            {p.mode !== 'tiers' && (
              <>
                <label>超时多少分钟起罚<input type="number" min={1} disabled={!editable} value={p.afterMinutes} onChange={(e) => setP({ afterMinutes: Number(e.target.value) })} /></label>
                <label>首次金额（元）<input type="number" min={0} step="0.01" disabled={!editable} value={centsToYuan(p.amountCents)} onChange={(e) => setP({ amountCents: yuanToCents(e.target.value) ?? 0 })} /></label>
              </>
            )}
            {p.mode === 'repeat' && (
              <>
                <label>每隔多少分钟累计<input type="number" min={1} disabled={!editable} value={p.repeatMinutes} onChange={(e) => setP({ repeatMinutes: Number(e.target.value) })} /></label>
                <label>每次累计金额（元）<input type="number" min={0} step="0.01" disabled={!editable} value={centsToYuan(p.repeatAmountCents)} onChange={(e) => setP({ repeatAmountCents: yuanToCents(e.target.value) ?? 0 })} /></label>
              </>
            )}
            <label>封顶金额（元，空=不封顶）<input type="number" min={0} step="0.01" disabled={!editable} value={centsToYuan(p.capCents)} onChange={(e) => setP({ capCents: yuanToCents(e.target.value) })} /></label>
            {p.mode === 'tiers' && (
              <div className="wide fd-tiers">
                <strong>分档（超时达到阈值就按该档金额，金额不能随超时减少，最多 10 档）</strong>
                {p.tiers.map((t, i) => (
                  <div key={i} className="row-actions">
                    <label>超时（分钟）<input type="number" min={1} disabled={!editable} value={t.afterMinutes} onChange={(e) => setP({ tiers: p.tiers.map((x, j) => (j === i ? { ...x, afterMinutes: Number(e.target.value) } : x)) })} /></label>
                    <label>金额（元）<input type="number" min={0} step="0.01" disabled={!editable} value={centsToYuan(t.amountCents)} onChange={(e) => setP({ tiers: p.tiers.map((x, j) => (j === i ? { ...x, amountCents: yuanToCents(e.target.value) ?? 0 } : x)) })} /></label>
                    {editable && <button type="button" className="link-button danger" onClick={() => setP({ tiers: p.tiers.filter((_, j) => j !== i) })}>删除这一档</button>}
                  </div>
                ))}
                {editable && p.tiers.length < 10 && <button type="button" className="secondary-button" onClick={() => setP({ tiers: [...p.tiers, { afterMinutes: (p.tiers.at(-1)?.afterMinutes ?? 0) + 30, amountCents: p.tiers.at(-1)?.amountCents ?? 0 }] })}>添加一档</button>}
              </div>
            )}
          </div>
        )}
      </fieldset>

      {editable ? (
        <div className="row-actions">
          {dirty && <span className="muted">有未保存的修改</span>}
          <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => { setDraft(JSON.parse(JSON.stringify(dto.policy))); setMsg(null); }}>放弃修改</button>
          <button type="button" className="primary-button" disabled={busy || !dirty} onClick={save}>保存超时规则</button>
        </div>
      ) : <p className="muted">你没有“保存并发布流程配置”的权限，只能查看。</p>}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { ASSIGNEE_SOURCE_LABEL, STEP_TYPE_LABEL, getFlowTemplate, validateSteps, type AssigneeSource, type StepDef } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { loadRefOptions } from '../../resources/RecordForm';
import { flattenDepartments, orgApi } from '../org/orgApi';
import { flowApi, fmtTime, type DefinitionDto, type TemplateInfo } from './flowApi';

type Opt = { value: number; label: string };

/** 流程配置：每种流程配置办理人、时限、抄送、超时升级对象。保存是草稿，发布后新发起的流程才按新配置走（在办的流程不受影响）。 */
export function TemplatesPage() {
  const { can } = useAuth();
  const canManage = can('flow.templates.manage');
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [key, setKey] = useState('');
  const [def, setDef] = useState<DefinitionDto | null>(null);
  const [steps, setSteps] = useState<StepDef[]>([]);
  const [esc, setEsc] = useState<number[]>([]);
  const [users, setUsers] = useState<Opt[]>([]);
  const [positions, setPositions] = useState<Opt[]>([]);
  const [depts, setDepts] = useState<Opt[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    flowApi.templates().then((t) => { setTemplates(t); if (t[0]) setKey(t[0].key); }).catch((e) => setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '加载失败' }));
    loadRefOptions('user').then(setUsers).catch(() => undefined);
    orgApi.positions().then((p) => setPositions(p.map((x) => ({ value: x.id, label: x.name })))).catch(() => undefined);
    orgApi.departments().then((d) => setDepts(flattenDepartments(d).map((x) => ({ value: x.id, label: `${'　'.repeat(x.depth)}${x.name}` })))).catch(() => undefined);
  }, []);
  const load = (k: string) => flowApi.definition(k).then((d) => { setDef(d); setSteps(d.draft.steps); setEsc(d.draft.escalateUserIds); }).catch((e) => setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '加载失败' }));
  useEffect(() => { if (key) void load(key); }, [key]);

  const setStep = (i: number, patch: Partial<StepDef>) => setSteps((cur) => cur.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const optsFor = (src: AssigneeSource) => (src === 'employee' ? users : src === 'position' ? positions : depts);
  const handlers = steps.filter((s) => s.type !== 'submit' && s.type !== 'end');
  const dirty = !!def && (JSON.stringify(steps) !== JSON.stringify(def.draft.steps) || JSON.stringify([...esc].sort()) !== JSON.stringify([...def.draft.escalateUserIds].sort()));
  // 发布前检查：和服务端同一套规则，办理人没选、时限不合法等在这里就能看到
  const issues = useMemo(() => {
    const tpl = getFlowTemplate(key);
    return tpl && steps.length ? validateSteps(tpl, steps, esc) : [];
  }, [key, steps, esc]);
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const switchTo = (k: string) => {
    if (k === key) return;
    if (dirty && !window.confirm('当前流程有尚未保存的修改，切换会丢弃。确定切换吗？')) return;
    setMsg(null);
    setKey(k);
  };

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); await load(key); }
    catch (e) { setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '操作失败' }); }
    finally { setBusy(false); }
  }
  const save = () => flowApi.saveDraft(key, steps, esc);

  return (
    <div>
      <div className="page-head"><h1>流程配置</h1></div>
      <div className="tabs">
        {templates.map((t) => <button key={t.key} type="button" className={key === t.key ? 'tab active' : 'tab'} onClick={() => switchTo(t.key)}>{t.label}{t.active ? '' : '（未启用）'}</button>)}
      </div>
      {msg && <div role={msg.kind === 'error' ? 'alert' : 'status'} className={`notice ${msg.kind}`}>{msg.text}</div>}
      {def && (
        <section className="card" style={{ padding: 16 }}>
          <p className="muted">{def.template.description}</p>
          <p className="muted">
            当前启用版本：{def.active ? `v${def.active.version}` : '无（不能发起）'}；正在编辑草稿 v{def.draft.version}。
            办理人规则：指定员工/岗位必须解析到恰好 1 名在职员工；指定部门则部门里任一人办理即可；永远不会兜底给管理员。
          </p>
          {steps.map((s, i) => (
            <div key={s.key} className="step-edit">
              <div><strong>{i + 1}. {s.name}</strong><div className="muted">{STEP_TYPE_LABEL[s.type]}</div></div>
              {handlers.includes(s) ? (
                <>
                  <label>办理人类型
                    <select disabled={!canManage} value={s.assignee?.source ?? 'employee'} onChange={(e) => setStep(i, { assignee: { source: e.target.value as AssigneeSource, id: undefined } })}>
                      {(['employee', 'position', 'department'] as const).map((k) => <option key={k} value={k}>{ASSIGNEE_SOURCE_LABEL[k]}</option>)}
                    </select>
                  </label>
                  <label>具体对象
                    <select disabled={!canManage} value={s.assignee?.id ?? ''} onChange={(e) => setStep(i, { assignee: { source: s.assignee?.source ?? 'employee', id: e.target.value ? Number(e.target.value) : undefined } })}>
                      <option value="">（请选择）</option>
                      {optsFor(s.assignee?.source ?? 'employee').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                  <label>时限（小时，空=不限）
                    <input disabled={!canManage} type="number" min={1} value={s.dueMinutes ? s.dueMinutes / 60 : ''} onChange={(e) => setStep(i, { dueMinutes: e.target.value ? Math.round(Number(e.target.value) * 60) : null })} />
                  </label>
                  <label style={{ gridColumn: '1 / -1' }}>抄送（进入这一步时通知，可多选）
                    <select multiple disabled={!canManage} value={(s.ccUserIds ?? []).map(String)} onChange={(e) => setStep(i, { ccUserIds: [...e.target.selectedOptions].map((o) => Number(o.value)) })}>
                      {users.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                </>
              ) : <div className="muted" style={{ gridColumn: '2 / -1' }}>{s.type === 'submit' ? '由发起人填写提交' : '所有步骤办完后自动结束'}</div>}
            </div>
          ))}
          <label style={{ display: 'block', marginTop: 12 }}>超时升级对象（步骤逾期时额外通知，可多选）
            <select multiple disabled={!canManage} value={esc.map(String)} onChange={(e) => setEsc([...e.target.selectedOptions].map((o) => Number(o.value)))} style={{ width: '100%', minHeight: 64 }}>
              {users.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          {issues.length > 0 && (
            <div className="notice warn" role="status"><strong>发布前还要处理 {issues.length} 项：</strong><ul>{issues.map((t) => <li key={t}>{t}</li>)}</ul></div>
          )}
          {canManage ? (
            <div className="row-actions">
              {dirty && <span className="muted">有未保存的修改</span>}
              <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => { setSteps(def.draft.steps); setEsc(def.draft.escalateUserIds); setMsg(null); }}>放弃修改</button>
              <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => run(save, '草稿已保存')}>保存草稿</button>
              <button type="button" className="primary-button" disabled={busy || issues.length > 0} title={issues.length ? '先处理上面的检查项' : undefined} onClick={() => run(async () => { await save(); await flowApi.publish(key); }, '已发布，新发起的流程按新配置办理')}>保存并发布</button>
            </div>
          ) : <p className="muted">你没有“保存并发布流程配置”的权限，只能查看。</p>}
          <h3 className="section-title">流转一览</h3>
          <div className="table-scroll"><table className="data-table compact">
            <thead><tr><th>步骤</th><th>类型</th><th>办理人</th><th>时限</th><th>抄送</th></tr></thead>
            <tbody>{steps.map((s, i) => (
              <tr key={s.key}>
                <td>{i + 1}. {s.name}</td><td>{STEP_TYPE_LABEL[s.type]}</td>
                <td>{s.type === 'submit' ? '发起人' : s.type === 'end' ? '—' : s.assignee?.id ? (optsFor(s.assignee.source).find((o) => o.value === s.assignee!.id)?.label ?? `${ASSIGNEE_SOURCE_LABEL[s.assignee.source]} #${s.assignee.id}`) : <span className="late-text">未选择</span>}</td>
                <td>{s.dueMinutes ? `${s.dueMinutes / 60} 小时` : '不限'}</td>
                <td>{(s.ccUserIds ?? []).map((id) => users.find((u) => u.value === id)?.label ?? `#${id}`).join('、') || '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="muted">办理中遇到问题时，办理人可以“退回上一步”；发起人可撤回；管理员可转交他人。</p>
          <h3 className="section-title">版本记录</h3>
          <ul>{def.history.map((h) => <li key={h.version}>v{h.version} · {h.status === 'active' ? '启用中' : h.status === 'draft' ? '草稿' : '已停用'}{h.publishedAt && ` · ${fmtTime(h.publishedAt)}`}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

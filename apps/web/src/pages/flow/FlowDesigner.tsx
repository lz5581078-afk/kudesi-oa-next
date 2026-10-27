import { useEffect, useMemo, useState } from 'react';
import { getFlowTemplate, validateCustomTemplate, validateSteps, formatMinutes, STEP_TYPE_LABEL, type FieldDef, type FlowPostingDecl, type FlowTemplate, type StepDef } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { loadRefOptions } from '../../resources/RecordForm';
import { flattenDepartments, orgApi } from '../org/orgApi';
import { designerApi, type DesignerDefinition, type DesignerSchema, type NodeTemplateDto } from './designerApi';
import { describeAssignee, describeCondition, describeRemind, insertStepAfter, moveStep, newApprovalStep, sanitizeRefs, stepFromNodeTemplate, uniqueKey } from './designerUi';
import { DesignerCanvas } from './DesignerCanvas';
import { Confirm } from './FlowDirectory';
import { FormFieldsEditor } from './FormFieldsEditor';
import { NodeEditor, type Lookups } from './NodeEditor';
import { PostingEditor } from './PostingEditor';
import { fmtTime } from './flowApi';
import { TimeoutPolicyEditor } from './TimeoutPolicyEditor';
import './designer.css';

type Tab = 'design' | 'form' | 'check' | 'timeout';
type Msg = { kind: 'ok' | 'error'; text: string } | null;
const STATUS_LABEL: Record<string, string> = { active: '启用中', draft: '草稿', retired: '已停用' };

/**
 * 流程详情与设计器：①流程设计（画布/列表 + 节点设置）②申请表单（自建流程可改）③检查与启用（版本记录）④超时与处罚。
 * 保存是草稿；发布后新发起的申请按新版本走，在办的流程用启动时的版本，不受影响。
 */
export function FlowDesigner({ flowKey, onBack, onOpen }: { flowKey: string; onBack: () => void; onOpen: (key: string) => void }) {
  const { can } = useAuth();
  const canManage = can('flow.templates.manage');
  const [def, setDef] = useState<DesignerDefinition | null>(null);
  const [steps, setSteps] = useState<StepDef[]>([]);
  const [esc, setEsc] = useState<number[]>([]);
  const [schema, setSchema] = useState<DesignerSchema | null>(null);
  const [sel, setSel] = useState(1);
  const [tab, setTab] = useState<Tab>('design');
  const [mode, setMode] = useState<'canvas' | 'list'>(() => { try { return localStorage.getItem('flow.designer.mode') === 'list' ? 'list' : 'canvas'; } catch { return 'canvas'; } });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [lookups, setLookups] = useState<Lookups>({ users: [], positions: [], depts: [], groups: [] });
  const [dialog, setDialog] = useState<'copy' | 'stop' | 'delete' | 'meta' | 'discard' | { activate: number } | { remove: number } | { pick: number } | null>(null);
  const [nodes, setNodes] = useState<NodeTemplateDto[]>([]);
  const [timeoutDirty, setTimeoutDirty] = useState(false);
  const [nodeScope, setNodeScope] = useState('');

  const custom = !!def?.template.custom;
  const load = () => designerApi.definition(flowKey).then((d) => {
    setDef(d); setSteps(d.draft.steps); setEsc(d.draft.escalateUserIds);
    setSchema(d.template.custom ? (d.draft.schema ?? { fields: [], stepFields: {}, posting: null }) : null);
    setSel((s) => Math.min(Math.max(1, s), Math.max(0, d.draft.steps.length - 1)));
  }).catch((e) => setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '加载失败' }));
  useEffect(() => { setDef(null); setMsg(null); setTab('design'); void load(); }, [flowKey]);
  useEffect(() => {
    loadRefOptions('user').then((users) => setLookups((l) => ({ ...l, users }))).catch(() => undefined);
    loadRefOptions('duty-groups').then((groups) => setLookups((l) => ({ ...l, groups }))).catch(() => undefined);
    orgApi.positions().then((p) => setLookups((l) => ({ ...l, positions: p.map((x) => ({ value: x.id, label: x.name })) }))).catch(() => undefined);
    orgApi.departments().then((d) => setLookups((l) => ({ ...l, depts: flattenDepartments(d).map((x) => ({ value: x.id, label: `${'　'.repeat(x.depth)}${x.name}` })) }))).catch(() => undefined);
    designerApi.nodesForDesigner().then((n) => setNodes(n.templates)).catch(() => undefined);
  }, []);

  const lookup = (s: 'employee' | 'position' | 'department' | 'duty_group', id: number) => (s === 'employee' ? lookups.users : s === 'position' ? lookups.positions : s === 'duty_group' ? lookups.groups : lookups.depts).find((o) => o.value === id)?.label.trim();
  const tpl: FlowTemplate | null = useMemo(() => {
    if (!def) return null;
    if (!def.template.custom) { const b = getFlowTemplate(flowKey); return b ?? null; }
    return { key: flowKey, label: def.template.label, description: def.template.description, custom: true, fields: schema?.fields ?? [], stepFields: schema?.stepFields ?? {}, steps: [], ...(schema?.posting ? { posting: schema.posting } : {}) };
  }, [def, schema, flowKey]);
  const issues = useMemo(() => (tpl && steps.length ? (tpl.custom ? validateCustomTemplate(tpl, steps, esc) : validateSteps(tpl, steps, esc)) : []), [tpl, steps, esc]);
  const unresolved = steps.filter((s) => s.type !== 'submit' && s.type !== 'end' && ['employee', 'position', 'department', 'duty_group'].includes(s.assignee?.source ?? '') && !s.assignee?.id);
  const dirty = !!def && (JSON.stringify(steps) !== JSON.stringify(def.draft.steps) || JSON.stringify([...esc].sort()) !== JSON.stringify([...def.draft.escalateUserIds].sort()) || (custom && JSON.stringify(schema) !== JSON.stringify(def.draft.schema)));
  useEffect(() => {
    if (!dirty && !timeoutDirty) return undefined;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, timeoutDirty]);

  const leaveOk = () => !(dirty || timeoutDirty) || window.confirm('当前流程有尚未保存的修改，离开会丢弃。确定离开吗？');
  const goTab = (t: Tab) => { if (t === tab) return; if (tab === 'timeout' && timeoutDirty && !window.confirm('超时规则有尚未保存的修改，切换会丢弃。确定切换吗？')) return; setTimeoutDirty(false); setTab(t); };
  const patchStep = (i: number, patch: Partial<StepDef>) => setSteps((cur) => cur.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const setStepFields = (key: string, fields: FieldDef[]) => setSchema((sc) => (sc ? { ...sc, stepFields: { ...sc.stepFields, [key]: fields } } : sc));
  const canMoveFn = (from: number, to: number) => !!moveStep(steps, from, to);
  const doMove = (from: number, to: number) => {
    const next = moveStep(steps, from, to);
    if (!next) return;
    const r = sanitizeRefs(next);
    setSteps(r.steps); setSel(to);
    if (r.notes.length) setMsg({ kind: 'ok', text: r.notes.join('；') });
  };
  const insertAt = (after: number, s: StepDef, fields?: FieldDef[]) => {
    setSteps((cur) => insertStepAfter(cur, after, s));
    if (fields && custom && fields.length) setStepFields(s.key, fields.map((f) => ({ ...f, group: s.name })));
    setSel(Math.min(after + 1, steps.length - 1));
  };
  const copyStep = (i: number) => {
    const s = steps[i];
    const key = uniqueKey(steps.map((x) => x.key), 'step');
    const copy: StepDef = { ...s, key, name: `${s.name}（副本）`.slice(0, 40), locked: undefined, ccUserIds: [...(s.ccUserIds ?? [])] };
    insertAt(i, copy, schema?.stepFields[s.key]);
  };
  const removeStep = (i: number) => {
    const key = steps[i].key;
    const r = sanitizeRefs(steps.filter((_, j) => j !== i));
    setSteps(r.steps);
    setSchema((sc) => { if (!sc) return sc; const { [key]: _gone, ...rest } = sc.stepFields; return { ...sc, stepFields: rest, posting: sc.posting?.at === key ? null : sc.posting }; });
    setSel(Math.max(1, Math.min(i, r.steps.length - 2)));
    setMsg({ kind: 'ok', text: ['已删除节点，别忘了保存', ...r.notes].join('；') });
  };

  async function run(fn: () => Promise<unknown>, ok: string, after?: () => void) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); await load(); after?.(); }
    catch (e) { setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : '操作失败' }); }
    finally { setBusy(false); }
  }
  const save = () => designerApi.saveDraft(flowKey, steps, esc, custom ? schema : null);

  if (!def || !tpl) return <div><button type="button" className="link-button" onClick={onBack}>← 返回流程列表</button>{msg ? <div role="alert" className="notice error">{msg.text}</div> : <p className="muted" role="status">正在加载流程…</p>}</div>;
  const isActive = !!def.active;
  const hasHistory = def.history.some((h) => h.status !== 'draft');
  const current = steps[sel];
  const fullIssues = [...issues, ...unresolved.map((s) => `「${s.name}」还没有选择具体的办理人`).filter((t) => !issues.some((x) => x.includes(t.slice(1, 4))))];

  return (
    <div className="fd-designer">
      <nav className="fd-crumb"><button type="button" className="link-button" onClick={() => { if (leaveOk()) onBack(); }}>← 返回流程列表</button><span className="muted"> / {def.template.custom ? '自建流程' : '内置业务流程'} / </span><strong>{def.template.label}</strong></nav>
      <div className="page-head">
        <div>
          <h1>{def.template.label}</h1>
          <span className="muted">{def.template.description || '（没有说明）'}</span>
        </div>
        <div className="row-actions">
          <span className={`pill ${isActive ? 'ok' : ''}`}>{isActive ? `启用中 v${def.active!.version}` : '未启用，不能发起'}</span>
          {dirty && <span className="pill warn">有未保存的修改</span>}
          {canManage && custom && <button type="button" className="secondary-button" disabled={busy} onClick={() => setDialog('meta')}>改名/部门</button>}
          {canManage && <button type="button" className="secondary-button" disabled={busy || dirty} title={dirty ? '先保存或放弃修改' : undefined} onClick={() => setDialog('copy')}>复制流程</button>}
          {canManage && isActive && <button type="button" className="secondary-button" disabled={busy || dirty} onClick={() => setDialog('stop')}>停用流程</button>}
          {canManage && custom && <button type="button" className="secondary-button" disabled={busy || dirty || hasHistory} title={hasHistory ? '已发布过的流程请用停用，保留历史' : '删除这个流程'} onClick={() => setDialog('delete')}>删除流程</button>}
          <button type="button" className="secondary-button" disabled={busy || dirty} onClick={() => void load()}>刷新</button>
        </div>
      </div>
      <div className="fd-steps" role="tablist" aria-label="流程配置步骤">
        {([['design', '1', '流程设计'], ['form', '2', '申请表单'], ['check', '3', '检查与启用'], ['timeout', '4', '超时与处罚']] as const).map(([k, n, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" className={tab === k ? 'tab active' : 'tab'} onClick={() => goTab(k)}><span className="fd-stepno">{n}</span>{label}</button>
        ))}
      </div>
      {msg && <div role={msg.kind === 'error' ? 'alert' : 'status'} className={`notice ${msg.kind}`}>{msg.text}</div>}

      {tab === 'design' && (
        <section className="card" style={{ padding: 16 }}>
          <p className="muted">
            当前启用版本：{def.active ? `v${def.active.version}` : '无（不能发起）'}；正在编辑草稿 v{def.draft.version}。
            办理人规则：指定员工/岗位必须解析到恰好 1 名在职员工；指定部门则部门里任一人办理（或全员会签）；永远不会兜底给管理员。
          </p>
          <div className="between">
            <div className="chip-row" role="group" aria-label="显示方式">
              <button type="button" className={`chip ${mode === 'canvas' ? 'active' : ''}`} onClick={() => { setMode('canvas'); try { localStorage.setItem('flow.designer.mode', 'canvas'); } catch { /* ignore */ } }}>流程画布</button>
              <button type="button" className={`chip ${mode === 'list' ? 'active' : ''}`} onClick={() => { setMode('list'); try { localStorage.setItem('flow.designer.mode', 'list'); } catch { /* ignore */ } }}>节点列表</button>
            </div>
            {canManage && <span className="muted small">拖动节点或用“上移/下移”调整顺序；点节点在右侧设置</span>}
          </div>
          <div className="fd-design-layout">
            <div className="fd-canvas-wrap">
              <DesignerCanvas steps={steps} selected={sel} tpl={tpl} lookup={lookup} canEdit={canManage} mode={mode} onSelect={setSel} onMove={doMove} canMove={canMoveFn}
                onInsert={(after) => setDialog({ pick: after })} onCopy={copyStep} onRemove={(i) => setDialog({ remove: i })} />
            </div>
            <aside className="fd-panel card" aria-label="节点设置">
              {current ? <NodeEditor key={current.key} step={current} index={sel} steps={steps} tpl={tpl} custom={custom} canEdit={canManage} lookups={lookups}
                stepFields={schema?.stepFields[current.key] ?? [...(tpl.stepFields[current.key] ?? [])]} onChange={(p) => patchStep(sel, p)} onFields={(f) => setStepFields(current.key, f)} /> : <p className="muted">点一个节点来设置。</p>}
            </aside>
          </div>
          <label style={{ display: 'block', marginTop: 12 }}>超时升级对象（步骤逾期时额外通知，可多选）
            <select multiple disabled={!canManage} value={esc.map(String)} onChange={(e) => setEsc([...e.target.selectedOptions].map((o) => Number(o.value)))} style={{ width: '100%', minHeight: 64 }}>
              {lookups.users.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          {fullIssues.length > 0 && (
            <div className="notice warn" role="status"><strong>发布前还要处理 {fullIssues.length} 项：</strong><ul>{fullIssues.map((t) => <li key={t}>{t}</li>)}</ul></div>
          )}
          {canManage ? (
            <div className="row-actions fd-save-bar">
              {dirty && <span className="muted">有未保存的修改</span>}
              <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => { setSteps(def.draft.steps); setEsc(def.draft.escalateUserIds); setSchema(custom ? def.draft.schema : null); setMsg(null); }}>放弃修改</button>
              <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => run(save, '草稿已保存')}>保存草稿</button>
              <button type="button" className="primary-button" disabled={busy || fullIssues.length > 0} title={fullIssues.length ? '先处理上面的检查项' : undefined} onClick={() => run(async () => { await save(); await designerApi.publish(flowKey); }, '已发布，新发起的流程按新配置办理')}>保存并发布</button>
            </div>
          ) : <p className="muted">你没有“保存并发布流程配置”的权限，只能查看。</p>}
          <h3 className="section-title">流转一览</h3>
          <div className="table-scroll"><table className="data-table compact">
            <thead><tr><th>步骤</th><th>类型</th><th>办理人</th><th>时限</th><th>条件</th><th>抄送</th><th>督促</th></tr></thead>
            <tbody>{steps.map((s, i) => (
              <tr key={s.key}>
                <td>{i + 1}. {s.name}</td><td>{STEP_TYPE_LABEL[s.type]}</td>
                <td>{s.type === 'submit' ? '发起人' : s.type === 'end' ? '—' : describeAssignee(s, lookup) === '未选择' ? <span className="late-text">未选择</span> : describeAssignee(s, lookup)}</td>
                <td>{s.dueMinutes ? formatMinutes(s.dueMinutes) : '不限'}</td>
                <td>{describeCondition(s.when, tpl, steps) || '—'}</td>
                <td>{(s.ccUserIds ?? []).map((id) => lookups.users.find((u) => u.value === id)?.label ?? `#${id}`).join('、') || '—'}</td>
                <td>{describeRemind(s) || '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="muted">办理中遇到问题时，办理人可以“退回”；发起人可撤回；管理员可转交他人。</p>
        </section>
      )}

      {tab === 'form' && (
        <section className="card" style={{ padding: 16 }}>
          {custom && schema ? (
            <>
              <h3 className="section-title">申请表单（发起人要填写的内容）</h3>
              <FormFieldsEditor fields={schema.fields} group="申请" disabled={!canManage} onChange={(f) => setSchema({ ...schema, fields: f })} />
              <PostingEditor posting={(schema.posting ?? null) as FlowPostingDecl | null} steps={steps} fields={schema.fields} stepFields={schema.stepFields} disabled={!canManage} onChange={(p) => setSchema({ ...schema, posting: p })} />
              <p className="muted small">每一步办理时要填的内容，在“流程设计”里点对应节点设置。修改后保存草稿并发布生效；已经发起的申请仍按它发起时的表单。</p>
              {canManage && (
                <div className="row-actions fd-save-bar">
                  {dirty && <span className="muted">有未保存的修改</span>}
                  <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => { setSteps(def.draft.steps); setEsc(def.draft.escalateUserIds); setSchema(def.draft.schema); }}>放弃修改</button>
                  <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => run(save, '草稿已保存')}>保存草稿</button>
                  <button type="button" className="primary-button" disabled={busy || fullIssues.length > 0} onClick={() => run(async () => { await save(); await designerApi.publish(flowKey); }, '已发布，新发起的流程按新配置办理')}>保存并发布</button>
                </div>
              )}
              {fullIssues.length > 0 && <div className="notice warn" role="status"><ul>{fullIssues.map((t) => <li key={t}>{t}</li>)}</ul></div>}
            </>
          ) : (
            <>
              <h3 className="section-title">申请表单（内置业务流程，字段由业务规则固定）</h3>
              <ul className="plain-list">{tpl.fields.map((f) => <li key={f.key}>{f.label}{f.required ? '（必填）' : ''} <span className="muted small">{f.help ?? ''}</span></li>)}</ul>
              <p className="muted">想要一个可以自由改字段的版本，用“复制流程”得到自建流程。</p>
            </>
          )}
        </section>
      )}

      {tab === 'check' && (
        <section className="card" style={{ padding: 16 }}>
          <h3 className="section-title">配置检查</h3>
          {fullIssues.length === 0 ? <p className="ok-text">配置完整，可以发布。</p> : <div className="notice warn"><ul>{fullIssues.map((t) => <li key={t}>{t}</li>)}</ul></div>}
          {dirty && <p className="muted">当前有未保存的修改，检查结果按未保存的内容计算。</p>}
          <h3 className="section-title">版本记录</h3>
          <div className="table-scroll"><table className="data-table compact">
            <thead><tr><th>版本</th><th>状态</th><th>步骤数</th><th>发布时间</th><th>操作</th></tr></thead>
            <tbody>{def.history.map((h) => (
              <tr key={h.version}><td>v{h.version}</td><td>{STATUS_LABEL[h.status] ?? h.status}</td><td>{h.stepCount}</td><td>{h.publishedAt ? fmtTime(h.publishedAt) : '—'}</td>
                <td>{canManage && h.status === 'retired' && <button type="button" className="link-button" disabled={busy || dirty} onClick={() => setDialog({ activate: h.version })}>启用此版本</button>}
                  {canManage && h.status === 'draft' && !(custom && def.history.length === 1) && <button type="button" className="link-button danger" disabled={busy} onClick={() => setDialog('discard')}>放弃草稿</button>}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="muted small">启用历史版本相当于回退：当前启用的版本变为“已停用”，新发起的申请按被启用的版本办理；在办的流程不受影响。</p>
        </section>
      )}

      {tab === 'timeout' && (
        <section className="card" style={{ padding: 16 }}>
          <p className="muted">这里设置本流程独立的超时通知和处罚规则；不设置就沿用公司默认规则。</p>
          <label>范围
            <select aria-label="规则范围" value={nodeScope} onChange={(e) => { if (timeoutDirty && !window.confirm('规则有尚未保存的修改，切换会丢弃。确定切换吗？')) return; setTimeoutDirty(false); setNodeScope(e.target.value); }}>
              <option value="">整个流程</option>
              {steps.filter((s) => s.type !== 'submit' && s.type !== 'end').map((s) => <option key={s.key} value={s.key}>仅节点：{s.name}</option>)}
            </select>
          </label>
          <TimeoutPolicyEditor templateKey={flowKey} nodeKey={nodeScope} canManage={canManage} onDirty={setTimeoutDirty} />
        </section>
      )}

      {dialog === 'copy' && <CopyDialog name={def.template.label} onClose={() => setDialog(null)} onDone={(k) => { setDialog(null); onOpen(k); }} sourceKey={flowKey} departmentId={def.template.departmentId} />}
      {dialog === 'stop' && <Confirm title="停用流程" body={`停用“${def.template.label}”后不能再发起新申请；在办的申请照常办理，历史记录保留。`} ok="停用" onClose={() => setDialog(null)} onOk={async () => { await designerApi.deactivate(flowKey); setDialog(null); setMsg({ kind: 'ok', text: '流程已停用，新申请不可提交' }); await load(); }} />}
      {dialog === 'delete' && <Confirm title="删除流程" danger body={`删除“${def.template.label}”？将同时删除它的全部配置版本，删除后无法恢复。`} ok="删除" onClose={() => setDialog(null)} onOk={async () => { await designerApi.remove(flowKey); setDialog(null); onBack(); }} />}
      {dialog === 'discard' && <Confirm title="放弃草稿" body="放弃后草稿里保存的修改会丢失，启用中的版本不受影响。" ok="放弃草稿" onClose={() => setDialog(null)} onOk={async () => { await designerApi.discardDraft(flowKey); setDialog(null); setMsg({ kind: 'ok', text: '草稿已放弃' }); await load(); }} />}
      {dialog && typeof dialog === 'object' && 'activate' in dialog && <Confirm title="启用历史版本" body={`启用 v${dialog.activate}？当前启用的版本会变成“已停用”，之后新发起的申请按 v${dialog.activate} 办理，在办的不受影响。`} ok="启用" onClose={() => setDialog(null)} onOk={async () => { await designerApi.activate(flowKey, dialog.activate); setDialog(null); setMsg({ kind: 'ok', text: `已启用 v${dialog.activate}` }); await load(); }} />}
      {dialog && typeof dialog === 'object' && 'remove' in dialog && <Confirm title="删除节点" body={`删除节点“${steps[dialog.remove]?.name}”？它的办理页面设置会一起删除；点保存后才生效。`} ok="删除" danger onClose={() => setDialog(null)} onOk={async () => { removeStep(dialog.remove); setDialog(null); }} />}
      {dialog === 'meta' && <MetaDialog def={def} depts={lookups.depts} onClose={() => setDialog(null)} onDone={async () => { setDialog(null); setMsg({ kind: 'ok', text: '已保存' }); await load(); }} flowKey={flowKey} />}
      {dialog && typeof dialog === 'object' && 'pick' in dialog && (
        <NodePicker nodes={nodes} custom={custom} onClose={() => setDialog(null)}
          onBlank={() => { insertAt(dialog.pick, newApprovalStep(steps)); setDialog(null); }}
          onPick={(nt) => { const r = stepFromNodeTemplate(nt, steps); insertAt(dialog.pick, r.step, r.fields); setDialog(null); }} />
      )}
    </div>
  );
}

function CopyDialog({ name, sourceKey, departmentId, onClose, onDone }: { name: string; sourceKey: string; departmentId: number | null; onClose: () => void; onDone: (key: string) => void }) {
  const [n, setN] = useState(`${name}副本`);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="复制流程" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { const r = await designerApi.create({ name: n.trim(), departmentId, sourceKey }); onDone(r.key); } catch (x) { setErr(x instanceof ApiError ? x.message : '复制失败'); setBusy(false); }
      }}>
        <div className="modal-head"><strong>复制流程</strong></div>
        <div className="modal-body">{err && <div role="alert" className="notice error">{err}</div>}<label>新流程名称<input autoFocus required maxLength={100} value={n} onChange={(e) => setN(e.target.value)} /></label><p className="muted small">复制全部步骤、办理人和表单，得到一个新的自建流程草稿；复制内置业务流程时不带业务专属的自动动作。</p></div>
        <div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !n.trim()}>复制</button></div>
      </form>
    </div>
  );
}

function MetaDialog({ def, depts, flowKey, onClose, onDone }: { def: DesignerDefinition; depts: Array<{ value: number; label: string }>; flowKey: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(def.template.label);
  const [desc, setDesc] = useState(def.template.description);
  const [dept, setDept] = useState(def.template.departmentId ? String(def.template.departmentId) : '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="流程信息" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { await designerApi.updateMeta(flowKey, { name: name.trim(), description: desc, departmentId: dept ? Number(dept) : null }); onDone(); } catch (x) { setErr(x instanceof ApiError ? x.message : '保存失败'); setBusy(false); }
      }}>
        <div className="modal-head"><strong>流程信息</strong></div>
        <div className="modal-body">
          {err && <div role="alert" className="notice error">{err}</div>}
          <label>流程名称<input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>所属部门<select value={dept} onChange={(e) => setDept(e.target.value)}><option value="">全公司通用</option>{depts.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</select></label>
          <label>说明<textarea rows={3} maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !name.trim()}>保存</button></div>
      </form>
    </div>
  );
}

/** 添加节点：空白审批节点，或从节点模板里选（套用后互不影响）。 */
function NodePicker({ nodes, custom, onClose, onBlank, onPick }: { nodes: NodeTemplateDto[]; custom: boolean; onClose: () => void; onBlank: () => void; onPick: (n: NodeTemplateDto) => void }) {
  const [q, setQ] = useState('');
  const list = nodes.filter((n) => n.insertable !== false && (custom || n.type === 'approval') && `${n.name}${n.description}${n.category}`.includes(q.trim()));
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="添加节点">
        <div className="modal-head"><strong>添加节点</strong></div>
        <div className="modal-body">
          <button type="button" className="secondary-button" onClick={onBlank}>添加空白审批节点</button>
          <input type="search" aria-label="搜索节点模板" placeholder="搜索节点模板" value={q} onChange={(e) => setQ(e.target.value)} />
          {!custom && <p className="muted small">内置业务流程只能增加审批类节点。</p>}
          <ul className="plain-list fd-node-templates">
            {list.map((n) => (
              <li key={n.key}><button type="button" className="fd-nt" onClick={() => onPick(n)}>
                <strong>{n.name}</strong> <span className="pill">{n.category}</span> <span className="pill">{STEP_TYPE_LABEL[n.type]}</span>
                <div className="muted small">{n.description}{custom && n.fields.length > 0 ? ` · 带 ${n.fields.length} 项办理页面` : ''}</div>
              </button></li>
            ))}
            {list.length === 0 && <li className="muted">没有匹配的节点模板</li>}
          </ul>
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button></div>
      </div>
    </div>
  );
}

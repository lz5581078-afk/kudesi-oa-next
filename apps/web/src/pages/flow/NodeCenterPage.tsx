import { useEffect, useMemo, useState } from 'react';
import { STEP_TYPE_LABEL, formatMinutes, type FieldDef, type StepType } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { designerApi, type NodeCenterDto, type NodeTemplateDto } from './designerApi';
import { Confirm } from './FlowDirectory';
import { FormFieldsEditor } from './FormFieldsEditor';
import { DUE_PRESETS } from './designerUi';
import './designer.css';

const EDITABLE_TYPES: StepType[] = ['approval', 'execute', 'finance'];
type Draft = { key: string | null; sourceKey: string | null; revision: number; name: string; description: string; category: string; type: StepType; dueMinutes: number | null; fields: FieldDef[] };
const blank = (category: string): Draft => ({ key: null, sourceKey: null, revision: 0, name: '', description: '', category, type: 'approval', dueMinutes: null, fields: [] });

/** 节点中心：按分类查看节点模板与节点默认页面；内置只读，可复制成自己的再改。改模板不影响已套用到流程里的节点。 */
export function NodeCenterPage() {
  const { can } = useAuth();
  const canManage = can('flow.templates.manage');
  const [data, setData] = useState<NodeCenterDto | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [cat, setCat] = useState('全部');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [del, setDel] = useState<NodeTemplateDto | null>(null);

  const load = () => designerApi.nodeCenter().then(setData).catch((e) => setErr(e instanceof ApiError ? e.message : '加载失败'));
  useEffect(() => { void load(); }, []);

  const list = useMemo(() => (data?.templates ?? []).filter((t) => (cat === '全部' || t.category === cat) && `${t.name}${t.description}${t.category}`.includes(q.trim())), [data, cat, q]);
  const current = data?.templates.find((t) => t.key === sel) ?? null;
  const categories = data?.categories ?? [];

  const open = (t: NodeTemplateDto) => { setSel(t.key); setDraft(null); setMsg(''); };
  const copy = (t: NodeTemplateDto) => { setSel(null); setMsg(''); setDraft({ key: null, sourceKey: t.key, revision: 0, name: `${t.name}（我的）`, description: t.description, category: t.category, type: t.type, dueMinutes: t.dueMinutes, fields: t.fields.map((f) => ({ ...f })) }); };
  const edit = (t: NodeTemplateDto) => { setMsg(''); setDraft({ key: t.key, sourceKey: null, revision: t.revision, name: t.name, description: t.description, category: t.category, type: t.type, dueMinutes: t.dueMinutes, fields: t.fields.map((f) => ({ ...f })) }); };

  async function save() {
    if (!draft) return;
    setSaving(true); setErr(''); setMsg('');
    try {
      const r = await designerApi.saveNode({ key: draft.key, sourceKey: draft.sourceKey, revision: draft.key ? draft.revision : undefined, name: draft.name.trim(), description: draft.description.trim(), category: draft.category, type: draft.type, dueMinutes: draft.dueMinutes, fields: draft.fields });
      setMsg(draft.key ? '节点模板已保存；已套用到流程里的节点不受影响' : '节点模板已创建');
      setDraft(null); setSel(r.key); await load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : '保存失败'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <div className="page-head">
        <h1>节点中心</h1>
        {canManage && <button type="button" className="primary-button" onClick={() => { setSel(null); setMsg(''); setDraft(blank(categories.find((c) => c !== '业务专用') ?? '通用节点')); }}>新建节点模板</button>}
      </div>
      <p className="muted">节点模板是设计流程时可以直接套用的“一步”：自带办理人来源、时限和办理页面（要填的字段）。套用到流程后互相独立，改模板不会改动已有流程。</p>
      {err && <div role="alert" className="notice error">{err}</div>}
      {msg && <div role="status" className="notice ok">{msg}</div>}
      <div className="fd-design-layout">
        <section className="card" style={{ padding: 12 }}>
          <div className="toolbar">
            <input type="search" aria-label="搜索节点模板" placeholder="搜索名称或用途" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="chip-row" role="group" aria-label="节点分类">
            {['全部', ...categories].map((c) => <button key={c} type="button" className={`chip ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>{c}</button>)}
          </div>
          {!data && !err && <p className="muted" role="status">正在加载…</p>}
          <ul className="plain-list fd-node-templates">
            {list.map((t) => (
              <li key={t.key}><button type="button" className="fd-nt" aria-current={sel === t.key} onClick={() => open(t)}>
                <strong>{t.name}</strong> <span className="pill">{t.category}</span> {t.builtin ? <span className="pill">内置</span> : <span className="pill ok">我的</span>}
                <div className="muted small">{t.description || '（没有说明）'}</div>
              </button></li>
            ))}
            {data && list.length === 0 && <li className="empty-state">没有匹配的节点模板</li>}
          </ul>
          {(data?.business.length ?? 0) > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary>业务流程里固定的节点（只读，{data!.business.length} 个）</summary>
              <ul className="plain-list small">{data!.business.filter((b) => `${b.name}${b.flowLabel}`.includes(q.trim())).map((b) => <li key={b.key}>{b.flowLabel} · {b.name}（{STEP_TYPE_LABEL[b.type as StepType] ?? b.type}，{b.fields.length} 项办理字段{b.legacy?.length ? `；对应旧节点：${b.legacy.join('、')}` : ''}）</li>)}</ul>
            </details>
          )}
        </section>

        <section className="card fd-panel" aria-label="节点模板详情">
          {draft ? (
            <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="fd-node-editor">
              <h2>{draft.key ? '编辑节点模板' : draft.sourceKey ? '复制为我的节点模板' : '新建节点模板'}</h2>
              <label>名称<input required maxLength={40} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
              <label>用途说明<textarea rows={2} maxLength={200} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
              <label>分类<select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>{categories.filter((c) => c !== '业务专用').map((c) => <option key={c}>{c}</option>)}</select></label>
              <label>节点类型<select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as StepType })}>{EDITABLE_TYPES.map((t) => <option key={t} value={t}>{STEP_TYPE_LABEL[t]}</option>)}</select></label>
              <label>默认时限<select value={draft.dueMinutes ?? ''} onChange={(e) => setDraft({ ...draft, dueMinutes: e.target.value ? Number(e.target.value) : null })}><option value="">不限</option>{DUE_PRESETS.map((p) => <option key={p.minutes} value={p.minutes}>{p.label}</option>)}</select></label>
              <fieldset className="fd-section"><legend>节点默认页面（办理这一步要填的内容）</legend><FormFieldsEditor fields={draft.fields} group={draft.name || '办理'} onChange={(fields) => setDraft({ ...draft, fields })} /></fieldset>
              <div className="row-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => setDraft(null)}>取消</button><button type="submit" className="primary-button" disabled={saving || !draft.name.trim()}>{saving ? '保存中…' : '保存'}</button></div>
            </form>
          ) : current ? (
            <div className="fd-node-editor">
              <h2>{current.name}</h2>
              <p className="muted">{current.description || '（没有说明）'}</p>
              <p>分类：{current.category}　类型：{STEP_TYPE_LABEL[current.type]}　默认时限：{current.dueMinutes ? formatMinutes(current.dueMinutes) : '不限'}　{current.builtin ? '内置模板（只读）' : `版本 ${current.revision}`}</p>
              {current.note && <p className="notice warn">{current.note}</p>}
              {current.binding && <p className="muted">对应业务流程：{data?.business.find((b) => b.key === `${current.binding!.flowKey}:${current.binding!.stepKey}`)?.flowLabel ?? current.binding.flowKey} · {data?.business.find((b) => b.key === `${current.binding!.flowKey}:${current.binding!.stepKey}`)?.name ?? current.binding.stepKey}</p>}
              {current.insertable === false && <p className="muted">只能查看，不能加入自建流程。</p>}
              {(current.context?.length ?? 0) > 0 && <p className="muted small">办理时还能看到：{current.context!.join('、')}</p>}
              <h3 className="section-title">节点默认页面（办理时要填的内容）</h3>
              {current.fields.length === 0 ? <p className="muted">这个节点办理时没有额外要填的内容。</p> : <ul className="plain-list">{current.fields.map((f) => <li key={f.key}>{f.label}{f.required ? '（必填）' : ''} <span className="muted small">{f.type}</span></li>)}</ul>}
              {canManage && (
                <div className="row-actions">
                  {current.insertable !== false && <button type="button" className="secondary-button" onClick={() => copy(current)}>复制为我的模板</button>}
                  {!current.builtin && <button type="button" className="secondary-button" onClick={() => edit(current)}>编辑</button>}
                  {!current.builtin && <button type="button" className="link-button danger" onClick={() => setDel(current)}>删除</button>}
                </div>
              )}
            </div>
          ) : <p className="muted">在左侧选一个节点模板查看。</p>}
        </section>
      </div>
      {del && <Confirm title="删除节点模板" danger body={`删除“${del.name}”？已套用到流程里的节点不受影响。`} ok="删除" onClose={() => setDel(null)} onOk={async () => { await designerApi.deleteNode(del.key); setDel(null); setSel(null); setMsg('已删除'); await load(); }} />}
    </div>
  );
}

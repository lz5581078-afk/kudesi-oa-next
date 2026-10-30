import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { createChecker, getResourceDef, resourcePermission } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { resourceApi, type ResourceDto } from './api';
import { clearRefCache } from './RecordForm';
import { loadUnitOptions } from './unitOptions';
import './referenceDictionary.css';

/** 表单旁的字典维护窗口，使用现有资料服务，保存成功即刷新选择项。 */
export function ReferenceDictionaryManager({ target, kind, title, onClose }: { target: string; kind?: string; title: string; onClose: () => void }) {
  const { user } = useAuth();
  const can = (action: 'create' | 'edit' | 'disable') => !!user && createChecker(user.permissions)(resourcePermission(target, action));
  const [rows, setRows] = useState<ResourceDto[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ id?: number; name: string; code: string }>({ name: '', code: '' });
  const def = getResourceDef(target)!;
  const load = async () => { const all: ResourceDto[] = []; for (let page = 1; ; page++) { const r = await resourceApi.list(target, { page, pageSize: 200, showHidden: true, ...(kind ? { tab: kind } : {}) }); all.push(...r.items); if (all.length >= r.total || !r.items.length) break; } setRows(all); };
  useEffect(() => { void load().catch(e => setError(e instanceof Error ? e.message : '读取失败')); }, [target, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const requestClose=()=>{if(!busy&&(!(draft.id||draft.name.trim()||draft.code.trim())||window.confirm('当前编辑内容尚未保存，确认关闭？')))onClose();};
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!e.defaultPrevented){e.preventDefault();requestClose();}};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[busy,draft,onClose]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save(e: React.FormEvent) { e.preventDefault(); if (busy) return; if (!draft.name.trim()) return setError('请填写名称。'); setBusy(true); setError('');
    try { const values = { name: draft.name.trim(), code: draft.code.trim(), ...(!draft.id && kind ? { kind } : {}) }; if (draft.id) await resourceApi.update(target, draft.id, values); else await resourceApi.create(target, values); clearRefCache(target); if (target === 'finance-product-units') await loadUnitOptions(true); await load(); setDraft({ name: '', code: '' }); } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  }
  return <div className="reference-dict-backdrop"><section className="reference-dict" role="dialog" aria-modal="true" aria-label={title}><header><div><small>商品基础资料</small><h2>{title}</h2></div><button type="button" aria-label="关闭字典管理" disabled={busy} onClick={requestClose}><X size={20}/></button></header><div className="reference-dict-body">{error && <p role="alert" className="notice error">{error}</p>}{(draft.id ? can('edit') : can('create')) && <form onSubmit={save}><h3>{draft.id ? '编辑资料' : '新增资料'}</h3><div><label>名称 <b className="req">必填</b><input autoFocus value={draft.name} maxLength={def.fields.find(f => f.key === 'name')?.maxLength ?? 120} onChange={e => setDraft(v => ({ ...v, name:e.target.value }))}/></label><label>编码<input value={draft.code} maxLength={def.fields.find(f => f.key === 'code')?.maxLength ?? 30} placeholder="不填则自动生成" onChange={e => setDraft(v => ({ ...v, code:e.target.value }))}/></label></div><footer>{draft.id && <button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft({ name:'',code:'' })}>取消编辑</button>}<button className="primary-button" disabled={busy}>{busy ? '保存中…' : draft.id ? '保存修改' : '新增'}</button></footer></form>}{rows === null ? <p>读取中…</p> : <table><thead><tr><th>名称</th><th>编码</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{r.title}</td><td>{String(r.data.code ?? '')}</td><td>{r.status === 'active' ? '启用' : '停用'}</td><td>{can('edit') && <button className="link-button" disabled={busy} onClick={() => setDraft({ id:r.id,name:r.title,code:String(r.data.code ?? '') })}>编辑</button>}</td></tr>)}</tbody></table>}</div></section></div>;
}

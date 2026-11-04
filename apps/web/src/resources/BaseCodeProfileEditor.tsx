import { loadResourceDirectory } from './resourceDirectory';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { createChecker, getResourceDef, unitYuanText } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { BaseProfileSourceDetails } from './BaseProfileSourceDetails';
import './baseCodeProfileEditor.css';

const KEYS = ['code', 'styleCode', 'name', 'shortName', 'spec', 'codeDictionaryCategoryId', 'weightG'] as const;
const LABELS = { code: '商品编码', styleCode: '款式编码', name: '商品名称', shortName: '商品简称', spec: '颜色及规格' };

const sourceCostText = (cents: number) => { const [whole, fraction = ''] = unitYuanText(cents).split('.'); return whole + '.' + fraction.padEnd(3, '0'); };

/** 专属字段与只读来源上下排列，保存动作沿用资料服务及生效引用锁。 */
export function BaseCodeProfileEditor({ record, onClose, onSaved }: { record: ResourceDto; onClose: () => void; onSaved: (row: ResourceDto) => void }) {
  const { user } = useAuth();
  const can = user ? createChecker(user.permissions) : () => false;
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(KEYS.map(k => [k, record.data[k] ?? ''])));
  const [kg, setKg] = useState(record.data.weightG === undefined ? '' : String(Number(record.data.weightG) / 1000));
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [categoriesReady,setCategoriesReady]=useState(false);
  const [locked, setLocked] = useState<string[] | null>(null), [categories, setCategories] = useState<ResourceDto[]>([]), [source, setSource] = useState<ResourceDto | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ lockedFields: string[] }>(`/finance/base-codes/${record.id}/references`).then(r => alive && setLocked(r.lockedFields)).catch(() => alive && setError('无法核对生效引用，请关闭后重试。'));
    setCategoriesReady(false);loadResourceDirectory('finance-code-dictionaries',()=>alive,'sort',{includeInactive:true}).then(rows=>{if(alive&&rows){setCategories(rows.filter(r=>r.data.kind==='product_category'));setCategoriesReady(true);}}).catch(()=>alive&&setError('分类读取失败，请关闭后重试。'));
    if (typeof record.data.productId === 'number') resourceApi.get('finance-products', record.data.productId).then(r => alive && setSource(r)).catch(() => undefined);
    return () => { alive = false; };
  }, [record.id, record.data.productId]);
  const change = (key: string, value: unknown) => setValues(v => ({ ...v, [key]: value }));
  const codeChanged = ['code', 'styleCode'].some(k => String(values[k]).trim() !== String(record.data[k] ?? ''));
  const isLocked = (key: string) => locked === null || locked.includes(key) || (!!record.data.canonicalId && ['code', 'styleCode'].includes(key));
  const byId = new Map(categories.map(r => [r.id, r]));
  const categoryPath = (id: number) => { const names: string[] = [], seen = new Set<number>(); for (let r = byId.get(id); r && !seen.has(r.id); r = byId.get(Number(r.data.parentId))) { seen.add(r.id); names.unshift(r.title); } return names.join(' / '); };
  const leaves = categories.filter(r => r.status==='active'&&!categories.some(c => c.data.parentId === r.id));
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (busy || locked === null || !categoriesReady) return;
    if (['code', 'styleCode', 'name', 'shortName'].some(k => !String(values[k] ?? '').trim())) return setError('请填写商品编码、款式编码、商品名称和商品简称。');
    if ((!values.codeDictionaryCategoryId && !record.data.categoryId) || !kg.trim() || !Number.isFinite(Number(kg)) || Number(kg) < 0) return setError('请选择分类，并填写不小于0的重量。');
    if (codeChanged && reason.trim().length < 2) return setError('手改编码请填写修改原因。');
    setBusy(true); setError('');
    try { const row = await resourceApi.confirmBaseProfile(record.id, { ...values, weightG: Math.round(Number(kg) * 1e9) / 1e6, ...(codeChanged ? { codeChangeReason: reason.trim() } : {}) }); onSaved(row); } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); setBusy(false); }
  }
  return <div className="base-profile-backdrop"><form className="base-profile-editor" role="dialog" aria-modal="true" aria-label="编辑商品基础编码" onSubmit={save}>
    <header><div><small>商品基础编码 · 专属资料</small><h2>编辑商品基础编码</h2><p>上方字段独立维护，保存后不再被来源商品档案覆盖。</p></div><button type="button" className="base-profile-close" aria-label="关闭" disabled={busy} onClick={onClose}><X size={22} /></button></header>
    <div className="base-profile-scroll">
      {error && <div role="alert" className="notice error">{error}</div>}
      {locked && locked.length > 0 && <p className="notice warn">该商品编码已有生效引用，编码、分类和重量已锁定；可修改名称、简称和颜色及规格。</p>}
      <section><div className="base-profile-section-title"><h3>商品编码专属信息</h3><span>{record.data.profileManual ? '已人工维护' : '等待人工确认'}</span></div>
        <div className="base-profile-edit-grid">
          {(Object.keys(LABELS) as Array<keyof typeof LABELS>).map(key => <label key={key}><span>{LABELS[key]}{key !== 'spec' && <b>必填</b>}</span><input value={String(values[key] ?? '')} disabled={busy || isLocked(key)} onChange={e => change(key, e.target.value)} maxLength={getResourceDef('finance-base-codes')?.fields.find(field => field.key === key)?.maxLength} /></label>)}
          <label><span>分类 <b>必填</b></span><select value={String(values.codeDictionaryCategoryId ?? '')} disabled={busy || !categoriesReady || isLocked('codeDictionaryCategoryId')} onChange={e => change('codeDictionaryCategoryId', e.target.value ? Number(e.target.value) : '')}><option value="">请选择分类</option>{!leaves.some(r => r.id === values.codeDictionaryCategoryId) && !!values.codeDictionaryCategoryId && <option value={String(values.codeDictionaryCategoryId)}>{record.refLabels.codeDictionaryCategoryId ?? `#${values.codeDictionaryCategoryId}`}</option>}{leaves.map(r => <option key={r.id} value={r.id}>{categoryPath(r.id)}</option>)}</select>{!record.data.codeDictionaryCategoryId && !!record.data.categoryId && <small>商品档案分类：{record.refLabels.categoryId || `#${record.data.categoryId}`}</small>}</label>
          <label><span>重量（kg） <b>必填</b></span><input type="number" min="0" step="any" value={kg} disabled={busy || isLocked('weightG')} onChange={e => setKg(e.target.value)} /></label>
        </div>
        {codeChanged && <label className="base-profile-reason">修改编码原因<textarea value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></label>}
      </section>
      <section className="base-profile-source"><div className="base-profile-section-title"><h3>来源商品档案</h3><span>只读资料</span></div>
        {source ? <>{(source.status === 'deleted' || source.archived?.deleted) && <p className="notice warn">来源商品档案已删除，以下为保留的档案资料。</p>}{can('product.cost.view') && source.data.totalCost != null && <div className="base-profile-source-cost"><small>成本价（含运费、装卸费）</small><strong>¥{sourceCostText(Number(source.data.totalCost))} / {String(source.data.purchaseSpec || '单位')}</strong></div>}<div className="base-profile-source-name"><small>商品资料名</small><strong>{String(source.data.basicInfoFullName || source.title)}</strong></div><BaseProfileSourceDetails source={source} canCost={can('product.cost.view')}/></> : <p className="base-profile-source-empty">来源商品档案暂不可读；专属字段仍可独立维护。</p>}
      </section>
    </div>
    <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || locked === null || !categoriesReady}>{busy ? '保存中…' : '保存专属资料'}</button></footer>
  </form></div>;
}

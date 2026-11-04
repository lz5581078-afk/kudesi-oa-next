import { useEffect, useState, type FormEvent } from 'react';
import { getResourceDef, todayInChina } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { useResourceCan } from '../../../resources/RecordDetail';
import type { TreeCarrier } from './expressApi';
import './hierarchyForm.css';

export type HierarchyState = { kind: 'carrier'; id: number | null } | { kind: 'branch'; id: number | null; carrierId: number } | { kind: 'version'; branchId: number; id?: number };
export function HierarchyForm({ state, carriers, onClose, onSaved }: { state: HierarchyState; carriers: TreeCarrier[]; onClose: () => void; onSaved: (row: ResourceDto) => void }) {
  const type = state.kind === 'carrier' ? 'finance-express-carriers' : state.kind === 'branch' ? 'finance-express-branches' : 'finance-express-versions';
  const id = state.id ?? null;
  const [record, setRecord] = useState<ResourceDto | null>(null);
  const [loaded, setLoaded] = useState(id === null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = state.kind === 'version' ? { versionName: '', effectiveStart: todayInChina(), effectiveEnd: '', shippingWeightMin: '', shippingWeightMax: '', remark: '' } : { name: '', note: '' };
    if (state.kind === 'branch') Object.assign(initial, { carrierId: String(state.carrierId), jstLogisticsName: '', contactName: '', contactPhone: '' });
    return initial;
  });
  const [status, setStatus] = useState('normal');
  const can = useResourceCan('finance-express-prices');
  useEffect(() => {
    if (id === null) return;
    let active = true;
    void resourceApi.get(type, id).then(row => {
      if (!active) return;
      setRecord(row); setStatus(row.status); setValues(Object.fromEntries(Object.entries(row.data).map(([key, value]) => [key, value == null ? '' : String(value)]))); setLoaded(true);
    }).catch(e => { if (active) setError((e as Error).message || '读取失败'); });
    return () => { active = false; };
  }, [id, type]);
  const update = (key: string, value: string) => setValues(current => ({ ...current, [key]: value }));
  const field = (key: string, label: string, placeholder = '', inputType = 'text') => <label className={['note', 'remark', 'jstLogisticsName'].includes(key) ? 'express-hierarchy-wide' : undefined}>{label}<input type={inputType} autoFocus={key === (state.kind === 'version' ? 'versionName' : 'name')} value={values[key] ?? ''} maxLength={getResourceDef(type)?.fields.find(f => f.key === key)?.maxLength} placeholder={placeholder} step={inputType === 'number' ? 'any' : undefined} min={inputType === 'number' ? 0 : undefined} onChange={e => update(key, e.target.value)} /></label>;
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy || !loaded) return;
    setError('');
    const keys = state.kind === 'carrier' ? ['name', 'note'] : state.kind === 'branch' ? ['name', 'carrierId', 'jstLogisticsName', 'contactName', 'contactPhone', 'note'] : ['versionName', 'effectiveStart', 'effectiveEnd', 'shippingWeightMin', 'shippingWeightMax', 'remark'];
    const data: Record<string, unknown> = Object.fromEntries(keys.map(key => [key, (values[key] ?? '').trim()]));
    if (!data[state.kind === 'version' ? 'versionName' : 'name']) return setError(state.kind === 'version' ? '请填写版本名称' : state.kind === 'carrier' ? '请填写快递公司名称' : '请填写经营网点名称');
    if (state.kind === 'branch') { data.carrierId = Number(values.carrierId); if (!data.carrierId) return setError('请选择快递公司'); if (record && data.carrierId !== record.data.carrierId) return setError('已有网点不能更换所属快递公司，请保持原所属公司后保存。'); }
    if (state.kind === 'version') {
      data.branchId = state.branchId;
      data.effectiveStart = data.effectiveStart || todayInChina();
      for (const key of ['shippingWeightMin', 'shippingWeightMax']) {
        if (data[key] === '') { data[key] = null; continue; }
        const value = Number(data[key]);
        if (!Number.isFinite(value) || value < 0) return setError('可发货重量要填大于等于0的数字');
        data[key] = value;
      }
      if (data.shippingWeightMax != null && Number(data.shippingWeightMax) <= Number(data.shippingWeightMin ?? 0)) return setError('可发货重量上限必须大于下限');
      if (data.effectiveEnd && String(data.effectiveEnd) < String(data.effectiveStart)) return setError('失效日期不能早于生效日期');
    }
    setBusy(true);
    try {
      let saved: ResourceDto;
      if (!record) saved = await resourceApi.create(type, data, state.kind === 'version' ? 'draft' : status);
      else if (state.kind !== 'version' && status !== record.status) {
        const result = await resourceApi.gridSave(type, { updates: [{ id: record.id, version: record.version, data, status }], note: '快递资料编辑' });
        if (!result.results[0]?.ok) throw new Error(result.results[0]?.message || '保存失败');
        saved = result.results[0].row ?? await resourceApi.get(type, record.id);
      } else saved = await resourceApi.update(type, record.id, data);
      onSaved(saved);
    } catch (e) { setError((e as Error).message || '保存失败'); setBusy(false); }
  }
  const title = state.kind === 'version' ? id ? '编辑价格版本' : '新建价格版本' : `${id ? '编辑' : '新增'}${state.kind === 'carrier' ? '快递公司' : '经营网点'}`;
  return <div className="modal-backdrop express-hierarchy-backdrop" role="presentation"><form className="modal express-hierarchy-form" role="dialog" aria-modal="true" aria-label={title} onSubmit={e => void save(e)}>
    <div className="modal-head"><h3>{title}</h3><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></div>
    <div className="modal-body">{error && <div className="notice error" role="alert">{error}</div>}{!loaded ? <p className="muted">读取中…</p> : <fieldset disabled={busy} className="express-hierarchy-grid">
      {state.kind === 'branch' && <label>所属快递公司<select value={values.carrierId ?? ''} onChange={e => update('carrierId', e.target.value)}>{!carriers.length && <option value="">请先新增快递公司</option>}{carriers.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label>}
      {state.kind !== 'version' && field('name', state.kind === 'carrier' ? '快递公司名称' : '经营网点名称', state.kind === 'carrier' ? '例如 极兔、中通、圆通' : '例如 兰山网点')}
      {state.kind === 'branch' && <>{field('jstLogisticsName', '聚水潭快递公司名称', '例如 淘宝-申通小件；须与聚水潭“物流(快递)公司及打印模板”中的名称一致')}{field('contactName', '联系人')}{field('contactPhone', '联系电话')}</>}
      {state.kind !== 'version' && <label>状态<select value={status} disabled={id !== null && !can('disable')} onChange={e => setStatus(e.target.value)}><option value="normal">正常</option><option value="inactive">停用</option></select></label>}
      {state.kind === 'version' && <>{field('versionName', '版本名称', '例如 2026年7月价格')}{field('effectiveStart', '生效日期', '', 'date')}{field('effectiveEnd', '失效日期', '', 'date')}<fieldset className="express-hierarchy-wide express-hierarchy-weight"><legend>可发货重量</legend><div className="express-hierarchy-grid">{field('shippingWeightMin', '最小可发货重量（kg）', '0', 'number')}{field('shippingWeightMax', '最大可发货重量（kg）', '不限', 'number')}</div><p>包含上下限；超出范围不报价、不参与推荐。上限留空表示不限。</p></fieldset></>}
      <label className="express-hierarchy-wide">备注<textarea value={values[state.kind === 'version' ? 'remark' : 'note'] ?? ''} onChange={e => update(state.kind === 'version' ? 'remark' : 'note', e.target.value)} placeholder={state.kind === 'version' ? '可填写本次调价原因或原始价格表说明' : state.kind === 'branch' ? '可填写网点价格口径、合作说明等' : '可填写合作说明、价格联系人等'} /></label>
    </fieldset>}</div><div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !loaded}>{busy ? '保存中…' : id ? '保存修改' : state.kind === 'version' ? '保存价格版本' : state.kind === 'carrier' ? '保存快递公司' : '保存经营网点'}</button></div>
  </form></div>;
}

import { useState, type FormEvent } from 'react';
import { PROVINCES, todayInChina } from '@kudesi/shared';
import { yuanToCents } from '../common';
import { expressApi, type SurchargeDraft } from './expressApi';
import './surchargeDialog.css';
export function SurchargeDialog({ versionId, onClose, onSaved }: { versionId: number; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(''), [start, setStart] = useState(todayInChina()), [end, setEnd] = useState('');
  const [type, setType] = useState<SurchargeDraft['chargeType']>('fixed'), [amount, setAmount] = useState('');
  const [custom, setCustom] = useState(false), [provinces, setProvinces] = useState<string[]>([]);
  const [mode, setMode] = useState<SurchargeDraft['weightMode']>('all'), [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [fileName, setFileName] = useState(''), [note, setNote] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault(); if (busy) return; setError('');
    if (!name.trim()) return setError('请填写加收名称');
    if (custom && !provinces.length) return setError('请选择适用省份');
    const value = amount.trim() === '' ? 0 : type === 'percent' ? Number(amount) : yuanToCents(amount);
    if (value === null || !Number.isFinite(value) || value < 0 || type !== 'percent' && !Number.isSafeInteger(value)) return setError('请填写有效的非负加收值，金额最多两位小数');
    const lower = mode === 'above' || mode === 'between' ? from.trim() === '' ? null : Number(from) : null;
    const upper = mode === 'below' || mode === 'between' ? to.trim() === '' ? null : Number(to) : null;
    if ((mode === 'above' || mode === 'between') && (lower === null || !Number.isFinite(lower) || lower < 0) || (mode === 'below' || mode === 'between') && (upper === null || !Number.isFinite(upper) || upper < 0) || mode === 'between' && Number(upper) <= Number(lower)) return setError('请填写完整且有效的重量范围');
    if (start && end && end < start) return setError('结束日期不能早于开始日期');
    const rows = (custom ? provinces : ['全部省份']).map(areaScope => ({ name: name.trim(), effectiveStart: start, effectiveEnd: end, areaScope, chargeType: type, amount: type === 'percent' ? null : value, percent: type === 'percent' ? value : null, weightMode: mode, weightStart: lower, weightEnd: upper, note: note.trim() }));
    setBusy(true);
    try { await expressApi.createSurcharge(versionId, { batchName: name.trim(), batchNote: note.trim(), rows, fileName: fileName || undefined }); onSaved(); }
    catch (e) { setError((e as Error).message || '保存失败'); setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation"><form className="modal wide express-surcharge-dialog" role="dialog" aria-modal="true" aria-label="新增临时加收" onSubmit={e => void save(e)}>
    <div className="modal-head"><div><h3>新增临时加收</h3><p>临时加收不进入基础价格表，后续快递对账时按日期、省份和重量范围匹配。</p></div><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></div>
    <div className="modal-body"><fieldset disabled={busy} className="express-surcharge-sections"><section><strong>基础信息</strong><p>加收名称、生效日期和加收方式。</p><div className="express-surcharge-fields"><label>加收名称<input value={name} maxLength={160} placeholder="例如 偏远地区临时加收" onChange={e => setName(e.target.value)} /></label><label>加收方式<select value={type} onChange={e => setType(e.target.value as SurchargeDraft['chargeType'])}><option value="fixed">固定金额</option><option value="percent">按比例</option><option value="per_kg">按公斤</option></select></label><label>开始日期<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label><label>结束日期<input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label><label>加收值<input inputMode="decimal" value={amount} placeholder="固定金额/比例/每公斤金额" onChange={e => setAmount(e.target.value)} /></label></div></section>
      <section><strong>适用省份</strong><p>选择全部省份，或按省份多选；多选保存时会拆成一省一条规则。</p><div className="toolbar"><button type="button" aria-pressed={!custom} onClick={() => setCustom(false)}>全部省份</button><button type="button" aria-pressed={custom} onClick={() => setCustom(true)}>选择省份</button></div>{custom && <div className="express-province-checks">{PROVINCES.map(province => <label key={province}><input type="checkbox" checked={provinces.includes(province)} onChange={() => setProvinces(current => current.includes(province) ? current.filter(item => item !== province) : [...current, province])} />{province}</label>)}</div>}</section>
      <section><strong>适用重量</strong><p>对账时会用这个重量范围匹配账单或订单。</p><div className="express-surcharge-fields"><label>重量范围<select value={mode} onChange={e => setMode(e.target.value as SurchargeDraft['weightMode'])}><option value="all">全重量段</option><option value="below">多少公斤以内</option><option value="above">多少公斤以上</option><option value="between">多少公斤到多少公斤</option></select></label>{mode !== 'all' && <label>{mode === 'below' ? '结束重量 kg' : '起始重量 kg'}<input type="number" min="0" step="any" value={mode === 'below' ? to : from} onChange={e => mode === 'below' ? setTo(e.target.value) : setFrom(e.target.value)} /></label>}{mode === 'between' && <label>结束重量 kg<input type="number" min="0" step="any" value={to} onChange={e => setTo(e.target.value)} /></label>}</div></section>
      <section><strong>凭据与备注</strong><p>保存加收通知文件名和口径说明。</p><div className="express-surcharge-fields"><label>上传附件凭据<input type="file" onChange={e => setFileName(e.target.files?.[0]?.name || '')} /></label><label>备注<textarea value={note} maxLength={5000} placeholder="填写通知口径、特殊说明等" onChange={e => setNote(e.target.value)} /></label></div></section></fieldset>{error && <div className="notice error" role="alert">{error}</div>}</div>
    <div className="modal-foot"><button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存临时加收'}</button><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button></div>
  </form></div>;
}

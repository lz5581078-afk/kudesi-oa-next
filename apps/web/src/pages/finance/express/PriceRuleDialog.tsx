import { useState, type FormEvent } from 'react';
import { resourceApi } from '../../../resources/api';
import { centsToYuan, yuanToCents } from '../common';
import type { RuleRow } from './expressApi';
import './hierarchyForm.css';

export function PriceRuleDialog({ rule, onClose, onSaved }: { rule: RuleRow & { id: number }; onClose: () => void; onSaved: () => void }) {
  const [province, setProvince] = useState(rule.province);
  const [formula, setFormula] = useState(rule.fixedPrice == null);
  const [start, setStart] = useState(String(rule.shipWeightMin ?? 0));
  const [end, setEnd] = useState(rule.shipWeightMax == null ? '' : String(rule.shipWeightMax));
  const [minExclusive, setMinExclusive] = useState(Boolean(rule.minExclusive));
  const [maxExclusive, setMaxExclusive] = useState(Boolean(rule.maxExclusive));
  const [firstWeight, setFirstWeight] = useState(String(rule.firstWeight ?? 1));
  const [amount, setAmount] = useState(centsToYuan(rule.fixedPrice ?? rule.firstPrice));
  const [extra, setExtra] = useState(centsToYuan(rule.extraPrice));
  const [note, setNote] = useState(rule.note ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault(); if (busy) return; setError('');
    const from = Number(start), to = end.trim() === '' ? null : Number(end);
    if (!province.trim()) return setError('请填写省份。');
    if (!start.trim() || !Number.isFinite(from) || from < 0) return setError('重量下限必须是大于或等于0的数字。');
    if (to !== null && (!Number.isFinite(to) || to <= from)) return setError('重量上限必须大于下限，或留空表示不限。');
    const value = yuanToCents(amount), continued = formula ? yuanToCents(extra) : null;
    if (value === null || !Number.isSafeInteger(value) || value < 0 || formula && (continued === null || !Number.isSafeInteger(continued) || continued < 0)) return setError('请填写有效的非负运费，金额最多两位小数。');
    setBusy(true);
    try { await resourceApi.update('finance-express-prices', rule.id, { province: province.trim(), shipWeightMin: from, shipWeightMax: to, minExclusive, maxExclusive, fixedPrice: formula ? null : value, firstWeight: formula ? Number(firstWeight) : null, firstPrice: formula ? value : null, extraPrice: continued, note }); onSaved(); }
    catch (e) { setError((e as Error).message || '保存失败'); setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation"><form className="modal express-hierarchy-form" role="dialog" aria-modal="true" aria-label="修改价格规则" onSubmit={e => void save(e)}>
    <div className="modal-head"><h3>修改价格规则</h3><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></div>
    <div className="modal-body"><fieldset disabled={busy} className="express-hierarchy-grid"><label>省份<input value={province} onChange={e => setProvince(e.target.value)} /></label><label>计费方式<select value={formula ? 'formula' : 'fixed'} onChange={e => setFormula(e.target.value === 'formula')}><option value="fixed">区间统一价</option><option value="formula">首重续重</option></select></label>
      <label>重量下限（kg）<div className="express-rule-bound"><select aria-label="重量下限条件" value={minExclusive ? 'exclusive' : 'inclusive'} onChange={e => setMinExclusive(e.target.value === 'exclusive')}><option value="inclusive">≥</option><option value="exclusive">&gt;</option></select><input aria-label="重量下限（kg）" type="number" min="0" step="any" value={start} onChange={e => setStart(e.target.value)} /></div></label>
      <label>重量上限（kg）<div className="express-rule-bound"><select aria-label="重量上限条件" value={maxExclusive ? 'exclusive' : 'inclusive'} onChange={e => setMaxExclusive(e.target.value === 'exclusive')}><option value="inclusive">≤</option><option value="exclusive">&lt;</option></select><input aria-label="重量上限（kg）" type="number" min="0" step="any" value={end} placeholder="不限" onChange={e => setEnd(e.target.value)} /></div></label>
      {formula && <label>首重（kg）<select value={firstWeight} onChange={e => setFirstWeight(e.target.value)}><option value="0">0</option><option value="1">1</option></select></label>}
      <label>{formula ? '首重运费（元）' : '基础运费（元）'}<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></label>{formula && <label>续重运费（元/kg）<input inputMode="decimal" value={extra} onChange={e => setExtra(e.target.value)} /></label>}
      <label className="express-hierarchy-wide">备注<textarea value={note} maxLength={5000} onChange={e => setNote(e.target.value)} /></label></fieldset>{error && <div className="notice error" role="alert">{error}</div>}</div>
    <div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存修改'}</button></div>
  </form></div>;
}

import { useState } from 'react';
import { PROVINCES } from '@kudesi/shared';
import { downloadText } from '../../../resources/csv';
import { centsToYuan } from '../common';
import { expressApi, type PriceRecognition, type RuleRow } from './expressApi';
import { parseRulesCsv, priceTemplateCsv, rulesToCsv } from './priceCsv';
import { correctedRecognitionRows, type RecognitionEdits } from './RecognitionPreview';
import './manualPriceDialog.css';

interface Draft {
  key: number; province: string; mode: 'fixed' | 'formula'; from: string; to: string;
  fixed: string; firstWeight: string; first: string; extra: string; note: string; minExclusive?: boolean; maxExclusive?: boolean;
}
const draftsFrom = (rules: RuleRow[]): Draft[] => rules.map((r, key) => ({ key, province: r.province, mode: r.fixedPrice == null ? 'formula' : 'fixed', from: String(r.shipWeightMin ?? 0), to: r.shipWeightMax == null ? '' : String(r.shipWeightMax), fixed: centsToYuan(r.fixedPrice), firstWeight: String(r.firstWeight ?? 1), first: centsToYuan(r.firstPrice), extra: centsToYuan(r.extraPrice), note: r.note ?? '', minExclusive: r.minExclusive, maxExclusive: r.maxExclusive }));
function parseDrafts(drafts: Draft[]): RuleRow[] {
  const rows: PriceRecognition['rows'] = [];
  const edits: RecognitionEdits = {};
  for (const d of drafts) {
    if (![d.from, d.to, d.fixed, d.first, d.extra].some(value => value.trim())) continue;
    const i = rows.length;
    rows.push({ province: d.province, minExclusive: d.minExclusive, maxExclusive: d.maxExclusive, warnings: [] });
    edits[i] = { ruleType: d.mode, shipWeightMin: d.from || '0', shipWeightMax: d.to, fixedPrice: d.fixed, firstWeight: d.firstWeight, firstPrice: d.first, extraPrice: d.extra, note: d.note };
  }
  return correctedRecognitionRows({ kind: 'price_table', rows, effectiveStart: '', effectiveEnd: '', extraRemark: '', confidence: 1, warnings: [], fileName: '', modelName: '' }, edits, new Set()) as RuleRow[];
}

/** Per-province rules stay independent, including multiple rules with the same weight bounds. */
export function ManualPriceDialog({ versionId, rules, onClose, onSaved }: { versionId: number; rules: RuleRow[]; onClose: () => void; onSaved: () => void }) {
  const [drafts, setDrafts] = useState(() => draftsFrom(rules));
  const [nextKey, setNextKey] = useState(rules.length);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const provinces = [...PROVINCES, ...(drafts.some(d => d.province === 'ALL') ? ['ALL'] : [])];
  const change = (key: number, patch: Partial<Draft>) => setDrafts(current => current.map(d => d.key === key ? { ...d, ...patch } : d));
  function add(province: string, mode: Draft['mode']) {
    setDrafts(current => [...current, { key: nextKey, province, mode, from: '', to: '', fixed: '', firstWeight: '1', first: '', extra: '', note: '' }]);
    setNextKey(current => current + 1);
  }
  async function importFile(file?: File) {
    if (!file) return;
    setError(''); setNotice('');
    try {
      const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result ?? '')); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsText(file, 'utf-8'); });
      const parsed = parseRulesCsv(text);
      if (parsed.errors.length) throw new Error(parsed.errors.join('；'));
      setDrafts(draftsFrom(parsed.rules)); setNextKey(parsed.rules.length);
      setNotice(`已读入 ${parsed.rules.length} 条规则，确认导入后才生效`);
    } catch (e) { setError((e as Error).message); }
  }
  function exportCurrent() {
    try { downloadText('当前快递价格表.csv', rulesToCsv(rules)); setError(''); }
    catch (e) { setError((e as Error).message); }
  }
  async function save() {
    setError('');
    let parsed: RuleRow[];
    try { parsed = parseDrafts(drafts); }
    catch (e) { setError((e as Error).message); return; }
    setBusy(true);
    try { await expressApi.saveRules(versionId, 'manual', parsed, true); onSaved(); }
    catch (e) { setError((e as Error).message || '保存失败'); setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation"><section className="modal wide express-manual-dialog" role="dialog" aria-modal="true" aria-label="手工创建快递价格表">
    <div className="modal-head"><div><strong>手工创建快递价格表</strong><p>按省份维护动态重量段价格，支持任意区间统一价和首重续重公式；确认后写入当前价格版本。</p></div><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></div>
    <div className="modal-body"><div className="toolbar"><button type="button" className="secondary-button" onClick={() => downloadText('快递价格表手工创建模板.csv', priceTemplateCsv())}>下载导入模板</button><button type="button" className="secondary-button" onClick={exportCurrent}>导出当前手工价格表</button><label className="secondary-button file-button">导入 CSV<input type="file" hidden accept=".csv,.txt" aria-label="导入手工价格CSV" disabled={busy} onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} /></label></div>
      <p className="muted">每个省份可以添加多条规则，例如 0–0.5kg 统一价、2.01–3.2kg 统一价、7.01–30kg 首重续重。空白规则不会生成价格。</p>
      {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice ok" role="status">{notice}</div>}
      {provinces.map(province => <section key={province} className="express-manual-province" aria-label={`${province === 'ALL' ? '全国' : province}规则`}><header><strong>{province === 'ALL' ? '全国' : province}</strong><div className="row-actions"><button type="button" className="secondary-button small" disabled={busy} onClick={() => add(province, 'fixed')}>加区间统一价</button><button type="button" className="secondary-button small" disabled={busy} onClick={() => add(province, 'formula')}>加首重续重</button></div></header>
        <div className="express-manual-rule-grid">{drafts.filter(d => d.province === province).map((d, i) => <fieldset className="express-manual-rule" key={d.key} disabled={busy} aria-label={`${province}第${i + 1}条规则`}>
          <label>规则类型<select value={d.mode} onChange={e => change(d.key, { mode: e.target.value as Draft['mode'] })}><option value="fixed">区间统一价</option><option value="formula">首重续重</option></select></label>
          <label>起始重量 kg<input type="number" step="any" min="0" value={d.from} placeholder="如 0" onChange={e => change(d.key, { from: e.target.value })} /></label>
          <label>结束重量 kg<input type="number" step="any" min="0" value={d.to} placeholder="空=以上" onChange={e => change(d.key, { to: e.target.value })} /></label>
          {d.mode === 'fixed' ? <label>区间统一价<input inputMode="decimal" value={d.fixed} onChange={e => change(d.key, { fixed: e.target.value })} /></label> : <><label>首重类型<select value={d.firstWeight} onChange={e => change(d.key, { firstWeight: e.target.value })}><option value="0">0公斤</option><option value="1">1公斤</option></select></label><label>首重金额<input inputMode="decimal" value={d.first} onChange={e => change(d.key, { first: e.target.value })} /></label><label>续重/公斤<input inputMode="decimal" value={d.extra} onChange={e => change(d.key, { extra: e.target.value })} /></label></>}
          <label className="express-manual-note">备注<input value={d.note} maxLength={5000} onChange={e => change(d.key, { note: e.target.value })} /></label><button type="button" className="link-button danger" onClick={() => setDrafts(current => current.filter(row => row.key !== d.key))}>删除规则</button>
        </fieldset>)}</div>
        {!drafts.some(d => d.province === province) && <p className="muted">未添加价格规则</p>}
      </section>)}
    </div><div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '确认生成手工价格表'}</button></div>
  </section></div>;
}

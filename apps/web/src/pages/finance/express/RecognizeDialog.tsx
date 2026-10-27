import { useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import { money } from '../common';
import { resourceApi } from '../../../resources/api';
import { expressApi, type PriceRecognition, type RuleRow, type SurchargeRecognition } from './expressApi';

const CHARGE: Record<string, string> = { fixed: '固定金额', percent: '按比例', per_kg: '按公斤' };
const WEIGHT: Record<string, string> = { all: '全部重量', below: '以内', above: '以上', between: '区间' };
const err = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

const rangeText = (r: RuleRow) => `${r.minExclusive ? '>' : '≥'}${r.shipWeightMin ?? 0}kg${r.shipWeightMax == null ? '' : ` ~ ${r.maxExclusive ? '<' : '≤'}${r.shipWeightMax}kg`}`;
const priceText = (r: RuleRow) => (r.fixedPrice != null ? money(r.fixedPrice) : `首重${r.firstWeight ?? '—'}kg ${money(r.firstPrice)} + 续重 ${money(r.extraPrice)}/kg`);

/**
 * AI 识别：价格表（图片、Excel、CSV）或临时加收通知。识别结果先列出来给人核对，
 * 有提醒的行默认不导入；确认后才写入，价格表会替换这个版本里原有的“AI 识别”那一套。
 */
export function RecognizeDialog({ versionId, kind, onClose, onDone }: { versionId: number; kind: 'price' | 'surcharge'; onClose: () => void; onDone: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PriceRecognition | SurchargeRecognition | null>(null);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [batchName, setBatchName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [remark, setRemark] = useState('');

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const r = await expressApi.recognize(versionId, kind, file);
      setResult(r);
      setPicked(file);
      setSkip(new Set(r.rows.flatMap((x, i) => (x.warnings.length ? [i] : []))));
      if (r.kind === 'surcharge_notice') setBatchName(r.batchName || file.name.replace(/\.[^.]+$/, ''));
      else { setStart(r.effectiveStart); setEnd(r.effectiveEnd); setRemark(r.extraRemark); }
    } catch (e) { setError(err(e)); }
    setBusy(false);
    if (input.current) input.current.value = '';
  }

  async function confirm() {
    if (!result) return;
    setBusy(true); setError('');
    try {
      if (result.kind === 'price_table') {
        const rules = result.rows.filter((_, i) => !skip.has(i)).map(({ warnings: _w, ...r }) => r);
        if (!rules.length) throw new Error('没有勾选任何价格行');
        const r = await expressApi.confirmPrice(versionId, { rules, fileName: result.fileName, modelName: result.modelName, effectiveStart: start || undefined, effectiveEnd: end || undefined, extraRemark: remark || undefined });
        onDone(`已导入 ${r.created} 条价格，并把这个版本的最终价格依据改为“AI 识别价格表”`);
      } else {
        const rows = result.rows.filter((_, i) => !skip.has(i)).map(({ warnings: _w, ...r }) => r);
        if (!rows.length) throw new Error('没有勾选任何加收规则');
        // 图片类通知把原图留作凭据（Excel/CSV 没有图，不留）
        let evidenceFileId: number | undefined;
        if (picked && picked.type.startsWith('image/')) evidenceFileId = (await resourceApi.uploadFile('finance-express-fee-batches', 'evidence', picked)).id;
        const r = await expressApi.confirmSurcharge(versionId, { batchName, rows, fileName: result.fileName, modelName: result.modelName, evidenceFileId });
        onDone(`已保存加收通知「${batchName}」，共 ${r.created} 条规则`);
      }
    } catch (e) { setError(err(e)); setBusy(false); }
  }

  const toggle = (i: number, on: boolean) => setSkip((s) => { const n = new Set(s); if (on) n.delete(i); else n.add(i); return n; });
  const title = kind === 'price' ? 'AI 识别价格表' : 'AI 识别临时加收通知';
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal wide" role="dialog" aria-label={title}>
        <div className="modal-head"><strong>{title}</strong></div>
        <div className="modal-body">
          <input ref={input} type="file" hidden aria-label="选择要识别的文件" accept="image/png,image/jpeg,image/webp,.xlsx,.csv,.txt" onChange={(e) => void pick(e.target.files?.[0])} />
          {!result && (
            <>
              <p>{kind === 'price' ? '上传快递报价单：图片、Excel（xlsx）、CSV 都可以。识别结果不会直接生效，要你核对后确认。' : '上传快递公司发来的临时加收通知（图片、Excel、CSV）。识别结果会按“一份通知 = 一个批次”保存。'}</p>
              <button type="button" className="primary-button" disabled={busy} onClick={() => input.current?.click()}>{busy ? '识别中，请稍等…' : '选择文件'}</button>
            </>
          )}
          {error && <div role="alert" className="notice error">{error}</div>}
          {result && (
            <>
              <p className="muted">文件：{result.fileName || '—'}，识别模型：{result.modelName}。有提醒的行默认不导入，核对无误后可以勾选。</p>
              {result.warnings.map((w) => <div key={w} className="bad-text">⚠ {w}</div>)}
              {result.kind === 'price_table' ? (
                <>
                  <div className="form-grid">
                    <label>生效日期（版本里没填才会补上）<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
                    <label>失效日期<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
                  </div>
                  <label>识别到的合作口径 / 退改费等（会追加到版本备注）<textarea rows={4} value={remark} onChange={(e) => setRemark(e.target.value)} /></label>
                  <div className="table-scroll"><table className="data-table">
                    <thead><tr><th>导入</th><th>省份</th><th>重量段</th><th>价格</th><th>提醒</th></tr></thead>
                    <tbody>{result.rows.map((r, i) => (
                      <tr key={i}><td><input type="checkbox" aria-label={`导入第${i + 1}行`} checked={!skip.has(i)} onChange={(e) => toggle(i, e.target.checked)} /></td>
                        <td>{r.province === 'ALL' ? '全国' : r.province}</td><td>{rangeText(r)}</td><td>{priceText(r)}</td><td className="bad-text">{r.warnings.join('；')}</td></tr>
                    ))}</tbody>
                  </table></div>
                  <p className="muted">确认后：会替换这个版本里已有的“AI 识别”价格，并把最终价格依据改为 AI 识别；手工那一套不动。</p>
                </>
              ) : (
                <>
                  <label>批次名称<input value={batchName} maxLength={160} onChange={(e) => setBatchName(e.target.value)} /></label>
                  <div className="table-scroll"><table className="data-table">
                    <thead><tr><th>导入</th><th>名称</th><th>省份</th><th>日期</th><th>加收</th><th>重量</th><th>提醒</th></tr></thead>
                    <tbody>{result.rows.map((r, i) => (
                      <tr key={i}><td><input type="checkbox" aria-label={`导入第${i + 1}行`} checked={!skip.has(i)} onChange={(e) => toggle(i, e.target.checked)} /></td>
                        <td>{r.name}</td><td>{r.areaScope}</td><td>{r.effectiveStart || '—'} ~ {r.effectiveEnd || '长期'}</td>
                        <td>{CHARGE[r.chargeType]} {r.chargeType === 'percent' ? `${r.percent ?? '—'}%` : money(r.amount)}{r.chargeType === 'per_kg' ? '/kg' : ''}</td>
                        <td>{WEIGHT[r.weightMode]}{r.weightStart != null ? ` ${r.weightStart}` : ''}{r.weightEnd != null ? `~${r.weightEnd}` : ''}</td><td className="bad-text">{r.warnings.join('；')}</td></tr>
                    ))}</tbody>
                  </table></div>
                </>
              )}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>{result ? '放弃' : '关闭'}</button>
          {result && <button type="button" className="secondary-button" disabled={busy} onClick={() => input.current?.click()}>换一个文件重新识别</button>}
          {result && <button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>{busy ? '保存中…' : '确认导入'}</button>}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import { resourceApi } from '../../../resources/api';
import { expressApi, type RecognitionModels, type PriceRecognition, type RuleRow, type SurchargeDraft, type SurchargeRecognition } from './expressApi';

import { correctedRecognitionRows, RecognitionPreview, type RecognitionEdits } from './RecognitionPreview';
import './recognitionPreview.css';

const err = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

/**
 * AI 识别：价格表（图片、Excel、CSV）或临时加收通知。识别结果先列出来给人核对，
 * 有提醒的行默认不导入；确认后才写入，价格表会替换这个版本里原有的“AI 识别”那一套。
 */
export function RecognizeDialog({ versionId, kind, onClose, onDone }: { versionId: number; kind: 'price' | 'surcharge'; onClose: () => void; onDone: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<RecognitionModels | null>(null);
  const [model, setModel] = useState('');
  useEffect(() => {
    let active = true;
    void expressApi.recognitionModels().then(options => {
      if (!active) return;
      setModels(options);
      const current = options.current;
      const preferred = current && options.providers.some(p => p.id === current.providerId && p.models.includes(current.modelId)) ? `${current.providerId}:${current.modelId}` : '';
      const first = options.providers.find(p => p.models.length);
      setModel(current ? preferred : first ? `${first.id}:${first.models[0]}` : '');
    }).catch(e => { if (active) setError(err(e)); });
    return () => { active = false; };
  }, []);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PriceRecognition | SurchargeRecognition | null>(null);
  const [edits, setEdits] = useState<RecognitionEdits>({});
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [batchName, setBatchName] = useState('');
  const [batchNote, setBatchNote] = useState('');
  const [remark, setRemark] = useState('');

  function pick(file: File | undefined) {
    if (busy) return;
    setPicked(file ?? null); setResult(null); setEdits({}); setSkip(new Set()); setError('');
  }

  async function recognize() {
    if (!picked) return setError('请先上传文件');
    const selected = models?.providers.flatMap(p => p.models.map(id => ({ value: `${p.id}:${id}`, providerId: p.id, modelId: id }))).find(option => option.value === model);
    if (!selected) return setError('请先选择 AI 模型');
    const file = picked;
    setBusy(true); setError('');
    try {
      const r = await expressApi.recognize(versionId, kind, file, { providerId: selected.providerId, modelId: selected.modelId });
      setResult(r);
      setEdits({});
      setBatchNote('');
      setPicked(file);
      setSkip(new Set(r.rows.flatMap((x, i) => (x.warnings.length ? [i] : []))));
      if (r.kind === 'surcharge_notice') { setBatchName(r.batchName || file.name.replace(/\.[^.]+$/, '')); setBatchNote(r.batchNote ?? ''); }
      else setRemark(r.extraRemark);
    } catch (e) { setError(err(e)); }
    setBusy(false);
    if (input.current) input.current.value = '';
  }

  async function confirm() {
    if (!result) return;
    setBusy(true); setError('');
    try {
      if (result.kind === 'price_table') {
        const rules = correctedRecognitionRows(result, edits, skip) as RuleRow[];
        if (!rules.length) throw new Error('没有勾选任何价格行');
        const r = await expressApi.confirmPrice(versionId, { rules, fileName: result.fileName, modelName: result.modelName, effectiveStart: result.effectiveStart || undefined, effectiveEnd: result.effectiveEnd || undefined, extraRemark: remark || undefined });
        onDone(`已导入 ${r.created} 条 AI 识别价格`);
      } else {
        const rows = correctedRecognitionRows(result, edits, skip) as Array<Omit<SurchargeDraft, 'warnings'>>;
        if (!batchName.trim()) throw new Error('请填写批次名称');
        if (!rows.length) throw new Error('没有勾选任何加收规则');
        // 图片类通知把原图留作凭据（Excel/CSV 没有图，不留）
        let evidenceFileId: number | undefined;
        if (picked && picked.type.startsWith('image/')) evidenceFileId = (await resourceApi.uploadFile('finance-express-fee-batches', 'evidence', picked)).id;
        const r = await expressApi.confirmSurcharge(versionId, { batchName: batchName.trim(), ...(batchNote.trim() ? { batchNote: batchNote.trim() } : {}), rows, fileName: result.fileName, modelName: result.modelName, evidenceFileId });
        onDone(`已保存加收通知「${batchName}」，共 ${r.created} 条规则`);
      }
    } catch (e) { setError(err(e)); setBusy(false); }
  }

  function addRule(index: number, mode: 'fixed' | 'formula') {
    if (!result || result.kind !== 'price_table' || busy) return;
    const province = edits[index]?.province ?? result.rows[index].province;
    const nextIndex = result.rows.length;
    setResult({ ...result, rows: [...result.rows, { province, shipWeightMin: 0, shipWeightMax: null, fixedPrice: null, firstWeight: null, firstPrice: null, extraPrice: null, warnings: [] }] });
    setEdits(current => ({ ...current, [nextIndex]: { ruleType: mode, ...(mode === 'fixed' ? { fixedPrice: '' } : { firstWeight: '1', firstPrice: '', extraPrice: '' }) } }));
  }
  function removeRule(index: number) {
    if (!result || result.kind !== 'price_table' || busy) return;
    setResult({ ...result, rows: result.rows.filter((_, i) => i !== index) });
    setSkip(current => new Set([...current].filter(i => i !== index).map(i => i > index ? i - 1 : i)));
    setEdits(current => Object.fromEntries(Object.entries(current).filter(([key]) => Number(key) !== index).map(([key, value]) => [Number(key) > index ? Number(key) - 1 : key, value])));
  }

  const toggle = (i: number, on: boolean) => setSkip((s) => { const n = new Set(s); if (on) n.delete(i); else n.add(i); return n; });
  const title = kind === 'price' ? '上传价格表 AI 识别' : '上传加收通知 AI 识别';
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal wide express-recognition-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><div><h3>{title}</h3><p>选择企业 AI 模型，上传文件后先预览识别结果，可修改后再确认导入。</p></div><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
        <div className="modal-body">
          <>
              <div className="form-grid"><label>AI 模型<select aria-label="AI 模型" disabled={busy} value={model} onChange={e => setModel(e.target.value)}><option value="">请选择 AI 模型</option>{models?.providers.flatMap(p => p.models.map(id => <option key={`${p.id}:${id}`} value={`${p.id}:${id}`}>{p.name} / {id}</option>))}</select></label><label>上传文件<input ref={input} type="file" aria-label="选择要识别的文件" accept="image/png,image/jpeg,image/webp,.xlsx,.csv,.txt,.json" disabled={busy} onChange={e => pick(e.target.files?.[0])} /></label></div>
              <div className="express-recognition-upload" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}>
                <strong>{picked?.name || '选择文件，也可以把图片/CSV/TXT 拖到这里'}</strong>
                <span>Excel 文件建议先另存为 CSV；图片类通知可直接上传给 AI 识别。</span>
              </div>
              <div className="toolbar"><button type="button" className="primary-button" disabled={busy || !picked} onClick={() => void recognize()}>{busy ? 'AI 识别中…' : '开始识别'}</button>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => { pick(undefined); if (input.current) input.current.value = ''; }}>清空</button></div>
          </>
          {error && <div role="alert" className="notice error">{error}</div>}
          {result && (
            <>
              <p className="muted">文件：{result.fileName || '—'}，识别模型：{result.modelName}。有提醒的行默认不导入，核对无误后可以勾选。</p>
              <p className="muted">可修改省份、重量和金额后再确认导入；金额以元填写，空的结束重量表示以上。</p>
              {result.warnings.map((w) => <div key={w} className="bad-text">⚠ {w}</div>)}
              {result.kind === 'price_table' ? (
                <>
                  <label>识别到的合作口径 / 退改费等（会追加到版本备注）<textarea rows={4} value={remark} onChange={(e) => setRemark(e.target.value)} /></label>
                  <p className="muted">确认后替换这个版本已有的 AI 识别价格，保留手工价格和已选择的最终价格依据。</p>
                </>
              ) : (
                <>
                  <label>批次名称<input value={batchName} maxLength={160} onChange={(e) => setBatchName(e.target.value)} /></label>
                  <label>批次备注<input value={batchNote} maxLength={5000} onChange={e => setBatchNote(e.target.value)} /></label>

                </>
              )}
              <RecognitionPreview result={result} edits={edits} skip={skip} busy={busy} onEdit={(i, field, value) => setEdits(current => ({ ...current, [i]: { ...current[i], [field]: value } }))} onToggle={toggle} onAdd={addRule} onRemove={removeRule} />
            </>
          )}
        </div>
        <div className="modal-foot">
          {result && <button type="button" className="secondary-button" disabled={busy} onClick={() => setResult(null)}>重新识别</button>}
          {result && <button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>{busy ? '保存中…' : '确认导入'}</button>}
        </div>
      </div>
    </div>
  );
}

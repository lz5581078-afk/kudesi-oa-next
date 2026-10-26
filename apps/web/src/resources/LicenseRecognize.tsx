import { useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { resourceApi } from './api';

const LABELS: Record<string, string> = {
  companyName: '主体名称', creditCode: '统一社会信用代码', legalPerson: '法人', licenseType: '类型', registeredCapital: '注册资本',
  address: '地址', businessScope: '经营范围', foundedAt: '成立日期', approvedAt: '核准日期', registrar: '登记机关',
};

/** 营业执照识别：选图 → 识别 → 弹出结果让人确认 → 点“确认填入”才写进表单，识别结果不会直接入库。 */
export function LicenseRecognizeButton({ onApply }: { onApply: (fields: Record<string, string>) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ fields: Record<string, string>; warnings: string[] } | null>(null);

  async function recognize(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      setResult(await resourceApi.recognizeLicense(file));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '识别失败');
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  }

  return (
    <div className="recognize">
      <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="选择营业执照图片" onChange={(e) => void recognize(e.target.files?.[0])} />
      <button type="button" className="secondary-button" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? '识别中…' : '📷 识别营业执照图片'}
      </button>
      <small className="muted"> 识别结果先给你确认，不会自动保存。</small>
      {error && <div role="alert" className="notice error">{error}</div>}
      {result && (
        <div className="notice recognize-result" role="dialog" aria-label="识别结果">
          <strong>识别结果（请核对）</strong>
          <dl className="kv">
            {Object.entries(result.fields).map(([k, v]) => (
              <div key={k} className="kv-row"><dt>{LABELS[k] ?? k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
          {result.warnings.map((w) => <div key={w} className="bad-text">⚠ {w}</div>)}
          <div className="row-actions">
            <button type="button" className="primary-button" onClick={() => { onApply(result.fields); setResult(null); }}>确认填入</button>
            <button type="button" className="secondary-button" onClick={() => setResult(null)}>放弃</button>
          </div>
        </div>
      )}
    </div>
  );
}

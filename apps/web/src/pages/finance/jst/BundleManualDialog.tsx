import {frozenBundleCode} from '@kudesi/shared';
import { useState } from 'react';
import { ApiError } from '../../../api/client';
import { resourceApi, type ResourceDto } from '../../../resources/api';

const FIELDS: Array<[string, string, string, number]> = [
  ['manualCode', 'code', '组合编码', 120], ['manualStyleCode', 'styleCode', '款式编码', 120], ['manualName', 'name', '组合名称', 300],
  ['manualShortName', 'shortName', '简称', 160], ['manualPropertiesValue', 'propertiesValue', '规格值（颜色及规格）', 255],
];

/** 手改组合的编码、款式编码、名称、简称、规格值：填了就覆盖自动生成的值，必须写原因；清空 = 恢复自动。 */
export function BundleManualDialog({ bundle, onClose, onDone }: { bundle: ResourceDto; onClose: () => void; onDone: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map(([k]) => [k, String(bundle.data[k] ?? '')])));
  const [reason, setReason] = useState(String(bundle.data.manualReason ?? ''));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const any = FIELDS.some(([k]) => vals[k].trim());
  const fixed = frozenBundleCode(bundle);
  async function save() {
    setBusy(true); setError('');
    try { await resourceApi.update('finance-bundles', bundle.id, { ...vals, manualReason: any ? reason.trim() : '' }); onDone(); onClose(); }
    catch (e) { setError(e instanceof ApiError ? e.message : (e as Error).message || '保存失败'); }
    setBusy(false);
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="手改编码和名称">
        <div className="modal-head between"><strong>手改编码和名称：{bundle.title}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          <p className="muted">名称、简称和规格值可维护；已固定的编码保持不变。{bundle.status === 'verified' && '这个组合已验证，改完会回到“需重新验证”。'}</p>
          {fixed && <div className="notice">已上传聚水潭，组合编码固定；款式、名称等其他资料可维护。</div>}
          <div className="form-grid">
            {FIELDS.map(([k, auto, label, max]) => (
              <label key={k} className="wide">{label}
                <div className="row-actions">
                  <input aria-label={label} readOnly={fixed && k==='manualCode'} className="grow" maxLength={max} value={vals[k]} placeholder={`自动：${String(bundle.data[auto] ?? '')}`} onChange={(e) => setVals({ ...vals, [k]: k === 'manualCode' || k === 'manualStyleCode' ? e.target.value.toUpperCase() : e.target.value })} />
                  {vals[k] && !(fixed && k==='manualCode') && <button type="button" className="link-button" onClick={() => setVals({ ...vals, [k]: '' })}>恢复自动</button>}
                </div>
              </label>
            ))}
            <label className="wide">改码/改名原因{any && <b className="req"> *</b>}<textarea aria-label="改码改名原因" rows={2} maxLength={500} value={reason} disabled={!any} onChange={(e) => setReason(e.target.value)} /></label>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-button" disabled={busy || (any && reason.trim().length < 2)} onClick={() => void save()}>保存</button>
        </div>
      </div>
    </div>
  );
}

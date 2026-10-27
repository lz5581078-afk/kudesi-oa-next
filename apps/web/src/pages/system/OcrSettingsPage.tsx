import { useCallback, useEffect, useState } from 'react';
import { createChecker } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { aiApi, type AiDefaults } from './aiApi';

/** OCR 设置：营业执照识别、快递价格表识别各用哪个 AI 服务商的哪个模型。没选时用“接口设置”里的识别大模型。识别结果都只是预填，人工核对后才入库。 */
export function OcrSettingsPage() {
  const { user } = useAuth();
  const canEdit = user ? createChecker(user.permissions)('system.ocr.edit') : false;
  const [data, setData] = useState<AiDefaults | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pick, setPick] = useState<Record<string, { providerId: number | ''; modelId: string }>>({});
  const load = useCallback(() => {
    aiApi.defaults().then((d) => {
      setData(d); setError('');
      setPick(Object.fromEntries(d.scopes.map((s) => [s.key, { providerId: s.current?.providerId ?? '', modelId: s.current?.modelId ?? '' }])));
    }).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, []);
  useEffect(load, [load]);
  async function save(key: string, label: string) {
    const v = pick[key];
    setError(''); setNotice('');
    try {
      await aiApi.setDefault(key, v.providerId === '' ? null : v.providerId, v.modelId || undefined);
      setNotice(v.providerId === '' ? `「${label}」已改回使用“接口设置”里的识别大模型` : `「${label}」已保存`);
      load();
    } catch (e) { setError(e instanceof ApiError ? e.message : '保存失败'); }
  }
  return (
    <div>
      <div className="page-head"><h1>OCR 设置</h1></div>
      <p className="muted">选择各识别功能使用的 AI 模型。服务商和模型清单在“AI API 接口”里维护；没有选择时，使用“接口设置”里的识别大模型。识别结果只是预填，需要人工核对后才会入库。</p>
      {notice && <div role="status" className="notice ok-notice">{notice}</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
      {data?.providers.length === 0 && <div className="notice">还没有 AI 服务商，先到“AI API 接口”添加。</div>}
      {data?.scopes.map((s) => {
        const v = pick[s.key] ?? { providerId: '', modelId: '' };
        const models = data.providers.find((p) => p.id === v.providerId)?.models ?? [];
        return (
          <div key={s.key} className="card settings-card" role="group" aria-label={s.label}>
            <div className="between"><h2 className="section-title">{s.label}</h2><span className={`pill ${s.current ? 'ok' : ''}`}>{s.current ? `${data.providers.find((p) => p.id === s.current!.providerId)?.name ?? ''} · ${s.current.modelId}` : '使用接口设置里的识别大模型'}</span></div>
            <label>AI 服务商
              <select value={v.providerId} disabled={!canEdit} onChange={(e) => setPick({ ...pick, [s.key]: { providerId: e.target.value ? Number(e.target.value) : '', modelId: '' } })}>
                <option value="">不指定（用接口设置里的识别大模型）</option>
                {data.providers.filter((p) => p.status !== 'inactive' || p.id === v.providerId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {v.providerId !== '' && (
              <label>模型
                <select value={v.modelId} disabled={!canEdit} onChange={(e) => setPick({ ...pick, [s.key]: { ...v, modelId: e.target.value } })}>
                  <option value="">（请选择）</option>{models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                {models.length === 0 && <small className="field-error-text">这个服务商还没有可选模型，请先在“AI API 接口”同步模型或填写默认模型名。</small>}
              </label>
            )}
            {canEdit && <div className="row-actions"><button type="button" className="primary-button" onClick={() => save(s.key, s.label)}>保存</button></div>}
          </div>
        );
      })}
    </div>
  );
}

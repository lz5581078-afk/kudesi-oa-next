import { useEffect, useState } from 'react';
import { api } from '../api/client';

export function useArchiveCodePreview(type: string, values: Record<string, unknown>, enabled: boolean) {
  const [result, setResult] = useState<{ code?: string; shortCode?: string }>({});
  const [error, setError] = useState('');
  const body = { name: values.name ?? '', shortName: values.shortName ?? '', code: values.code ?? '', shortCode: values.shortCode ?? '', categoryIds: values.categoryIds ?? [] };
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setResult({}); setError('');
    const timer = setTimeout(() => {
      api<{ code: string; shortCode?: string }>(`/resources/${type}/code-preview`, { method: 'POST', body: { values: body } })
        .then(result => { if (alive) setResult(result); })
        .catch(() => { if (alive) setError('自动编号预览暂不可用，保存时会重新生成。'); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [type, key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...result, error };
}

export function ArchiveCodeInput({ inputId, label, value, preview, manual, onManual, onChange, error }: { inputId: string; label: string; value: unknown; preview?: string; manual: boolean; onManual: (value: boolean) => void; onChange: (value: string) => void; error?: string }) {
  return <div className="reference-archive-code"><input id={inputId} aria-label={label} disabled={!manual} value={String(manual ? value ?? '' : value || preview || '')} placeholder="自动生成" onChange={event => onChange(event.target.value)}/><button type="button" className="link-button" onClick={() => { if (manual) onChange(''); else if (!value) onChange(preview || ''); onManual(!manual); }}>{manual ? '恢复自动' : '人工修正'}</button>{error && <small role="status">{error}</small>}</div>;
}

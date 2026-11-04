import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Pencil } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { referenceIdentity } from './referenceOptionsCache';

export function useArchiveCodePreview(type: string, values: Record<string, unknown>, enabled: boolean) {
  const {user}=useAuth();
  const [result, setResult] = useState<{scope:string;code?:string;shortCode?:string;error?:string}>();
  const body = { name: values.name ?? '', shortName: values.shortName ?? '', code: values.code ?? '', shortCode: values.shortCode ?? '', categoryIds: values.categoryIds ?? [] };
  const key = JSON.stringify(body);
  const scope=JSON.stringify([referenceIdentity(user),type,key,enabled]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setResult(undefined);
    const timer = setTimeout(() => {
      api<{ code: string; shortCode?: string }>(`/resources/${type}/code-preview`, { method: 'POST', body: { values: body } })
        .then(result => { if (alive) setResult({...result,scope}); })
        .catch(() => { if (alive) setResult({scope,error:'自动编号预览暂不可用，保存时会重新生成。'}); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const current=enabled&&result?.scope===scope?result:undefined;
  return { code:current?.code,shortCode:current?.shortCode,error:current?.error??'' };
}

export function ArchiveCodeInput({ inputId, label, value, preview, manual, onManual, onChange, error,placeholder,mode='contact',editing=false }: { inputId: string; label: string; value: unknown; preview?: string; manual: boolean; onManual: (value: boolean) => void; onChange: (value: string) => void; error?: string;placeholder?:string;mode?:'contact'|'expense';editing?:boolean }) {
  return <div className="reference-archive-code"><input id={inputId} aria-label={label} disabled={!manual && !editing} value={String(manual ? value ?? '' : value || preview || '')} placeholder={placeholder??(mode==='expense'?'如 FY-001':'自动生成')} onChange={event => onChange(event.target.value)}/>{!editing && <button type="button" className="link-button" onClick={() => { if(mode==='expense' && manual){onChange('');onManual(false);}else{if(!value)onChange(preview || '');onManual(true);} }}>{mode==='contact' && <Pencil size={14}/>} {mode==='expense' ? manual ? '自动' : '修改' : '人工修正'}</button>}{error && <small role="status">{error}</small>}</div>;
}

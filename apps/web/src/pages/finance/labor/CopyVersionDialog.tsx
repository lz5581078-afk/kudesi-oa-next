import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { UsersRound, X } from 'lucide-react';
import { api, ApiError } from '../../../api/client';
import { FieldInput } from '../../../resources/RecordForm';
import type { ResourceDto } from '../../../resources/api';
import '../../../resources/sectionedForm.css';

/** 复制是整版本的原子操作；字段和分区沿用通用版本资料配置。 */
export function CopyVersionDialog({ source, onClose, onCopied }: { source: ResourceDto; onClose: () => void; onCopied: (newId: number) => void }) {
  const def = getResourceDef('finance-labor-versions')!, presentation = def.form!;
  const [values, setValues] = useState<Record<string, unknown>>({ versionCode: `${String(source.data.versionCode ?? '')}-COPY`, versionName: `${String(source.data.versionName ?? source.title)} - 副本`, periodName: String(source.data.periodName ?? ''), effectiveFrom: String(source.data.effectiveFrom ?? ''), effectiveTo: String(source.data.effectiveTo ?? ''), note: String(source.data.note ?? source.data.remark ?? '') });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null), working = useRef(false), mounted = useRef(false), close = useRef(onClose);
  close.current = onClose;
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    form.current?.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.focus();
    const element = form.current;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !working.current) { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(element?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)') ?? []);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    element?.addEventListener('keydown', keydown);
    return () => { mounted.current = false; element?.removeEventListener('keydown', keydown); if(previous?.isConnected)previous.focus(); };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working.current) return;
    const required = def.fields.find(field => field.required && presentation.sections.some(section => section.fields.includes(field.key)) && !String(values[field.key] ?? '').trim());
    if (required) { setError(`请填写${required.label}`); form.current?.querySelector<HTMLInputElement>(`[id="${id}-${required.key}"]`)?.focus(); return; }
    working.current = true; setBusy(true); setError('');
    try {
      const { note, ...fields } = values;
      const result = await api<{ id: number }>(`/finance/labor/versions/${source.id}/copy`, { method: 'POST', body: { ...fields, remark: note } });
      if (mounted.current) onCopied(result.id);
    } catch (err) { if (mounted.current) { setError(err instanceof ApiError ? err.message : '复制失败'); setBusy(false); working.current = false; } }
  }
  return <div className="modal-backdrop sectioned-backdrop" onMouseDown={event => { if(event.target === event.currentTarget && !working.current)onClose(); }}>
    <form ref={form} className="modal card rf sectioned-editor rf-sectioned" style={{ '--sectioned-width': `${presentation.width}px`, '--sectioned-title': `${presentation.titleSize}px` } as CSSProperties} role="dialog" aria-modal="true" aria-label="复制人力成本版本" onSubmit={submit}>
      <header className="modal-head rf-head"><div className="rf-sectioned-icon"><UsersRound size={20}/></div><div className="rf-sectioned-heading"><span>{presentation.sectionLabel}</span><h2>复制人力成本版本</h2><p>{presentation.subtitle}</p></div><span className="rf-gap"/><button type="button" className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18}/></button></header>
      <div className="rf-main"><div className="rf-scroll">{error && <p className="notice error" role="alert">{error}</p>}{presentation.sections.map(section => <section key={section.title} className="rf-sec rf-configured-section" aria-label={section.title}><header><h3>{section.title}</h3><small>{section.hint}</small></header><div className="form-grid">{section.fields.map(key => {
        const field = def.fields.find(candidate => candidate.key === key)!;
        return <label key={key} className={`rf-field${section.wideFields?.includes(key) ? ' wide' : ''}`}><span className="rf-label">{field.label}</span><FieldInput field={field} inputId={`${id}-${key}`} type={def.key} value={values[key]} values={values} onChange={value => setValues(current => ({ ...current, [key]: value }))} known={{}} onKnown={() => {}}/></label>;
      })}</div></section>)}</div></div>
      <footer className="modal-foot rf-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button finance-form-save" disabled={busy}>{busy ? '保存中…' : presentation.saveLabel}</button></footer>
    </form>
  </div>;
}

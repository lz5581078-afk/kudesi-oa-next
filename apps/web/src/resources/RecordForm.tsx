import { FormEvent, useEffect, useMemo, useState } from 'react';
import { SIMILARITY_RESOURCES, unitYuanText, yuanToPreciseCents, createChecker, type FieldDef, type ResourceDef } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { resourceApi, type FileInfo, type ResourceDto } from './api';
import { FilesInput } from './FilesField';
import { LicenseRecognizeButton } from './LicenseRecognize';

export function MoneyControl({value,scale,onChange}:{value:unknown;scale:number;onChange:(v:unknown)=>void}) {
  const textOf=(v:unknown)=>v===undefined||v===null||v===''?'':unitYuanText(Number(v));
  const [text,setText]=useState(()=>textOf(value));
  useEffect(()=>{if(!Number.isNaN(value))setText(textOf(value));},[value]);
  return <input inputMode="decimal" value={text} placeholder={scale?'元（最多六位小数）':'元'} onChange={e=>{
    const raw=e.target.value;setText(raw);
    if(!raw.trim())return onChange('');
    try{onChange(yuanToPreciseCents(raw.trim().replace(/^\./,'0.'),scale));}catch{onChange(NaN);}
  }} />;
}

const refCache = new Map<string, Promise<Array<{ value: number; label: string; disabled?: boolean }>>>();
export function clearRefCache(type?: string) {
  if (type) refCache.delete(type);
  else refCache.clear();
}

export function loadRefOptions(target: string) {
  let p = refCache.get(target);
  if (!p) {
    p =
      target === 'department'
        ? resourceApi.departments().then((list) => list.map((d) => ({ value: d.id, label: d.name })))
        : target === 'user'
        ? resourceApi.users().then((list) => list.map((u) => ({ value: u.id, label: u.active ? u.name : `${u.name}（已停用）`, disabled: !u.active })))
        : resourceApi.list(target, { pageSize: 200, showHidden: true }).then((r) => r.items.map((i) => ({ value: i.id, label: i.title })));
    p.catch(() => refCache.delete(target));
    refCache.set(target, p);
  }
  return p;
}

function RefSelect({ field, value, onChange, labelNow }: { field: FieldDef; value: unknown; onChange: (v: number | null) => void; labelNow?: string }) {
  const [options, setOptions] = useState<Array<{ value: number; label: string; disabled?: boolean }> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadRefOptions(field.ref!).then((o) => alive && setOptions(o)).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [field.ref]);
  const current = typeof value === 'number' ? value : '';
  if (failed) return <input disabled value={labelNow ?? ''} placeholder="没有权限查看可选项" />;
  const list = options ?? [];
  const missing = current !== '' && !list.some((o) => o.value === current);
  return (
    <select value={current} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} disabled={!options}>
      <option value="">{options ? '（不选）' : '加载中…'}</option>
      {missing && <option value={current}>{labelNow ?? `#${current}`}</option>}
      {list.map((o) => (
        // 已停用的员工不能新选；若本来就是这个值则保留显示
        <option key={o.value} value={o.value} disabled={o.disabled && o.value !== current}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** 多选引用：勾选若干条记录（如供应商同时属于多个分类） */
function RefsSelect({ field, value, onChange, labelNow }: { field: FieldDef; value: number[]; onChange: (v: number[]) => void; labelNow?: string }) {
  const [options, setOptions] = useState<Array<{ value: number; label: string }> | null>(null);
  useEffect(() => {
    let alive = true;
    loadRefOptions(field.ref!).then((o) => alive && setOptions(o)).catch(() => alive && setOptions([]));
    return () => { alive = false; };
  }, [field.ref]);
  if (!options) return <span className="muted">加载中…</span>;
  const labels = (labelNow ?? '').split('、');
  const extra = value.filter((v) => !options.some((o) => o.value === v));
  return (
    <div className="check-list" role="group" aria-label={field.label}>
      {extra.map((v, i) => <label key={v} className="check"><input type="checkbox" checked onChange={() => onChange(value.filter((x) => x !== v))} /> {labels[i] ?? `#${v}`}</label>)}
      {options.map((o) => (
        <label key={o.value} className="check">
          <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))} />
          {o.label}
        </label>
      ))}
      {options.length === 0 && extra.length === 0 && <span className="muted">还没有可选项</span>}
    </div>
  );
}

/** 分类自定义属性：属性名来自所选分类（逗号分隔的 customFields），值写在本记录里。 */
function AttrsInput({ field, def, values, value, onChange }: { field: FieldDef; def: ResourceDef; values: Record<string, unknown>; value: unknown; onChange: (v: unknown) => void }) {
  const refField = def.fields.find((f) => f.key === field.attrsFrom);
  const catId = typeof values[field.attrsFrom!] === 'number' ? (values[field.attrsFrom!] as number) : null;
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!catId || !refField?.ref) { setNames([]); return; }
    let alive = true;
    resourceApi.get(refField.ref, catId).then((r) => { if (alive) setNames(String(r.data.customFields ?? '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean)); }).catch(() => alive && setNames([]));
    return () => { alive = false; };
  }, [catId, refField?.ref]);
  const cur = (value && typeof value === 'object' ? value : {}) as Record<string, string>;
  const keys = [...new Set([...names, ...Object.keys(cur)])];
  if (!catId) return <small className="muted">先选分类，再填这个分类的自定义属性</small>;
  if (keys.length === 0) return <small className="muted">这个分类没有设置自定义属性</small>;
  return (
    <div className="form-grid">
      {keys.map((k) => (
        <label key={k}><span>{k}{!names.includes(k) && <small className="muted">（原有，分类里已去掉）</small>}</span>
          <input value={cur[k] ?? ''} maxLength={200} onChange={(e) => onChange({ ...cur, [k]: e.target.value })} />
        </label>
      ))}
    </div>
  );
}

export function FieldInput({ field, value, onChange, configured, labelNow, type, known, onKnown }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void; configured?: boolean; labelNow?: string;
  type: string; known: Record<number, FileInfo>; onKnown: (f: FileInfo) => void;
}) {
  const str = value === undefined || value === null ? '' : String(value);
  switch (field.type) {
    case 'textarea':
      return <textarea rows={3} value={str} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />;
    case 'select':
      if (field.multi) {
        const picked = new Set(str.split('、').filter(Boolean));
        const toggle = (v: string, on: boolean) => {
          const next = new Set(picked);
          if (on) next.add(v); else next.delete(v);
          onChange((field.options ?? []).map((o) => o.value).filter((x) => next.has(x)).join('、'));
        };
        return (
          <div className="check-list" role="group" aria-label={field.label}>
            {field.options?.map((o) => <label key={o.value} className="check"><input type="checkbox" checked={picked.has(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} />{o.label}</label>)}
          </div>
        );
      }
      return (
        <select value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">（不选）</option>
          {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case 'bool':
      return <input type="checkbox" checked={value === true || value === 'true'} onChange={(e) => onChange(e.target.checked)} />;
    case 'date':
      return <input type="date" value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'monthday':
      return <input value={str} placeholder="MM-DD，如 03-15" maxLength={5} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <input type="number" min={0} value={str} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
    case 'decimal':
      return <input type="number" min={0} step="any" value={str} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
    case 'money':
      return <MoneyControl value={value} scale={field.scale ?? 0} onChange={onChange} />;
    case 'files':
      return <FilesInput field={field} type={type} value={Array.isArray(value) ? (value as number[]) : []} known={known} onChange={onChange} onKnown={onKnown} />;
    case 'refs':
      return <RefsSelect field={field} value={Array.isArray(value) ? (value as number[]) : []} onChange={onChange} labelNow={labelNow} />;
    case 'ref':
      return <RefSelect field={field} value={value} onChange={onChange} labelNow={labelNow} />;
    case 'secret':
      return (
        <input
          type="password"
          autoComplete="new-password"
          value={str}
          maxLength={field.maxLength}
          placeholder={configured ? '已设置，留空表示不修改' : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return <input value={str} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** 新建/编辑弹窗：按字段定义生成，按字段分组；showWhen 不满足的字段不显示。 */
export function RecordForm({ def, record, initial, lockedFields, onClose, onSaved }: {
  def: ResourceDef;
  record: ResourceDto | null;
  initial?: Record<string, unknown>;
  lockedFields?: string[];
  onClose: () => void;
  onSaved: (dto: ResourceDto) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...(record?.data ?? {}), ...(initial ?? {}) }));
  const [status, setStatus] = useState(record?.status ?? def.defaultStatus);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState<Record<number, FileInfo>>(record?.files ?? {});

  const { user: me } = useAuth();
  const canField = (f: FieldDef) => !f.permission || (me ? createChecker(me.permissions)(f.permission) : false);
  const visible = useMemo(() => {
    const ctx: Record<string, unknown> = { ...values, status };
    return def.fields.filter((f) => !f.readonly && canField(f)).filter((f) => !(def.key === 'fixed-assets' && record && f.key === 'userId')).filter((f) => !f.showWhen || f.showWhen.in.includes(String(ctx[f.showWhen.field] ?? '')));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, values, status, me]);
  const groups = useMemo(() => {
    const map = new Map<string, FieldDef[]>();
    for (const f of visible) map.set(f.group, [...(map.get(f.group) ?? []), f]);
    return [...map.entries()];
  }, [visible]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      // 只提交可见字段；密码类留空表示不修改，所以空值不提交
      const body: Record<string, unknown> = {};
      for (const f of visible) {
        const v = values[f.key];
        if (f.type === 'secret' && (v === undefined || v === '')) continue;
        body[f.key] = v === undefined ? (f.type === 'files' ? [] : f.type === 'attrs' ? {} : '') : v;
      }
      if (SIMILARITY_RESOURCES.includes(def.key)) {
        const sim = await resourceApi.similarCheck(def.key, { ...(record?.data ?? {}), ...body }, record?.id).catch(() => null);
        if (sim?.warnings.length && !window.confirm(`发现相似的资料，确定仍要保存吗？\n\n${sim.warnings.slice(0, 3).map((w) => w.text).join('\n')}`)) { setBusy(false); return; }
      }
      const saved = record ? await resourceApi.update(def.key, record.id, body) : await resourceApi.create(def.key, body, status);
      clearRefCache(def.key);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败，请重试');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card" role="dialog" aria-label={record ? `编辑${def.label}` : `新增${def.label}`} onSubmit={submit}>
        <div className="modal-head between">
          <strong>{record ? `编辑${def.label}` : `新增${def.label}`}</strong>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {def.key === 'licenses' && (
            <LicenseRecognizeButton
              onApply={(fields) => setValues((cur) => ({ ...cur, ...fields }))}
            />
          )}
          {!record && def.statuses.length > 1 && def.key !== 'fixed-assets' && (
            <label>初始状态
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {def.statuses.filter((s) => !s.requiresReason).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
          )}
          {groups.map(([group, fields]) => (
            <fieldset key={group}>
              <legend>{group}</legend>
              <div className="form-grid">
                {fields.map((f) => (
                  <label key={f.key} className={f.type === 'textarea' || f.type === 'attrs' ? 'wide' : undefined}>
                    <span>{f.label}{f.required && <b className="req"> *</b>}</span>
                    {f.type === 'attrs' ? <AttrsInput field={f} def={def} values={values} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} /> : <FieldInput
                      field={f}
                      value={lockedFields?.includes(f.key) ? initial?.[f.key] : values[f.key]}
                      configured={record?.secretConfigured[f.key]}
                      labelNow={record?.refLabels[f.key]}
                      type={def.key}
                      known={known}
                      onKnown={(info) => setKnown((cur) => ({ ...cur, [info.id]: info }))}
                      onChange={(v) => !lockedFields?.includes(f.key) && setValues((cur) => ({ ...cur, [f.key]: v }))}
                    />}
                    {f.help && <small className="muted">{f.help}</small>}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </div>
  );
}

/** 停用/删除等需要填写原因的确认框。 */
export function ReasonDialog({ title, hint, confirmLabel, danger, onClose, onConfirm }: {
  title: string; hint?: string; confirmLabel: string; danger?: boolean;
  onClose: () => void; onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation">
      <form
        className="modal card small"
        role="dialog"
        aria-label={title}
        onSubmit={async (e) => {
          e.preventDefault();
          if (reason.trim().length < 2) return setError('请填写原因（至少 2 个字）');
          setBusy(true);
          try {
            await onConfirm(reason.trim());
          } catch (err) {
            setError(err instanceof ApiError ? err.message : '操作失败');
            setBusy(false);
          }
        }}
      >
        <div className="modal-head"><strong>{title}</strong></div>
        <div className="modal-body">
          {hint && <p className="muted">{hint}</p>}
          <label>原因<textarea rows={3} autoFocus value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className={danger ? 'primary-button danger-fill' : 'primary-button'} disabled={busy}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

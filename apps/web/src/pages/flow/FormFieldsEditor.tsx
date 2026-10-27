import { useState } from 'react';
import { CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_LABEL, CUSTOM_REF_TARGETS, FLOW_FIELD_CATALOG, type FieldDef } from '@kudesi/shared';
import { newFieldKey } from './designerUi';

type CustomType = (typeof CUSTOM_FIELD_TYPES)[number];

/**
 * 表单字段编辑器：发起申请表单、每一步的办理页面都用它。
 * 字段编号由系统生成（用户只管名称和类型）；常用字段可以从字段目录一键加入。
 */
export function FormFieldsEditor({ fields, onChange, group, disabled, catalog = true }: { fields: FieldDef[]; onChange: (f: FieldDef[]) => void; group: string; disabled?: boolean; catalog?: boolean }) {
  const [pick, setPick] = useState('');
  const set = (i: number, patch: Partial<FieldDef>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = (f?: FieldDef) => onChange([...fields, f ? { ...f, group } : { key: newFieldKey(fields.map((x) => x.key)), label: '', type: 'text', group }]);
  const available = FLOW_FIELD_CATALOG.filter((c) => !fields.some((f) => f.key === c.key));
  return (
    <div className="fd-fields">
      {fields.length === 0 && <p className="muted">还没有字段。点“添加字段”，或从常用字段里选。</p>}
      {fields.map((f, i) => (
        <div key={f.key} className="fd-field" role="group" aria-label={`字段 ${f.label || f.key}`}>
          <label>名称
            <input disabled={disabled} value={f.label} maxLength={30} placeholder="例如：供应商" onChange={(e) => set(i, { label: e.target.value })} />
          </label>
          <label>类型
            <select disabled={disabled} value={f.type} onChange={(e) => {
              const type = e.target.value as CustomType;
              set(i, { type, options: type === 'select' ? f.options ?? [{ value: 'o1', label: '选项一' }, { value: 'o2', label: '选项二' }] : undefined, ref: type === 'ref' ? f.ref ?? 'user' : undefined });
            }}>
              {CUSTOM_FIELD_TYPES.map((t) => <option key={t} value={t}>{CUSTOM_FIELD_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label className="check-line"><input type="checkbox" disabled={disabled} checked={!!f.required} onChange={(e) => set(i, { required: e.target.checked })} />必填</label>
          {f.type === 'ref' && (
            <label>选择范围
              <select disabled={disabled} value={f.ref ?? 'user'} onChange={(e) => set(i, { ref: e.target.value })}>
                {CUSTOM_REF_TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
          )}
          {f.type === 'select' && (
            <label className="fd-wide">选项（每行一个）
              <textarea disabled={disabled} rows={3} value={(f.options ?? []).map((o) => o.label).join('\n')} onChange={(e) => {
                const labels = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 30);
                const old = f.options ?? [];
                set(i, { options: labels.map((label, k) => ({ value: old.find((o) => o.label === label)?.value ?? `o${Date.now().toString(36)}${k}`, label })) });
              }} />
            </label>
          )}
          <label className="fd-wide">填写提示（可选）
            <input disabled={disabled} value={f.help ?? ''} maxLength={100} onChange={(e) => set(i, { help: e.target.value || undefined })} />
          </label>
          {!disabled && (
            <span className="fd-actions">
              <button type="button" className="link-button" aria-label={`上移 ${f.label || f.key}`} disabled={i === 0} onClick={() => move(i, -1)}>上移</button>
              <button type="button" className="link-button" aria-label={`下移 ${f.label || f.key}`} disabled={i === fields.length - 1} onClick={() => move(i, 1)}>下移</button>
              <button type="button" className="link-button danger" aria-label={`删除字段 ${f.label || f.key}`} onClick={() => onChange(fields.filter((_, j) => j !== i))}>删除</button>
              <span className="muted mono small">{f.key}</span>
            </span>
          )}
        </div>
      ))}
      {!disabled && (
        <div className="row-actions">
          <button type="button" className="secondary-button" onClick={() => add()}>添加字段</button>
          {catalog && available.length > 0 && (
            <>
              <select aria-label="常用字段" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">从常用字段添加…</option>
                {available.map((c) => <option key={c.key} value={c.key}>{c.label}（{CUSTOM_FIELD_TYPE_LABEL[c.type as CustomType]}）</option>)}
              </select>
              <button type="button" className="secondary-button" disabled={!pick} onClick={() => { const c = available.find((x) => x.key === pick); if (c) add(c); setPick(''); }}>加入</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

import type { FieldDef } from '@kudesi/shared';
import { useState } from 'react';
import { FieldInput } from '../../resources/RecordForm';
import { FileList } from '../../resources/FilesField';
import type { FileInfo } from '../../resources/api';
import { PurchaseJsonField } from './PurchaseFields';
import { PURCHASE_TEMPLATE_KEY } from './purchaseApi';
import { SKU_TEMPLATE, SkuApplyFields, SkuWarehouseFields } from './SkuApply';

/** 流程表单：沿用资料表单的输入控件；金额界面按元、存整数分。 */
export function FlowFieldsForm({ fields, values, onChange, labels, templateKey, context, files }: {
  fields: FieldDef[]; values: Record<string, unknown>; onChange: (key: string, v: unknown) => void; labels?: Record<string, string>;
  /** 已上传文件的信息（重新提交时显示已有附件的缩略图） */
  files?: Record<number, FileInfo>;
  /** 有专用编辑器的流程（SKU 批量申请）传模板编号；context 是发起时的表单（仓库步骤要按规格逐个填） */
  templateKey?: string; context?: Record<string, unknown>;
}) {
  if (templateKey === SKU_TEMPLATE && fields.some((f) => f.key === 'specs')) return <SkuApplyFields values={values} onChange={onChange} />;
  if (templateKey === SKU_TEMPLATE && fields.some((f) => f.key === 'config')) {
    return (
      <>
        <SkuWarehouseFields specs={(Array.isArray(context?.specs) ? context!.specs : []) as never} values={values} onChange={onChange} />
        <FlowFieldsForm fields={fields.filter((f) => f.type !== 'json')} values={values} onChange={onChange} />
      </>
    );
  }
  return <GenericFields fields={fields} values={values} onChange={onChange} labels={labels} templateKey={templateKey} context={context} files={files} />;
}

function GenericFields({ fields, values, onChange, labels, templateKey, context, files }: {
  fields: FieldDef[]; values: Record<string, unknown>; onChange: (key: string, v: unknown) => void; labels?: Record<string, string>; templateKey?: string; context?: Record<string, unknown>; files?: Record<number, FileInfo>;
}) {
  const [known, setKnown] = useState<Record<number, FileInfo>>({});
  const purchase = templateKey === PURCHASE_TEMPLATE_KEY;
  // 内置流程的附件上传到“flow:模板编号”下，保存到流程里才算数
  const uploadType = purchase ? `flow:${templateKey}` : 'flow';
  // showWhen 不满足的字段不显示（服务端也会清掉）
  const shown = fields.filter((f) => !f.showWhen || f.showWhen.in.includes(String(values[f.showWhen.field] ?? '')));
  return (
    <div className="form-grid">
      {shown.map((f) => (
        <label key={f.key} className={f.type === 'textarea' || (purchase && f.type === 'json') ? 'wide' : undefined}>
          <span>{f.label}{f.required && <b className="req"> *</b>}</span>
          {purchase && f.type === 'json'
            ? <PurchaseJsonField field={f} values={values} context={context} onChange={(v) => onChange(f.key, v)} />
            : <FieldInput field={f} value={values[f.key]} labelNow={labels?.[f.key]} type={uploadType} known={{ ...(files ?? {}), ...known }} onKnown={(info) => setKnown((cur) => ({ ...cur, [info.id]: info }))} onChange={(v) => onChange(f.key, v)} />}
          {f.help && <small className="muted">{f.help}</small>}
        </label>
      ))}
    </div>
  );
}

/** 只读展示一份流程表单的值。 */
export function FlowValues({ fields, values, labels, files }: { fields: FieldDef[]; values: Record<string, unknown>; labels?: Record<string, string>; files?: Record<number, FileInfo> }) {
  const show = (f: FieldDef): React.ReactNode => {
    const v = values[f.key];
    if (v === undefined || v === null || v === '') return '—';
    if (f.type === 'ref') return labels?.[f.key] || `#${v}`;
    if (f.type === 'files') return Array.isArray(v) && v.length ? <FileList ids={v as number[]} files={files ?? {}} /> : '—';
    if (f.type === 'json') return '见下方明细';
    if (f.type === 'refs') return labels?.[f.key] || (Array.isArray(v) ? `${v.length} 项` : String(v));
    if (f.type === 'bool') return v ? '是' : '否';
    if (f.type === 'money') return `¥${(Number(v) / 100).toFixed(2)}`;
    if (f.type === 'select') return f.options?.find((o) => o.value === v)?.label ?? String(v);
    return String(v);
  };
  return (
    <dl className="kv-grid">
      {fields.map((f) => (<div key={f.key}><dt>{f.label}</dt><dd>{show(f)}</dd></div>))}
    </dl>
  );
}

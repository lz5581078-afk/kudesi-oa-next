import type { FieldDef } from '@kudesi/shared';
import { FieldInput } from '../../resources/RecordForm';
import { PURCHASE_TEMPLATE } from '@kudesi/shared';
import { PurchaseRequestFields } from './PurchaseFields';
import { PurchaseStepFields } from './PurchaseStepForms';
import { SKU_TEMPLATE, SkuApplyFields, SkuWarehouseFields } from './SkuApply';

/** 流程表单：沿用资料表单的输入控件；金额界面按元、存整数分。 */
export function FlowFieldsForm({ fields, values, onChange, labels, templateKey, context, stepKey, runId, refreshKey }: {
  fields: FieldDef[]; values: Record<string, unknown>; onChange: (key: string, v: unknown) => void; labels?: Record<string, string>;
  /** 有专用编辑器的流程（SKU 批量申请）传模板编号；context 是发起时的表单（仓库步骤要按规格逐个填） */
  templateKey?: string; context?: Record<string, unknown>;
  /** 采购申请：办理步骤的编号、流程编号（步骤表单要读采购状态、上传凭证） */
  stepKey?: string; runId?: number; refreshKey?: number;
}) {
  if (templateKey === PURCHASE_TEMPLATE && fields.some((f) => f.key === 'lines')) {
    return (
      <>
        <PurchaseRequestFields values={values} onChange={onChange} />
      </>
    );
  }
  if (templateKey === PURCHASE_TEMPLATE && stepKey && runId && fields.some((f) => f.key === 'data')) {
    return (
      <>
        <PurchaseStepFields runId={runId} stepKey={stepKey} refreshKey={refreshKey ?? 0} onChange={onChange} />
        <FlowFieldsForm fields={fields.filter((f) => f.type !== 'json')} values={values} onChange={onChange} />
      </>
    );
  }
  if (templateKey === SKU_TEMPLATE && fields.some((f) => f.key === 'specs')) return <SkuApplyFields values={values} onChange={onChange} />;
  if (templateKey === SKU_TEMPLATE && fields.some((f) => f.key === 'config')) {
    return (
      <>
        <SkuWarehouseFields specs={(Array.isArray(context?.specs) ? context!.specs : []) as never} values={values} onChange={onChange} />
        <FlowFieldsForm fields={fields.filter((f) => f.type !== 'json')} values={values} onChange={onChange} />
      </>
    );
  }
  return (
    <div className="form-grid">
      {fields.map((f) => (
        <label key={f.key} className={f.type === 'textarea' ? 'wide' : undefined}>
          <span>{f.label}{f.required && <b className="req"> *</b>}</span>
          <FieldInput field={f} value={values[f.key]} labelNow={labels?.[f.key]} type="flow" known={{}} onKnown={() => undefined} onChange={(v) => onChange(f.key, v)} />
          {f.help && <small className="muted">{f.help}</small>}
        </label>
      ))}
    </div>
  );
}

/** 只读展示一份流程表单的值。 */
export function FlowValues({ fields, values, labels }: { fields: FieldDef[]; values: Record<string, unknown>; labels?: Record<string, string> }) {
  const show = (f: FieldDef) => {
    const v = values[f.key];
    if (v === undefined || v === null || v === '') return '—';
    if (f.type === 'ref') return labels?.[f.key] || `#${v}`;
    if (f.type === 'json') return '见下方规格明细';
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

import type { FieldDef } from '@kudesi/shared';
import { useEffect, useRef, useState } from 'react';
import { FieldInput } from '../../resources/RecordForm';
import { FileList } from '../../resources/FilesField';
import { resourceApi, type FileInfo } from '../../resources/api';
import { PurchaseRequestFields } from './PurchaseFields';
import { PurchaseStepFields } from './PurchaseStepForms';
import { PurchaseJsonField } from './PurchaseCompatibilityFields';
import { PURCHASE_TEMPLATE_KEY } from './purchaseApi';
import { SKU_TEMPLATE, SkuApplyFields, SkuWarehouseFields } from './SkuApply';
import { liveApi, type SessionDetail } from '../live/liveApi';
import { StorePerformanceTable, storeDrafts, storePayload, type StoreDraft } from '../live/StorePerformanceTable';
import { liveJsonArray, type LiveStoreLine } from '@kudesi/shared';

/** 流程表单：沿用资料表单的输入控件；金额界面按元、存整数分。 */
export function FlowFieldsForm({ fields, values, onChange, labels, templateKey, context, files, stepKey, runId, refreshKey }: {
  fields: FieldDef[]; values: Record<string, unknown>; onChange: (key: string, v: unknown) => void; labels?: Record<string, string>;
  /** 已上传文件的信息（重新提交时显示已有附件的缩略图） */
  files?: Record<number, FileInfo>;
  stepKey?: string; runId?: number; refreshKey?: number;
  /** 有专用编辑器的流程（SKU 批量申请）传模板编号；context 是发起时的表单（仓库步骤要按规格逐个填） */
  templateKey?: string; context?: Record<string, unknown>;
}) {
  if (templateKey === PURCHASE_TEMPLATE_KEY && fields.some(f => f.key === 'requestedArrivalAt')) return <PurchaseRequestFields values={values} onChange={onChange} />;
  if (templateKey === PURCHASE_TEMPLATE_KEY && stepKey && runId && fields.some(f => f.key === 'data')) return <PurchaseStepFields runId={runId} stepKey={stepKey} refreshKey={refreshKey ?? 0} onChange={onChange} />;
  if (templateKey === SKU_TEMPLATE && fields.some((f) => f.key === 'specs')) return <SkuApplyFields values={values} onChange={onChange} />;
  if (templateKey === SKU_TEMPLATE && fields.some((f) => f.key === 'config')) {
    return (
      <>
        <SkuWarehouseFields specs={(Array.isArray(context?.specs) ? context!.specs : []) as never} values={values} onChange={onChange} />
        <FlowFieldsForm fields={fields.filter((f) => f.type !== 'json')} values={values} onChange={onChange} />
      </>
    );
  }
  if (templateKey === 'live-session-review' && fields.some(f=>f.key==='finalSource')) return <LiveReviewFields fields={fields} values={values} onChange={onChange} labels={labels} templateKey={templateKey} context={context} files={files}/>;
  return <GenericFields fields={fields} values={values} onChange={onChange} labels={labels} templateKey={templateKey} context={context} files={files} />;
}

/** The task inbox and live management use the same shop performance table. */
function LiveReviewFields(props: Parameters<typeof GenericFields>[0]) {
  const [session,setSession]=useState<SessionDetail|null>(null);
  const [error,setError]=useState('');
  const [rows,setRows]=useState<StoreDraft[]>([]);
  const edited=useRef(false);
  const id=Number(props.context?.sessionId);
  useEffect(()=>{let active=true;if(id)liveApi.session(id).then(s=>{if(active){setSession(s);setRows(storeDrafts(s.channels??[],liveJsonArray<LiveStoreLine>(props.values.storeLines).length?liveJsonArray<LiveStoreLine>(props.values.storeLines):s.reports.find(r=>r.role==='anchor')?.storeLines));}}).catch(()=>{if(active)setError('读取场次店铺失败，请刷新后审核');});return()=>{active=false;};},[id]);
  const multi=!!session?.channels?.length;
  const manual=props.values.finalSource==='manual';
  useEffect(()=>{
    if(!edited.current&&multi&&manual&&!props.values.storeLines)props.onChange('storeLines',session!.reports.find(r=>r.role==='anchor')?.storeLines??[]);
  },[multi,manual,props.values.storeLines,session]); // onChange belongs to the active task form
  return <>
    {error&&<p className="notice error" role="alert">{error}</p>}
    <GenericFields {...props} fields={props.fields.filter(f=>f.key!=='storeLines'&&!(multi&&f.key==='finalSalesCents'))}/>
    {multi&&manual&&<StorePerformanceTable channels={session!.channels!} rows={rows} onChange={next=>{edited.current=true;setRows(next);try{props.onChange('storeLines',storePayload(next));setError('');}catch{props.onChange('storeLines',[]);setError('请逐店填写有效营业额和投流费用');}}}/>}
  </>;
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

/** 附件字段的只读展示：显示文件名，点开用临时链接下载；没有权限或文件已删除时只显示编号并说明。 */
export function FlowFiles({ ids }: { ids: number[] }) {
  const [info, setInfo] = useState<Record<number, { name: string; url: string } | 'fail'>>({});
  useEffect(() => {
    let alive = true;
    for (const id of ids) {
      resourceApi.fileUrl(id).then((r) => alive && setInfo((c) => ({ ...c, [id]: { name: r.name, url: r.url } }))).catch(() => alive && setInfo((c) => ({ ...c, [id]: 'fail' })));
    }
    return () => { alive = false; };
  }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <ul className="plain-list file-links">
      {ids.map((id) => {
        const f = info[id];
        return <li key={id}>{!f ? <span className="muted">正在读取文件 #{id}…</span> : f === 'fail' ? <span className="muted">文件 #{id}（无法打开：没有权限或文件已删除）</span> : <a href={f.url} target="_blank" rel="noopener noreferrer" download={f.name}>{f.name}</a>}</li>;
      })}
    </ul>
  );
}

/** 只读展示一份流程表单的值。 */
export function FlowValues({ fields, values, labels, files }: { fields: FieldDef[]; values: Record<string, unknown>; labels?: Record<string, string>; files?: Record<number, FileInfo> }) {
  const show = (f: FieldDef): React.ReactNode => {
    const v = values[f.key];
    if (v === undefined || v === null || v === '') return '—';
    if (f.type === 'files') {
      const ids = (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) return '—';
      // 服务端已经给了文件信息的（采购等内置流程）显示缩略图；没有的（自建流程）显示文件名 + 下载链接，不再显示编号
      const known = ids.filter((id) => files?.[id]);
      const rest = ids.filter((id) => !files?.[id]);
      return <>{known.length > 0 && <FileList ids={known} files={files ?? {}} />}{rest.length > 0 && <FlowFiles ids={rest} />}</>;
    }
    if (f.type === 'ref') return labels?.[f.key] || `#${v}`;
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

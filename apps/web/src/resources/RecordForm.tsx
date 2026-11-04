import {sourceProductQualityDraft,currentSourceQualityConfirmations} from './sourceProductQualityDraft';
import {withSourceQualityKey,copySourceQualityRow} from './sourceQualityRows';
import {sourceFinishedNamesState,sourceFinishedNamesCommand,SOURCE_FINISHED_NAMES_COMMAND} from './sourceProductFinishedNames';
import {ProductArchiveBrandSelect} from './ProductArchiveBrandSelect';
import {PurchasePriceHistory} from './ProductPurchaseHistory';
import { ReasonDialog } from './ResourceConfirmDialog';
import { ReferencePartyCreateActions } from './ReferencePartyCreateActions';
import { ArchiveSimilarityNotice } from './ArchiveSimilarityNotice';
import './referencePartyCreate.css';
import './referenceExpenseCreate.css';
import './referenceCustomerDetail.css';
import { matchesProductCategoryFamily } from './productCategoryFamily';
import { useReferenceFieldFill } from './useReferenceFieldFill';
import { StoreJstSelect } from './StoreJstSelect';
import { CascadePicker } from './CascadePicker';
import { Fragment, FormEvent, type CSSProperties, useEffect, useMemo, useRef, useState, useId } from 'react';
import { fieldOptions, useUnitOptions, unitOptionsLoaded,unitOptionLabel } from './unitOptions';
import { selectChoices, useCategoryVersion } from './categoryOptions';
import { PRODUCT_UNIT_SEEDS, optionsKindOf, groupTitle, SIMILARITY_RESOURCES, isComposedArchive, resolveProductSections, productFormProblems, productLayout, productLayoutKey, type ResolvedNode, type QualityOptions, type SourceQualityConfirmations, type SourceQualityCommand, unitYuanText, sumUnitCents, LOGISTICS_CENT_SCALE, systemWeightG, specificationWeightG, yuanToPreciseCents, createChecker, permissionOwner, resourcePermission, type FieldDef, type ResourceDef, type ResourceFormInput } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { ApiError, api } from '../api/client';
import { CodePreview } from './CodePreview';
import { ManageLink } from './ManageLink';
import { BomDraft, bomCollection, loadBomRows, validBomRows, type BomDraftRow } from './BomDraft';
import { FieldHint } from './FieldHint';
import { resourceFields, resourceGroups, resourceFieldWide } from './resourceFieldLayout';
import { displayValue } from './format';
import { fieldSpan, needsZeroReason } from './productFormGrid';
import './productForm.css';
import './referenceForm.css';
import { X, Pencil, FolderTree, Database, UsersRound, ClipboardList } from 'lucide-react';
import { referenceRecordLabel, referencePartyGroups, referenceFieldSpan, REFERENCE_PARTIES } from './referenceFormLayout';
import { ReferenceProductCategoryPicker } from './ReferenceProductCategoryPicker';
import { ArchiveCodeInput, useArchiveCodePreview } from './ArchiveCodeInput';
import { ResourceCodePreview } from './ResourceCodePreview';
import { ResourceFormContext } from './ResourceFormContext';
import './sectionedForm.css';
import { ResourceDictionaryButton } from './ResourceDictionaryManager';
import { ZeroValueConfirmation } from './ZeroValueConfirmation';
import { SupplierCategoryContext } from './SupplierCategoryContext';
import { FeeBookingNodes } from './FeeBookingNodes';
import { ReferenceCategoryContext } from './ReferenceCategoryContext';
import { useProductDraftFacts } from './useProductDraftFacts';
import { ReferenceRecordHistory } from './ReferenceRecordHistory';
import { ReferenceLines, FreightHistory, CompositionResult, ProductCompositionFormula,ProductFormPhotos } from './ReferenceProductFields';
import { BundleProfileEditor } from './BundleProfileEditor';
import { BaseCodeProfileEditor } from './BaseCodeProfileEditor';
import { SourcesDraft, WeightBlock, PackageWeightFields, latestSource, loadSourceRows, sourceCollection, type SourceRow } from './ProductFormParts';
import { draftApi, resourceApi, type FileInfo, type ResourceDto } from './api';
import { ProductQualityDialog } from './ProductQualityDialog';
import { FilesInput } from './FilesField';
import { LicenseRecognizeButton } from './LicenseRecognize';
import { RefSelect, RefsSelect, clearRefCache, loadRefOptions } from './ResourceReferenceControls';
export { RefSelect, RefsSelect, loadRefOptions, clearRefCache } from './ResourceReferenceControls';
import {productReferenceCostText} from './productReferenceList';
import './resourceWorkspace.css';
import './sourceProductForm.css';

export function MoneyControl({value,scale,onChange,ariaLabel,inputId,appearance,placeholder,displayDecimals,readOnly=false}:{value:unknown;scale:number;onChange:(v:unknown)=>void;ariaLabel?:string;inputId?:string;appearance?:FieldDef['moneyInput'];placeholder?:string;displayDecimals?:8;readOnly?:boolean}) {
  const textOf=(v:unknown)=>v===undefined||v===null||v===''?'':displayDecimals===8?(Number(v)/100).toFixed(8).replace(/\.?0+$/,''):unitYuanText(Number(v),scale);
  const [text,setText]=useState(()=>textOf(value));
  useEffect(()=>{if(!Number.isNaN(value))setText(textOf(value));},[value,scale,displayDecimals]);
  const input = <input readOnly={readOnly} id={inputId} aria-label={ariaLabel} type={appearance?.nativeNumber ? 'number' : undefined} min={appearance?.nativeNumber ? 0 : undefined} step={appearance?.nativeNumber ? (10 ** -(scale + 2)).toFixed(scale + 2) : undefined} inputMode="decimal" value={text} placeholder={placeholder ?? (scale?`元（最多${scale+2}位小数）`:'元')} onChange={e=>{
    const raw=e.target.value;setText(raw);
    if(!raw.trim())return onChange('');
    try{onChange(yuanToPreciseCents(raw.trim().replace(/^\./,'0.'),scale));}catch{onChange(NaN);}
  }} />;
  return appearance?.currency ? <div className="rf-money-input"><span aria-hidden="true">{appearance.currency}</span>{input}</div> : input;
}

/** 分类自定义属性：属性名来自所选分类（逗号分隔的 customFields），值写在本记录里。 */
export function AttrsInput({ field, def, values, value, onChange }: { field: FieldDef; def: ResourceDef; values: Record<string, unknown>; value: unknown; onChange: (v: unknown) => void }) {
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

export function FieldInput({ field, value, onChange, configured, labelNow, type, known, onKnown, values, inputId, readOnly = false,emptySelectLabel,onPendingChange }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void; configured?: boolean; labelNow?: string;
  type: string; known: Record<number, FileInfo>; onKnown: (f: FileInfo) => void;
  /** 整张表单当前的值（“规格单位”这类按档案类型换列表的字段要看它） */
  values?: Record<string, unknown>; inputId?: string; readOnly?: boolean;emptySelectLabel?:string|false;onPendingChange?:(pending:boolean)=>void;
}) {
  const units = useUnitOptions();
  useCategoryVersion(); // 分类改名/新增后下拉立即刷新
  const str = value === undefined || value === null ? '' : String(value);
  if (readOnly) return <input id={inputId} readOnly value={field.type === 'select' ? field.options?.find(option=>option.value===str)?.label ?? str : str}/>;
  if (type === 'finance-products' && field.key === 'purchaseSpec') {
    const own = fieldOptions(field, values ?? {}, units);
    const options = own.length ? own : PRODUCT_UNIT_SEEDS.filter(([kind]) => kind === 'system_spec').map(([,label]) => ({ value:label,label }));
    return <select id={inputId} value={str} onChange={event => onChange(event.target.value)}><option value="">请选择系统规格</option>{str && !options.some(option => option.value === str) && <option value={str}>{str}</option>}{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  }
  if(type==='finance-products'&&field.key==='brandId')return <ProductArchiveBrandSelect inputId={inputId} value={value} labelNow={labelNow} onChange={onChange} onPendingChange={onPendingChange}/>;
  if (type === 'stores' && field.key === 'jushuitanShopId') return <StoreJstSelect value={str} currentName={String(values?.jushuitanShopName ?? '')} onChange={onChange} />;
  switch (field.input ?? field.type) {
    case 'textarea':
      return <textarea id={inputId} rows={3} value={str} placeholder={field.placeholder} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />;
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
        <select id={inputId} value={str} onChange={(e) => onChange(e.target.value)}>
          {emptySelectLabel!==false && <option value="">{emptySelectLabel ?? '（不选）'}</option>}
          {selectChoices(type, field, (f) => {const kind=optionsKindOf(f,values??{});return type==='finance-products'&&['archive_unit','packaging_unit','shipping_unit'].includes(kind??'')&&!units[kind!]?.length?[['B','包'],['J','斤'],['D','袋'],['PCS','件'],['G','克'],['KG','千克']].map(([value,label])=>({value,label})):f.optionsFrom ? fieldOptions(f, values ?? {}, units) : f.options ?? [];}, { mode: 'form', current: str }).map((o) => <option key={o.value} value={o.value}>{type==='finance-products'&&['specUnit','productPackagingUnit'].includes(field.key)&&o.value!==o.label?`${o.label}（${o.value}）`:o.label}</option>)}
          {/* 记录里原来的值不在现在的列表里（历史数据、已停用的项）也要能看到 */}
          {field.optionsFrom && str && !fieldOptions(field, values ?? {}, units).some((o) => o.value === str) && <option value={str}>{str}</option>}
        </select>
      );
    case 'bool':
      return <input id={inputId} type="checkbox" checked={value === true || value === 'true'} onChange={(e) => onChange(e.target.checked)} />;
    case 'date':
      return <input id={inputId} type="date" value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'monthday':
      return <input id={inputId} value={str} placeholder="MM-DD，如 03-15" maxLength={5} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <input id={inputId} type="number" min={0} value={str} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
    case 'decimal':
      return <input id={inputId} type="number" min={0} step="any" value={str} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
    case 'money':
      return <MoneyControl inputId={inputId} value={value} scale={field.scale ?? 0} appearance={field.moneyInput} displayDecimals={type==='finance-products'?8:undefined} placeholder={field.placeholder} onChange={onChange} />;
    case 'files':
      return <FilesInput field={field} type={type} value={Array.isArray(value) ? (value as number[]) : []} known={known} onChange={onChange} onKnown={onKnown} />;
    case 'refs':
      return <RefsSelect leafOnly={type === 'finance-suppliers' && field.key === 'categoryIds'} field={field} value={Array.isArray(value) ? (value as number[]) : []} onChange={onChange} labelNow={labelNow} />;
    case 'ref':
      if (field.cascade && field.ref) return <CascadePicker target={field.ref} label={field.label} value={typeof value === 'number' ? value : null} onChange={onChange} labelNow={labelNow} />;
      return <RefSelect inputId={inputId} field={field} value={value} onChange={onChange} labelNow={labelNow} emptyLabel={emptySelectLabel===false?undefined:emptySelectLabel} />;
    case 'secret':
      return <SecretInput inputId={inputId} value={str} maxLength={field.maxLength} placeholder={configured ? '已设置，留空表示不修改' : ''} onChange={onChange} />;
    default: {
      // 系统规格这类“可以选公司维护的，也可以手填”的文本
      const hints = field.optionsFrom ? fieldOptions(field, values ?? {}, units).map((o) => o.label) : [];
      const listId = hints.length ? `hints-${field.key}` : undefined;
      return (
        <>
          <input id={inputId} value={str} maxLength={field.maxLength} placeholder={field.placeholder} list={listId} onChange={(e) => onChange(field.inputCase === 'upper' ? e.target.value.toUpperCase() : e.target.value)} />
          {listId && <datalist id={listId}>{hints.map((h) => <option key={h} value={h} />)}</datalist>}
        </>
      );
    }
  }
}

/** 密码输入：默认遮住，点“显示输入”才看到自己输入的内容（核对有没有输错）。 */
function SecretInput({ value, maxLength, placeholder, onChange, inputId }: { value: string; maxLength?: number; placeholder: string; onChange: (v: string) => void; inputId?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="secret-input-row">
      <input id={inputId} type={shown ? 'text' : 'password'} autoComplete="new-password" value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="link-button" aria-pressed={shown} onClick={() => setShown((v) => !v)}>{shown ? '隐藏输入' : '显示输入'}</button>
    </span>
  );
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

type SaveMode = 'close' | 'blank' | 'keep';

function initialFormValues(def: ResourceDef, input: Record<string, unknown>) {
  const values = { ...input };
  for (const field of def.fields) {
    if (field.initialValue === undefined || values[field.key] !== undefined) continue;
    if (field.showWhen && !field.showWhen.in.includes(String(values[field.showWhen.field] ?? ''))) continue;
    values[field.key] = field.initialValue;
  }
  return values;
}

/** 新建/编辑弹窗：按字段定义生成，按字段分组；showWhen 不满足的字段不显示。 */
export function RecordForm(props: Parameters<typeof GenericRecordForm>[0]) {
  if (props.def.key === 'finance-bundles' && props.record && !props.inline) return <BundleProfileEditor record={props.record} onClose={props.onClose} onSaved={props.onSaved} />;
  if (props.def.key === 'finance-base-codes' && props.record && !props.inline) return <BaseCodeProfileEditor record={props.record} onClose={props.onClose} onSaved={props.onSaved} />;
  return <GenericRecordForm {...props} />;
}

function GenericRecordForm({ def, record, initial, lockedFields, onlyGroup, inline, inDetail, inlineStatusSelectAfter, onCloseReady, onClose, onDismiss, onSaved, onContinued }: {
  def: ResourceDef;
  record: ResourceDto | null;
  initial?: Record<string, unknown>;
  lockedFields?: string[];
  /** 只编辑这一个分区的字段（详情页“编辑本区”） */
  onlyGroup?: string;
  /** 就地编辑：不弹窗，直接在详情页该分区的位置显示表单 */
  inline?: boolean;
  /** 整条资料在原详情位置编辑，保留分区及字段列位置。 */
  inDetail?: boolean;
  /** Optional inline presentation; uses the existing status and save transaction. */
  inlineStatusSelectAfter?: string;
  /** 详情标题栏关闭也经过未保存检查。 */
  onCloseReady?: (close: (() => void) | null) => void;
  onClose: () => void;
  /** 供应商原位编辑的关闭整窗；取消编辑仍返回查看态。 */
  onDismiss?: () => void;
  onSaved: (dto: ResourceDto) => void;
  /** 提供了它，新建时就多出“保存并继续新建”：保存后不关弹窗，列表由它刷新 */
  onContinued?: (dto: ResourceDto) => void;
}) {
  const formId = useId().replace(/:/g, '');
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (inline) return;
    const previous = document.activeElement as HTMLElement | null;
    if(!record && REFERENCE_PARTIES.includes(def.key))formRef.current?.querySelector<HTMLInputElement>('[data-field="name"] input')?.focus();
    else formRef.current?.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [inline]);
  const copyOf = typeof initial?.__copyOf === 'number' ? initial.__copyOf : null;
  const [copySource,setCopySource]=useState<ResourceFormInput['copySource']>(()=>!record && copyOf && typeof initial?.__copyVersion==='string' ? {id:copyOf,version:initial.__copyVersion,files:Object.fromEntries(def.fields.filter(f=>f.type==='files' && f.copyOnCreate && Array.isArray(initial[f.key])).map(f=>[f.key,initial[f.key] as number[]]))} : undefined);
  const [values, setValues] = useState<Record<string, unknown>>(() => { const v: Record<string, unknown> = { ...(!record && def.key === 'finance-fee-items' ? {direction:'expense',platform:'any',isCommon:'yes',needFlow:'by_amount'} : {}), ...(record?.data ?? {}), ...(initial ?? {}) }; delete v.__copyOf; delete v.__copyVersion; delete v.__copyFiles; if(def.key==='finance-products'&&['package','oem_package'].includes(String(v.archiveType))&&!v.weightUnit)v.weightUnit=record||copyOf?'kg':'g'; if(def.key==='finance-products'&&(record||copyOf)&&v.archiveType==='purchased'&&v.supplyMode!=='supplier_oem'&&v.weightManual===undefined)v.weightManual=true; return record ? v : initialFormValues(def, v); });
  const [status, setStatus] = useState(record?.status ?? def.defaultStatus);
  const [statusReason, setStatusReason] = useState('');
  const referenceStatus = def.key==='finance-fee-items' || def.key==='finance-customers' && !!record;
  const supplierEdit=!!record&&def.key==='finance-suppliers';
  const customerEdit=!!record&&def.key==='finance-customers';
  const expenseEdit=!!record&&def.key==='finance-fee-items';
  const structuredPartyEdit=customerEdit||expenseEdit;
  const contactCreate=!record && ['finance-suppliers','finance-customers'].includes(def.key);
  const expenseCreate=!record && def.key==='finance-fee-items';
  const [error, setError] = useState('');
  const [feeReasonSave,setFeeReasonSave]=useState<{body:Record<string,unknown>;mode:SaveMode}|null>(null);
  const [bomRows, setBomRows] = useState<BomDraftRow[]>([]);
  const [bomOrig, setBomOrig] = useState<BomDraftRow[]>([]);
  const [sourceRows, setSourceRows] = useState<SourceRow[]>([]);
  const [sourceOrig, setSourceOrig] = useState<SourceRow[]>([]);
  // 读不出来（没有权限等）时为 null：不在表单里校验，交给服务端
  const [partsKnown, setPartsKnown] = useState({ sources: true, composition: true });
  const [partsLoading,setPartsLoading]=useState(()=>({sources:def.key==='finance-products'&&Boolean(record||copyOf)&&['raw','shipping_material'].includes(productLayoutKey(values)),composition:def.key==='finance-products'&&Boolean(record||copyOf)&&['self_made','purchased_oem'].includes(productLayoutKey(values))}));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [fieldPending, setFieldPending] = useState<Record<string, boolean>>({});
  const fieldPendingRef = useRef<Record<string, boolean>>({});
  const pendingHandlers = useRef<Record<string, (pending: boolean) => void>>({});
  const pendingChange = (key: string) => pendingHandlers.current[key] ?? (pendingHandlers.current[key] = pending => {
    fieldPendingRef.current[key] = pending;
    setFieldPending(current => current[key] === pending ? current : { ...current, [key]: pending });
  });
  const hasFieldPending = Object.values(fieldPending).some(Boolean);
  const hasDraftPending=Object.entries(fieldPending).some(([key,pending])=>key!=='codePreview'&&pending);
  const guardPendingFields = (draft=false) => {
    const pending=Object.entries(fieldPendingRef.current).filter(([key,value])=>value&&(!draft||key!=='codePreview'));
    if(!pending.length&&(draft||!waitingForAutoCode))return false;
    setError(pending.some(([key])=>key!=='codePreview')?'品牌正在保存，请稍后再保存档案。':'编号预览尚未完成，请稍后保存或检查预览错误。');
    return true;
  };
  const formRequestKey = useRef('');
  if (['finance-products','finance-fee-items','finance-suppliers'].includes(def.key) && !formRequestKey.current) formRequestKey.current = crypto.randomUUID();
  const [known, setKnown] = useState<Record<number, FileInfo>>(record?.files ?? initial?.__copyFiles as Record<number,FileInfo> ?? {});
  // 新建时填了内容就关闭，先确认，免得点错丢内容（旧系统同款）
  const startValues = useRef(JSON.stringify(values));
  const formUnits = useUnitOptions();
  const initialOptionsApplied = useRef(new Set<string>());
  const touchedInitialOptions = useRef(new Set<string>());
  const optionDefaultContext = JSON.stringify(def.fields.filter(field => field.initialOption).map(field => [field.key, values[field.optionsFrom?.kindBy?.field ?? ''], values[field.initialOption?.except?.field ?? ''], values[field.initialOption?.when?.field ?? '']]));
  useEffect(() => {
    if (record || copyOf || !unitOptionsLoaded()) return;
    const defaults: Record<string, string> = {};
    for (const field of def.fields) {
      const rule = field.initialOption;
      if (!rule || touchedInitialOptions.current.has(field.key) || lockedFields?.includes(field.key)) continue;
      if (rule.when && !rule.when.in.includes(String(values[rule.when.field] ?? ''))) continue;
      if (field.optionsFrom?.kindBy && !values[field.optionsFrom.kindBy.field]) continue;
      if (rule.except?.in.includes(String(values[rule.except.field] ?? ''))) continue;
      const kind = rule.sourceKind ?? optionsKindOf(field, values), scope = `${field.key}:${kind ?? ''}:${optionDefaultContext}`;
      if (initialOptionsApplied.current.has(scope)) continue;
      initialOptionsApplied.current.add(scope);
      if (values[field.key] !== undefined && values[field.key] !== null && values[field.key] !== '') continue;
      const first = kind ? formUnits[kind]?.[0] : undefined;
      const choice = (rule.useLabel ? first?.label : first?.value) || rule.fallback;
      if (choice) defaults[field.key] = choice;
    }
    if (!Object.keys(defaults).length) return;
    startValues.current = JSON.stringify({ ...(JSON.stringify(values) === startValues.current ? values : JSON.parse(startValues.current)), ...defaults });
    setValues(current => ({ ...current, ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !touchedInitialOptions.current.has(key) && (current[key] === undefined || current[key] === null || current[key] === ''))) }));
  // 默认值只跟随种类及公司选项初始化，清空字段后不重新填回。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, record, copyOf, formUnits, optionDefaultContext]);
  const rowsKey = JSON.stringify([bomRows, sourceRows]);
  const startRows = useRef<string | null>(null);
  if (startRows.current === null && !(record || copyOf)) startRows.current = rowsKey;
  useEffect(() => { if (startRows.current === null && (record || copyOf) && (bomRows.length || sourceRows.length || bomOrig.length || sourceOrig.length)) startRows.current = rowsKey; }, [rowsKey, record, copyOf, bomRows.length, sourceRows.length, bomOrig.length, sourceOrig.length]);
  const dirty = status !== (record?.status ?? def.defaultStatus) || JSON.stringify(values) !== startValues.current || (startRows.current !== null && rowsKey !== startRows.current);
  const requestClose = () => {
    if (busy) return;
    if (!REFERENCE_PARTIES.includes(def.key) && dirty && def.form?.confirmClose !== false && !window.confirm(record ? '修改的内容还没有保存，关闭后会丢失。确定直接关闭吗？' : '新增的资料还没有保存，关闭后填写的内容会丢失。确定直接关闭吗？')) return;
    onClose();
  };
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  useEffect(() => { onCloseReady?.(() => closeRef.current()); return () => onCloseReady?.(null); }, [onCloseReady]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelectorAll('[role="dialog"]').length > 1) return; // 上面还有别的弹窗，让它先处理
      closeRef.current();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const { user: me } = useAuth();
  const canField = (f: FieldDef) => !f.permission || (me ? createChecker(me.permissions)(f.permission) : false);
  // 基础编码已有生效引用（组合在用、已上传聚水潭）：身份字段锁定，只能改名称、简称、规格和启停
  const [refLock, setRefLock] = useState<{ label: string; fields: string[]; items: Array<{ sourceLabel: string; name: string }> } | null>(null);
  useEffect(() => {
    if (def.key !== 'finance-base-codes' || !record) return;
    let alive = true;
    api<{ level: string; label: string; items: Array<{ sourceLabel: string; name: string }>; lockedFields: string[] }>(`/finance/base-codes/${record.id}/references`)
      .then((r) => alive && setRefLock(r.lockedFields.length ? { label: r.label, fields: r.lockedFields, items: r.items } : null)).catch(() => undefined);
    return () => { alive = false; };
  }, [def.key, record]);
  const referenceFill = useReferenceFieldFill(def,record,values,setValues,JSON.stringify([me?.companyId,me?.id,me?.permissions?.isCompanyAdmin,[...(me?.permissions?.allow ?? [])].sort(),[...(me?.permissions?.deny ?? [])].sort()]));
  const locked = [...(lockedFields ?? []), ...(refLock?.fields ?? []), ...referenceFill.locked];
  // 商品档案：分区、顺序、叫法、必填、显示条件全部来自 product-layout（详情页读的是同一份）
  const resolved = useMemo(() => (def.key === 'finance-products' ? resolveProductSections(values, { canUse: (p) => (me ? createChecker(me.permissions)(p) : false) }) : null), [def.key, values, me]);
  const visible = useMemo(() => {
    if (resolved) return resolved.flatMap((s) => s.nodes.flatMap((n) => (n.kind === 'field' ? [n.field] : n.fields))).filter((f) => !f.readonly && (!onlyGroup || f.group === onlyGroup));
    const ctx: Record<string, unknown> = { ...values, status };
    return resourceFields(def, values, status, p => !!me && createChecker(me.permissions)(p)).filter((f) => !f.readonly && canField(f)).filter(f => !(def.key === 'finance-base-codes' && !record && ['categoryId','weightG'].includes(f.key)) && !(def.key === 'finance-categories' && record && f.key === 'archiveType')).filter((f) => !(def.key === 'fixed-assets' && record && f.key === 'userId')).filter((f) => !f.showWhen || f.showWhen.in.includes(String(ctx[f.showWhen.field] ?? ''))).filter((f) => !onlyGroup || f.group === onlyGroup);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, values, status, me, onlyGroup, resolved]);
  const isReferenceParty = REFERENCE_PARTIES.includes(def.key);
  const referenceLabel = referenceRecordLabel(def.key, values) || def.label;
  const referenceMaintenance = ['finance-categories','finance-supplier-categories','finance-customer-categories','finance-fee-categories','finance-brands','finance-product-units','finance-platforms','finance-scenarios'].includes(def.key);
  const reference = def.key === 'finance-products' || isReferenceParty || referenceMaintenance;
  const groups = useMemo(() => {
    if (def.form) {
      const fields = record ? resourceFields(def, values, status, p => !!me && createChecker(me.permissions)(p)) : visible;
      return def.form.sections.map(section => [section.title, section.fields.flatMap(key => fields.find(field => field.key === key) ?? [])] as [string, FieldDef[]]);
    }
    if (isReferenceParty) return referencePartyGroups(def.key, record ? resourceFields(def, values, status, p => !!me && createChecker(me.permissions)(p)) : visible,!record);
    if (resolved) return resolved.filter((s) => !(productLayoutKey(values)==='shipping_material'&&s.id==='extra') && (!onlyGroup || s.title === onlyGroup)).map((s) => [s.title, visible.filter((f) => f.group === s.title)] as [string, FieldDef[]]);
    const fields = record ? resourceFields(def, values, status, p => !!me && createChecker(me.permissions)(p)).filter(f => !onlyGroup || f.group === onlyGroup) : visible;
    return resourceGroups(fields);
  }, [visible, resolved, onlyGroup, isReferenceParty, def, record, values, status, me]);

  // 商品档案新建：草稿（每人每个档案类型一份，存在服务器上）、保存并继续新建
  const isProduct = def.key === 'finance-products';
  const [finishedNames,setFinishedNames]=useState(()=>sourceFinishedNamesState(record?.data??initial??{},!!record&&!copyOf));
  const draftEnabled = !record && (isProduct || isReferenceParty || !!def.draft);
  const draftParts = def.draft?.keyFields ? def.draft.keyFields.map(key => String(initial?.[key] ?? values[key] ?? '')) : [String(initial?.archiveType ?? ''), String(initial?.supplyMode ?? '')];
  const draftKey = draftApi.key(`resource:${def.key}`, draftParts);
  const [draftNote, setDraftNote] = useState('');
  const [categoryNeedsPick, setCategoryNeedsPick] = useState(false);
  const [quality, setQuality] = useState<{ body: Record<string, unknown>; mode: SaveMode; options: QualityOptions } | null>(null);
  const [qualityConfirmations,setQualityConfirmations]=useState<SourceQualityConfirmations>(()=>record?.data.sourceQualityConfirmations&&typeof record.data.sourceQualityConfirmations==='object'?record.data.sourceQualityConfirmations as SourceQualityConfirmations:{});
  useEffect(() => {
    if (!draftEnabled || copyOf) return;
    let alive = true;
    draftApi.get(draftKey).then(async (r) => {
      if (!alive || !r.draft) return;
      const { __productParts, __archiveState, __draftStatus, __copyContext, ...fields } = r.draft.payload;
      for (const key of def.draft?.keyFields ?? []) delete fields[key];
      for (const key of def.draft?.omitFields ?? []) delete fields[key];
      if (def.draft && def.codePreview) delete fields[def.codePreview.field];
      if ((def.draft?.includeStatus || isReferenceParty) && typeof __draftStatus === 'string' && def.statuses.some(option => option.value === __draftStatus)) setStatus(current => current === status ? __draftStatus : current);
      if((def.copyReferenceFields?.length || def.fields.some(f=>f.type==='files' && f.copyOnCreate)) && __copyContext && typeof __copyContext==='object'){const context=__copyContext as {source?:ResourceFormInput['copySource'];files?:Record<number,FileInfo>};setCopySource(context.source);setKnown(context.files ?? {});}
      let categoryMessage = '';
      if (isProduct && fields.categoryId) {
        try {
          const options = await loadRefOptions('finance-categories');
          if (!alive) return;
          const selected = options.find(option => option.value === Number(fields.categoryId));
          const archive = fields.archiveType ?? initial?.archiveType;
          const family = archive === 'purchased' ? fields.supplyMode || initial?.supplyMode || 'original_purchase' : archive;
          if (!selected || selected.leaf === false || selected.archiveType && !matchesProductCategoryFamily(String(family ?? ''),selected)) {
            fields.categoryId = '';
            categoryMessage = '草稿原分类已失效或不再是本档案的末级分类，请重新选择后保存。';
          }
        } catch {
          if (!alive) return;
          setCategoryNeedsPick(true);
          categoryMessage = '草稿分类暂时无法核对，已保留原归属，请核对分类后保存。';
        }
      }
      if(isProduct&&typeof fields.rawFinishedNames==='string')setFinishedNames(sourceFinishedNamesState(fields,false));
      setValues((cur) => ({ ...cur, ...(def.draft ? Object.fromEntries(Object.entries(fields).filter(([key]) => Object.is(cur[key], values[key]))) : fields) }));
      if (isProduct && __productParts && typeof __productParts === 'object') {
        const parts = __productParts as { sources?: SourceRow[]; composition?: BomDraftRow[]; manualCode?: boolean;qualityConfirmations?:SourceQualityConfirmations };
        if (Array.isArray(parts.sources)) setSourceRows(parts.sources.map(({rowId:_id,...row})=>withSourceQualityKey(row)));
        if (Array.isArray(parts.composition)) setBomRows(parts.composition.map(({rowId:_id,...row})=>withSourceQualityKey(row)));
        setQualityConfirmations(parts.qualityConfirmations??{}); // 使用前按实际恢复事实重新核对context。
        setManualCode(parts.manualCode === true);
      }
      if (isReferenceParty && __archiveState && typeof __archiveState === 'object') {
        const state = __archiveState as Record<string, unknown>;
        setManualCode(state.manualCode === true); setManualShortCode(state.manualShortCode === true); setShortNameManual(state.shortNameManual === true);
      }
      setDraftNote(isReferenceParty ? '' : `已恢复上次保存的草稿。${categoryMessage}`);
    }).catch(() => { if (alive && def.draft) setDraftNote('草稿读取失败，已保留当前填写内容。'); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 商品档案的供货来源、生产组成：编辑时读出已有的行；复制新增时带上被复制那条的行（不带行 id）
  const layoutKey = productLayoutKey(values);
  const wantSources = isProduct && (layoutKey === 'raw' || layoutKey === 'shipping_material');
  const wantComposition = isProduct && (layoutKey === 'self_made' || layoutKey === 'purchased_oem');
  useEffect(() => {
    const src = record?.id ?? copyOf;
    if (!src) return;
    let alive = true;
    if (wantSources) loadSourceRows(src,()=>alive).then((rows) => { if (!alive) return; const mine = rows.filter((r) => !r.stopped); setSourceRows(record ? mine : mine.map(copySourceQualityRow)); setSourceOrig(record ? mine : []); }).catch(() => alive && setPartsKnown((c) => ({ ...c, sources: false }))).finally(()=>{if(alive)setPartsLoading(current=>({...current,sources:false}));});
    if (wantComposition) loadBomRows(src,()=>alive).then((rows) => { if (!alive) return; setBomRows(record ? rows : rows.map(copySourceQualityRow)); setBomOrig(record ? rows : []); }).catch(() => alive && setPartsKnown((c) => ({ ...c, composition: false }))).finally(()=>{if(alive)setPartsLoading(current=>({...current,composition:false}));});
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  function currentBody() {
    // 只提交可见字段；密码类留空表示不修改，所以空值不提交
    const body: Record<string, unknown> = {};
    for (const f of visible) {
      const v = values[f.key];
      if (f.type === 'secret' && (v === undefined || v === '')) continue;
      body[f.key] = v === undefined ? (f.type === 'files' ? [] : f.type === 'attrs' ? {} : f.type === 'bool' ? false : '') : v;
    }
    const policy = def.zeroValueConfirmation;
    if (policy && body[policy.valueField] === 0) {
      const valueField = def.fields.find(field => field.key === policy.valueField);
      const permission = valueField?.writePermission ?? valueField?.permission;
      if (!permission || me && createChecker(me.permissions)(permission)) {
        const raw = values[policy.confirmationField] as { reason?: unknown; context?: unknown } | undefined;
        if (raw) body[policy.confirmationField] = { reason: raw.reason, context: raw.context };
      }
    }
    if (isProduct) for (const key of productLayout(values).header) if (values[key] !== undefined) body[key] = values[key];
    if(isProduct&&['raw','self_made','purchased_original','purchased_oem'].includes(layoutKey)&&values.weightManual!==true&&typeof automaticWeight==='number'&&Number.isFinite(automaticWeight))body.weightG=automaticWeight;
    if(isProduct&&values.archiveType==='raw'){const command=sourceFinishedNamesCommand(finishedNames);body.rawFinishedNames=command.rows.map(row=>row.name).join('\n');body[SOURCE_FINISHED_NAMES_COMMAND]=command;}
    return body;
  }

  async function saveDraft() {
    if (guardPendingFields(true)) return;
    setBusy(true);
    setError('');
    try {
      let draftConfirmations:SourceQualityConfirmations={};
      if(isProduct&&Object.keys(qualityConfirmations).length){try{draftConfirmations=currentSourceQualityConfirmations(qualityConfirmations,sourceProductQualityDraft(currentBody(),null,sourceRows,bomRows,draftFacts.records,wantSources,wantComposition).facts);}catch{/* 未读完整的事实不能保存为已确认；仍保留所有业务草稿。 */}}
      // 来源和组成不属于档案主表字段，但也是用户已填写的草稿，必须一起恢复。
      const payload: Record<string, unknown> = { ...currentBody(), ...(isProduct ? { archiveType: values.archiveType, ...(values.supplyMode ? { supplyMode: values.supplyMode } : {}), __productParts: {
        sources: sourceRows.map(({ rowId: _r, ...row }) => row),
        composition: bomRows.map(({ rowId: _r, ...row }) => row), manualCode, qualityConfirmations:draftConfirmations,
      } } : {}), ...(isReferenceParty ? { __archiveState: { manualCode, manualShortCode, shortNameManual } } : {}), ...(copySource ? {__copyContext:{source:copySource,files:known}} : {}) };
      for (const key of def.draft?.omitFields ?? []) delete payload[key];
      await draftApi.save(draftKey, { moduleKey: `resource:${def.key}`, title: `新增${def.label}`, ...(def.draft && copyOf ? { sourceRecordId: String(copyOf) } : {}), payload: { ...payload, ...(def.draft?.includeStatus || isReferenceParty ? { __draftStatus: status } : {}) } });
      if (formRef.current) { onClose(); if(isReferenceParty) window.alert('草稿已保存，再次点击新增时会自动恢复。'); }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '草稿保存失败');
      setBusy(false);
    }
  }

  async function clearDraft() {
    await draftApi.remove(draftKey).catch(() => undefined);
    setDraftNote('');
  }

  async function prepare(mode: SaveMode) {
    if (guardPendingFields()) return;
    if (!validate()) return;
    setBusy(true);
    setError('');
    try {
      const body = currentBody();
      if (isProduct && !manualCode) body.code = '';
      if (SIMILARITY_RESOURCES.includes(def.key) && (!isProduct || !record || body.name !== record.data.name)) {
        const sim = await resourceApi.similarCheck(def.key, { ...(record?.data ?? {}), ...body }, record?.id).catch(() => null);
        if(isReferenceParty && sim?.blocked.length){window.alert(`不能保存：${sim.blocked[0].text}`);setBusy(false);return;}
        const warningText=sim?.warnings.slice(0,3).map(warning=>warning.text).join('\n');
        if (warningText && !window.confirm(isReferenceParty?`发现可能相似的资料：\n${warningText}\n\n确认仍要保存吗？`:`发现相似的资料，确定仍要保存吗？\n\n${warningText}`)) { setBusy(false); return; }
      }
      if (isProduct) {
        // 旧系统每次保存商品档案都先弹“核算资料确认”：逐项核对、零值写原因
        // 原料、发货物料的采购价来自供货来源：核算确认里按有价格的来源行显示（保存时仍以来源为准）
        const sourcePrice = wantSources ? latestSource(sourceRows)?.purchasePrice : undefined;
        const merged = { ...(record?.data ?? {}), ...body, ...(sourcePrice !== undefined ? { purchasePrice: sourcePrice } : {}), ...(layoutKey === 'shipping_material' && latestSource(sourceRows)?.systemSpec ? { purchaseSpec: latestSource(sourceRows)!.systemSpec } : {}) };
        const options: QualityOptions = { canCost: Boolean(me && createChecker(me.permissions)('product.cost.edit')), composition: wantComposition || layoutKey === 'self_made' ? (partsKnown.composition ? { packaging: validBomRows(bomRows).filter((r) => r.group === 'package' || r.group === 'oem_package').length, labor: validBomRows(bomRows).filter((r) => r.group === 'labor').length } : await compositionCounts(record?.id, merged)) : undefined };
        if (['raw','self_made','purchased_original','purchased_oem','package','oem_package','shipping_material'].includes(layoutKey)) {
          const factsParent = { ...merged, code: body.code || generatedCode || values.code || record?.data.code };
          options.sourceFacts = sourceProductQualityDraft(factsParent, record?.id ?? null, sourceRows, bomRows, draftFacts.records, wantSources, wantComposition).facts;
          options.confirmations = currentSourceQualityConfirmations(qualityConfirmations,options.sourceFacts);
        }
        setQuality({ body: merged, mode, options });
        setBusy(false);
        return;
      }
      if(status==='inactive'&&(!record&&def.key==='finance-fee-items'||structuredPartyEdit&&status!==record?.status)){setFeeReasonSave({body,mode});setBusy(false);return;}
      await commit(body, mode);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败，请重试');
      setBusy(false);
    }
  }

  async function commit(body: Record<string, unknown>, mode: SaveMode,initialStatusReason?:string, reportFailure=false) {
    if (guardPendingFields()) {if(reportFailure)throw new Error(fieldPendingRef.current.brandId?'品牌正在保存，请稍后再保存档案。':'编号预览尚未完成，请稍后保存或检查预览错误。');return;}
    setBusy(true);
    setError('');
    try {
      if (wantSources) delete body.purchasePrice; // 采购价由供货来源汇出，不直接写档案
      let saved: ResourceDto;
      if (isProduct) {
        const canCostEdit = Boolean(me && createChecker(me.permissions)('product.cost.edit'));
        delete body.sourceQualityConfirmations; // 服务端只读确认投影不能作为普通字段回写。
        let sourcesToSave = sourceRows;
        const sourceQuality = body.__sourceQuality;
        if (sourceQuality && typeof sourceQuality === 'object' && !Array.isArray(sourceQuality) && (sourceQuality as SourceQualityCommand).version === 1) {
          sourcesToSave = sourceRows.map(row => {
            const key = `source:${row.qualityKey || (row.rowId ? `id:${row.rowId}` : '')}:purchasePrice`;
            return body[key] === 0 ? { ...row, purchasePrice: 0, ...(row.purchasePrice !== 0 ? { priceUpdatedAt: new Date().toISOString() } : {}) } : row;
          });
          for (const key of Object.keys(body)) if (key.startsWith('source:') || key.startsWith('composition:')) delete body[key];
          const bindings = sourceProductQualityDraft(body, record?.id ?? null, sourcesToSave, bomRows, draftFacts.records, wantSources && partsKnown.sources && (!onlyGroup || sectionHas(onlyGroup, 'supplySources')), wantComposition && partsKnown.composition && (!onlyGroup || sectionHas(onlyGroup, 'composition'))).rows;
          const receipts=(sourceQuality as SourceQualityCommand).confirmations;
          body.__sourceQuality = { version: 1, rows: bindings, confirmations: receipts } satisfies SourceQualityCommand;
          const confirmedParent:Record<string,unknown>={};
          for(const key of ['freight','handlingFee','purchasePrice','weightG'])if(receipts[key]&&body[key]===0)confirmedParent[key]=0;
          if(confirmedParent.weightG===0&&body.weightManual===true)confirmedParent.weightManual=true;
          if(Object.keys(confirmedParent).length)setValues(current=>({...current,...confirmedParent}));
          setSourceRows(sourcesToSave);
        }
        const collections = [
          ...(wantSources && partsKnown.sources && (!onlyGroup || sectionHas(onlyGroup, 'supplySources')) ? [sourceCollection(sourcesToSave, sourceOrig, canCostEdit)] : []),
          ...(wantComposition && partsKnown.composition && (!onlyGroup || sectionHas(onlyGroup, 'composition')) ? [bomCollection(bomRows, bomOrig)] : []),
        ];
        saved = await resourceApi.saveForm(def.key, { requestKey: formRequestKey.current, ...(record ? { id: record.id, version: record.version } : copySource?{copySource}:{}), values: body, status, statusReason, collections });
      } else if(!record && copySource){
        const copiedFiles:Record<string,number[]>={};const safeBody={...body};
        for(const [key,ids] of Object.entries(copySource.files)){const selected=Array.isArray(safeBody[key]) ? safeBody[key] as number[] : [];const kept=selected.filter(id=>ids.includes(id));if(kept.length){copiedFiles[key]=kept;safeBody[key]=selected.filter(id=>!ids.includes(id));}}
        saved=await resourceApi.saveForm(def.key,{requestKey:formRequestKey.current,values:safeBody,status,collections:[],copySource:{...copySource,files:copiedFiles}});
      } else if(!record && def.key==='finance-fee-items' && status==='inactive'){
        saved=await resourceApi.saveForm(def.key,{requestKey:formRequestKey.current,values:body,status,statusReason:initialStatusReason ?? statusReason,collections:[]});
      } else if(record&&isReferenceParty){
        saved=await resourceApi.saveForm(def.key,{requestKey:formRequestKey.current,id:record.id,version:record.version,values:body,status,statusReason:initialStatusReason??statusReason,collections:[]});
      } else if (record && (referenceStatus || def.form?.status) && status !== record.status) {
        const result = await resourceApi.gridSave(def.key, { updates: [{ id: record.id, version: record.version, data: body, status, statusReason }], note: '资料编辑' });
        const item = result.results[0];
        if (!item?.ok) throw new ApiError(400, item?.message || '保存失败');
        saved = item.row ?? await resourceApi.get(def.key, record.id);
      } else saved = record ? await resourceApi.update(def.key, record.id, body) : await resourceApi.create(def.key, body, status);
      clearRefCache(def.key);
      if (isProduct) {
        if(!record&&mode!=='close')setFinishedNames(sourceFinishedNamesState(mode==='keep'?{rawFinishedNames:finishedNames.rows.map(row=>row.name).join('\n')}: {},false));
        if (mode === 'blank') { setBomRows([]); setSourceRows([]); setBomOrig([]); setSourceOrig([]); }
        else { setBomRows((r) => r.map(copySourceQualityRow)); setSourceRows((r) => r.map(copySourceQualityRow)); setBomOrig([]); setSourceOrig([]); }
      }
      if (draftEnabled) await clearDraft();
      if (mode === 'close' || !onContinued) { onSaved(saved); return; }
      // 继续新建：“保存并继续新建”留空重填（只留档案类型、分类、采购方式），“不清除保存”带着内容，只清掉每个商品独有的编码和赠品简称
      onContinued(saved);
      setValues(mode === 'blank'
        ? def.key === 'finance-fee-items' ? { ...values, code: '', name: '', note: '' }
          : initialFormValues(def, Object.fromEntries(['archiveType', 'supplyMode', 'categoryId', 'categoryIds', 'purchaseSpec', ...(layoutKey === 'self_made' ? ['productPackagingUnit'] : ['specUnit']), ...(['package','oem_package'].includes(layoutKey) ? ['packagingCategory','dimensionUnit','weightUnit'] : [])].filter((k) => values[k] !== undefined).map((k) => [k, values[k]])))
        : { ...values, code: '', giftShortName: '', giftCodeShortName: '', zeroValueReason: '' });
      if(isProduct&&mode==='blank')setValues(current=>({...current,unitDictionaryKind:layoutKey==='shipping_material'?'shipping_unit':'archive_unit'}));
      setQualityConfirmations({});
      setManualCode(false);
      setManualShortCode(false);
      setShortNameManual(mode === 'keep' && Boolean(values.shortName));
      if (isReferenceParty && def.key !== 'finance-fee-items' && mode === 'blank') setStatus(def.defaultStatus);
      if(!record && (def.copyReferenceFields?.length || def.fields.some(f=>f.type==='files' && f.copyOnCreate))){
        const files=mode==='keep'?Object.fromEntries(def.fields.filter(f=>f.type==='files' && f.copyOnCreate && Array.isArray(saved.data[f.key])).map(f=>[f.key,saved.data[f.key] as number[]])):{};
        setCopySource(isProduct?mode==='blank'?undefined:bomRows.some(row=>row.importedLabor)&&copySource?copySource:{id:saved.id,version:saved.version!,files}:mode==='keep'||def.copyReferenceFields?.length?{id:saved.id,version:saved.version!,files}:undefined);
        if(mode==='keep'){setValues(cur=>({...cur,...Object.fromEntries(Object.entries(files))}));setKnown(saved.files ?? {});}else setKnown({});
      }else setKnown({});
      if (isProduct || isReferenceParty) formRequestKey.current = crypto.randomUUID();
      if(def.key==='finance-fee-items')setStatusReason('');
      setDraftNote(isReferenceParty ? '' : `已保存「${String(saved.title ?? '')}」，可以继续新增。`);
      if(contactCreate && mode==='keep') window.alert('保存成功，当前内容已保留，可以继续新增。');
      setBusy(false);
    } catch (err) {
      const message=err instanceof ApiError ? err.message : '保存失败，请重试';
      setError(message);
      setBusy(false);
      if(reportFailure)throw new Error(message);
    }
  }

  /** 一个字段现在有什么问题（没有返回空串）：必填没填、数字格式不对、日期格式不对 */
  function fieldProblem(f: (typeof visible)[number]): string {
    if (locked.includes(f.key) || f.type === 'bool') return '';
    const v = values[f.key];
    if ((f.type === 'money' || f.type === 'number') && typeof v === 'number' && Number.isNaN(v)) return `${f.label}请填写数字`;
    if (f.required && f.type !== 'secret' && isEmptyValue(v)) return `请填写${f.label}`;
    if (f.required && f.type === 'secret' && !record?.secretConfigured[f.key] && isEmptyValue(v)) return `请填写${f.label}`;
    if (f.type === 'date' && typeof v === 'string' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${f.label}日期格式不对`;
    return '';
  }

  /** 必填没填、金额格式不对，先在表单里标出来，不用等服务器退回 */
  function validate(): boolean {
    if(isProduct&&(record||copyOf)){for(const [part,wanted,section] of [['sources',wantSources,'supplySources'],['composition',wantComposition,'composition']] as const){if(!wanted||onlyGroup&&!sectionHas(onlyGroup,section))continue;if(partsLoading[part]||!partsKnown[part]){setError(partsLoading[part]?'来源与组成资料正在读取，请稍后保存。':'来源或组成资料未读取完整，请关闭后重新打开，避免遗漏原明细。');return false;}}}
    const next: Record<string, string> = {};
    for (const f of visible) {
      const p = fieldProblem(f);
      if (p) next[f.key] = p;
    }
    if (isProduct) {
      // 按旧版 saveProduct 的校验逐项标出来（同一份布局决定哪些必填）；服务端仍是最终裁判
      const bom = bomRows.map((r) => ({ group: r.group, id: r.id, qty: r.qty, ...(r.importedLabor ? {sourceRowId:r.importedLabor.sourceRowId,sourceVersion:r.importedLabor.version} : {}) }));
      const probs = productFormProblems(values, {
        canCost: Boolean(me && createChecker(me.permissions)('product.cost.edit')),
        // Source 空价先进入逐项确认；真实草稿仍为空，只有确认0才写子表。
        sources: partsKnown.sources ? sourceRows.map(row=>wantSources&&isEmptyValue(row.purchasePrice)?{...row,purchasePrice:0}:row) : null, composition: partsKnown.composition ? bom : null,
      });
      const shown = new Set([...visible.map((f) => f.key), ...(!onlyGroup || sectionHas(onlyGroup, 'supplySources') ? ['supplySources'] : []), ...(!onlyGroup || sectionHas(onlyGroup, 'composition') ? ['composition'] : [])]);
      for (const [k, msg] of Object.entries(probs)) if (shown.has(k) && !(next[k] && /数字|日期格式/.test(next[k]))) next[k] = msg;
    }
    Object.assign(next,referenceFill.problems);
    const first = visible.find((f) => next[f.key]);
    if(isReferenceParty && (!record||supplierEdit||structuredPartyEdit) && first){
      setErrors({});
      window.alert(expenseCreate && first.key==='name'?'请填写费用类型名称':next[first.key]);
      return false;
    }
    setErrors(next);
    if (first) setTimeout(() => {
      const el = scrollBox.current?.querySelector<HTMLElement>(`[data-field="${first.key}"] input, [data-field="${first.key}"] select, [data-field="${first.key}"] textarea`);
      el?.focus();
      el?.scrollIntoView?.({ block: 'center' });
    }, 0);
    return !Object.values(next).some(Boolean);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (e.target !== e.currentTarget) return;
    void prepare(!record && def.key === 'finance-fee-items' && onContinued ? 'blank' : 'close');
  }

  const sectionHas = (title: string, block: string) => Boolean(resolved?.some((s) => s.title === title && s.nodes.some((n) => n.kind === 'block' && n.block === block)));
  const secId = (g: string) => `rf-sec-${formId}-${g}`;
  const [manualCode, setManualCode] = useState(Boolean(record && isProduct && !['package','oem_package'].includes(layoutKey)));
  const [manualShortCode, setManualShortCode] = useState(false);
  const [shortNameManual, setShortNameManual] = useState(Boolean(record || initial?.shortName));
  const archiveCode = useArchiveCodePreview(def.key, values, isReferenceParty && !record);
  const [generatedCode, setGeneratedCode] = useState('');
  const [generatedName, setGeneratedName] = useState('');
  const waitingForAutoCode=isProduct&&!manualCode&&!generatedCode;
  const canCostEdit = Boolean(me && createChecker(me.permissions)('product.cost.edit'));
  const draftFacts = useProductDraftFacts(bomRows, canCostEdit,layoutKey==='purchased_oem'?'oem':'self');
  const compositionPrice = layoutKey === 'purchased_oem' && !bomRows.length ? 0 : draftFacts.cost;
  const oemRawPrice = Number(values.purchasePrice || 0);
  const previewValues = { ...values, ...(wantComposition ? { purchasePrice: compositionPrice === null || layoutKey === 'purchased_oem' && !Number.isFinite(oemRawPrice) ? undefined : sumUnitCents([compositionPrice, layoutKey === 'purchased_oem' ? oemRawPrice : 0],LOGISTICS_CENT_SCALE) } : {}), ...(wantSources ? { purchasePrice: latestSource(sourceRows)?.purchasePrice ?? values.purchasePrice, ...(layoutKey === 'shipping_material' && latestSource(sourceRows)?.systemSpec ? { purchaseSpec: latestSource(sourceRows)!.systemSpec } : {}) } : {}) };
  const selfTotalPurchase=previewValues.purchasePrice??(!record&&!bomRows.length?0:undefined);
  const automaticWeight = layoutKey === 'raw' ? systemWeightG(String(values.purchaseSpec ?? '')) : layoutKey === 'self_made' ? draftFacts.weightG : layoutKey === 'purchased_oem' ? (specificationWeightG(values.specQty, values.specUnit) ?? 0) + Number(values.oemPackageWeightG || 0) + (draftFacts.weightG ?? 0) : specificationWeightG(values.specQty, values.specUnit);
  const weightValues = values.weightManual === true || ['package','oem_package','shipping_material','custom'].includes(layoutKey) ? values : { ...values, weightG: automaticWeight };
  const secTitle = (g: string) => (resolved ? g : groupTitle(def, g, values));
  const errorsByGroup = (g: string) => groups.find(([name]) => name === g)?.[1].filter((f) => errors[f.key]).length ?? 0;
  const showAnchors = (!inline || inDetail) && !reference && !def.form && groups.length > 1;
  const scrollBox = useRef<HTMLDivElement>(null);
  const [activeGroup, setActiveGroup] = useState('');
  const jumpedGroup = useRef<string | null>(null);
  const jump = (g: string) => {
    setActiveGroup(g); jumpedGroup.current = g;
    const box = scrollBox.current, section = document.getElementById(secId(g));
    if (box && section) box.scrollTo?.({ top: box.scrollTop + section.getBoundingClientRect().top - box.getBoundingClientRect().top - 20, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const onScroll = () => {
    const box = scrollBox.current;
    if (!box || !showAnchors || jumpedGroup.current) return;
    const top = box.getBoundingClientRect().top + 24;
    let current = groups[0]?.[0] ?? '';
    for (const [g] of groups) { const el = document.getElementById(secId(g)); if (el && el.getBoundingClientRect().top <= top) current = g; }
    if (current !== activeGroup) setActiveGroup(current);
  };
  const errorCount = Object.values(errors).filter(Boolean).length;

  const renderField = (f: FieldDef, wide?: boolean) => {
    if (f.hideInForm || def.codePreview?.field === f.key) return null;
    if(isProduct&&f.key==='photos'&&!record)return <div key={f.key} className="s12 product-archive-photos"><div className="product-photo-scope"><span>图片归属当前商品档案：{String(values.name||'未命名商品')}</span><b>0 / 20 张</b></div><p className="product-photo-help">先保存这条商品档案，再添加图片。</p></div>;
    if(isProduct&&f.key==='photos'&&record)return <ProductFormPhotos key={f.key} field={f} ids={Array.isArray(values.photos)?values.photos as number[]:[]} known={known} name={String(values.name||record.title)} onChange={photos=>setValues(current=>({...current,photos}))} onKnown={file=>setKnown(current=>({...current,[file.id]:file}))}/>;
    if (record && !visible.some(field => field.key === f.key)) return <div key={f.key} data-field={f.key} data-kind={f.type} className={`rf-field readonly-field${reference ? ` s${referenceFieldSpan(def.key, f)}` : resourceFieldWide(f) ? ' wide' : ''}`}><span className="rf-label">{f.label}</span><output>{displayValue(f, record) || '—'}</output><small className="muted">只读</small></div>;
    const compound = def.key === 'stores' && f.key === 'jushuitanShopId' || ['refs','attrs','files'].includes(f.type) || f.type === 'select' && f.multi || f.type === 'ref' && f.cascade;
    const inputId = `rf-field-${formId}-${f.key}`;
    let inputField = reference&&isProduct&&f.type==='money'?{...f,moneyInput:{nativeNumber:true,currency:['package','oem_package'].includes(layoutKey)&&f.key==='purchasePrice'?undefined:'¥'},placeholder:'0'}:f;if(isProduct&&layoutKey==='self_made')inputField={...inputField,placeholder:({name:'请输入自产成品名称',specQty:'例如100',productPackagingSpec:'例如500'} as Record<string,string>)[f.key]??inputField.placeholder};
    if(isProduct&&f.key==='giftShortName')inputField={...inputField,placeholder:'例如：购种合同、拌种剂10克'};
    if(isProduct&&f.key==='giftCodeShortName')inputField={...inputField,placeholder:'例如：HT、BZJ10G，仅字母和数字',inputCase:'upper'};
    if (expenseCreate||expenseEdit) {
      const hints: Record<string,string> = {relationRequirement:'写清这个费用单必须挂什么资料，连带建议挂什么资料。',note:'记录旧表来源、使用场景或特殊规则。'};
      const options = f.key==='direction' ? f.options?.map(option=>({...option,label:option.value==='expense'?'支出':option.label}))
        : f.key==='needFlow' ? [...(f.options??[])].sort((a,b)=>['yes','no','by_amount'].indexOf(a.value)-['yes','no','by_amount'].indexOf(b.value)) : f.options;
      inputField = {...f,placeholder:expenseEdit?(f.key==='relationRequirement'?'写清必须挂什么资料、连带建议挂什么资料，例如：费用单必须挂店铺；如能关联订单、售后或商品，需要补充关联。':''):hints[f.key] ?? f.placeholder,options};
    } else if (contactCreate) {
      const hints: Record<string,string> = {shortName:'如 润农',bankAccountName:'请输入收款账户户名',bank:'请输入开户行',bankAccountNo:'请输入银行账号'};
      inputField = {...f,placeholder:hints[f.key] ?? f.placeholder};
    }
    const Caption = compound ? 'span' : 'label';
    return (
    <div key={f.key} data-field={f.key} data-kind={f.type} onBlur={() => { if(isReferenceParty && (!record||supplierEdit||structuredPartyEdit))return;const p = fieldProblem(f); if (p !== (errors[f.key] ?? '')) setErrors((cur) => ({ ...cur, [f.key]: p })); }} className={['rf-field', reference ? `s${isProduct&&['package','oem_package'].includes(layoutKey)&&f.key==='printingCompany'?4:wide || f.type === 'refs' ? 12 : referenceFieldSpan(def.key, f)}` : '', !reference && (wide ?? resourceFieldWide(f)) ? 'wide' : '', errors[f.key] ? 'invalid' : ''].filter(Boolean).join(' ') || undefined}>
      <Caption className="rf-label" htmlFor={compound ? undefined : inputId}>{isProduct&&['freight','handlingFee','purchasePrice'].includes(f.key)&&values.purchaseSpec?`${f.label}（元/${values.purchaseSpec}）`:isProduct && f.key === 'name' && ['self_made','purchased_original','purchased_oem','shipping_material'].includes(layoutKey) ? `${referenceLabel}名称` : isProduct && layoutKey === 'custom' && f.key === 'specQty' ? '多少' : isProduct && layoutKey === 'custom' && f.key === 'shape' ? '形态样式' : f.label}{f.required && (!expenseCreate || f.key==='name') && (!def.form || def.form.requiredBadges) && <b className="req" title="必填">{reference || def.form ? '必填' : ' *'}</b>}{def.form?.requiredBadges && !f.required && <small className="rf-optional">选填</small>}{isProduct && ['materialCode','note','specQty','specUnit'].includes(f.key) && !f.required && <small className="reference-optional">选填</small>}{!reference && isProduct && f.help && <FieldHint text={f.help} />}{isProduct && <ManageLink field={f} values={values} inPlace={reference} onChoose={value => { if (!locked.includes(f.key)) { if (f.initialOption) touchedInitialOptions.current.add(f.key); setValues(current => ({ ...current, [f.key]: value })); setErrors(current => ({ ...current, [f.key]: '' })); } }} />}<ResourceDictionaryButton field={f} disabled={locked.includes(f.key)} onChoose={id => { if (!locked.includes(f.key)) setValues(current => ({ ...current, [f.key]: id })); }} /></Caption>
      {def.key==='finance-suppliers' && f.key==='paymentQr' && <small className="reference-payment-hint">支持微信、支付宝或银行收款码图片{!supplierEdit&&'，不超过 2MB'}</small>}
      {def.key === 'finance-fee-items' && f.key === 'defaultObject' ? <FeeBookingNodes value={values.defaultObject} onChange={value => setValues(cur => ({...cur,defaultObject:value}))}/> : isReferenceParty && (f.key === 'code' || def.key === 'finance-suppliers' && f.key === 'shortCode') ? <ArchiveCodeInput placeholder={structuredPartyEdit&&f.key==='code'?(expenseEdit?'如 0456':'如 KH-KH-...'):undefined} mode={def.key==='finance-fee-items'?'expense':'contact'} editing={!!record} inputId={inputId} label={f.label} value={values[f.key]} preview={f.key === 'code' ? archiveCode.code : archiveCode.shortCode} manual={f.key === 'code' ? manualCode : manualShortCode} onManual={f.key === 'code' ? setManualCode : setManualShortCode} onChange={v => setValues(cur => ({...cur,[f.key]:v}))} error={f.key === 'code' ? archiveCode.error : undefined}/> : def.key === 'finance-customers' && f.key === 'categoryIds' ? <><RefSelect inputId={inputId} emptyLabel={customerEdit?'未分类':undefined} leafOnly={!record} field={{...f,type:'ref'}} value={Array.isArray(values.categoryIds) ? values.categoryIds[0] : null} labelNow={record?.refLabels.categoryIds} onChange={v => setValues(cur => ({...cur,categoryIds:v ? [v] : []}))} />{Array.isArray(values.categoryIds) && values.categoryIds.length > 1 && <small>当前同时归属：{record?.refLabels.categoryIds}；重新选择后归入所选分类。</small>}</> : f.type === 'attrs' ? <AttrsInput field={f} def={def} values={values} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} /> : <FieldInput
        inputId={inputId}
        onPendingChange={isProduct && f.key === 'brandId' ? pendingChange(f.key) : undefined}
        emptySelectLabel={isProduct&&f.key==='specUnit'?'请选择单位':isProduct&&f.key==='productPackagingUnit'?'请选择产品包装单位':def.key==='finance-product-costs'&&inlineStatusSelectAfter?false:expenseCreate ? f.key==='categoryId'?'未分类':false : expenseEdit?f.key==='categoryId'?'未分类':'未设置':undefined}
        field={inputField}
        readOnly={f.formReadOnly || referenceFill.locked.includes(f.key)}
        value={def.draft ? values[f.key] : lockedFields?.includes(f.key) ? initial?.[f.key] : values[f.key]}
        configured={record?.secretConfigured[f.key]}
        labelNow={record?.refLabels[f.key]}
        type={def.key}
        values={values}
        known={known}
        onKnown={(info) => setKnown((cur) => ({ ...cur, [info.id]: info }))}
        onChange={(v) => { if (locked.includes(f.key)) return; if (f.initialOption) touchedInitialOptions.current.add(f.key); if (def.key === 'finance-suppliers' && f.key === 'shortName') setShortNameManual(true); setValues((cur) => ({ ...cur, [f.key]: v, ...(def.key === 'finance-suppliers' && f.key === 'name' && !shortNameManual ? {shortName:v} : {}) })); if (errors[f.key]) setErrors((cur) => ({ ...cur, [f.key]: '' })); }}
      />}
      {def.zeroValueConfirmation?.valueField === f.key && <ZeroValueConfirmation def={def} values={values} enabled={!locked.includes(f.key) && (!f.writePermission || !!me && createChecker(me.permissions)(f.writePermission))} onChange={patch => setValues(current => ({ ...current, ...patch }))}/>}
      {isProduct&&['self_made','purchased_original','purchased_oem'].includes(layoutKey)&&f.key==='purchaseSpec'&&<small className="reference-source-spec-help">从统一维护的系统规格中选择；用于采购价计量，并供后续采购单、销售单选择。</small>}{errors[f.key] ? <small className="field-error" role="alert">{errors[f.key]}</small> : !reference && f.help && <small className="muted">{f.help}</small>}
    </div>
  );
  };

  /** 商品档案分区里的一项：普通字段，或联动的功能块（编号预览、供货来源行、生产组成、重量、成本预览） */
  const renderNode = (n: ResolvedNode, i: number) => {
    if (n.kind === 'field') return n.field.key === 'zeroValueReason' && (layoutKey!=='custom'||!needsZeroReason(values)&&!errors.zeroValueReason) ? null : renderField(n.field, n.wide);
    const editable = n.fields.filter((f) => !f.readonly);
    switch (n.block) {
      case 'code': return <div key={`b${i}`} className="s12 reference-code"><button type="button" className="reference-code-toggle" disabled={locked.includes('code')} onClick={() => {setManualCode(true);if(!manualCode&&generatedCode)setValues(v=>({...v,code:generatedCode}));}}><Pencil size={15} />人工修正</button><input aria-label="系统自动编号" readOnly={!manualCode || locked.includes('code')} disabled={!manualCode || locked.includes('code')} maxLength={def.fields.find(f => f.key === 'code')?.maxLength} value={String(manualCode ? values.code ?? '' : generatedCode || values.code || '')} placeholder="保存后自动生成" onChange={e => setValues(v => ({ ...v, code: e.target.value }))} /><CodePreview values={manualCode ? values : { ...values, code: '' }} excludeId={record?.id} onPreview={setGeneratedCode} onFullName={setGeneratedName} onPendingChange={manualCode?undefined:pendingChange('codePreview')} quiet />{!['raw','shipping_material'].includes(layoutKey) && <p className="reference-code-hint">{layoutKey==='self_made'?'编码顺序：自产档案-分类-品牌-名称-名称规格+名称单位（选填）-产品包装规格+产品包装单位-系统规格。规格和单位合并为一段，例如 500G。':resolved?.find(sec => sec.id === 'code')?.hint}</p>}</div>;
      case 'supplySources': return <div key={`b${i}`} className="s12"><SourcesDraft rows={sourceRows} onChange={rows=>setSourceRows(rows.map(withSourceQualityKey))} reference pricingUnit={String(values.purchaseSpec ?? '')} canCost={canCostEdit} needSpec={layoutKey === 'shipping_material'} error={errors.supplySources} />{!partsKnown.sources && <small className="muted">供货来源暂时读取不到，请到详情的“供货来源”页签维护。</small>}</div>;
      case 'composition': return <div key={`b${i}`} className="s12">{layoutKey === 'self_made' && <><nav className="reference-production-summary" aria-label="生产资料组成">{(['raw','package','labor'] as const).map((g,index)=><button type="button" key={g} onClick={()=>document.getElementById(`rf-bom-${g}`)?.scrollIntoView({behavior:'smooth',block:'start'})}><i>{String(index+1).padStart(2,'0')}</i><strong>{g==='raw'?'原料':g==='package'?'包装':'人工'}</strong><span>{bomRows.filter(r=>r.group===g||g==='package'&&r.group==='oem_package').length} 项</span></button>)}</nav><p className="reference-production-hint">选择档案和用量后，采购价、重量及成本会自动汇总。</p></>}<BomDraft reference records={draftFacts.records} canCost={canCostEdit} rows={bomRows} onChange={(r) => { setBomRows(r.map(withSourceQualityKey)); if (errors.composition) setErrors((c) => ({ ...c, composition: '' })); }} groups={n.groups} required={layoutKey === 'self_made'} error={errors.composition} />{!partsKnown.composition && <small role="alert">组成资料未读取完整，请关闭后重新打开。</small>}</div>;
      case 'weight': if(['package','oem_package'].includes(layoutKey))return <PackageWeightFields key={`b${i}`} values={values} defaultUnit={!record&&!copyOf?'g':'kg'} error={errors.weightG} onChange={patch=>{setValues(current=>({...current,...patch}));setErrors(current=>({...current,weightG:''}));}}/>;return (
        <div key={`b${i}`} className="s6 rf-block" data-field="weightG">
          <span className="rf-label">{layoutKey === 'shipping_material' ? '物料重量' : ['self_made','purchased_original','purchased_oem'].includes(layoutKey)?'称重重量':'重量'}{(n.required||['self_made','purchased_original','purchased_oem'].includes(layoutKey)) && <b className="req" title="必填">{reference ? '必填' : ' *'}</b>}</span>
          <WeightBlock reference={reference} referencePackaging={['package','oem_package'].includes(layoutKey)} automaticOnly={layoutKey==='self_made'} correctionLabel={['purchased_original','purchased_oem'].includes(layoutKey)?'人工纠错':undefined} blankWhenUnknown={['purchased_original','purchased_oem'].includes(layoutKey)} fixedUnit={['raw','self_made','purchased_original','purchased_oem'].includes(layoutKey)?'kg':undefined} values={weightValues} manualOnly={['package', 'oem_package', 'shipping_material', 'custom'].includes(layoutKey)} required={n.required} error={errors.weightG} defaultUnit={['package','oem_package'].includes(layoutKey) && !record && !copyOf ? 'g' : 'kg'}
            onChange={(patch) => { setValues((cur) => ({ ...cur, ...(patch.weightManual===true&&cur.weightManual!==true&&typeof automaticWeight==='number'&&Number.isFinite(automaticWeight)?{weightG:automaticWeight}:{}), ...patch })); if (errors.weightG) setErrors((c) => ({ ...c, weightG: '' })); }} />{layoutKey==='self_made'&&<><ProductCompositionFormula facts={draftFacts} kind="weight" preview={!record&&!bomRows.length}/><small className="reference-source-weight-hint">自动换算为 kg：各原料和包装档案单重 × 对应倍数，人工不计重量。</small></>}{layoutKey==='purchased_oem'&&<><ProductCompositionFormula facts={draftFacts} values={values} kind="weight" preview={!record}/><small className="reference-source-weight-hint">{values.weightManual===true?'当前使用人工纠错重量。':'自动换算为 kg：商品净重 + 各 OEM 包装单件重量 × 数量。'}</small></>}{layoutKey==='purchased_original'&&<small className="reference-source-weight-hint">{values.weightManual===true?'当前使用人工纠错重量。':typeof automaticWeight==='number'?`已按“${values.specQty||''} ${unitOptionLabel(def.fields.find(field=>field.key==='specUnit')!,values,String(values.specUnit||''))||values.specUnit||''}”自动换算。`:'请填写可换算的名称规格和名称单位，例如“500克/袋”或“25kg”。'}</small>}
        </div>
      );
      case 'costSummary': return <div key={`b${i}`} className="s12"><TotalCostPreview sourceProduct reference emptyAsZero={!record} values={previewValues} idle /></div>;
      case 'category': if (layoutKey === 'custom') return <Fragment key={`b${i}`}><div className="s6"><span className="rf-label">所属分类 <b className="req">必填</b></span><ReferenceProductCategoryPicker values={values} labelNow={record?.refLabels.categoryId} onChange={id => setValues(v => ({...v,categoryId:id}))}/>{errors.categoryId && <small className="field-error">{errors.categoryId}</small>}</div><label className="s6"><span className="rf-label">状态</span><select value={status} disabled={!!record && !(me && createChecker(me.permissions)('resource.finance-products.disable'))} onChange={e => setStatus(e.target.value)}><option value="active">正常</option><option value="inactive">停用</option></select></label>{record && status !== record.status && status === 'inactive' && <label className="s12">停用原因<textarea value={statusReason} onChange={e => setStatusReason(e.target.value)}/></label>}</Fragment>;
      return <div key={`b${i}`} className="s12"><ReferenceCategoryContext label={referenceLabel} editing={Boolean(record) || Boolean(values.categoryId) && !categoryNeedsPick} categoryId={Number(values.categoryId) || undefined} path={record?.refLabels.categoryId ?? ''}>{record ? editable.map(f => renderField(f)) : <div data-field="categoryId"><ReferenceProductCategoryPicker values={values} onChange={id => { setValues(v => ({...v, categoryId:id})); setErrors(e => ({...e,categoryId:''})); }} />{errors.categoryId && <small className="field-error" role="alert">{errors.categoryId}</small>}</div>}</ReferenceCategoryContext></div>;
      case 'capacities': case 'finishedNames': return <div key={`b${i}`} className="s12"><ReferenceLines kind={n.block} parentValues={values} {...(n.block==='finishedNames'?{finishedRows:finishedNames.rows,onFinishedRowsChange:(rows:typeof finishedNames.rows)=>{setFinishedNames(current=>({...current,rows}));setValues(current=>({...current,rawFinishedNames:rows.map(row=>row.name).join('\n')}));}}:{})} defaultUnit={!record && !copyOf ? String(values.specUnit || '') : undefined} value={values[n.block === 'capacities' ? 'capacities' : 'rawFinishedNames']} onChange={v => setValues(cur => ({ ...cur, [n.block === 'capacities' ? 'capacities' : 'rawFinishedNames']: v }))} /></div>;
      case 'breakdown': return <div key={`b${i}`} className="s12"><CompositionResult source={layoutKey==='self_made'} preview={!record&&!bomRows.length} facts={draftFacts} values={values} canCost={canCostEdit} /></div>;
      case 'fullName': return <div key={`b${i}`} className="reference-full-name s12"><small>基础信息全名</small><output>{generatedName || String(values.basicInfoFullName ?? '填写基础信息后自动生成')}</output></div>;
      default: return null;
    }
  };

  const sectionNodes=(sec:NonNullable<typeof resolved>[number])=>{const nodes=sec.nodes.filter(n=>!(layoutKey!=='custom'&&n.kind==='field'&&n.field.key==='shape')).filter(n=>!(layoutKey==='custom'&&(n.kind==='field'&&n.field.key==='note'||n.kind==='block'&&n.block==='fullName'))).filter(n=>!(['raw','shipping_material'].includes(layoutKey)&&sec.id==='base'&&(n.kind==='field'&&n.field.key==='note'||n.kind==='block'&&n.block==='fullName')));if(['purchased_original','purchased_oem'].includes(layoutKey)&&sec.id==='pricing')return nodes.filter(n=>n.kind==='field'&&n.field.key==='purchaseSpec'||n.kind==='block'&&n.block==='weight');return layoutKey==='self_made'&&sec.id==='result'?[...nodes.filter(n=>n.kind==='block'&&n.block==='breakdown'),...nodes.filter(n=>!(n.kind==='block'&&n.block==='breakdown'))]:nodes;};
  return (
    <div className={inline ? 'inline-edit' : `modal-backdrop${reference ? ' reference-backdrop' : ''}${def.form ? ' sectioned-backdrop' : ''}`} role="presentation">
      <form ref={formRef} style={def.form ? { '--sectioned-width': `${def.form.width ?? 780}px`, '--sectioned-title': `${def.form.titleSize ?? 21}px` } as CSSProperties : undefined} data-size={visible.length <= 4 && !isProduct ? 'compact' : 'full'} onKeyDown={e => {
        if (inline || e.key !== 'Tab') return;
        const dialogs = document.querySelectorAll('[role="dialog"]');
        if (dialogs[dialogs.length - 1] !== formRef.current) return;
        const controls = [...(formRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') ?? [])].filter(el => el.getClientRects().length > 0);
        const first = controls[0], last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }} className={inline ? `inline-form resource-inline-editor${inDetail ? ' resource-detail-editor' : ''}` : `modal card rf${reference ? ' finance-base-editor' : def.form ? ' sectioned-editor' : ' resource-editor'}${isProduct ? ' rf-p' : ''}${def.form ? ' rf-sectioned' : ''}${reference ? ` rf-reference${referenceMaintenance ? ' reference-maintenance' : ''} reference-${isProduct ? productLayoutKey(values) : def.key}${contactCreate||supplierEdit?' reference-contact-create':''}${supplierEdit?' reference-supplier-edit':''}${structuredPartyEdit?' reference-customer-edit':''}${expenseEdit?' reference-expense-edit':''}${expenseCreate?' reference-expense-create':''}` : ''}`} role={inline ? 'group' : 'dialog'} aria-modal={inline ? undefined : true} aria-label={onlyGroup ? `编辑${onlyGroup}` : def.form ? record ? def.form.editTitle : def.form.createTitle : record ? `编辑${def.label}` : `新增${def.label}`} onSubmit={submit}>
        {!inline && <div className="modal-head rf-head">
          {def.form ? <><div className="rf-sectioned-icon">{def.form.icon === 'users' ? <UsersRound size={20}/> : <Database size={22}/>}</div><div className="rf-sectioned-heading"><span>{def.form.sectionLabel || def.label}</span><h2>{record ? def.form.editTitle : def.form.createTitle}</h2><p>{def.form.subtitle}</p></div></> : reference ? <div className="reference-title">{(def.key === 'finance-suppliers' || contactCreate) && <small className="reference-party-kicker"><FolderTree size={20}/>财务基础资料</small>}{isProduct && values.archiveType === 'purchased' && <small>外购成品档案 · {values.supplyMode === 'supplier_oem' ? '供应商 OEM' : '原装采购'}</small>}<h2>{record ? referenceStatus || (isProduct && layoutKey === 'custom') ? String(values.name || referenceLabel) : `编辑${isProduct ? String(values.name || referenceLabel) : referenceLabel}` : `新增${referenceLabel}`}</h2><p>{isProduct && layoutKey === 'custom' ? '先确认分类，再维护基础信息；编号按分类、可选品牌、名称、规格和可选形态样式生成，空白可选段会直接省略。' : def.key === 'finance-fee-items' && !expenseEdit ? '费用类型用于后续费用单、流程和财务归集；挂账节点支持多选。' : contactCreate ? '填写基础资料即可保存；档案会直接归入当前最末级分类。' : referenceStatus ? `${def.label}详情、分类归属和操作记录。` : isReferenceParty ? record ? `在原位编辑${referenceLabel}资料，保存后立即生效。` : `填写${referenceLabel}基础资料，保存后归入当前分类。` : record ? isProduct?`字段布局与新增${referenceLabel}保持一致，保存后更新当前记录。`:`维护${referenceLabel}基础信息、规格及关联资料。` : isProduct&&layoutKey==='self_made'?'填写基本信息即可保存，更多设置可按需补充。':isProduct&&['package','oem_package'].includes(layoutKey)?'先确认系统编号，再维护包装基础信息、容量和库存参数。':isProduct&&['purchased_original','purchased_oem'].includes(layoutKey)?`已选择${layoutKey==='purchased_oem'?'供应商OEM':'原装采购'}，请补充商品与采购信息。`:`填写${referenceLabel}基础资料即可保存。`}</p></div> : <><strong>{record ? `编辑${def.label}` : `新增${def.label}`}</strong>{record && <span className="rf-sub" title={record.title}>{record.title}</span>}</>}
          <span className="rf-gap" />
          {!reference && !def.form && visible.some((f) => f.required) && <span className="muted rf-req-hint"><b className="req">*</b> 必填</span>}
          <button type="button" className={`icon-button${referenceStatus && !contactCreate || isProduct && layoutKey === 'custom' ? ' reference-full-close' : ''}`} aria-label="关闭" onClick={supplierEdit||structuredPartyEdit?()=>{if(!busy)(onDismiss??onClose)();}:requestClose}>{referenceStatus && !contactCreate || isProduct && layoutKey === 'custom' ? '关闭' : reference ? <X size={20} /> : '✕'}</button>
        </div>}
        <div className={showAnchors ? 'rf-main with-anchors' : 'rf-main'}>
          {showAnchors && (
            <nav className="rf-anchors" aria-label="表单分区">
              {groups.map(([g]) => {
                const n = errorsByGroup(g);
                return (
                  <button key={g} type="button" aria-current={(activeGroup || groups[0][0]) === g ? 'location' : undefined} className={`rf-anchor${(activeGroup || groups[0][0]) === g ? ' active' : ''}${n ? ' has-error' : ''}`} onClick={() => jump(g)}>
                    <span>{secTitle(g)}</span>
                    {n > 0 && <b className="rf-err-n" aria-label={`${n} 项有问题`}>{n}</b>}
                  </button>
                );
              })}
            </nav>
          )}
          <div className="modal-body rf-scroll" ref={scrollBox} onScroll={onScroll} onWheel={() => { jumpedGroup.current = null; }} onTouchMove={() => { jumpedGroup.current = null; }} onPointerDown={() => { jumpedGroup.current = null; }} onKeyDown={e => { if (['PageDown','PageUp','Home','End','ArrowDown','ArrowUp'].includes(e.key)) jumpedGroup.current = null; }}>
          {def.key === 'licenses' && (
            <LicenseRecognizeButton
              onApply={(fields) => setValues((cur) => ({ ...cur, ...fields }))}
            />
          )}
          {draftNote && <div className="notice">{draftNote}{draftEnabled && draftNote.startsWith('已恢复') && <> <button type="button" className="link-button" onClick={() => void clearDraft()}>清除草稿</button></>}</div>}
          {!reference && !record && !inlineStatusSelectAfter && !def.draft?.fixedStatus && !def.form?.status && def.statuses.length > 1 && def.key !== 'fixed-assets' && (
            <label className="rf-status">初始状态
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {def.statuses.filter((s) => def.draft?.includeStatus || !s.requiresReason).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
          )}
          {inline && !inDetail && visible.some((f) => f.required) && <p className="muted required-hint"><b className="req">*</b> 为必填项。</p>}
          {def.codePreview && <ResourceCodePreview def={def} values={values} record={record} />}
          {!inline && !record && !reference && !def.form && visible.some((f) => f.required) && <p className="muted required-hint">带 <b className="req">*</b> 的为必填项，保存后可以继续补充关联资料。</p>}
          {resolved ? resolved.filter(sec => !(layoutKey==='shipping_material'&&sec.id==='extra') && (!onlyGroup || sec.title === onlyGroup) && !(['package','oem_package'].includes(layoutKey) && sec.id === 'category' && !categoryNeedsPick) && !(layoutKey === 'custom' && ['cost','total','photos'].includes(sec.id))).map((sec) => sec.id === 'extra' ? <details key={sec.id} className="rf-sec reference-section-extra" data-sec={sec.id}><summary>{sec.title}</summary><div className="form-grid">{sec.nodes.map(renderNode)}</div></details> : (
            <Fragment key={sec.id}>{layoutKey==='self_made'&&sec.id==='photos'&&<details className="reference-extra reference-source-more"><summary>更多设置</summary><p>编号默认随分类、名称、品牌和规格自动更新。手动修改后将停止自动生成。</p>{manualCode&&<button type="button" className="secondary-button" onClick={()=>{setManualCode(false);setValues(current=>({...current,code:''}));setGeneratedCode('');}}>恢复自动编号</button>}</details>}<section key={sec.id} id={secId(sec.title)} data-sec={sec.id} className={`rf-sec reference-section-${sec.id}`} aria-label={sec.title}>
              {!inline && (sec.id !== 'category' || layoutKey === 'custom') && <h3 className="rf-sec-title">{sec.step && !(layoutKey === 'self_made' && sec.id !== 'base') && <i className="rf-step">{sec.step}</i>}{sec.id==='photos'?'档案图片':sec.id==='total'?'总成本价（含运费、装卸费）':sec.id === 'stock' && ['package','oem_package'].includes(layoutKey) ? '库存' : sec.title}{sec.hint && !['gift','total','finished'].includes(sec.id) && (reference ? <small>{sec.id==='logistics'?'两项费用分别维护、统一汇总，并与当前系统规格和采购价一起留存历史':layoutKey==='self_made'&&sec.id==='production'?'记录自产成品消耗的原料、产品包装和人工成本':layoutKey==='self_made'&&sec.id==='result'?sec.hint+'。':sec.hint}</small> : <FieldHint text={sec.hint} />)}</h3>}
              {sec.id === 'gift' && sec.hint && <p className="reference-gift-hint">{sec.hint}</p>}<div className="form-grid">{layoutKey==='self_made'&&sec.id==='result'?<>{sectionNodes(sec).filter(n=>n.kind==='block'&&n.block==='breakdown').map(renderNode)}<div className="reference-source-metric-grid s12">{sectionNodes(sec).filter(n=>!(n.kind==='block'&&n.block==='breakdown')).map(renderNode)}</div></>:['purchased_original','purchased_oem'].includes(layoutKey)&&sec.id==='pricing'?<div className="reference-purchased-metric-grid s12">{sectionNodes(sec).map(renderNode)}</div>:sectionNodes(sec).map(renderNode)}</div>{['raw','shipping_material'].includes(layoutKey) && sec.id === 'base' && <div className="reference-note">{sec.nodes.filter(n => n.kind === 'field' && n.field.key === 'note').map(renderNode)}</div>}{['raw','shipping_material'].includes(layoutKey) && sec.id === 'base' && sec.nodes.filter(n => n.kind === 'block' && n.block === 'fullName').map(renderNode)}{['self_made','purchased_original','purchased_oem'].includes(layoutKey)&&['result','pricing'].includes(sec.id)&&canCostEdit&&<PurchasePriceHistory productForm record={record} total={layoutKey!=='purchased_original'} priceField={layoutKey==='self_made'?<><label className="reference-production-total-price"><span>总采购价{values.purchaseSpec?`（元/${values.purchaseSpec}）`:''} <b className="req">必填</b></span><MoneyControl ariaLabel="总采购价" readOnly value={selfTotalPurchase} scale={4} appearance={{nativeNumber:true,currency:'¥'}} displayDecimals={8} onChange={()=>{}}/></label><ProductCompositionFormula facts={draftFacts} kind="price" preview={!record&&!bomRows.length}/></>:<><div className="reference-source-price-field">{sec.nodes.filter(n=>n.kind==='field'&&n.field.key==='purchasePrice').map(renderNode)}</div>{layoutKey==='purchased_oem'&&<ProductCompositionFormula facts={draftFacts} values={values} kind="price" preview={!record}/>}</>}/>}{sec.id === 'logistics' && canCostEdit && <FreightHistory newRecord={!record} productId={record?.id} values={previewValues} />}
            </section></Fragment>
          )) : def.form ? groups.map(([group, fields]) => {
            const section = def.form!.sections.find(item => item.title === group)!;
            const state = def.form!.status?.section === group ? def.form!.status : undefined;
            const context = section.contextField ? def.fields.find(field => field.key === section.contextField) : undefined;
            return <section key={group} id={secId(group)} className="rf-sec rf-configured-section" aria-label={group}>
              <header><h3>{section.step && <i>{section.step}</i>}{group}</h3>{context ? <ResourceFormContext field={context} value={values[context.key]} label={section.contextLabel || context.label} currentLabel={record && values[context.key] === record.data[context.key] ? record.refLabels[context.key] : undefined}/> : section.hint && <small>{section.hint}</small>}</header>
              <div className="form-grid">{state && !inlineStatusSelectAfter && <div className="rf-configured-status"><span>状态</span><button type="button" role="switch" aria-label="状态" aria-checked={status === state.activeValue} disabled={!!record && !(me && createChecker(me.permissions)(resourcePermission(permissionOwner(def.key), 'disable')))} onClick={() => setStatus(status === state.activeValue ? state.inactiveValue : state.activeValue)}><i/><strong>{status === state.activeValue ? state.activeText : state.inactiveText}</strong></button><small>{status === state.activeValue ? state.activeHint : state.inactiveHint}</small></div>}{fields.map(field => <Fragment key={field.key}>{renderField(field, section.wideFields?.includes(field.key) ?? false)}{inlineStatusSelectAfter===field.key && <label className="rf-inline-status-select"><span className="rf-label">状态</span><select aria-label="状态" value={status} disabled={busy || !!record && !(me && createChecker(me.permissions)(resourcePermission(permissionOwner(def.key), 'disable')))} onChange={event=>setStatus(event.target.value)}>{def.statuses.filter(option=>!option.requiresReason).map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}</Fragment>)}</div>
            </section>;
          }) : groups.map(([group, fields]) => group === '补充资料' && isReferenceParty ? null : group === '补充资料' && reference ? <details key={group} className="rf-sec reference-extra"><summary>更多设置</summary><div className="form-grid">{fields.map(f => renderField(f))}</div></details> : (
            <section key={group} id={secId(group)} data-layout="full" className={`rf-sec reference-party-${group === '归入分类' ? 'category' : group === '系统自动编号' ? 'code' : 'fields'}`} aria-label={group}>
              {group === '归入分类' && isReferenceParty ? def.key === 'finance-suppliers' || contactCreate ? <SupplierCategoryContext editing={supplierEdit} type={def.key} value={Array.isArray(values.categoryIds) ? values.categoryIds as number[] : []} labelNow={record?.refLabels.categoryIds} onChange={ids => setValues(cur => ({...cur,categoryIds:ids}))}/> : <ReferenceCategoryContext party label={referenceLabel} editing={!!record} path={record?.refLabels.categoryIds ?? ''}>{!record && fields.map(f => renderField(f))}</ReferenceCategoryContext> : <>
              {(!inline || inDetail) && !(expenseCreate && group==='其他说明') && <h3 className="rf-sec-title">{isReferenceParty && ['基础资料','联系资料','收款与银行资料'].includes(group) && <i className="rf-step">{['基础资料','联系资料','收款与银行资料'].indexOf(group) + 1}</i>}{referenceStatus && !expenseCreate && group === '基础信息' && <Database size={18}/>} {secTitle(group)}{def.key === 'finance-fee-items' && !expenseEdit && <small>{({ '基础信息': '先确定费用叫什么、放在哪个目录。', '费用设置': '控制费用单里怎么使用这个费用类型。', '挂账节点': '可以多选，费用单后续会按这些资料节点归集和统计。' } as Record<string,string>)[group]}</small>}{(def.key === 'finance-suppliers' || contactCreate) && group === '基础资料' && <small>{record ? '与新增供应商的字段排列一致' : '带“必填”的项目必须填写'}</small>}{(def.key === 'finance-suppliers' || contactCreate) && group === '联系资料' && <small>用于业务联系和后续单据引用</small>}{contactCreate && group==='收款与银行资料' && <small>用于付款、对账和快速复制</small>}{group === '系统自动编号' && <small>编码按分类和名称生成</small>}</h3>}
              <div className="form-grid">{fields.map(f => <Fragment key={f.key}>{renderField(f)}{referenceStatus && (def.key === 'finance-fee-items' ? f.key === (expenseEdit?'categoryId':'needFlow') : ['categoryId','categoryIds'].includes(f.key)) && <label className={def.key === 'finance-fee-items' ? 's3' : 's6'}><span className="rf-label">状态</span><select value={status} disabled={!!record && !(me && createChecker(me.permissions)(`resource.${def.key}.disable`))} onChange={e => setStatus(e.target.value)}><option value="active">正常</option><option value="inactive">停用</option></select></label>}</Fragment>)}{referenceStatus && record && !structuredPartyEdit && group==='基础信息' && status !== record.status && status === 'inactive' && <label className="s12">停用原因<textarea value={statusReason} maxLength={500} onChange={e => setStatusReason(e.target.value)} /></label>}</div></>}
            </section>
          ))}
          {isProduct && layoutKey === 'custom' && <details className="reference-extra"><summary>更多设置</summary><div className="form-grid">{resolved?.filter(sec => ['cost','total','photos'].includes(sec.id)).flatMap(sec => sec.nodes).map(renderNode)}{resolved?.find(sec=>sec.id==='base')?.nodes.filter(n => n.kind === 'field' && n.field.key === 'note' || n.kind === 'block' && n.block === 'fullName').map(renderNode)}</div></details>}
          {referenceStatus && record && <ReferenceRecordHistory type={def.key} id={record.id} label={def.label.replace(/档案$/,'')} icon={structuredPartyEdit?<ClipboardList size={18}/>:undefined} />}
          {isReferenceParty && !!record && groups.find(([g])=>g==='补充资料') && <details className="reference-extra"><summary>补充资料</summary><div className="form-grid">{groups.find(([g])=>g==='补充资料')![1].map(f=>renderField(f))}</div></details>}
          {referenceStatus && !isReferenceParty && groups.find(([g]) => g === '补充资料') && <details className="reference-extra"><summary>更多设置</summary><div className="form-grid">{groups.find(([g]) => g === '补充资料')![1].map(f=>renderField(f))}</div></details>}
          {(contactCreate||expenseCreate) && <ArchiveSimilarityNotice type={def.key} values={values} previewCode={archiveCode.code}/>}
          {refLock && <div role="status" className="notice warn">该商品编码{refLock.label}（{refLock.items.slice(0, 3).map((i) => `${i.sourceLabel}：${i.name}`).join('；')}），编码和来源已锁定，只能修改商品名称、简称、颜色及规格和启停状态。</div>}
          {referenceFill.error && <div role="alert" className="notice error">{referenceFill.error} <button type="button" onClick={referenceFill.retry}>重试引用资料</button></div>}
          {error && <div role="alert" className="notice error">{error}</div>}
          </div>
        </div>
        {errorCount > 0 && (
          <div role="alert" className="rf-errbar error-summary">
            <strong>还有 {errorCount} 项需要补充或修改：</strong>
            {visible.filter((f) => errors[f.key]).map((f) => (
              <button key={f.key} type="button" className="link-button" onClick={() => scrollBox.current?.querySelector<HTMLElement>(`[data-field="${f.key}"] input, [data-field="${f.key}"] select, [data-field="${f.key}"] textarea`)?.focus()}>{f.label}</button>
            ))}
            {([['supplySources', '供货来源'], ['composition', '生产组成']] as const).filter(([k]) => errors[k]).map(([k, label]) => (
              <button key={k} type="button" className="link-button" onClick={() => scrollBox.current?.querySelector<HTMLElement>(`[data-field="${k}"]`)?.scrollIntoView?.({ block: 'center' })}>{label}</button>
            ))}
          </div>
        )}
        <div className="modal-foot rf-foot">
          {!record&&reference&&isProduct&&onContinued?<ReferencePartyCreateActions expense={false} busy={busy || hasDraftPending} saveDisabled={hasFieldPending || waitingForAutoCode} onKeep={()=>void prepare('keep')} onNext={()=>void prepare('blank')} onDraft={()=>void saveDraft()} onSave={()=>void prepare('close')} onClose={requestClose}/>:supplierEdit?<><button type="submit" className="primary-button finance-form-save" disabled={busy||referenceFill.pending||!!referenceFill.error}>{busy?'保存中…':'保存'}</button><button type="button" className="secondary-button finance-form-cancel" disabled={busy} onClick={onClose}>取消编辑</button><button type="button" className="secondary-button finance-form-dismiss" disabled={busy} onClick={onDismiss??onClose}>关闭</button></>:!record && isReferenceParty && onContinued ? <ReferencePartyCreateActions expense={def.key==='finance-fee-items'} busy={busy} onKeep={()=>void prepare('keep')} onNext={()=>void prepare('blank')} onDraft={()=>void saveDraft()} onSave={()=>void prepare('close')} onClose={requestClose}/> : <>
          {dirty && !reference && !def.form && <span className="muted dirty-hint">{record ? '有未保存的修改' : '已填写内容尚未保存'}</span>}
          <button type="button" className="secondary-button finance-form-cancel" disabled={busy} onClick={supplierEdit?onClose:requestClose}>{isProduct?record?'取消':'关闭':isReferenceParty && record ? '取消编辑' : '取消'}</button>
          {draftEnabled && <button type="button" className="secondary-button finance-form-draft" disabled={busy || hasDraftPending} onClick={() => void saveDraft()}>保存草稿</button>}
          {!record && onContinued && (isProduct || isReferenceParty && def.key !== 'finance-fee-items') && <button type="button" className="secondary-button finance-form-keep" disabled={busy || hasFieldPending || waitingForAutoCode} onClick={() => void prepare('keep')}>不清除保存继续新增</button>}
          {!record && onContinued && (isProduct || isReferenceParty) && <button type="button" className="secondary-button finance-form-next" disabled={busy || hasFieldPending || waitingForAutoCode} onClick={() => void prepare('blank')}>保存并继续新增</button>}
          {!(def.key === 'finance-fee-items' && !record && onContinued) && <button type="submit" className="primary-button finance-form-save" disabled={busy || hasFieldPending || waitingForAutoCode || referenceFill.pending || !!referenceFill.error}>{busy ? '保存中…' : def.form?.saveLabel ? def.form.saveLabel : isProduct && layoutKey === 'custom' ? '保存商品' : isProduct && record ? '保存修改' : '保存'}</button>}
          </>}
        </div>
      </form>
      {feeReasonSave && <ReasonDialog presentation="finance-archive" title="填写停用原因" hint={`停用“${String(feeReasonSave.body.name || '该资料')}”后默认不再显示，原因会写入档案记录。`} confirmLabel="确认提交" onClose={()=>setFeeReasonSave(null)} onConfirm={async reason=>{const pending=feeReasonSave;await commit(pending.body,pending.mode,reason);setFeeReasonSave(null);}}/>}
      {quality && (
        <ProductQualityDialog
          values={quality.body}
          options={quality.options}
          onCancel={() => setQuality(null)}
          onConfirm={async(next) => {
            const command=next.__sourceQuality as SourceQualityCommand|undefined;
            if(command?.version===1)setQualityConfirmations(command.confirmations);
            const { mode } = quality;
            await commit(next, mode,undefined,true);
            setQuality(null);
          }}
        />
      )}
    </div>
  );
}

/** 填写时实时看总成本价：采购价 + 运费 + 装卸费（自制品/OEM 的采购价来自构成，保存后才有，这里只提示）。 */
export function TotalCostPreview({ values, idle,reference=false,emptyAsZero=false,sourceProduct=false }: {sourceProduct?:boolean;reference?:boolean;emptyAsZero?:boolean; values: Record<string, unknown>; /** 表单里还没填时也画出汇总条（用 — 占位） */ idle?: boolean }) {
  const num = (k: string) => (values[k] === '' || values[k] === undefined || values[k] === null || !Number.isFinite(Number(values[k])) ? null : Number(values[k]));
  const p = num('purchasePrice'), f = num('freight'), h = num('handlingFee');
  if (p === null && f === null && h === null && !idle) return null;
  const composed = ['self_made', 'oem_package'].includes(String(values.archiveType)) || values.supplyMode === 'supplier_oem';
  if (composed && p === null && !sourceProduct) return <div className="notice" role="status">采购价由构成汇总，保存后在“构成（BOM）”页签里维护。</div>;
  const total = sumUnitCents([p ?? 0,f ?? 0,h ?? 0],LOGISTICS_CENT_SCALE);
  const empty = p === null && f === null && h === null;
  const amount=(value:number)=>productReferenceCostText(value,LOGISTICS_CENT_SCALE).slice(1);
  const part = (label: string, v: number | null) => <span className="rf-total-part"><small>{label}</small><b>{reference?(!emptyAsZero&&v===null?'待补齐':`¥${amount(v??0)}`):empty ? '—' : `¥${unitYuanText(v ?? 0,LOGISTICS_CENT_SCALE)}`}</b></span>;
  if(sourceProduct){const fee=f===null||h===null?null:sumUnitCents([f,h],LOGISTICS_CENT_SCALE),text=(value:number|null,final=false)=>value===null&&!emptyAsZero?final?'待补齐核算资料':'待补齐':`¥${amount(value??0)}`;return <div className="reference-source-total" role="status" aria-label="总成本预览">{[[composed?'总采购价':'采购价',p],['运费＋装卸费',fee],[`总成本价${values.purchaseSpec?`（元/${values.purchaseSpec}）`:''}`,[p,f,h].some(value=>value===null)?null:total]].map(([label,value],index)=><div className={index===2?'rf-total-sum is-total':''} key={String(label)}><small>{String(label)}</small><strong>{text(value as number|null,index===2)}</strong></div>)}</div>;}
  return (
    <div className="rf-total" role="status" aria-label="总成本预览">
      <span className="rf-total-sr">总成本价预览：采购价 ¥{unitYuanText(p ?? 0,LOGISTICS_CENT_SCALE)} + 运费 ¥{unitYuanText(f ?? 0,LOGISTICS_CENT_SCALE)} + 装卸费 ¥{unitYuanText(h ?? 0,LOGISTICS_CENT_SCALE)} = ¥{unitYuanText(total,LOGISTICS_CENT_SCALE)}</span>
      <span aria-hidden="true" className="rf-total-row">
        {part('采购价', p)}<i>+</i>{part('运费', f)}<i>+</i>{part('装卸费', h)}<i>=</i>
        <span className="rf-total-sum"><small>总成本</small><strong>{reference?(!emptyAsZero&&[p,f,h].some(value=>value===null)?'待补齐':`¥${amount(total)}`):empty ? '—' : `¥${unitYuanText(total,LOGISTICS_CENT_SCALE)}`}</strong></span>
      </span>
    </div>
  );
}

/** 已有构成的自制品/OEM 成品：包装组成、人力组成各有几行（新建时没有构成，返回 undefined） */
async function compositionCounts(productId: number | undefined, values: Record<string, unknown>): Promise<QualityOptions['composition']> {
  if (!productId || !isComposedArchive(values)) return undefined;
  try {
    const boms = (await resourceApi.list('finance-product-boms', { fieldKey: 'productId', fieldValue: String(productId), pageSize: 200 })).items;
    const pkgIds = new Set<number>();
    for (const tab of ['package', 'oem_package']) (await resourceApi.list('finance-products', { tab, pageSize: 200, showHidden: true })).items.forEach((i) => pkgIds.add(i.id));
    return {
      labor: boms.filter((b) => typeof b.data.laborId === 'number').length,
      packaging: boms.filter((b) => typeof b.data.componentId === 'number' && pkgIds.has(b.data.componentId as number)).length,
    };
  } catch {
    return undefined;
  }
}

export { ReasonDialog } from './ResourceConfirmDialog';

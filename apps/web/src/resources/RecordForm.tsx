import { CascadePicker } from './CascadePicker';
import { Fragment, FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { fieldOptions, useUnitOptions } from './unitOptions';
import { selectChoices, useCategoryVersion } from './categoryOptions';
import { groupTitle, SIMILARITY_RESOURCES, isComposedArchive, resolveProductSections, productFormProblems, productLayoutKey, type ResolvedNode, type QualityOptions, unitYuanText, sumUnitCents, systemWeightG, specificationWeightG, yuanToPreciseCents, createChecker, type FieldDef, type ResourceDef } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { ApiError, api } from '../api/client';
import { CodePreview } from './CodePreview';
import { ManageLink } from './ManageLink';
import { BomDraft, saveBomRows, loadBomRows, validBomRows, type BomDraftRow } from './BomDraft';
import { FieldHint } from './FieldHint';
import { fieldSpan, needsZeroReason } from './productFormGrid';
import './productForm.css';
import './referenceForm.css';
import { X, Pencil, FolderTree, Database } from 'lucide-react';
import { referenceRecordLabel, referencePartyGroups, referenceFieldSpan, REFERENCE_PARTIES } from './referenceFormLayout';
import { ReferenceProductCategoryPicker } from './ReferenceProductCategoryPicker';
import { ReferenceCategoryContext } from './ReferenceCategoryContext';
import { useProductDraftFacts } from './useProductDraftFacts';
import { ReferenceRecordHistory } from './ReferenceRecordHistory';
import { ReferenceLines, FreightHistory, CompositionResult } from './ReferenceProductFields';
import { BundleProfileEditor } from './BundleProfileEditor';
import { BaseCodeProfileEditor } from './BaseCodeProfileEditor';
import { SourcesDraft, WeightBlock, loadSourceRows, saveSourceRows, type SourceRow } from './ProductFormParts';
import { draftApi, resourceApi, type FileInfo, type ResourceDto } from './api';
import { ProductQualityDialog } from './ProductQualityDialog';
import { FilesInput } from './FilesField';
import { LicenseRecognizeButton } from './LicenseRecognize';

export function MoneyControl({value,scale,onChange,ariaLabel}:{value:unknown;scale:number;onChange:(v:unknown)=>void;ariaLabel?:string}) {
  const textOf=(v:unknown)=>v===undefined||v===null||v===''?'':unitYuanText(Number(v));
  const [text,setText]=useState(()=>textOf(value));
  useEffect(()=>{if(!Number.isNaN(value))setText(textOf(value));},[value]);
  return <input aria-label={ariaLabel} inputMode="decimal" value={text} placeholder={scale?'元（最多六位小数）':'元'} onChange={e=>{
    const raw=e.target.value;setText(raw);
    if(!raw.trim())return onChange('');
    try{onChange(yuanToPreciseCents(raw.trim().replace(/^\./,'0.'),scale));}catch{onChange(NaN);}
  }} />;
}

type RefOption = { value: number; label: string; disabled?: boolean; leaf?: boolean };
type RefOptions = RefOption[] & { total?: number };
/** 引用选择器一次最多取这么多条；更多的靠搜索框按关键字找（店铺、手机号等可能有几百条） */
const REF_PAGE = 50;
let refVersion = 0;
const refListeners = new Set<() => void>();
function useRefVersion() { return useSyncExternalStore(cb => { refListeners.add(cb); return () => { refListeners.delete(cb); }; }, () => refVersion); }
const refCache = new Map<string, Promise<RefOptions>>();

/** 按关键字服务端搜索可选项；员工/部门这类小列表不走这里 */
function searchRefOptions(target: string, keyword: string): Promise<RefOptions> {
  return resourceApi.list(target, { pageSize: REF_PAGE, showHidden: true, keyword }).then((r) => Object.assign(r.items.map((i) => ({ value: i.id, label: i.title })), { total: r.total }));
}

/** 选择器上方的搜索框：输入后（稍作防抖）向服务端搜索；用户/部门是整表加载，不显示 */
function useRefSearch(target: string, initial: RefOptions | null) {
  const [keyword, setKeyword] = useState('');
  const [found, setFound] = useState<RefOptions | null>(null);
  const searchable = target !== 'department' && target !== 'user' && (initial?.total ?? 0) > (initial?.length ?? 0);
  useEffect(() => {
    if (!searchable || !keyword.trim()) { setFound(null); return; }
    let alive = true;
    const t = setTimeout(() => { searchRefOptions(target, keyword.trim()).then((o) => alive && setFound(o)).catch(() => alive && setFound([])); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [keyword, searchable, target]);
  return { keyword, setKeyword, searchable, shown: found ?? initial, truncated: (found ?? initial) ? ((found ?? initial)!.total ?? 0) > (found ?? initial)!.length : false };
}
export function clearRefCache(type?: string) {
  if (type) refCache.delete(type);
  else refCache.clear();
  refVersion++; refListeners.forEach(listener => listener());
}

export function loadRefOptions(target: string) {
  let p = refCache.get(target);
  if (!p) {
    p =
      target === 'department'
        ? resourceApi.departments().then((list) => list.map((d) => ({ value: d.id, label: d.name })))
        : target === 'user'
        ? resourceApi.users().then((list) => list.map((u) => ({ value: u.id, label: u.active ? u.name : `${u.name}（已停用）`, disabled: !u.active })))
        : ['finance-categories','finance-supplier-categories','finance-customer-categories','finance-fee-categories'].includes(target)
        ? (async () => { const rows: ResourceDto[] = []; for (let page=1;;page++) { const r=await resourceApi.list(target,{page,pageSize:200,showHidden:true}); rows.push(...r.items); if(rows.length>=r.total||!r.items.length)break; } const byId=new Map(rows.map(r=>[r.id,r])); const path=(row:ResourceDto)=>{const parts:string[]=[],seen=new Set<number>();for(let r:ResourceDto|undefined=row;r&&!seen.has(r.id);r=byId.get(Number(r.data.parentId))){seen.add(r.id);parts.unshift(r.title);}return parts.join(' / ');};return Object.assign(rows.filter(r=>r.status==='active').map(r=>({value:r.id,label:path(r),leaf:!rows.some(c=>c.data.parentId===r.id)})),{total:rows.filter(r=>r.status==='active').length}); })()
        : resourceApi.list(target, { pageSize: REF_PAGE, showHidden: true }).then((r) => Object.assign(r.items.map((i) => ({ value: i.id, label: i.title })), { total: r.total }));
    p.catch(() => refCache.delete(target));
    refCache.set(target, p);
  }
  return p;
}

export function RefSelect({ field, value, onChange, labelNow, leafOnly = false }: { field: FieldDef; value: unknown; onChange: (v: number | null) => void; labelNow?: string; leafOnly?: boolean }) {
  const version = useRefVersion();
  const [options, setOptions] = useState<RefOptions | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadRefOptions(field.ref!).then((o) => alive && setOptions(o)).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [field.ref, version]);
  const search = useRefSearch(field.ref!, options);
  const current = typeof value === 'number' ? value : '';
  if (failed) return <input disabled value={labelNow ?? ''} placeholder="没有权限查看可选项" />;
  const list: RefOptions = leafOnly ? (search.shown ?? []).filter(o=>o.leaf!==false) : search.shown ?? Object.assign([], { total: 0 });
  const missing = current !== '' && !list.some((o) => o.value === current);
  return (
    <>
      {search.searchable && <input type="search" className="ref-search" aria-label={`搜索${field.label}`} placeholder="输入关键字搜索…" value={search.keyword} onChange={(e) => search.setKeyword(e.target.value)} />}
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
      {search.truncated && <small className="muted">只列出前 {list.length} 条，共 {list.total ?? '更多'} 条，输入关键字缩小范围</small>}
    </>
  );
}

/** 多选引用：勾选若干条记录（如供应商同时属于多个分类） */
export function RefsSelect({ field, value, onChange, labelNow, onLabels, leafOnly = false }: { field: FieldDef; value: number[]; onChange: (v: number[]) => void; labelNow?: string; onLabels?: (labels: Record<number, string>) => void; leafOnly?: boolean }) {
  const version = useRefVersion();
  const [options, setOptions] = useState<RefOptions | null>(null);
  const seen = useRef<Record<number, string>>({});
  useEffect(() => {
    let alive = true;
    loadRefOptions(field.ref!).then((o) => alive && setOptions(o)).catch(() => alive && setOptions(Object.assign([], { total: 0 })));
    return () => { alive = false; };
  }, [field.ref, version]);
  const search = useRefSearch(field.ref!, options);
  if (!options) return <span className="muted">加载中…</span>;
  const shown: RefOptions = leafOnly ? (search.shown ?? options).filter(o=>o.leaf!==false) : search.shown ?? options;
  for (const o of shown) seen.current[o.value] = o.label;
  const pick = (next: number[]) => { onChange(next); onLabels?.(seen.current); };
  const labels = (labelNow ?? '').split('、');
  // 已选但不在当前列出范围内的（分页/搜索之外），固定显示在最上面，保证能取消
  const extra = value.filter((v) => !shown.some((o) => o.value === v));
  return (
    <div className="check-list" role="group" aria-label={field.label}>
      {search.searchable && <input type="search" className="ref-search" aria-label={`搜索${field.label}`} placeholder="输入关键字搜索…" value={search.keyword} onChange={(e) => search.setKeyword(e.target.value)} />}
      {extra.map((v, i) => <label key={v} className="check"><input type="checkbox" checked onChange={() => pick(value.filter((x) => x !== v))} /> {labels[i] ?? `#${v}`}</label>)}
      {shown.map((o) => (
        <label key={o.value} className="check">
          <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => pick(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))} />
          {o.label}
        </label>
      ))}
      {search.truncated && <small className="muted">只列出前 {shown.length} 条，共 {shown.total} 条，输入关键字缩小范围</small>}
      {shown.length === 0 && extra.length === 0 && <span className="muted">还没有可选项</span>}
    </div>
  );
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

export function FieldInput({ field, value, onChange, configured, labelNow, type, known, onKnown, values }: {
  field: FieldDef; value: unknown; onChange: (v: unknown) => void; configured?: boolean; labelNow?: string;
  type: string; known: Record<number, FileInfo>; onKnown: (f: FileInfo) => void;
  /** 整张表单当前的值（“规格单位”这类按档案类型换列表的字段要看它） */
  values?: Record<string, unknown>;
}) {
  const units = useUnitOptions();
  useCategoryVersion(); // 分类改名/新增后下拉立即刷新
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
          {selectChoices(type, field, (f) => (f.optionsFrom ? fieldOptions(f, values ?? {}, units) : f.options ?? []), { mode: 'form', current: str }).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          {/* 记录里原来的值不在现在的列表里（历史数据、已停用的项）也要能看到 */}
          {field.optionsFrom && str && !fieldOptions(field, values ?? {}, units).some((o) => o.value === str) && <option value={str}>{str}</option>}
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
      return <RefsSelect leafOnly={type === 'finance-suppliers' && field.key === 'categoryIds'} field={field} value={Array.isArray(value) ? (value as number[]) : []} onChange={onChange} labelNow={labelNow} />;
    case 'ref':
      if (field.cascade && field.ref) return <CascadePicker target={field.ref} label={field.label} value={typeof value === 'number' ? value : null} onChange={onChange} labelNow={labelNow} />;
      return <RefSelect field={field} value={value} onChange={onChange} labelNow={labelNow} />;
    case 'secret':
      return <SecretInput value={str} maxLength={field.maxLength} placeholder={configured ? '已设置，留空表示不修改' : ''} onChange={onChange} />;
    default: {
      // 系统规格这类“可以选公司维护的，也可以手填”的文本
      const hints = field.optionsFrom ? fieldOptions(field, values ?? {}, units).map((o) => o.label) : [];
      const listId = hints.length ? `hints-${field.key}` : undefined;
      return (
        <>
          <input value={str} maxLength={field.maxLength} list={listId} onChange={(e) => onChange(e.target.value)} />
          {listId && <datalist id={listId}>{hints.map((h) => <option key={h} value={h} />)}</datalist>}
        </>
      );
    }
  }
}

/** 密码输入：默认遮住，点“显示输入”才看到自己输入的内容（核对有没有输错）。 */
function SecretInput({ value, maxLength, placeholder, onChange }: { value: string; maxLength?: number; placeholder: string; onChange: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="secret-input-row">
      <input type={shown ? 'text' : 'password'} autoComplete="new-password" value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
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

/** 新建/编辑弹窗：按字段定义生成，按字段分组；showWhen 不满足的字段不显示。 */
export function RecordForm(props: Parameters<typeof GenericRecordForm>[0]) {
  if (props.def.key === 'finance-bundles' && props.record && !props.inline) return <BundleProfileEditor record={props.record} onClose={props.onClose} onSaved={props.onSaved} />;
  if (props.def.key === 'finance-base-codes' && props.record && !props.inline) return <BaseCodeProfileEditor record={props.record} onClose={props.onClose} onSaved={props.onSaved} />;
  return <GenericRecordForm {...props} />;
}

function GenericRecordForm({ def, record, initial, lockedFields, onlyGroup, inline, onClose, onSaved, onContinued }: {
  def: ResourceDef;
  record: ResourceDto | null;
  initial?: Record<string, unknown>;
  lockedFields?: string[];
  /** 只编辑这一个分区的字段（详情页“编辑本区”） */
  onlyGroup?: string;
  /** 就地编辑：不弹窗，直接在详情页该分区的位置显示表单 */
  inline?: boolean;
  onClose: () => void;
  onSaved: (dto: ResourceDto) => void;
  /** 提供了它，新建时就多出“保存并继续新建”：保存后不关弹窗，列表由它刷新 */
  onContinued?: (dto: ResourceDto) => void;
}) {
  const copyOf = typeof initial?.__copyOf === 'number' ? initial.__copyOf : null;
  const [values, setValues] = useState<Record<string, unknown>>(() => { const v: Record<string, unknown> = { ...(!record && def.key === 'finance-fee-items' ? {direction:'expense'} : {}), ...(record?.data ?? {}), ...(initial ?? {}) }; delete v.__copyOf; return v; });
  const [status, setStatus] = useState(record?.status ?? def.defaultStatus);
  const [statusReason, setStatusReason] = useState('');
  const referenceStatus = ['finance-customers','finance-fee-items'].includes(def.key);
  const [error, setError] = useState('');
  const [bomRows, setBomRows] = useState<BomDraftRow[]>([]);
  const [bomOrig, setBomOrig] = useState<BomDraftRow[]>([]);
  const [sourceRows, setSourceRows] = useState<SourceRow[]>([]);
  const [sourceOrig, setSourceOrig] = useState<SourceRow[]>([]);
  // 读不出来（没有权限等）时为 null：不在表单里校验，交给服务端
  const [partsKnown, setPartsKnown] = useState({ sources: true, composition: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState<Record<number, FileInfo>>(record?.files ?? {});
  // 新建时填了内容就关闭，先确认，免得点错丢内容（旧系统同款）
  const startValues = useRef(JSON.stringify(values));
  const rowsKey = JSON.stringify([bomRows, sourceRows]);
  const startRows = useRef<string | null>(null);
  if (startRows.current === null && !(record || copyOf)) startRows.current = rowsKey;
  useEffect(() => { if (startRows.current === null && (record || copyOf) && (bomRows.length || sourceRows.length || bomOrig.length || sourceOrig.length)) startRows.current = rowsKey; }, [rowsKey, record, copyOf, bomRows.length, sourceRows.length, bomOrig.length, sourceOrig.length]);
  const dirty = status !== (record?.status ?? def.defaultStatus) || JSON.stringify(values) !== startValues.current || (startRows.current !== null && rowsKey !== startRows.current);
  const requestClose = () => {
    if (busy) return;
    if (dirty && !window.confirm(record ? '修改的内容还没有保存，关闭后会丢失。确定直接关闭吗？' : '新增的资料还没有保存，关闭后填写的内容会丢失。确定直接关闭吗？')) return;
    onClose();
  };
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
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
  const locked = useMemo(() => [...(lockedFields ?? []), ...(refLock?.fields ?? [])], [lockedFields, refLock]);
  // 商品档案：分区、顺序、叫法、必填、显示条件全部来自 product-layout（详情页读的是同一份）
  const resolved = useMemo(() => (def.key === 'finance-products' ? resolveProductSections(values, { canUse: (p) => (me ? createChecker(me.permissions)(p) : false) }) : null), [def.key, values, me]);
  const visible = useMemo(() => {
    if (resolved) return resolved.flatMap((s) => s.nodes.flatMap((n) => (n.kind === 'field' ? [n.field] : n.fields))).filter((f) => !f.readonly && (!onlyGroup || f.group === onlyGroup));
    const ctx: Record<string, unknown> = { ...values, status };
    return def.fields.filter((f) => !f.readonly && canField(f)).filter(f => !(def.key === 'finance-base-codes' && !record && ['categoryId','weightG'].includes(f.key)) && !(def.key === 'finance-categories' && record && f.key === 'archiveType')).filter((f) => !(def.key === 'fixed-assets' && record && f.key === 'userId')).filter((f) => !f.showWhen || f.showWhen.in.includes(String(ctx[f.showWhen.field] ?? ''))).filter((f) => !onlyGroup || f.group === onlyGroup);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, values, status, me, onlyGroup, resolved]);
  const isReferenceParty = REFERENCE_PARTIES.includes(def.key);
  const referenceLabel = referenceRecordLabel(def.key, values) || def.label;
  const referenceMaintenance = ['finance-categories','finance-supplier-categories','finance-customer-categories','finance-fee-categories','finance-brands','finance-product-units','finance-platforms','finance-scenarios'].includes(def.key);
  const reference = def.key === 'finance-products' || isReferenceParty || referenceMaintenance;
  const groups = useMemo(() => {
    if (isReferenceParty) return referencePartyGroups(def.key, visible);
    if (resolved) return resolved.filter((s) => !onlyGroup || s.title === onlyGroup).map((s) => [s.title, visible.filter((f) => f.group === s.title)] as [string, FieldDef[]]);
    const map = new Map<string, FieldDef[]>();
    for (const f of visible) map.set(f.group, [...(map.get(f.group) ?? []), f]);
    return [...map.entries()];
  }, [visible, resolved, onlyGroup, isReferenceParty, def.key]);

  // 商品档案新建：草稿（每人每个档案类型一份，存在服务器上）、保存并继续新建
  const isProduct = def.key === 'finance-products';
  // 人力成本版本：旧系统是边填边自动存草稿，关掉再开能接着填
  const autoDraft = !record && def.key === 'finance-labor-versions';
  const draftEnabled = !record && (isProduct || autoDraft);
  const draftKey = draftApi.key(`resource:${def.key}`, [String(initial?.archiveType ?? ''), String(initial?.supplyMode ?? '')]);
  const [draftNote, setDraftNote] = useState('');
  const [quality, setQuality] = useState<{ body: Record<string, unknown>; mode: SaveMode; options: QualityOptions } | null>(null);
  useEffect(() => {
    if (!draftEnabled) return;
    let alive = true;
    draftApi.get(draftKey).then((r) => {
      if (!alive || !r.draft) return;
      setValues((cur) => ({ ...cur, ...r.draft!.payload }));
      setDraftNote('已恢复上次保存的草稿。');
    }).catch(() => undefined);
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
    if (wantSources) loadSourceRows(src).then((rows) => { if (!alive) return; const mine = rows.filter((r) => !r.stopped); setSourceRows(record ? mine : mine.map(({ rowId: _r, ...x }) => x)); setSourceOrig(record ? mine : []); }).catch(() => alive && setPartsKnown((c) => ({ ...c, sources: false })));
    if (wantComposition) loadBomRows(src).then((rows) => { if (!alive) return; setBomRows(record ? rows : rows.map(({ rowId: _r, ...x }) => x)); setBomOrig(record ? rows : []); }).catch(() => alive && setPartsKnown((c) => ({ ...c, composition: false })));
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draftReady = useRef(false);
  useEffect(() => {
    if (!autoDraft) return;
    if (!draftReady.current) { draftReady.current = true; return; }
    const t = setTimeout(() => {
      const body = currentBody();
      if (Object.values(body).some((v) => v !== '' && v !== undefined && !(Array.isArray(v) && !v.length))) {
        void draftApi.save(draftKey, { moduleKey: `resource:${def.key}`, title: `新增${def.label}`, payload: body }).then(() => setDraftNote('草稿已自动保存。')).catch(() => undefined);
      }
    }, 1200);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  function currentBody() {
    // 只提交可见字段；密码类留空表示不修改，所以空值不提交
    const body: Record<string, unknown> = {};
    for (const f of visible) {
      const v = values[f.key];
      if (f.type === 'secret' && (v === undefined || v === '')) continue;
      body[f.key] = v === undefined ? (f.type === 'files' ? [] : f.type === 'attrs' ? {} : '') : v;
    }
    return body;
  }

  async function saveDraft() {
    setBusy(true);
    setError('');
    try {
      await draftApi.save(draftKey, { moduleKey: `resource:${def.key}`, title: `新增${def.label}`, payload: currentBody() });
      onClose();
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
    if (!validate()) return;
    setBusy(true);
    setError('');
    try {
      const body = currentBody();
      if (SIMILARITY_RESOURCES.includes(def.key) && (!isProduct || !record || body.name !== record.data.name)) {
        const sim = await resourceApi.similarCheck(def.key, { ...(record?.data ?? {}), ...body }, record?.id).catch(() => null);
        if (sim?.warnings.length && !window.confirm(`发现相似的资料，确定仍要保存吗？\n\n${sim.warnings.slice(0, 3).map((w) => w.text).join('\n')}`)) { setBusy(false); return; }
      }
      if (isProduct) {
        // 旧系统每次保存商品档案都先弹“核算资料确认”：逐项核对、零值写原因
        // 原料、发货物料的采购价来自供货来源：核算确认里按有价格的来源行显示（保存时仍以来源为准）
        const sourcePrice = wantSources ? sourceRows.find((r) => r.supplierId && r.purchasePrice !== '' && !Number.isNaN(r.purchasePrice))?.purchasePrice : undefined;
        const merged = { ...(record?.data ?? {}), ...body, ...(sourcePrice !== undefined ? { purchasePrice: sourcePrice } : {}) };
        const options: QualityOptions = { canCost: Boolean(me && createChecker(me.permissions)('product.cost.edit')), composition: wantComposition || layoutKey === 'self_made' ? (partsKnown.composition ? { packaging: validBomRows(bomRows).filter((r) => r.group === 'package' || r.group === 'oem_package').length, labor: validBomRows(bomRows).filter((r) => r.group === 'labor').length } : await compositionCounts(record?.id, merged)) : undefined };
        setQuality({ body: merged, mode, options });
        setBusy(false);
        return;
      }
      await commit(body, mode);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败，请重试');
      setBusy(false);
    }
  }

  async function commit(body: Record<string, unknown>, mode: SaveMode) {
    setBusy(true);
    setError('');
    try {
      if (wantSources) delete body.purchasePrice; // 采购价由供货来源汇出，不直接写档案
      let saved: ResourceDto;
      if (record && (referenceStatus || isProduct) && status !== record.status) {
        const result = await resourceApi.gridSave(def.key, { updates: [{ id: record.id, version: record.version, data: body, status, statusReason }], note: '资料编辑' });
        const item = result.results[0];
        if (!item?.ok) throw new ApiError(400, item?.message || '保存失败');
        saved = item.row ?? await resourceApi.get(def.key, record.id);
      } else saved = record ? await resourceApi.update(def.key, record.id, body) : await resourceApi.create(def.key, body, status);
      clearRefCache(def.key);
      if (isProduct) {
        const failed: string[] = [];
        const canCostEdit = Boolean(me && createChecker(me.permissions)('product.cost.edit'));
        if (wantSources && partsKnown.sources && (!onlyGroup || sectionHas(onlyGroup, 'supplySources'))) failed.push(...await saveSourceRows(saved.id, sourceRows, sourceOrig, canCostEdit));
        if (wantComposition && partsKnown.composition && (!onlyGroup || sectionHas(onlyGroup, 'composition'))) failed.push(...await saveBomRows(saved.id, bomRows, bomOrig));
        if (failed.length) window.alert(`档案已保存，但这些明细没保存成功，请到详情的“供货来源 / 构成（BOM）”页签补录：\n${failed.join('\n')}`);
        if (mode === 'blank') { setBomRows([]); setSourceRows([]); setBomOrig([]); setSourceOrig([]); }
        else { setBomRows((r) => r.map(({ rowId: _r, ...x }) => x)); setSourceRows((r) => r.map(({ rowId: _r, ...x }) => x)); setBomOrig([]); setSourceOrig([]); }
      }
      if (draftEnabled) await clearDraft();
      if (mode === 'close' || !onContinued) { onSaved(saved); return; }
      // 继续新建：“保存并继续新建”留空重填（只留档案类型、分类、采购方式），“不清除保存”带着内容，只清掉每个商品独有的编码和赠品简称
      onContinued(saved);
      setValues(mode === 'blank'
        ? Object.fromEntries(['archiveType', 'supplyMode', 'categoryId', 'purchaseSpec', 'specUnit'].filter((k) => values[k] !== undefined).map((k) => [k, values[k]]))
        : { ...values, code: '', giftShortName: '', giftCodeShortName: '', zeroValueReason: '' });
      setKnown({});
      setDraftNote(`已保存「${String(saved.title ?? '')}」，可以继续新增。`);
      setBusy(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败，请重试');
      setBusy(false);
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
    const next: Record<string, string> = {};
    for (const f of visible) {
      const p = fieldProblem(f);
      if (p) next[f.key] = p;
    }
    if (isProduct && !onlyGroup) {
      // 按旧版 saveProduct 的校验逐项标出来（同一份布局决定哪些必填）；服务端仍是最终裁判
      const bom = bomRows.map((r) => ({ group: r.group, id: r.id, qty: r.qty }));
      const probs = productFormProblems(values, {
        canCost: Boolean(me && createChecker(me.permissions)('product.cost.edit')),
        sources: partsKnown.sources ? sourceRows : null, composition: partsKnown.composition ? bom : null,
      });
      const shown = new Set([...visible.map((f) => f.key), 'supplySources', 'composition']);
      for (const [k, msg] of Object.entries(probs)) if (shown.has(k) && !(next[k] && /数字|日期格式/.test(next[k]))) next[k] = msg;
    }
    setErrors(next);
    const first = visible.find((f) => next[f.key]);
    if (first) setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-field="${first.key}"] input, [data-field="${first.key}"] select, [data-field="${first.key}"] textarea`);
      el?.focus();
      el?.scrollIntoView?.({ block: 'center' });
    }, 0);
    return !Object.values(next).some(Boolean);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void prepare('close');
  }

  const sectionHas = (title: string, block: string) => Boolean(resolved?.some((s) => s.title === title && s.nodes.some((n) => n.kind === 'block' && n.block === block)));
  const secId = (g: string) => `rf-sec-${g}`;
  const [manualCode, setManualCode] = useState(false);
  const [generatedCode, setGeneratedCode] = useState('');
  const [generatedName, setGeneratedName] = useState('');
  const canCostEdit = Boolean(me && createChecker(me.permissions)('product.cost.edit'));
  const draftFacts = useProductDraftFacts(bomRows, canCostEdit);
  const compositionPrice = layoutKey === 'purchased_oem' && !bomRows.length ? 0 : draftFacts.cost;
  const oemRawPrice = Number(values.purchasePrice || 0);
  const previewValues = { ...values, ...(wantComposition ? { purchasePrice: compositionPrice === null || layoutKey === 'purchased_oem' && !Number.isFinite(oemRawPrice) ? undefined : sumUnitCents([compositionPrice, layoutKey === 'purchased_oem' ? oemRawPrice : 0]) } : {}), ...(wantSources ? { purchasePrice: sourceRows.find(r => r.supplierId && r.purchasePrice !== '')?.purchasePrice ?? values.purchasePrice } : {}) };
  const automaticWeight = layoutKey === 'raw' ? systemWeightG(String(values.purchaseSpec ?? '')) : layoutKey === 'self_made' ? draftFacts.weightG : layoutKey === 'purchased_oem' ? (specificationWeightG(values.specQty, values.specUnit) ?? 0) + Number(values.oemPackageWeightG || 0) + (draftFacts.weightG ?? 0) : specificationWeightG(values.specQty, values.specUnit);
  const weightValues = values.weightManual === true || ['package','oem_package','shipping_material','custom'].includes(layoutKey) ? values : { ...values, weightG: automaticWeight };
  const secTitle = (g: string) => (resolved ? g : groupTitle(def, g, values));
  const errorsByGroup = (g: string) => groups.find(([name]) => name === g)?.[1].filter((f) => errors[f.key]).length ?? 0;
  const showAnchors = !inline && !reference && groups.length > 1;
  const scrollBox = useRef<HTMLDivElement>(null);
  const [activeGroup, setActiveGroup] = useState('');
  const jump = (g: string) => { setActiveGroup(g); document.getElementById(secId(g))?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); };
  const onScroll = () => {
    const box = scrollBox.current;
    if (!box || !showAnchors) return;
    const top = box.getBoundingClientRect().top + 24;
    let current = groups[0]?.[0] ?? '';
    for (const [g] of groups) { const el = document.getElementById(secId(g)); if (el && el.getBoundingClientRect().top <= top) current = g; }
    if (current !== activeGroup) setActiveGroup(current);
  };
  const errorCount = Object.values(errors).filter(Boolean).length;

  const renderField = (f: FieldDef, wide?: boolean) => (
    <label key={f.key} data-field={f.key} onBlur={() => { const p = fieldProblem(f); if (p !== (errors[f.key] ?? '')) setErrors((cur) => ({ ...cur, [f.key]: p })); }} className={[reference ? `s${wide ? 12 : referenceFieldSpan(def.key, f)}` : '', !reference && (wide || f.type === 'textarea' || f.type === 'attrs' || f.type === 'files' || (f.type === 'ref' && f.cascade)) ? 'wide' : '', errors[f.key] ? 'invalid' : ''].filter(Boolean).join(' ') || undefined}>
      <span className="rf-label">{isProduct && f.key === 'name' && ['self_made','purchased_original','purchased_oem','shipping_material'].includes(layoutKey) ? `${referenceLabel}名称` : isProduct && layoutKey === 'custom' && f.key === 'specQty' ? '多少' : isProduct && layoutKey === 'custom' && f.key === 'shape' ? '形态样式' : f.label}{f.required && <b className="req" title="必填">{reference ? '必填' : ' *'}</b>}{isProduct && ['materialCode','note'].includes(f.key) && !f.required && <small className="reference-optional">选填</small>}{!reference && isProduct && f.help && <FieldHint text={f.help} />}{isProduct && <ManageLink field={f} values={values} inPlace={reference} />}</span>
      {def.key === 'finance-customers' && f.key === 'categoryIds' ? <><RefSelect leafOnly field={{...f,type:'ref'}} value={Array.isArray(values.categoryIds) ? values.categoryIds[0] : null} labelNow={record?.refLabels.categoryIds} onChange={v => setValues(cur => ({...cur,categoryIds:v ? [v] : []}))} />{Array.isArray(values.categoryIds) && values.categoryIds.length > 1 && <small>当前同时归属：{record?.refLabels.categoryIds}；重新选择后归入所选分类。</small>}</> : f.type === 'attrs' ? <AttrsInput field={f} def={def} values={values} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} /> : <FieldInput
        field={f}
        value={lockedFields?.includes(f.key) ? initial?.[f.key] : values[f.key]}
        configured={record?.secretConfigured[f.key]}
        labelNow={record?.refLabels[f.key]}
        type={def.key}
        values={values}
        known={known}
        onKnown={(info) => setKnown((cur) => ({ ...cur, [info.id]: info }))}
        onChange={(v) => { if (locked.includes(f.key)) return; setValues((cur) => ({ ...cur, [f.key]: v })); if (errors[f.key]) setErrors((cur) => ({ ...cur, [f.key]: '' })); }}
      />}
      {errors[f.key] ? <small className="field-error" role="alert">{errors[f.key]}</small> : !reference && f.help && <small className="muted">{f.help}</small>}
    </label>
  );

  /** 商品档案分区里的一项：普通字段，或联动的功能块（编号预览、供货来源行、生产组成、重量、成本预览） */
  const renderNode = (n: ResolvedNode, i: number) => {
    if (n.kind === 'field') return n.field.key === 'zeroValueReason' && !needsZeroReason(values) && !errors.zeroValueReason ? null : renderField(n.field, n.wide);
    const editable = n.fields.filter((f) => !f.readonly);
    switch (n.block) {
      case 'code': return <div key={`b${i}`} className="s12 reference-code"><button type="button" className="reference-code-toggle" disabled={locked.includes('code')} onClick={() => { setManualCode(v => !v); if (manualCode) { setValues(v => ({ ...v, code: '' })); setGeneratedCode(''); } }}>{!manualCode && <Pencil size={15} />}{manualCode ? '恢复自动编号' : '人工修正'}</button><input aria-label="系统自动编号" readOnly={!manualCode || locked.includes('code')} value={String(manualCode ? values.code ?? '' : generatedCode || values.code || '')} placeholder="保存后自动生成" onChange={e => setValues(v => ({ ...v, code: e.target.value }))} /><CodePreview values={values} excludeId={record?.id} onPreview={setGeneratedCode} onFullName={setGeneratedName} quiet />{!['raw','shipping_material'].includes(layoutKey) && <p className="reference-code-hint">{resolved?.find(sec => sec.id === 'code')?.hint}</p>}</div>;
      case 'supplySources': return <div key={`b${i}`} className="s12"><SourcesDraft rows={sourceRows} onChange={setSourceRows} reference canCost={canCostEdit} needSpec={layoutKey === 'shipping_material'} error={errors.supplySources} />{!partsKnown.sources && <small className="muted">供货来源暂时读取不到，请到详情的“供货来源”页签维护。</small>}</div>;
      case 'composition': return <div key={`b${i}`} className="s12">{layoutKey === 'self_made' && <><nav className="reference-production-summary" aria-label="生产资料组成">{(['raw','package','labor'] as const).map((g,index)=><button type="button" key={g} onClick={()=>document.getElementById(`rf-bom-${g}`)?.scrollIntoView({behavior:'smooth',block:'start'})}><i>{String(index+1).padStart(2,'0')}</i><strong>{g==='raw'?'原料':g==='package'?'包装':'人工'}</strong><span>{bomRows.filter(r=>r.group===g||g==='package'&&r.group==='oem_package').length} 项</span></button>)}</nav><p className="reference-production-hint">选择档案和用量后，采购价、重量及成本会自动汇总。</p></>}<BomDraft reference records={draftFacts.records} canCost={canCostEdit} rows={bomRows} onChange={(r) => { setBomRows(r); if (errors.composition) setErrors((c) => ({ ...c, composition: '' })); }} groups={n.groups} required={layoutKey === 'self_made'} error={errors.composition} /></div>;
      case 'weight': return (
        <div key={`b${i}`} className="s6 rf-block" data-field="weightG">
          <span className="rf-label">{layoutKey === 'shipping_material' ? '物料重量' : '重量'}{n.required && <b className="req" title="必填">{reference ? '必填' : ' *'}</b>}</span>
          <WeightBlock values={weightValues} manualOnly={['package', 'oem_package', 'shipping_material', 'custom'].includes(layoutKey)} required={n.required} error={errors.weightG} defaultUnit={['package','oem_package'].includes(layoutKey) ? 'g' : 'kg'}
            onChange={(patch) => { setValues((cur) => ({ ...cur, ...patch })); if (errors.weightG) setErrors((c) => ({ ...c, weightG: '' })); }} />
        </div>
      );
      case 'costSummary': return <div key={`b${i}`} className="s12"><TotalCostPreview values={previewValues} idle /></div>;
      case 'category': if (layoutKey === 'custom') return <Fragment key={`b${i}`}><div className="s6"><span className="rf-label">所属分类 <b className="req">必填</b></span><ReferenceProductCategoryPicker values={values} labelNow={record?.refLabels.categoryId} onChange={id => setValues(v => ({...v,categoryId:id}))}/>{errors.categoryId && <small className="field-error">{errors.categoryId}</small>}</div><label className="s6"><span className="rf-label">状态</span><select value={status} disabled={!!record && !(me && createChecker(me.permissions)('resource.finance-products.disable'))} onChange={e => setStatus(e.target.value)}><option value="active">正常</option><option value="inactive">停用</option></select></label>{record && status !== record.status && status === 'inactive' && <label className="s12">停用原因<textarea value={statusReason} onChange={e => setStatusReason(e.target.value)}/></label>}</Fragment>;
      return <div key={`b${i}`} className="s12"><ReferenceCategoryContext label={referenceLabel} editing={!!record} path={record?.refLabels.categoryId ?? ''}>{record ? editable.map(f => renderField(f)) : <div data-field="categoryId"><ReferenceProductCategoryPicker values={values} onChange={id => { setValues(v => ({...v, categoryId:id})); setErrors(e => ({...e,categoryId:''})); }} />{errors.categoryId && <small className="field-error" role="alert">{errors.categoryId}</small>}</div>}</ReferenceCategoryContext></div>;
      case 'capacities': case 'finishedNames': return <div key={`b${i}`} className="s12"><ReferenceLines kind={n.block} value={values[n.block === 'capacities' ? 'capacities' : 'rawFinishedNames']} onChange={v => setValues(cur => ({ ...cur, [n.block === 'capacities' ? 'capacities' : 'rawFinishedNames']: v }))} /></div>;
      case 'breakdown': return <div key={`b${i}`} className="s12"><CompositionResult facts={draftFacts} values={values} canCost={canCostEdit} /></div>;
      case 'fullName': return <div key={`b${i}`} className="reference-full-name s12"><small>基础信息全名</small><output>{generatedName || String(values.basicInfoFullName ?? '填写基础信息后自动生成')}</output></div>;
      default: return null;
    }
  };

  return (
    <div className={inline ? 'inline-edit' : `modal-backdrop${reference ? ' reference-backdrop' : ''}`} role="presentation">
      <form className={inline ? 'inline-form' : `modal card rf${isProduct ? ' rf-p' : ''}${reference ? ` rf-reference${referenceMaintenance ? ' reference-maintenance' : ''} reference-${isProduct ? productLayoutKey(values) : def.key}` : ''}`} role={inline ? 'group' : 'dialog'} aria-label={onlyGroup ? `编辑${onlyGroup}` : record ? `编辑${def.label}` : `新增${def.label}`} onSubmit={submit}>
        {!inline && <div className="modal-head rf-head">
          {reference ? <div className="reference-title">{def.key === 'finance-suppliers' && <small className="reference-party-kicker"><FolderTree size={20}/>财务基础资料</small>}{isProduct && values.archiveType === 'purchased' && <small>外购成品档案 · {values.supplyMode === 'supplier_oem' ? '供应商 OEM' : '原装采购'}</small>}<h2>{record ? referenceStatus || (isProduct && layoutKey === 'custom') ? String(values.name || referenceLabel) : `编辑${isProduct ? String(values.name || referenceLabel) : referenceLabel}` : `新增${referenceLabel}`}</h2><p>{isProduct && layoutKey === 'custom' ? '先确认分类，再维护基础信息；编号按分类、可选品牌、名称、规格和可选形态样式生成，空白可选段会直接省略。' : referenceStatus ? `${def.label}详情、分类归属和操作记录。` : isReferenceParty ? record ? `在原位编辑${referenceLabel}资料，保存后立即生效。` : `填写${referenceLabel}基础资料，保存后归入当前分类。` : record ? `字段布局与新增${referenceLabel}保持一致，保存后更新当前记录。` : `填写${referenceLabel}基础资料即可保存。`}</p></div> : <><strong>{record ? `编辑${def.label}` : `新增${def.label}`}</strong>{record && <span className="rf-sub" title={record.title}>{record.title}</span>}</>}
          <span className="rf-gap" />
          {!reference && visible.some((f) => f.required) && <span className="muted rf-req-hint"><b className="req">*</b> 必填</span>}
          <button type="button" className={`icon-button${referenceStatus || isProduct && layoutKey === 'custom' ? ' reference-full-close' : ''}`} aria-label="关闭" onClick={requestClose}>{referenceStatus || isProduct && layoutKey === 'custom' ? '关闭' : reference ? <X size={20} /> : '✕'}</button>
        </div>}
        <div className={showAnchors ? 'rf-main with-anchors' : 'rf-main'}>
          {showAnchors && (
            <nav className="rf-anchors" aria-label="表单分区">
              {groups.map(([g]) => {
                const n = errorsByGroup(g);
                return (
                  <button key={g} type="button" className={`rf-anchor${(activeGroup || groups[0][0]) === g ? ' active' : ''}${n ? ' has-error' : ''}`} onClick={() => jump(g)}>
                    <span>{secTitle(g)}</span>
                    {n > 0 && <b className="rf-err-n" aria-label={`${n} 项有问题`}>{n}</b>}
                  </button>
                );
              })}
            </nav>
          )}
          <div className="modal-body rf-scroll" ref={scrollBox} onScroll={onScroll}>
          {def.key === 'licenses' && (
            <LicenseRecognizeButton
              onApply={(fields) => setValues((cur) => ({ ...cur, ...fields }))}
            />
          )}
          {draftNote && <div className="notice">{draftNote}{draftEnabled && draftNote.startsWith('已恢复') && <> <button type="button" className="link-button" onClick={() => void clearDraft()}>清除草稿</button></>}</div>}
          {!reference && !record && def.statuses.length > 1 && def.key !== 'fixed-assets' && (
            <label className="rf-status">初始状态
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {def.statuses.filter((s) => !s.requiresReason).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
          )}
          {inline && visible.some((f) => f.required) && <p className="muted required-hint"><b className="req">*</b> 为必填项。</p>}
          {!inline && !record && !reference && visible.some((f) => f.required) && <p className="muted required-hint">带 <b className="req">*</b> 的为必填项，保存后可以继续补充关联资料。</p>}
          {resolved ? resolved.filter(sec => (!onlyGroup || sec.title === onlyGroup) && !(record && ['package','oem_package'].includes(layoutKey) && sec.id === 'category') && !(layoutKey === 'custom' && ['cost','total','photos'].includes(sec.id))).sort((a, b) => Number(a.id === 'gift') - Number(b.id === 'gift')).map((sec) => ['gift','extra'].includes(sec.id) ? <details key={sec.id} className="rf-sec reference-section-gift" data-sec={sec.id === 'extra' ? sec.id : undefined}><summary>{sec.id === 'gift' ? '赠品简称设置' : sec.title}</summary><div className="form-grid">{sec.nodes.map(renderNode)}</div></details> : (
            <section key={sec.id} id={secId(sec.title)} data-sec={sec.id} className={`rf-sec reference-section-${sec.id}`} aria-label={sec.title}>
              {!inline && (sec.id !== 'category' || layoutKey === 'custom') && <h3 className="rf-sec-title">{sec.step && !(layoutKey === 'self_made' && sec.id !== 'base') && <i className="rf-step">{sec.step}</i>}{sec.id === 'stock' && ['package','oem_package'].includes(layoutKey) ? '库存' : sec.title}{sec.hint && (reference ? <small>{sec.hint}</small> : <FieldHint text={sec.hint} />)}</h3>}
              <div className="form-grid">{sec.nodes.filter(n => !(layoutKey === 'custom' && (n.kind === 'field' && n.field.key === 'note' || n.kind === 'block' && n.block === 'fullName'))).filter(n => !(['raw','shipping_material'].includes(layoutKey) && sec.id === 'base' && (n.kind === 'field' && n.field.key === 'note' || n.kind === 'block' && n.block === 'fullName'))).map(renderNode)}</div>{['raw','shipping_material'].includes(layoutKey) && sec.id === 'base' && <div className="reference-note">{sec.nodes.filter(n => n.kind === 'field' && n.field.key === 'note').map(renderNode)}</div>}{['raw','shipping_material'].includes(layoutKey) && sec.id === 'base' && sec.nodes.filter(n => n.kind === 'block' && n.block === 'fullName').map(renderNode)}{sec.id === 'logistics' && canCostEdit && <FreightHistory productId={record?.id} values={previewValues} />}
            </section>
          )) : groups.map(([group, fields]) => group === '补充资料' && referenceStatus ? null : group === '补充资料' && reference ? <details key={group} className="rf-sec reference-extra"><summary>更多设置</summary><div className="form-grid">{fields.map(f => renderField(f))}</div></details> : (
            <section key={group} id={secId(group)} className={`rf-sec reference-party-${group === '归入分类' ? 'category' : group === '系统自动编号' ? 'code' : 'fields'}`} aria-label={group}>
              {group === '归入分类' && isReferenceParty ? <><ReferenceCategoryContext party label={referenceLabel} editing={!!record} path={record?.refLabels.categoryIds ?? ''}>{!record && fields.map(f => renderField(f))}</ReferenceCategoryContext>{record && def.key === 'finance-suppliers' && <div className="reference-supplier-categories"><h3>供应产品分类 <small>可多选</small></h3>{fields.map(f => renderField(f))}</div>}</> : <>
              {!inline && <h3 className="rf-sec-title">{isReferenceParty && ['基础资料','联系资料','收款与银行资料'].includes(group) && <i className="rf-step">{['基础资料','联系资料','收款与银行资料'].indexOf(group) + 1}</i>}{referenceStatus && group === '基础信息' && <Database size={18}/>} {secTitle(group)}{def.key === 'finance-suppliers' && group === '基础资料' && <small>与新增供应商的字段排列一致</small>}{def.key === 'finance-suppliers' && group === '联系资料' && <small>用于业务联系和后续单据引用</small>}{group === '系统自动编号' && <small>编码按分类和名称生成</small>}</h3>}
              <div className="form-grid">{fields.map(f => <Fragment key={f.key}>{renderField(f)}{def.key === 'finance-fee-items' && f.key === 'isCommon' && <label className="s6"><span className="rf-label">费用单必须挂归属对象</span><select title="按挂账节点自动判断，修改挂账节点可改变要求" disabled value={String(values.defaultObject || '').split(/[、,，]/).some(n => n && n !== '公司' && n !== '不固定') ? 'yes' : 'no'}><option value="yes">是</option><option value="no">否</option></select><small className="muted">按挂账节点自动判断</small></label>}{referenceStatus && ['categoryId','categoryIds'].includes(f.key) && <label className="s6"><span className="rf-label">状态</span><select value={status} disabled={!!record && !(me && createChecker(me.permissions)(`resource.${def.key}.disable`))} onChange={e => setStatus(e.target.value)}><option value="active">正常</option><option value="inactive">停用</option></select></label>}</Fragment>)}{referenceStatus && status !== record?.status && status === 'inactive' && <label className="s12">停用原因<textarea value={statusReason} maxLength={500} onChange={e => setStatusReason(e.target.value)} /></label>}</div></>}
            </section>
          ))}
          {isProduct && layoutKey === 'custom' && <details className="reference-extra"><summary>更多设置</summary><div className="form-grid">{resolved?.filter(sec => ['cost','total','photos'].includes(sec.id)).flatMap(sec => sec.nodes).map(renderNode)}{resolved?.find(sec=>sec.id==='base')?.nodes.filter(n => n.kind === 'field' && n.field.key === 'note' || n.kind === 'block' && n.block === 'fullName').map(renderNode)}</div></details>}
          {referenceStatus && record && <ReferenceRecordHistory type={def.key} id={record.id} label={def.label.replace(/档案$/,'')} />}
          {referenceStatus && groups.find(([g]) => g === '补充资料') && <details className="reference-extra"><summary>更多设置</summary><div className="form-grid">{groups.find(([g]) => g === '补充资料')![1].map(f=>renderField(f))}</div></details>}
          {refLock && <div role="status" className="notice warn">该商品编码{refLock.label}（{refLock.items.slice(0, 3).map((i) => `${i.sourceLabel}：${i.name}`).join('；')}），编码和来源已锁定，只能修改商品名称、简称、颜色及规格和启停状态。</div>}
          {error && <div role="alert" className="notice error">{error}</div>}
          </div>
        </div>
        {errorCount > 0 && (
          <div role="alert" className="rf-errbar error-summary">
            <strong>还有 {errorCount} 项需要补充或修改：</strong>
            {visible.filter((f) => errors[f.key]).map((f) => (
              <button key={f.key} type="button" className="link-button" onClick={() => document.querySelector<HTMLElement>(`[data-field="${f.key}"] input, [data-field="${f.key}"] select, [data-field="${f.key}"] textarea`)?.focus()}>{f.label}</button>
            ))}
            {([['supplySources', '供货来源'], ['composition', '生产组成']] as const).filter(([k]) => errors[k]).map(([k, label]) => (
              <button key={k} type="button" className="link-button" onClick={() => document.querySelector<HTMLElement>(`[data-field="${k}"]`)?.scrollIntoView?.({ block: 'center' })}>{label}</button>
            ))}
          </div>
        )}
        <div className="modal-foot rf-foot">
          {dirty && !reference && <span className="muted dirty-hint">{record ? '有未保存的修改' : '已填写内容尚未保存'}</span>}
          <button type="button" className="secondary-button" disabled={busy} onClick={requestClose}>{isReferenceParty && record ? '取消编辑' : '取消'}</button>
          {draftEnabled && <button type="button" className="secondary-button" disabled={busy} onClick={() => void saveDraft()}>保存草稿</button>}
          {!record && onContinued && isProduct && <button type="button" className="secondary-button" disabled={busy} onClick={() => void prepare('keep')}>不清除保存继续新增</button>}
          {!record && onContinued && isProduct && <button type="button" className="secondary-button" disabled={busy} onClick={() => void prepare('blank')}>保存并继续新增</button>}
          <button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : isProduct && layoutKey === 'custom' ? '保存商品' : isProduct && record ? '保存修改' : '保存'}</button>{isReferenceParty && record && <button type="button" className="secondary-button reference-party-close" disabled={busy} onClick={requestClose}>关闭</button>}
        </div>
      </form>
      {quality && (
        <ProductQualityDialog
          values={quality.body}
          options={quality.options}
          onCancel={() => setQuality(null)}
          onConfirm={(next) => {
            const { mode } = quality;
            setQuality(null);
            void commit(next, mode);
          }}
        />
      )}
    </div>
  );
}

/** 填写时实时看总成本价：采购价 + 运费 + 装卸费（自制品/OEM 的采购价来自构成，保存后才有，这里只提示）。 */
export function TotalCostPreview({ values, idle }: { values: Record<string, unknown>; /** 表单里还没填时也画出汇总条（用 — 占位） */ idle?: boolean }) {
  const num = (k: string) => (values[k] === '' || values[k] === undefined || values[k] === null || !Number.isFinite(Number(values[k])) ? null : Number(values[k]));
  const p = num('purchasePrice'), f = num('freight'), h = num('handlingFee');
  if (p === null && f === null && h === null && !idle) return null;
  const composed = ['self_made', 'oem_package'].includes(String(values.archiveType)) || values.supplyMode === 'supplier_oem';
  if (composed && p === null) return <div className="notice" role="status">采购价由构成汇总，保存后在“构成（BOM）”页签里维护。</div>;
  const total = sumUnitCents([p ?? 0,f ?? 0,h ?? 0]);
  const empty = p === null && f === null && h === null;
  const part = (label: string, v: number | null) => <span className="rf-total-part"><small>{label}</small><b>{empty ? '—' : `¥${unitYuanText(v ?? 0)}`}</b></span>;
  return (
    <div className="rf-total" role="status" aria-label="总成本预览">
      <span className="rf-total-sr">总成本价预览：采购价 ¥{unitYuanText(p ?? 0)} + 运费 ¥{unitYuanText(f ?? 0)} + 装卸费 ¥{unitYuanText(h ?? 0)} = ¥{unitYuanText(total)}</span>
      <span aria-hidden="true" className="rf-total-row">
        {part('采购价', p)}<i>+</i>{part('运费', f)}<i>+</i>{part('装卸费', h)}<i>=</i>
        <span className="rf-total-sum"><small>总成本</small><strong>{empty ? '—' : `¥${unitYuanText(total)}`}</strong></span>
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

/** 停用/删除等需要填写原因的确认框。 */
export function ReasonDialog({ title, hint, confirmLabel, danger, suggestions = ['重复录入', '录入错误', '不再使用', '信息有误'], onClose, onConfirm }: {
  title: string; hint?: string; confirmLabel: string; danger?: boolean; suggestions?: string[];
  onClose: () => void; onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) { e.preventDefault(); onClose(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
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
          <label>原因<textarea rows={3} autoFocus value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); setError(''); }} /></label>
          {suggestions.length > 0 && (
            <div className="pill-row" role="group" aria-label="常用原因">
              {suggestions.map((t) => <button key={t} type="button" className={reason.trim() === t ? 'chip active' : 'chip'} onClick={() => { setReason(t); setError(''); }}>{t}</button>)}
            </div>
          )}
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

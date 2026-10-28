import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { fieldOptions, useUnitOptions } from './unitOptions';
import { SIMILARITY_RESOURCES, isComposedArchive, type QualityOptions, unitYuanText, yuanToPreciseCents, createChecker, type FieldDef, type ResourceDef } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { ApiError, api } from '../api/client';
import { CodePreview } from './CodePreview';
import { ManageLink } from './ManageLink';
import { BomDraft, saveBomRows, validBomRows, type BomDraftRow } from './BomDraft';
import { draftApi, resourceApi, type FileInfo, type ResourceDto } from './api';
import { ProductQualityDialog } from './ProductQualityDialog';
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

type RefOption = { value: number; label: string; disabled?: boolean };
type RefOptions = RefOption[] & { total?: number };
/** 引用选择器一次最多取这么多条；更多的靠搜索框按关键字找（店铺、手机号等可能有几百条） */
const REF_PAGE = 50;
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
}

export function loadRefOptions(target: string) {
  let p = refCache.get(target);
  if (!p) {
    p =
      target === 'department'
        ? resourceApi.departments().then((list) => list.map((d) => ({ value: d.id, label: d.name })))
        : target === 'user'
        ? resourceApi.users().then((list) => list.map((u) => ({ value: u.id, label: u.active ? u.name : `${u.name}（已停用）`, disabled: !u.active })))
        : resourceApi.list(target, { pageSize: REF_PAGE, showHidden: true }).then((r) => Object.assign(r.items.map((i) => ({ value: i.id, label: i.title })), { total: r.total }));
    p.catch(() => refCache.delete(target));
    refCache.set(target, p);
  }
  return p;
}

export function RefSelect({ field, value, onChange, labelNow }: { field: FieldDef; value: unknown; onChange: (v: number | null) => void; labelNow?: string }) {
  const [options, setOptions] = useState<RefOptions | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadRefOptions(field.ref!).then((o) => alive && setOptions(o)).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [field.ref]);
  const search = useRefSearch(field.ref!, options);
  const current = typeof value === 'number' ? value : '';
  if (failed) return <input disabled value={labelNow ?? ''} placeholder="没有权限查看可选项" />;
  const list: RefOptions = search.shown ?? Object.assign([], { total: 0 });
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
export function RefsSelect({ field, value, onChange, labelNow, onLabels }: { field: FieldDef; value: number[]; onChange: (v: number[]) => void; labelNow?: string; onLabels?: (labels: Record<number, string>) => void }) {
  const [options, setOptions] = useState<RefOptions | null>(null);
  const seen = useRef<Record<number, string>>({});
  useEffect(() => {
    let alive = true;
    loadRefOptions(field.ref!).then((o) => alive && setOptions(o)).catch(() => alive && setOptions(Object.assign([], { total: 0 })));
    return () => { alive = false; };
  }, [field.ref]);
  const search = useRefSearch(field.ref!, options);
  if (!options) return <span className="muted">加载中…</span>;
  const shown = search.shown ?? options;
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
          {(field.optionsFrom ? fieldOptions(field, values ?? {}, units) : field.options)?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
      return <RefsSelect field={field} value={Array.isArray(value) ? (value as number[]) : []} onChange={onChange} labelNow={labelNow} />;
    case 'ref':
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
export function RecordForm({ def, record, initial, lockedFields, onlyGroup, inline, onClose, onSaved, onContinued }: {
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
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...(record?.data ?? {}), ...(initial ?? {}) }));
  const [status, setStatus] = useState(record?.status ?? def.defaultStatus);
  const [error, setError] = useState('');
  const [bomRows, setBomRows] = useState<BomDraftRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState<Record<number, FileInfo>>(record?.files ?? {});
  // 新建时填了内容就关闭，先确认，免得点错丢内容（旧系统同款）
  const startValues = useRef(JSON.stringify(values));
  const dirty = JSON.stringify(values) !== startValues.current;
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
  const visible = useMemo(() => {
    const ctx: Record<string, unknown> = { ...values, status };
    return def.fields.filter((f) => !f.readonly && canField(f)).filter((f) => !(def.key === 'fixed-assets' && record && f.key === 'userId')).filter((f) => !f.showWhen || f.showWhen.in.includes(String(ctx[f.showWhen.field] ?? ''))).filter((f) => !onlyGroup || f.group === onlyGroup);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, values, status, me, onlyGroup]);
  const groups = useMemo(() => {
    const map = new Map<string, FieldDef[]>();
    for (const f of visible) map.set(f.group, [...(map.get(f.group) ?? []), f]);
    return [...map.entries()];
  }, [visible]);

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
        const merged = { ...(record?.data ?? {}), ...body };
        const options: QualityOptions = { canCost: Boolean(me && createChecker(me.permissions)('product.cost.edit')), composition: await compositionCounts(record?.id, merged) };
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
      const saved = record ? await resourceApi.update(def.key, record.id, body) : await resourceApi.create(def.key, body, status);
      clearRefCache(def.key);
      if (!record && def.key === 'finance-products' && validBomRows(bomRows).length) {
        const failed = await saveBomRows(saved.id, bomRows);
        if (failed.length) window.alert(`档案已保存，但这些生产组成没保存成功，请到详情的“构成（BOM）”页签补录：\n${failed.join('\n')}`);
        setBomRows([]);
      }
      if (draftEnabled) await clearDraft();
      if (mode === 'close' || !onContinued) { onSaved(saved); return; }
      // 继续新建：“保存并继续新建”留空重填（只留档案类型、分类、采购方式），“不清除保存”带着内容，只清掉每个商品独有的编码和赠品简称
      onContinued(saved);
      setValues(mode === 'blank'
        ? Object.fromEntries(['archiveType', 'supplyMode', 'categoryId', 'purchaseSpec', 'specUnit'].filter((k) => values[k] !== undefined).map((k) => [k, values[k]]))
        : { ...values, code: '', giftShortName: '', giftCodeShortName: '', zeroValueReason: '' });
      setKnown({});
      setDraftNote(`已保存「${String(saved.title ?? '')}」，可以继续新建。`);
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
    setErrors(next);
    const first = visible.find((f) => next[f.key]);
    if (first) setTimeout(() => document.querySelector<HTMLElement>(`[data-field="${first.key}"] input, [data-field="${first.key}"] select, [data-field="${first.key}"] textarea`)?.focus(), 0);
    return !first;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void prepare('close');
  }

  return (
    <div className={inline ? 'inline-edit' : 'modal-backdrop'} role="presentation">
      <form className={inline ? 'inline-form' : 'modal card'} role={inline ? 'group' : 'dialog'} aria-label={onlyGroup ? `编辑${onlyGroup}` : record ? `编辑${def.label}` : `新增${def.label}`} onSubmit={submit}>
        {!inline && <div className="modal-head between">
          <strong>{record ? `编辑${def.label}` : `新增${def.label}`}</strong>
          <button type="button" className="icon-button" aria-label="关闭" onClick={requestClose}>✕</button>
        </div>}
        <div className="modal-body">
          {def.key === 'licenses' && (
            <LicenseRecognizeButton
              onApply={(fields) => setValues((cur) => ({ ...cur, ...fields }))}
            />
          )}
          {draftNote && <div className="notice">{draftNote}{draftEnabled && draftNote.startsWith('已恢复') && <> <button type="button" className="link-button" onClick={() => void clearDraft()}>清除草稿</button></>}</div>}
          {!record && def.statuses.length > 1 && def.key !== 'fixed-assets' && (
            <label>初始状态
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {def.statuses.filter((s) => !s.requiresReason).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
          )}
          {visible.some((f) => f.required) && <p className="muted required-hint"><b className="req">*</b> 为必填项{!record ? '，保存后可以继续补充关联资料。' : '。'}</p>}
          {groups.map(([group, fields]) => (
            <fieldset key={group}>
              <legend>{group}</legend>
              <div className="form-grid">
                {fields.map((f) => (
                  <label key={f.key} data-field={f.key} onBlur={() => { const p = fieldProblem(f); if (p !== (errors[f.key] ?? '')) setErrors((cur) => ({ ...cur, [f.key]: p })); }} className={[f.type === 'textarea' || f.type === 'attrs' ? 'wide' : '', errors[f.key] ? 'invalid' : ''].filter(Boolean).join(' ') || undefined}>
                    <span>{f.label}{f.required && <b className="req"> *</b>}</span>
                    {f.type === 'attrs' ? <AttrsInput field={f} def={def} values={values} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} /> : <FieldInput
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
                    {errors[f.key] ? <small className="field-error" role="alert">{errors[f.key]}</small> : f.help && <small className="muted">{f.help}</small>}
                    {def.key === 'finance-products' && <ManageLink field={f} />}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {isProduct && <TotalCostPreview values={values} />}
          {isProduct && !record && isComposedArchive(values) && <BomDraft rows={bomRows} onChange={setBomRows} />}
          {isProduct && <CodePreview values={values} excludeId={record?.id} />}
          {refLock && <div role="status" className="notice warn">该商品编码{refLock.label}（{refLock.items.slice(0, 3).map((i) => `${i.sourceLabel}：${i.name}`).join('；')}），编码和来源已锁定，只能修改商品名称、简称、颜色及规格和启停状态。</div>}
          {Object.values(errors).some(Boolean) && (
            <div role="alert" className="notice error error-summary">
              <strong>还有 {Object.values(errors).filter(Boolean).length} 项需要补充或修改：</strong>{' '}
              {visible.filter((f) => errors[f.key]).map((f) => (
                <button key={f.key} type="button" className="link-button" onClick={() => document.querySelector<HTMLElement>(`[data-field="${f.key}"] input, [data-field="${f.key}"] select, [data-field="${f.key}"] textarea`)?.focus()}>{f.label}</button>
              ))}
            </div>
          )}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          {dirty && <span className="muted dirty-hint">{record ? '有未保存的修改' : '已填写内容尚未保存'}</span>}
          <button type="button" className="secondary-button" onClick={requestClose}>取消</button>
          {draftEnabled && <button type="button" className="secondary-button" disabled={busy} onClick={() => void saveDraft()}>存为草稿</button>}
          {!record && onContinued && isProduct && <button type="button" className="secondary-button" disabled={busy} onClick={() => void prepare('keep')}>不清除保存继续新建</button>}
          {!record && onContinued && isProduct && <button type="button" className="secondary-button" disabled={busy} onClick={() => void prepare('blank')}>保存并继续新建</button>}
          <button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
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
export function TotalCostPreview({ values }: { values: Record<string, unknown> }) {
  const num = (k: string) => (values[k] === '' || values[k] === undefined || values[k] === null ? null : Number(values[k]));
  const p = num('purchasePrice'), f = num('freight'), h = num('handlingFee');
  if (p === null && f === null && h === null) return null;
  const composed = ['self_made', 'oem_package'].includes(String(values.archiveType)) || values.supplyMode === 'supplier_oem';
  if (composed && p === null) return <div className="notice" role="status">自制品/OEM 的采购价由构成汇总，保存后在“构成（BOM）”页签里添加原料、包装和人工。</div>;
  const total = (p ?? 0) + (f ?? 0) + (h ?? 0);
  return <div className="notice" role="status" aria-label="总成本预览">总成本价预览：采购价 ¥{unitYuanText(p ?? 0)} + 运费 ¥{unitYuanText(f ?? 0)} + 装卸费 ¥{unitYuanText(h ?? 0)} = <strong>¥{unitYuanText(total)}</strong></div>;
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

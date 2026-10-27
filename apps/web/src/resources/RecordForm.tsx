import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { fieldOptions, useUnitOptions } from './unitOptions';
import { SIMILARITY_RESOURCES, isComposedArchive, type QualityOptions, unitYuanText, yuanToPreciseCents, createChecker, type FieldDef, type ResourceDef } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { ApiError, api } from '../api/client';
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

function RefSelect({ field, value, onChange, labelNow }: { field: FieldDef; value: unknown; onChange: (v: number | null) => void; labelNow?: string }) {
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
function RefsSelect({ field, value, onChange, labelNow }: { field: FieldDef; value: number[]; onChange: (v: number[]) => void; labelNow?: string }) {
  const [options, setOptions] = useState<RefOptions | null>(null);
  useEffect(() => {
    let alive = true;
    loadRefOptions(field.ref!).then((o) => alive && setOptions(o)).catch(() => alive && setOptions(Object.assign([], { total: 0 })));
    return () => { alive = false; };
  }, [field.ref]);
  const search = useRefSearch(field.ref!, options);
  if (!options) return <span className="muted">加载中…</span>;
  const shown = search.shown ?? options;
  const labels = (labelNow ?? '').split('、');
  // 已选但不在当前列出范围内的（分页/搜索之外），固定显示在最上面，保证能取消
  const extra = value.filter((v) => !shown.some((o) => o.value === v));
  return (
    <div className="check-list" role="group" aria-label={field.label}>
      {search.searchable && <input type="search" className="ref-search" aria-label={`搜索${field.label}`} placeholder="输入关键字搜索…" value={search.keyword} onChange={(e) => search.setKeyword(e.target.value)} />}
      {extra.map((v, i) => <label key={v} className="check"><input type="checkbox" checked onChange={() => onChange(value.filter((x) => x !== v))} /> {labels[i] ?? `#${v}`}</label>)}
      {shown.map((o) => (
        <label key={o.value} className="check">
          <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))} />
          {o.label}
        </label>
      ))}
      {search.truncated && <small className="muted">只列出前 {shown.length} 条，共 {shown.total} 条，输入关键字缩小范围</small>}
      {shown.length === 0 && extra.length === 0 && <span className="muted">还没有可选项</span>}
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

type SaveMode = 'close' | 'blank' | 'keep';

/** 新建/编辑弹窗：按字段定义生成，按字段分组；showWhen 不满足的字段不显示。 */
export function RecordForm({ def, record, initial, lockedFields, onClose, onSaved, onContinued }: {
  def: ResourceDef;
  record: ResourceDto | null;
  initial?: Record<string, unknown>;
  lockedFields?: string[];
  onClose: () => void;
  onSaved: (dto: ResourceDto) => void;
  /** 提供了它，新建时就多出“保存并继续新建”：保存后不关弹窗，列表由它刷新 */
  onContinued?: (dto: ResourceDto) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...(record?.data ?? {}), ...(initial ?? {}) }));
  const [status, setStatus] = useState(record?.status ?? def.defaultStatus);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState<Record<number, FileInfo>>(record?.files ?? {});
  // 新建时填了内容就关闭，先确认，免得点错丢内容（旧系统同款）
  const startValues = useRef(JSON.stringify(values));
  const requestClose = () => {
    if (!record && JSON.stringify(values) !== startValues.current && !window.confirm('新增的资料还没有保存，关闭后填写的内容会丢失。确定直接关闭吗？')) return;
    onClose();
  };

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
    return def.fields.filter((f) => !f.readonly && canField(f)).filter((f) => !(def.key === 'fixed-assets' && record && f.key === 'userId')).filter((f) => !f.showWhen || f.showWhen.in.includes(String(ctx[f.showWhen.field] ?? '')));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, values, status, me]);
  const groups = useMemo(() => {
    const map = new Map<string, FieldDef[]>();
    for (const f of visible) map.set(f.group, [...(map.get(f.group) ?? []), f]);
    return [...map.entries()];
  }, [visible]);

  // 商品档案新建：草稿（每人每个档案类型一份，存在服务器上）、保存并继续新建
  const isProduct = def.key === 'finance-products';
  const draftEnabled = !record && isProduct;
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

  function submit(e: FormEvent) {
    e.preventDefault();
    void prepare('close');
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card" role="dialog" aria-label={record ? `编辑${def.label}` : `新增${def.label}`} onSubmit={submit}>
        <div className="modal-head between">
          <strong>{record ? `编辑${def.label}` : `新增${def.label}`}</strong>
          <button type="button" className="icon-button" aria-label="关闭" onClick={requestClose}>✕</button>
        </div>
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
                      values={values}
                      known={known}
                      onKnown={(info) => setKnown((cur) => ({ ...cur, [info.id]: info }))}
                      onChange={(v) => !locked.includes(f.key) && setValues((cur) => ({ ...cur, [f.key]: v }))}
                    />}
                    {f.help && <small className="muted">{f.help}</small>}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {isProduct && <TotalCostPreview values={values} />}
          {refLock && <div role="status" className="notice warn">该商品编码{refLock.label}（{refLock.items.slice(0, 3).map((i) => `${i.sourceLabel}：${i.name}`).join('；')}），编码和来源已锁定，只能修改商品名称、简称、颜色及规格和启停状态。</div>}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
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

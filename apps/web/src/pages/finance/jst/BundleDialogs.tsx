import { useEffect, useState } from 'react';
import { ApiError } from '../../../api/client';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { ChangeTable } from './BaseCodeDialogs';
import { BundleCategorySelect, LineEditor, ROLE_LABEL, toLineInput, type LineRow } from './BundleLineEditor';
import { jstApi, type BundleReport, type LineInput, type PreviewTarget } from './jstApi';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');
const NAMING_FIELDS: Array<[string, string]> = [
  ['category', '分类'], ['platform', '销售平台'], ['scenario', '销售场景'], ['brand', '品牌'], ['variety', '品种'], ['packageType', '包装形态'], ['supplyMode', '供货方式'],
  ['name', '商品名称'], ['shortName', '简称'], ['style', '款式编码'], ['baseCode', '基础编码'], ['spec', '规格'], ['quantity', '数量'], ['totalSpec', '总规格'], ['custom', '自定义'],
];

/** 新建组合编码：选构成（按主商品/包装/标签/打包材料/人工/赠品分组）+ 多个销售平台，先检查（复用、四层重复），每个平台的编码/名称/简称可手填覆盖，全部没问题才一起生成，生成后是“待验证”。 */
export function GenerateDialog({ onClose, onDone, sourceBundle }: { onClose: () => void; onDone: () => void; sourceBundle?: ResourceDto }) {
  const [rows, setRows] = useState<LineRow[]>([{ role: 'main', qty: 1, label: '' }]);
  const [platforms, setPlatforms] = useState<ResourceDto[]>([]);
  const [scenarios, setScenarios] = useState<ResourceDto[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [scenarioId, setScenarioId] = useState<number | ''>(Number(sourceBundle?.data.scenarioId) || '');
  const [preview, setPreview] = useState<PreviewTarget[] | null>(null);
  const [manual, setManual] = useState<Record<number, { code: string; name: string; shortName: string }>>({});
  const [reason, setReason] = useState('');
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  useEffect(() => {
    resourceApi.list('finance-platforms', { pageSize: 100 }).then((r) => setPlatforms(r.items)).catch(() => undefined);
    resourceApi.list('finance-scenarios', { pageSize: 100 }).then((r) => { setScenarios(r.items); if (!sourceBundle && r.items[0]) setScenarioId(r.items[0].id); }).catch(() => undefined);
  }, []);
  const [categoryId, setCategoryId] = useState<number | ''>(Number(sourceBundle?.data.bundleCategoryId) || '');
  const [brandId, setBrandId] = useState<number | ''>(Number(sourceBundle?.data.brandId) || '');
  const [brands, setBrands] = useState<ResourceDto[]>([]);
  useEffect(() => { resourceApi.list('finance-brands', { pageSize: 200, status: 'active' }).then((r) => setBrands(r.items)).catch(() => undefined); }, []);
  const [sourceLoading,setSourceLoading] = useState(!!sourceBundle);
  const [sourceError,setSourceError] = useState('');
  useEffect(()=>{
    if(!sourceBundle)return;
    let live=true;
    (async()=>{
      const items:ResourceDto[]=[];
      for(let page=1;;page++){const r=await resourceApi.list('finance-bundle-lines',{fieldKey:'bundleId',fieldValue:sourceBundle.id,page,pageSize:200});items.push(...r.items);if(items.length>=r.total || !r.items.length)break;}
      if(live){setRows(items.map(item=>({...item.data,role:String(item.data.role),qty:Number(item.data.qty),label:item.refLabels.baseCodeId || item.refLabels.laborId || item.title} as LineRow)));setSourceLoading(false);}
    })().catch(e=>{if(live){setSourceError(msg(e));setSourceLoading(false);}});
    return()=>{live=false;};
  },[sourceBundle]);
  const lines = (): LineInput[] => rows.filter((r) => r.baseCodeId || r.laborId).map(toLineInput);
  const targets = () => picked.map((p) => {
    const m = manual[p];
    return { platformId: p, scenarioId: Number(scenarioId), bundleCategoryId: categoryId || undefined, brandId: brandId || undefined,
      manualCode: m?.code.trim() || undefined, manualName: m?.name.trim() || undefined, manualShortName: m?.shortName.trim() || undefined, manualReason: m && (m.code || m.name || m.shortName).trim() ? reason.trim() : undefined };
  });
  const anyManual = Object.entries(manual).some(([k, m]) => picked.includes(Number(k)) && (m.code || m.name || m.shortName).trim());
  const setM = (p: number, patch: Partial<{ code: string; name: string; shortName: string }>) => { setManual({ ...manual, [p]: { ...(manual[p] ?? { code: '', name: '', shortName: '' }), ...patch } }); setStale(true); };
  const invalid = lines().length === 0 || picked.length === 0 || !scenarioId || !categoryId;
  async function check() {
    setBusy(true); setError('');
    try { setPreview((await jstApi.bundlePreview(lines(), targets())).targets); setStale(false); } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  async function generate() {
    setBusy(true); setError('');
    try {
      const r = await jstApi.bundleGenerate(lines(), targets());
      setDone(`完成：新建 ${r.created.filter((c) => !c.reused).length} 个，复用已有 ${r.created.filter((c) => c.reused).length} 个（${r.created.map((c) => c.code).join('、')}）`);
      onDone();
    } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card wide" role="dialog" aria-label={sourceBundle?'跨平台复用组合编码':'新建组合编码'}>
        <div className="modal-head between"><strong>{sourceBundle?'跨平台复用组合编码':'新建组合编码'}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <p className="muted">选好构成和销售平台，每个平台生成一个组合；编码按“命名中心”的规则拼。同样构成、同平台同场景已经有的会直接复用；编码和本地组合、本地基础编码、聚水潭商品、聚水潭组合装重复的会拦住。</p>
          <h4>1. 组合构成</h4>
          {sourceLoading && <p role="status">正在读取原组合构成…</p>}{sourceError && <p role="alert" className="notice error">{sourceError}</p>}
          <LineEditor rows={rows} allowLabor grouped onChange={(r) => { setRows(r); setPreview(null); }} />
          <h4>2. 销售平台和场景</h4>
          <div className="pill-row">{platforms.map((p) => <label key={p.id} className="check"><input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => { setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id)); setPreview(null); }} /> {p.title}</label>)}</div>
          <label>销售场景<select aria-label="销售场景" value={scenarioId} onChange={(e) => { setScenarioId(Number(e.target.value)); setPreview(null); }}>{scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select><small className="muted">销售场景在本页的“销售场景”页签里增删</small></label>
          <label>组合分类<b className="req"> *</b><BundleCategorySelect value={categoryId} onChange={(v) => { setCategoryId(v); setPreview(null); }} /><small className="muted">组合分类树里的最末级分类，成本表分类利润率按它汇总</small></label>
          <label>品牌（选填）<select aria-label="品牌" value={brandId} onChange={(e) => { setBrandId(e.target.value ? Number(e.target.value) : ''); setPreview(null); }}><option value="">不选（取第一个主品的品牌）</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select></label>
          {error && <div role="alert" className="notice error">{error}</div>}
          {done && <div role="status" className="notice ok">{done}</div>}
          {preview && (
            <>
              <h4>3. 组合品生成资料</h4>
              <p className="muted">下面是按命名规则自动生成的编码、名称和简称；想改哪个直接填（留空就用自动值），改了必须写原因，改完要重新“保存前检查”。生成后的组合是“待验证”状态，核对后才能验证并同步聚水潭。</p>
              <table className="data-table cards-narrow">
                <thead><tr><th>平台</th><th>编码</th><th>名称</th><th>简称</th><th>检查结果</th></tr></thead>
                <tbody>{preview.map((t) => (
                  <tr key={`${t.platformId}-${t.scenarioId}`}>
                    <td data-label="平台">{t.platformName}</td>
                    <td data-label="编码"><input aria-label={`${t.platformName}编码`} maxLength={120} placeholder={`自动：${t.code}`} value={manual[t.platformId]?.code ?? ''} onChange={(e) => setM(t.platformId, { code: e.target.value.toUpperCase() })} /></td>
                    <td data-label="名称"><input aria-label={`${t.platformName}名称`} maxLength={300} placeholder={`自动：${t.name}`} value={manual[t.platformId]?.name ?? ''} onChange={(e) => setM(t.platformId, { name: e.target.value })} /></td>
                    <td data-label="简称"><input aria-label={`${t.platformName}简称`} maxLength={160} placeholder={`自动：${t.shortName}`} value={manual[t.platformId]?.shortName ?? ''} onChange={(e) => setM(t.platformId, { shortName: e.target.value })} /></td>
                    <td data-label="检查结果" className={t.ok ? undefined : 'bad-text'}>{t.reuse ? `已有相同组合，直接复用（${t.reuse.code}）` : t.duplicates.length ? t.duplicates.map((d) => `和${d.label}「${d.hit}」重复`).join('；') : '没有重复'}</td>
                  </tr>))}
                </tbody>
              </table>
              {anyManual && <label>改码/改名原因<b className="req"> *</b><textarea aria-label="改码改名原因" rows={2} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); setStale(true); }} /></label>}
              {stale && <p className="muted" role="status">填写内容有变化，请重新点“保存前检查”。</p>}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
          <button type="button" className="secondary-button" disabled={sourceLoading || !!sourceError || busy || invalid} onClick={() => void check()}>保存前检查</button>
          <button type="button" className="primary-button" disabled={sourceLoading || !!sourceError || busy || invalid || !preview || stale || preview.some((t) => !t.ok) || !!done || (anyManual && reason.trim().length < 2)} onClick={() => void generate()}>生成 {picked.length} 个</button>
        </div>
      </div>
    </div>
  );
}

/** 命名中心：按分类设定组合编码/名称怎么拼；下级分类沿用上级；只有管理员能改。 */
export function NamingCenterDialog({ isAdmin, onClose }: { isAdmin: boolean; onClose: () => void }) {
  const [rules, setRules] = useState<ResourceDto[]>([]);
  const [cats, setCats] = useState<ResourceDto[]>([]);
  const [editing, setEditing] = useState<{ id?: number; categoryId?: number; prefix: string; namePrefix: string; stylePrefix: string; code: string[]; name: string[]; customCode: string; customName: string; codeOverrides: string; nameOverrides: string } | null>(null);
  const [error, setError] = useState('');
  const load = () => resourceApi.list('finance-bundle-naming-rules', { pageSize: 100 }).then((r) => setRules(r.items)).catch((e) => setError(msg(e)));
  useEffect(() => { void load(); resourceApi.list('finance-categories', { pageSize: 200 }).then((r) => setCats(r.items)).catch(() => undefined); }, []);
  const open = (r?: ResourceDto) => setEditing(r ? {
    id: r.id, categoryId: Number(r.data.categoryId), prefix: String(r.data.prefix ?? ''), namePrefix: String(r.data.namePrefix ?? ''), stylePrefix: String(r.data.stylePrefix ?? ''),
    code: String(r.data.codeFields ?? '').split(',').filter(Boolean), name: String(r.data.nameFields ?? '').split(',').filter(Boolean),
    customCode: String(r.data.customCode ?? ''), customName: String(r.data.customName ?? ''), codeOverrides: String(r.data.codeOverrides ?? ''), nameOverrides: String(r.data.nameOverrides ?? ''),
  } : { prefix: 'ZH-', namePrefix: '组合-', stylePrefix: '', code: ['platform', 'baseCode', 'scenario'], name: ['name'], customCode: '', customName: '', codeOverrides: '', nameOverrides: '' });
  async function save() {
    if (!editing) return;
    setError('');
    const values = { categoryId: editing.categoryId, prefix: editing.prefix, namePrefix: editing.namePrefix, stylePrefix: editing.stylePrefix, codeFields: editing.code.join(','), nameFields: editing.name.join(','), customCode: editing.customCode, customName: editing.customName, codeOverrides: editing.codeOverrides, nameOverrides: editing.nameOverrides };
    try { if (editing.id) await resourceApi.update('finance-bundle-naming-rules', editing.id, values); else await resourceApi.create('finance-bundle-naming-rules', values); setEditing(null); await load(); } catch (e) { setError(msg(e)); }
  }
  async function inherit(r: ResourceDto) {
    if (!window.confirm(`「${r.title}」改为沿用上级分类的规则（没有上级规则就用默认格式）？`)) return;
    try { await resourceApi.remove('finance-bundle-naming-rules', r.id, '改为沿用上级规则'); await load(); } catch (e) { setError(msg(e)); }
  }
  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card wide" role="dialog" aria-label="组合命名中心">
        <div className="modal-head between"><strong>命名中心</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <p className="muted">没有规则时，组合编码按默认格式：ZH-平台-主品+ZP-赠品-场景。给某个分类设了规则，这个分类和它的下级分类里的组合都按规则拼。平台选“通用”时不写进编码，赠品统一写在 +ZP- 后面。改规则只影响以后重新生成的编码。</p>
          {error && <div role="alert" className="notice error">{error}</div>}
          {!editing && (
            <>
              <table className="data-table">
                <thead><tr><th>适用分类</th><th>编码前缀</th><th>编码字段</th><th>名称前缀</th><th /></tr></thead>
                <tbody>
                  {rules.length === 0 && <tr><td colSpan={5} className="muted center">还没有规则，全部用默认格式</td></tr>}
                  {rules.map((r) => <tr key={r.id}><td>{r.refLabels.categoryId ?? r.title}</td><td>{String(r.data.prefix)}</td><td>{String(r.data.codeFields).split(',').map((k) => NAMING_FIELDS.find(([v]) => v === k)?.[1] ?? k).join(' + ')}</td><td>{String(r.data.namePrefix ?? '')}</td>
                    <td>{isAdmin && <><button type="button" className="secondary-button small" onClick={() => open(r)}>修改</button> <button type="button" className="secondary-button small" onClick={() => void inherit(r)}>沿用上级</button></>}</td></tr>)}
                </tbody>
              </table>
              {isAdmin ? <button type="button" className="primary-button" onClick={() => open()}>＋ 新增分类规则</button> : <p className="muted">只有公司管理员能修改命名规则。</p>}
            </>
          )}
          {editing && (
            <div className="form-grid">
              <label>适用分类<select value={editing.categoryId ?? ''} disabled={!!editing.id} onChange={(e) => setEditing({ ...editing, categoryId: Number(e.target.value) })}><option value="">请选择</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
              <label>编码前缀<input value={editing.prefix} maxLength={13} onChange={(e) => setEditing({ ...editing, prefix: e.target.value.toUpperCase() })} /></label>
              <label>款式编码前缀<input value={editing.stylePrefix} maxLength={13} onChange={(e) => setEditing({ ...editing, stylePrefix: e.target.value.toUpperCase() })} /></label>
              <label>名称前缀<input value={editing.namePrefix} maxLength={20} onChange={(e) => setEditing({ ...editing, namePrefix: e.target.value })} /></label>
              <fieldset><legend>编码里包含（按勾选顺序拼）</legend><div className="pill-row">{NAMING_FIELDS.map(([k, l]) => <label key={k} className="check"><input type="checkbox" checked={editing.code.includes(k)} onChange={() => setEditing({ ...editing, code: toggle(editing.code, k) })} /> {l}</label>)}</div></fieldset>
              <fieldset><legend>名称里包含</legend><div className="pill-row">{NAMING_FIELDS.map(([k, l]) => <label key={k} className="check"><input type="checkbox" checked={editing.name.includes(k)} onChange={() => setEditing({ ...editing, name: toggle(editing.name, k) })} /> {l}</label>)}</div></fieldset>
              <label>自定义编码段<input value={editing.customCode} maxLength={40} onChange={(e) => setEditing({ ...editing, customCode: e.target.value.toUpperCase() })} /></label>
              <label>自定义名称段<input value={editing.customName} maxLength={60} onChange={(e) => setEditing({ ...editing, customName: e.target.value })} /></label>
              <label>编码字段改写（每行 字段=文字，如 platform=TB）<textarea rows={2} value={editing.codeOverrides} onChange={(e) => setEditing({ ...editing, codeOverrides: e.target.value })} /></label>
              <label>名称字段改写<textarea rows={2} value={editing.nameOverrides} onChange={(e) => setEditing({ ...editing, nameOverrides: e.target.value })} /></label>
              <div className="row-actions"><button type="button" className="secondary-button" onClick={() => setEditing(null)}>返回</button><button type="button" className="primary-button" disabled={!editing.categoryId} onClick={() => void save()}>保存规则</button></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 组合的核对并验证，和基础编码一样：先看报告，勾选“已核对”才能验证；构成修订会随验证发布。 */
export function BundleVerifyDialog({ ids, isAdmin, onClose, onDone }: { ids: number[]; isAdmin: boolean; onClose: () => void; onDone: () => void }) {
  const [reports, setReports] = useState<Record<number, BundleReport>>({});
  const [index, setIndex] = useState(0);
  const [ack, setAck] = useState(false);
  const [sync, setSync] = useState(false);
  const [replaceOk, setReplaceOk] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => { for (const id of ids) { try { const r = await jstApi.bundleReport(id); if (live) setReports((m) => ({ ...m, [id]: r })); } catch (e) { if (live) setError(msg(e)); } } })();
    return () => { live = false; };
  }, [ids, tick]);
  const list = ids.map((id) => reports[id]).filter(Boolean);
  const ready = list.filter((r) => r.issues.length === 0 && ['pending', 'reverify'].includes(r.status));
  const cur = reports[ids[index]];
  const anyReplace = sync && ready.some((r) => r.replacing);
  const role = (r: string) => ROLE_LABEL[r] ?? r;
  async function submit() {
    setBusy(true); setError('');
    try {
      const r = await jstApi.bundleVerify(ready.map((x) => ({ id: x.id, signature: x.signature, uploadSignature: x.uploadSignature })), ack, sync, replaceOk);
      const failed = r.results.filter((x) => !x.ok);
      setResult(`已验证 ${r.verified} 个${sync ? `，其中 ${r.results.filter((x) => x.queued).length} 个已加入聚水潭同步队列` : ''}${failed.length ? `；${failed.length} 个没通过：${failed.slice(0, 3).map((x) => x.error).join('；')}` : ''}`);
      if (r.verified) onDone();
      if (failed.length) setTick((n) => n + 1);
    } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card wide" role="dialog" aria-label="核对并验证组合编码">
        <div className="modal-head between"><strong>核对并验证组合（共 {ids.length} 个）</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          {result && <div role="status" className="notice ok">{result}</div>}
          <div className="row-actions">
            <button type="button" className="secondary-button small" disabled={index <= 0} onClick={() => setIndex(index - 1)}>上一个</button>
            <span>第 {index + 1} / {ids.length} 个</span>
            <button type="button" className="secondary-button small" disabled={index >= ids.length - 1} onClick={() => setIndex(index + 1)}>下一个</button>
            <span className="muted">可验证 {ready.length} 个</span>
          </div>
          {!cur && <p className="muted">加载中…</p>}
          {cur && (
            <div>
              <h3>{cur.code} <span className="muted">{cur.name}</span></h3>
              {cur.issues.length > 0 && <div className="notice error" role="alert"><strong>验证前需要先处理这 {cur.issues.length} 个问题</strong><ul>{cur.issues.map((i, k) => <li key={k}>{i}</li>)}</ul></div>}
              {cur.pendingRevision && <div className="notice warn">有一份待发布的构成修订（原因：{cur.pendingRevision.reason}）。下面是修订后的构成，验证通过后随之生效。</div>}
              <table className="data-table">
                <thead><tr><th>用途</th><th>基础编码</th><th>名称</th><th className="num">数量</th><th>单位</th><th>进聚水潭</th><th className="num">损耗率%</th><th className="num">重量(克)</th>{cur.totalCost !== undefined && <th className="num">成本(分)</th>}</tr></thead>
                <tbody>{cur.components.map((c, i) => <tr key={i}><td>{role(c.role)}</td><td>{c.code}</td><td>{c.name}</td><td className="num">{c.qty}</td><td>{c.unit || '—'}</td><td>{c.includeInJst ? '是' : '否'}</td><td className="num">{c.lossRate ?? 0}</td><td className="num">{c.weightG ?? '—'}</td>{cur.totalCost !== undefined && <td className="num">{c.cost ?? '—'}</td>}</tr>)}</tbody>
              </table>
              <p>合计重量 {cur.totalWeightG} 克{cur.totalCost !== undefined ? `，合计成本 ${(cur.totalCost / 100).toFixed(2)} 元` : ''}</p>
              {cur.secondVerification && (<><h4>二次验证：和上次相比改了什么</h4><ChangeTable changes={cur.changes} baselineMissing={cur.baselineMissing} /></>)}
              <h4>实际上传到聚水潭的资料</h4>
              <table className="data-table"><tbody>
                <tr><th style={{ width: 120 }}>商品编码</th><td>{cur.outbound.sku_id}</td></tr><tr><th>款式编码</th><td>{cur.outbound.i_id || '—'}</td></tr>
                <tr><th>名称</th><td>{cur.outbound.name}</td></tr><tr><th>简称</th><td>{cur.outbound.short_name || '—'}</td></tr><tr><th>重量(kg)</th><td>{cur.outbound.weight}</td></tr>
                {cur.outbound.cost_price !== undefined && <tr><th>成本价</th><td>{cur.outbound.cost_price}</td></tr>}
              </tbody></table>
              {cur.replacing && <div className="notice warn">聚水潭上已有旧编码「{cur.uploadedCode}」，上传会变成改码。</div>}
            </div>
          )}
          <hr />
          <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 我已核对以上 {ready.length} 个组合的构成和上传内容，确认无误</label>
          {isAdmin && <label className="check"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 验证后加入聚水潭同步队列（只排队，不直接发送）</label>}
          {anyReplace && <label className="check"><input type="checkbox" checked={replaceOk} onChange={(e) => setReplaceOk(e.target.checked)} /> 已处理旧编码的库存、在途订单和店铺映射关联，确认禁用旧编码并创建新编码</label>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
          <button type="button" className="primary-button" disabled={busy || !ack || ready.length === 0 || (anyReplace && !replaceOk)} onClick={() => void submit()}>验证 {ready.length} 个</button>
        </div>
      </div>
    </div>
  );
}

/** 构成修订：已验证的组合要改主品时，提交一份“待发布”的新构成；赠品原样不能动；随组合验证生效。 */
export function RevisionDialog({ bundle, onClose, onDone }: { bundle: ResourceDto; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<LineRow[] | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pendingId = typeof bundle.data.pendingRevisionId === 'number' ? bundle.data.pendingRevisionId : null;
  const [pending, setPending] = useState<ResourceDto | null>(null);
  useEffect(() => {
    resourceApi.list('finance-bundle-lines', { fieldKey: 'bundleId', fieldValue: bundle.id, pageSize: 100 }).then((r) => {
      const keys = ['unit', 'lossRate', 'isRequired', 'includeInJst', 'costBucket', 'costTreatment', 'sortOrder', 'effectiveFrom', 'effectiveTo', 'note'];
      setRows(r.items.map((l) => ({
        role: String(l.data.role), baseCodeId: typeof l.data.baseCodeId === 'number' ? l.data.baseCodeId : undefined, laborId: typeof l.data.laborId === 'number' ? l.data.laborId : undefined, qty: Number(l.data.qty),
        label: String(l.refLabels.baseCodeId ?? l.refLabels.laborId ?? ''),
        ...Object.fromEntries(keys.filter((k) => l.data[k] !== undefined && l.data[k] !== null && l.data[k] !== '').map((k) => [k, l.data[k]])),
      })));
    }).catch((e) => setError(msg(e)));
    if (pendingId) resourceApi.get('finance-bundle-revisions', pendingId).then(setPending).catch(() => undefined);
  }, [bundle.id, pendingId]);
  async function submit() {
    setBusy(true); setError('');
    try { await jstApi.bundleRevise(bundle.id, reason.trim(), (rows ?? []).filter((r) => r.baseCodeId || r.laborId).map(toLineInput)); onDone(); onClose(); } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  async function cancel() {
    const why = window.prompt('取消这份修订的原因');
    if (!why) return;
    try { await jstApi.bundleCancelRevision(bundle.id, why); onDone(); onClose(); } catch (e) { setError(msg(e)); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card wide" role="dialog" aria-label="修改组合构成">
        <div className="modal-head between"><strong>修改构成：{bundle.title}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          {pendingId && pending ? (
            <div className="notice warn">
              <p>已经有一份待发布的修订：{String(pending.data.reason)}。到“核对并验证”里验证这个组合，修订就会生效。</p>
              <button type="button" className="secondary-button" onClick={() => void cancel()}>取消这份修订</button>
            </div>
          ) : (
            <>
              <p className="muted">赠品必须原样保留（商品和数量都不能改），主品等可以改；至少保留一个主品。提交后组合会进入“需重新验证”，验证通过时新构成才生效，聚水潭上的编码按验证结果更新。</p>
              {rows ? <LineEditor rows={rows} onChange={setRows} lockGifts allowLabor /> : <p className="muted">加载中…</p>}
              <label>修订原因（必填）<textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
          {!pendingId && <button type="button" className="primary-button" disabled={busy || reason.trim().length < 2 || !rows?.some((r) => r.role === 'main' && r.baseCodeId)} onClick={() => void submit()}>提交修订</button>}
        </div>
      </div>
    </div>
  );
}

/** 删除（没验证过、没同步过、没有成本历史才能删，要输入编码确认）或失效归档（上传过聚水潭的同时排停用任务）。 */
export function RemoveDialog({ bundle, isAdmin, onClose, onDone }: { bundle: ResourceDto; isAdmin: boolean; onClose: () => void; onDone: () => void }) {
  const [pre, setPre] = useState<{ canDelete: boolean; reason: string; token: string; code: string } | null>(null);
  const [mode, setMode] = useState<'delete' | 'archive'>('archive');
  const [confirmCode, setConfirmCode] = useState('');
  const [reason, setReason] = useState('');
  const [disableOk, setDisableOk] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const synced = !!bundle.data.jstUploadedCode;
  useEffect(() => { jstApi.bundleDeletion(bundle.id).then((p) => { setPre(p); if (p.canDelete) setMode('delete'); }).catch((e) => setError(msg(e))); }, [bundle.id]);
  async function run() {
    setBusy(true); setError('');
    try { if (mode === 'delete') await jstApi.bundleDelete(bundle.id, pre!.token, confirmCode, reason.trim()); else await jstApi.bundleArchive(bundle.id, reason.trim(), disableOk); onDone(); onClose(); } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="删除或归档组合">
        <div className="modal-head between"><strong>{bundle.title}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          <div className="pill-row">
            <label className="check"><input type="radio" name="rm" checked={mode === 'delete'} disabled={!pre?.canDelete} onChange={() => setMode('delete')} /> 彻底删除</label>
            <label className="check"><input type="radio" name="rm" checked={mode === 'archive'} disabled={bundle.status === 'archived'} onChange={() => setMode('archive')} /> 失效归档</label>
          </div>
          {pre && !pre.canDelete && <p className="muted">不能彻底删除：{pre.reason}</p>}
          {mode === 'delete' && <label>请输入组合编码「{bundle.title}」确认<input value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} /></label>}
          {mode === 'archive' && synced && (isAdmin
            ? <label className="check"><input type="checkbox" checked={disableOk} onChange={(e) => setDisableOk(e.target.checked)} /> 这个组合上传过聚水潭，确认同时在聚水潭停用（排入同步队列）</label>
            : <p className="bad-text">这个组合上传过聚水潭，只有公司管理员能归档。</p>)}
          <label>原因（必填）<textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-button danger-fill" disabled={busy || reason.trim().length < 2 || (mode === 'delete' && !confirmCode.trim()) || (mode === 'archive' && synced && !disableOk)} onClick={() => void run()}>{mode === 'delete' ? '彻底删除' : '归档'}</button>
        </div>
      </div>
    </div>
  );
}

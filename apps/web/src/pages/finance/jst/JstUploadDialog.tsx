import { useEffect, useRef, useState } from 'react';
import { FinanceModal } from '../FinanceModal';
import { jstApi } from './jstApi';
import { EMPTY, GROUPS, REQUIRED, type Field } from './jstUploadFields';

type Check = Awaited<ReturnType<typeof jstApi.uploadCheck>>;
const identity = (form: Record<string, string>) => JSON.stringify([form.skuId, form.styleId, form.name]);
export function JstUploadDialog({ onClose, onQueued }: { onClose: () => void; onQueued: () => void }) {
  const [form, setForm] = useState<Record<string, string>>({ ...EMPTY });
  const current = useRef(form); current.current = form;
  const [options, setOptions] = useState<Awaited<ReturnType<typeof jstApi.uploadOptions>>>({ categories: [], brands: [] });
  const latestOptions = useRef(options); latestOptions.current = options;
  const categoryRows = () => latestOptions.current.categoryOptions ?? latestOptions.current.categories.map(value => ({ value, label: value, disabled: false, reason: undefined as string | undefined }));
  const categoryProblem = () => { const selected = categoryRows().find(option => option.value === current.current.categoryName); return selected ? selected.disabled ? selected.reason || '该聚水潭分类不可选，请刷新后重新选择。' : '' : '所选聚水潭分类已失效，请刷新分类后重新选择。'; };
  const disabledReasons = [...new Set(categoryRows().filter(option => option.disabled && option.reason !== '请选择聚水潭末级分类。').map(option => option.reason).filter(Boolean))];
  const [optionsLoading, setOptionsLoading] = useState(false), [optionsError, setOptionsError] = useState('');
  const [check, setCheck] = useState<Check | null>(null), [checking, setChecking] = useState(false), [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null), [result, setResult] = useState<Awaited<ReturnType<typeof jstApi.upload>> | null>(null);
  const mounted = useRef(true), optionRequest = useRef(0), checkRequest = useRef(0), working = useRef(false), operation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; optionRequest.current++; checkRequest.current++; }; }, []);
  async function loadOptions() {
    const ticket = ++optionRequest.current; setOptionsLoading(true); setOptionsError('');
    try { const value = await jstApi.uploadOptions(); if (mounted.current && ticket === optionRequest.current) { latestOptions.current = value; setOptions(value); const errors = Object.values(value.errors ?? {}).filter(Boolean); setOptionsError(errors.length ? `聚水潭选项拉取提示：${errors.join('；')}` : ''); } }
    catch (failure) { if (mounted.current && ticket === optionRequest.current) { latestOptions.current = { categories: [], brands: [] }; setOptions(latestOptions.current); setOptionsError((failure as Error).message || '聚水潭分类拉取失败'); } }
    finally { if (mounted.current && ticket === optionRequest.current) setOptionsLoading(false); }
  }
  useEffect(() => { void loadOptions(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  function setField(key: string, value: string) {
    setForm(previous => { const next = { ...previous, [key]: value }; current.current = next; return next; });
    if (['skuId', 'styleId', 'name'].includes(key)) { operation.current++; working.current = false; checkRequest.current++; setCheck(null); setChecking(false); setMessage(null); }
  }
  function reset() { operation.current++; working.current = false; checkRequest.current++; setForm({ ...EMPTY }); current.current = { ...EMPTY }; setCheck(null); setChecking(false); setMessage(null); setResult(null); }
  function fillTestData() {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const selectable = categoryRows().filter(option => !option.disabled);
    const categoryName = selectable.some(option => option.value === current.current.categoryName) ? current.current.categoryName : selectable[0]?.value || '';
    const next = { ...current.current, skuId: `OA_TEST_${stamp}`, styleId: `OA_STYLE_${stamp}`, name: `OA测试普通商品-${stamp}`, shortName: `OA测试-${stamp.slice(-6)}`, propertiesValue: '测试规格;100g', categoryName, labels: 'OA测试标签', salePrice: '12.34', costPrice: '5.67', purchasePrice: '5.67', marketPrice: '19.99', brand: current.current.brand || 'OA测试品牌', unit: '个', weight: '0.1', remark: 'OA 系统接口测试商品，请在聚水潭确认后删除。' };
    operation.current++; working.current = false; checkRequest.current++; current.current = next; setForm(next); setCheck(null); setChecking(false); setMessage(null); setResult(null);
  }
  function validate() {
    const missing = REQUIRED.filter(field => !String(current.current[field.key] ?? '').trim());
    if (missing.length) { setMessage({ error: true, text: `请先填写必填项：${missing.map(field => field.label).join('、')}` }); return false; }
    const categoryError = categoryProblem();
    if (categoryError) { setMessage({ error: true, text: categoryError }); return false; }
    const invalid = GROUPS.flatMap(group => group.fields).find(field => field.type === 'number' && current.current[field.key]?.trim() && (!Number.isFinite(Number(current.current[field.key])) || Number(current.current[field.key]) < 0));
    if (invalid) { setMessage({ error: true, text: `「${invalid.label}」要填不小于 0 的数字` }); return false; }
    return true;
  }
  async function runCheck(): Promise<Check | null> {
    if (!validate()) return null;
    const ticket = ++checkRequest.current, scope = identity(current.current);
    setChecking(true); setMessage(null);
    try {
      const value = await jstApi.uploadCheck({ skuId: current.current.skuId, styleId: current.current.styleId, name: current.current.name, categoryName: current.current.categoryName });
      if (!mounted.current || ticket !== checkRequest.current || scope !== identity(current.current)) return null;
      setCheck(value);
      setMessage(value.hasHighRisk ? { error: true, text: '商品编码已存在。继续上传会覆盖聚水潭原商品资料，请核对后再确认上传。' } : value.hasWarning ? { error: true, text: '发现款式编码、商品名称或查重接口提示，请核对后再确认上传。' } : { error: false, text: '未发现重复资料，可以上传。' });
      return value;
    } catch (failure) {
      if (mounted.current && ticket === checkRequest.current) { const text = (failure as Error).message || '查重失败'; setMessage({ error: true, text: `查重失败：${text}` }); setCheck({ signature: null, hasHighRisk: false, hasWarning: true, errors: [text], matches: [] }); }
      return null;
    } finally { if (mounted.current && ticket === checkRequest.current) setChecking(false); }
  }
  async function submit(confirmed: boolean) {
    if (working.current || !validate()) return;
    const operationId = ++operation.current; working.current = true;
    try {
      const checked = confirmed ? check : await runCheck();
      if (!mounted.current || !checked || !checked.signature || (!confirmed && (checked.hasHighRisk || checked.hasWarning))) return;
      if (!validate()) return;
      const body: Record<string, string | number> = {};
      for (const field of GROUPS.flatMap(group => group.fields)) { const value = current.current[field.key]?.trim(); if (value) body[field.key] = field.type === 'number' ? Number(value) : value; }
      setSubmitting(true); setMessage(null); setResult(null);
      const uploaded = await jstApi.upload(body, checked.signature, confirmed);
      if (!mounted.current) return;
      setResult(uploaded); setMessage({ error: false, text: uploaded.queued ? '已提交，等待发送。' : '此份资料已在待发送记录中。' }); onQueued();
    } catch (failure) { if (mounted.current) { setMessage({ error: true, text: (failure as Error).message || '提交失败' }); onQueued(); } }
    finally { if (operationId === operation.current) { working.current = false; if (mounted.current) setSubmitting(false); } }
  }
  function fieldControl(field: Field) {
    const value = form[field.key] ?? '';
    return <label key={field.key} className={field.wide ? 'wide' : undefined}><span>{field.label}{field.required && <em>必填</em>}</span>{field.type === 'select' ? <select value={value} onChange={event => setField(field.key, event.target.value)}>{field.options!.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select> : field.type === 'category' ? <select value={value} onFocus={() => void loadOptions()} onChange={event => setField(field.key, event.target.value)}><option value="">{optionsLoading ? '正在从聚水潭拉取...' : '请选择聚水潭分类'}</option>{value && !categoryRows().some(option => option.value === value) && <option value={value} disabled>{value}（已失效，请重新选择）</option>}{categoryRows().map(option => <option key={option.value} value={option.value} disabled={option.disabled} title={option.reason}>{option.label}{option.disabled ? `（不可选：${option.reason || '请刷新后重试'}）` : ''}</option>)}</select> : field.type === 'textarea' ? <textarea value={value} maxLength={500} onChange={event => setField(field.key, event.target.value)} /> : <input type={field.type === 'number' ? 'number' : 'text'} step="any" min={field.type === 'number' ? 0 : undefined} value={value} placeholder={field.placeholder} maxLength={200} onChange={event => setField(field.key, event.target.value)} />}</label>;
  }
  return <FinanceModal title="普通商品资料上传" subtitle="填写商品资料并提交。商品编码相同会更新原资料。" presentation="reference" className="jst-upload-dialog" onClose={onClose} busy={submitting}>
    <div className="row-actions jst-upload-toolbar"><button type="button" className="secondary-button" disabled={submitting} onClick={fillTestData}>填入测试数据</button><button type="button" className="secondary-button" disabled={submitting} onClick={reset}>清空</button><button type="button" className="secondary-button" disabled={optionsLoading || submitting} onClick={() => void loadOptions()}>{optionsLoading ? '拉取中...' : '刷新分类/品牌'}</button></div>
    {optionsError && <div role="alert" className="jst-upload-message error">{optionsError}</div>}{!optionsError && categoryRows().length > 0 && <div className="jst-upload-message success">已从聚水潭拉取分类 {categoryRows().length} 个。分类必须从下拉框选择，品牌按实际资料填写。</div>}
    {disabledReasons.length > 0 && <div role="note" className="jst-upload-message error">部分分类不可选：{disabledReasons.join('；')}</div>}
    {message && <div role={message.error ? 'alert' : 'status'} className={`jst-upload-message ${message.error ? 'error' : 'success'}`}>{message.text}</div>}
    {check && <section aria-label="上传前查重结果" className={`jst-upload-duplicate ${check.hasHighRisk ? 'high-risk' : check.hasWarning ? 'warning' : 'clear'}`}><header><strong>上传前查重结果</strong><span>{check.hasHighRisk ? '高风险：商品编码重复会覆盖原资料。' : check.hasWarning ? '提示：请核对可能重复资料。' : '未发现重复。'}</span></header>{([['skuId', '商品编码重复'], ['styleId', '款式编码重复'], ['name', '商品名称重复']] as const).map(([key, title]) => { const matches = check.matches.filter(match => match.field === key); return matches.length > 0 && <div key={key} className="jst-upload-duplicate-block"><strong>{title}</strong><div className="table-scroll"><table className="data-table" aria-label={title}><thead><tr>{['商品编码', '款式编码', '商品名称', '规格', '分类', '来源'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{matches.slice(0, 8).map((match, index) => <tr key={index}><td>{match.skuId || '-'}</td><td>{match.styleId || '-'}</td><td>{match.name || match.hit || '-'}</td><td>{match.spec || '-'}</td><td>{match.category || '-'}</td><td>{match.source}</td></tr>)}</tbody></table></div></div>; })}{check.errors.length > 0 && <div className="jst-upload-duplicate-block"><strong>查重提示</strong><p>{check.errors.join('；')}</p></div>}{(check.hasWarning || check.hasHighRisk) && <div className="row-actions"><button type="button" className="jst-upload-continue" disabled={submitting || checking || !check.signature} onClick={() => void submit(true)}>已核对，继续上传</button><button type="button" className="secondary-button" disabled={submitting} onClick={() => { checkRequest.current++; setCheck(null); setChecking(false); setMessage(null); }}>返回修改</button></div>}</section>}
    <form className="jst-upload-layout" onSubmit={event => { event.preventDefault(); void submit(false); }}><fieldset disabled={submitting}>{GROUPS.map(group => <section className="jst-upload-field-section" key={group.title}><header><strong>{group.title}</strong><span>{group.description}</span></header><div className="jst-upload-field-grid">{group.fields.map(fieldControl)}</div></section>)}</fieldset><footer><button type="button" className="secondary-button" disabled={submitting} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={submitting || checking}>{submitting ? '提交中...' : checking ? '查重中...' : '查重并上传'}</button></footer></form>
    {result && <section className="jst-upload-result" role="status"><strong>待发送</strong><p>上传记录 #{result.id}。发送结果请查看上传记录。</p></section>}
  </FinanceModal>;
}

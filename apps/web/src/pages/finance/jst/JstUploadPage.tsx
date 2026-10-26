import { FormEvent, useEffect, useState } from 'react';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { Pager } from '../common';
import { jstApi } from './jstApi';

interface Field { key: string; label: string; required?: boolean; type?: 'number' | 'select' | 'textarea' | 'category'; options?: Array<[string, string]>; placeholder?: string; wide?: boolean }
const GROUPS: Array<{ title: string; description: string; fields: Field[] }> = [
  { title: '基础信息', description: '带“必填”的字段服务端也会校验，避免上传的资料不完整。', fields: [
    { key: 'skuId', label: '商品编码', required: true, placeholder: '如 SKU001' }, { key: 'styleId', label: '款式编码', required: true, placeholder: '如 STYLE001' },
    { key: 'name', label: '商品名称', required: true }, { key: 'shortName', label: '商品简称', required: true },
    { key: 'enabled', label: '商品状态', type: 'select', options: [['1', '启用'], ['0', '备用'], ['-1', '禁用']] },
    { key: 'itemType', label: '商品属性', type: 'select', options: [['成品', '成品'], ['半成品', '半成品'], ['原材料', '原材料'], ['包材', '包材']] },
    { key: 'stockDisabled', label: '库存同步', type: 'select', options: [['0', '允许同步'], ['1', '禁止同步']] },
    { key: 'remark', label: '备注', type: 'textarea', wide: true },
  ] },
  { title: '规格与分类', description: '分类从本地商品分类的最末级里选；颜色及规格多个属性用分号分隔，如“红色;100g”。', fields: [
    { key: 'propertiesValue', label: '颜色及规格', required: true, placeholder: '如 红色;100g' }, { key: 'categoryName', label: '分类', required: true, type: 'category' },
    { key: 'virtualCategory', label: '虚拟分类' }, { key: 'brand', label: '品牌', required: true }, { key: 'labels', label: '商品标签', placeholder: '多个标签用逗号分隔' },
    { key: 'skuCode', label: '国标码/条码' }, { key: 'otherCode', label: '辅助码' },
  ] },
  { title: '价格与尺寸', description: '价格（元）和重量（kg）按数字上传。', fields: [
    { key: 'marketPrice', label: '市场/吊牌价', type: 'number' }, { key: 'salePrice', label: '基本售价', type: 'number' },
    { key: 'costPrice', label: '成本价', required: true, type: 'number' }, { key: 'purchasePrice', label: '采购价', required: true, type: 'number' },
    { key: 'weight', label: '重量', required: true, type: 'number' }, { key: 'length', label: '长', type: 'number' }, { key: 'width', label: '宽', type: 'number' },
    { key: 'height', label: '高', type: 'number' }, { key: 'volume', label: '体积', type: 'number' }, { key: 'unit', label: '单位', required: true, placeholder: '如 个、斤、袋' },
  ] },
  { title: '供应商与图片', description: '供应商优先写名称、供应商商品编码和款式编码。', fields: [
    { key: 'supplierName', label: '供应商名称' }, { key: 'supplierSkuId', label: '供应商商品编码' }, { key: 'supplierStyleId', label: '供应商款式编码' },
    { key: 'pic', label: '图片 URL' }, { key: 'picBig', label: '大图 URL' }, { key: 'productionLicence', label: '生产许可证' },
    { key: 'productionBatchFormat', label: '生产批次格式' }, { key: 'shelfLife', label: '保质期天数', type: 'number' },
  ] },
  { title: '备用字段', description: '聚水潭支持其他价格 1-5、其他属性 1-5，名称可在聚水潭里自定义。', fields: [
    ...[1, 2, 3, 4, 5].map((n) => ({ key: `otherPrice${n}`, label: `其他价格${n}`, type: 'number' as const })),
    ...[1, 2, 3, 4, 5].map((n) => ({ key: `other${n}`, label: `其他属性${n}` })),
  ] },
];
const REQUIRED = GROUPS.flatMap((g) => g.fields).filter((f) => f.required);
const EMPTY: Record<string, string> = { enabled: '1', itemType: '成品', stockDisabled: '0' };
const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');
const STATUS: Record<string, string> = { queued: '已排队', success: '成功', failed: '失败' };

/** 资料维护 · 商品资料上传：填聚水潭普通商品资料，先查重，再加入同步队列（总开关开着、接入接口后才会真正发送）。 */
export function JstUploadPage() {
  const { user } = useAuth();
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const [form, setForm] = useState<Record<string, string>>(EMPTY);
  const [cats, setCats] = useState<string[]>([]);
  const [check, setCheck] = useState<Awaited<ReturnType<typeof jstApi.uploadCheck>> | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<Awaited<ReturnType<typeof jstApi.uploadLogs>> | null>(null);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  useEffect(() => { jstApi.uploadOptions().then((o) => setCats(o.categories)).catch(() => undefined); }, []);
  const loadLogs = () => jstApi.uploadLogs({ keyword: keyword || undefined, page }).then(setLogs).catch((e) => setError(msg(e)));
  useEffect(() => { void loadLogs(); }, [page, keyword]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: string) => { setForm((f) => ({ ...f, [k]: v })); setCheck(null); };
  const missing = REQUIRED.filter((f) => !String(form[f.key] ?? '').trim());

  async function runCheck() {
    setError('');
    try { setCheck(await jstApi.uploadCheck({ skuId: form.skuId, styleId: form.styleId, name: form.name })); } catch (e) { setError(msg(e)); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const body: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(form)) if (v.trim()) body[k] = GROUPS.flatMap((g) => g.fields).find((f) => f.key === k)?.type === 'number' ? Number(v) : v.trim();
      const r = await jstApi.upload(body);
      setNotice(r.queued ? '已加入同步队列。同步总开关打开并接入聚水潭接口后才会真正发送，结果会回写到下面的上传记录。' : '这条已经在队列里了。');
      setForm(EMPTY); setCheck(null);
      await loadLogs();
    } catch (er) { setError(msg(er)); }
    setBusy(false);
  }

  return (
    <div>
      <div className="page-head"><h1>资料维护</h1></div>
      <p className="muted">在这里补传聚水潭里没有的普通商品资料。成本价、采购价属于敏感信息，只有管理员能上传。{!isAdmin && ' 你不是管理员，只能查看上传记录。'}</p>
      <form onSubmit={submit}>
        {GROUPS.map((g) => (
          <fieldset key={g.title} className="card">
            <legend>{g.title}</legend>
            <p className="muted">{g.description}</p>
            <div className="form-grid">
              {g.fields.map((f) => (
                <label key={f.key} style={f.wide ? { gridColumn: '1 / -1' } : undefined}>{f.label}{f.required && <span className="bad-text">（必填）</span>}
                  {f.type === 'select' ? <select value={form[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>{f.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    : f.type === 'textarea' ? <textarea rows={2} value={form[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
                    : f.type === 'category' ? <><input list="jst-cats" value={form[f.key] ?? ''} placeholder="选最末级分类" onChange={(e) => set(f.key, e.target.value)} /><datalist id="jst-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist></>
                    : <input type={f.type === 'number' ? 'number' : 'text'} min={f.type === 'number' ? 0 : undefined} step={f.type === 'number' ? 'any' : undefined} value={form[f.key] ?? ''} placeholder={f.placeholder} maxLength={200} onChange={(e) => set(f.key, e.target.value)} />}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        {error && <div role="alert" className="notice error">{error}</div>}
        {notice && <div role="status" className="notice ok">{notice}</div>}
        {check && (
          <div className={`notice ${check.hasHighRisk ? 'error' : check.hasWarning ? 'warn' : 'ok'}`}>
            {check.matches.length === 0 ? '没有发现重复，可以上传。' : (
              <ul>{check.matches.map((m, i) => <li key={i}>{m.level === 'high' ? '【不能上传】' : '【提醒】'}{m.field === 'skuId' ? '商品编码' : m.field === 'styleId' ? '款式编码' : '商品名称'}和{m.source}「{m.hit}」重复</li>)}</ul>
            )}
          </div>
        )}
        <div className="row-actions">
          <button type="button" className="secondary-button" disabled={!form.skuId && !form.styleId && !form.name} onClick={() => void runCheck()}>检查是否重复</button>
          <button type="submit" className="primary-button" disabled={busy || !isAdmin || missing.length > 0 || check?.hasHighRisk}>加入同步队列</button>
          {missing.length > 0 && <span className="muted">还需填写：{missing.map((f) => f.label).join('、')}</span>}
        </div>
      </form>
      <h2>上传记录</h2>
      <div className="toolbar"><input aria-label="搜索上传记录" placeholder="按商品编码搜索" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} /></div>
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>商品编码</th><th>款式编码</th><th>名称</th><th>状态</th><th>说明</th><th>时间</th></tr></thead>
        <tbody>
          {logs?.rows.length === 0 && <tr><td colSpan={6} className="muted center">还没有上传记录</td></tr>}
          {logs?.rows.map((r) => <tr key={r.id}><td>{r.skuId}</td><td>{r.styleId}</td><td>{r.name}</td><td><span className={`pill ${r.status === 'success' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn'}`}>{STATUS[r.status] ?? r.status}</span></td><td>{r.message}</td><td>{new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}</td></tr>)}
        </tbody>
      </table></div>
      <Pager page={page} total={logs?.total ?? 0} pageSize={20} onPage={setPage} />
    </div>
  );
}

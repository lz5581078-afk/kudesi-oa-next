import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { FlowFieldsForm } from './FlowFields';
import { RunDetail } from './RunDetail';
import { SKU_TEMPLATE, skuApi } from './SkuApply';
import { flowApi, newRequestKey, type TemplateInfo } from './flowApi';
import { remember } from './flowUi';

const RECENT_KEY = 'kudesi.apply.recent';
const readRecent = (): string[] => { try { const v = JSON.parse(remember.get(RECENT_KEY, '[]')); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };

/** 申请中心：选一种流程、填表、提交。同一次填写用同一个 requestKey，重复点击不会重复发起；最近用过的排最前。 */
export function ApplyPage() {
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<TemplateInfo | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState('');
  const [keyword, setKeyword] = useState('');
  const [recent, setRecent] = useState<string[]>(readRecent);
  const keyRef = useRef(newRequestKey());
  useEffect(() => { flowApi.templates().then(setTemplates).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, []);

  const dirty = Object.values(values).some((v) => v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0));
  function closeForm() {
    if (dirty && !window.confirm('已填写的内容还没有提交，确定放弃吗？')) return;
    setSel(null);
  }

  async function submit() {
    if (!sel) return;
    setBusy(true);
    setError('');
    try {
      const { splitSpecs, ...rest } = values;
      const split = sel.key === SKU_TEMPLATE && splitSpecs === true && Array.isArray(rest.specs) && rest.specs.length > 1;
      if (split) {
        // 每个规格独立办理：拆成一规格一条流程；有失败的规格单独提示，已发起的不受影响
        const out = await skuApi.startSplit(rest, keyRef.current);
        keyRef.current = newRequestKey();
        setSubmitted(`「${sel.label}」已拆成 ${out.runs.length} 条独立流程（${out.runs.map((r) => `#${r.id}`).join('、')}）${out.failed.length ? `；${out.failed.length} 个规格没发起成功：${out.failed.map((f) => `${f.specName}（${f.message}）`).join('；')}` : ''}。`);
        setSel(null);
        setValues({});
        if (out.runs[0]) setOpenRun(out.runs[0].id);
        return;
      }
      const run = await flowApi.start(sel.key, rest, keyRef.current);
      keyRef.current = newRequestKey();
      const next = [sel.key, ...recent.filter((k) => k !== sel.key)].slice(0, 6);
      setRecent(next);
      remember.set(RECENT_KEY, JSON.stringify(next));
      setSubmitted(`「${sel.label}」已提交，编号 #${run.id}。办理进度可在“我发起的”查看。`);
      setSel(null);
      setValues({});
      setOpenRun(run.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '提交失败');
    } finally { setBusy(false); }
  }

  const shown = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const list = (templates ?? []).filter((t) => t.startable !== false).filter((t) => !kw || `${t.label} ${t.description}`.toLowerCase().includes(kw));
    const rank = (t: TemplateInfo) => (t.active ? 0 : 1000) + (recent.includes(t.key) ? recent.indexOf(t.key) : 100);
    return [...list].sort((a, b) => rank(a) - rank(b));
  }, [templates, keyword, recent]);

  return (
    <div>
      <div className="page-head"><h1>申请中心</h1><Link to="/workbench/started" className="muted">我发起的 →</Link></div>
      {submitted && <div role="status" className="notice ok-notice toast-line"><span>{submitted}</span><button type="button" aria-label="关闭提示" onClick={() => setSubmitted('')}>✕</button></div>}
      {error && !sel && <div role="alert" className="notice error">{error}</div>}
      <input type="search" className="search-input card-search" aria-label="搜索流程" placeholder="搜索想发起的流程" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      {templates && shown.length === 0 && (
        <div className="empty-state muted"><strong>{keyword ? '没有匹配的流程' : '还没有可申请的流程'}</strong>{keyword && <button type="button" className="secondary-button" onClick={() => setKeyword('')}>清除搜索</button>}</div>
      )}
      <div className="card-grid">
        {shown.map((t) => (
          <section key={t.key} className="card" style={{ padding: 16 }}>
            <h3>{t.label}{recent.includes(t.key) && <span className="recent-badge"> · 最近用过</span>}</h3>
            <p className="muted">{t.description}</p>
            {t.steps && t.steps.length > 0 && (
              <details>
                <summary>查看流程环节（{t.steps.length} 步）</summary>
                <ol className="step-progress">{t.steps.map((st, i) => <li key={`${st.name}${i}`}>{st.name}</li>)}</ol>
              </details>
            )}
            {t.active
              ? <button type="button" className="primary-button" onClick={() => { setSel(t); setValues({}); setError(''); setSubmitted(''); }}>发起申请</button>
              : <span className="pill warn">管理员还没有配置并启用</span>}
          </section>
        ))}
      </div>
      {sel && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal card" role="dialog" aria-label={`发起${sel.label}`} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <div className="modal-head between"><strong>{sel.label}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={closeForm}>✕</button></div>
            <div className="modal-body">
              {sel.description && <p className="muted">{sel.description}</p>}
              <FlowFieldsForm fields={sel.fields} templateKey={sel.key} values={values} onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))} />
              {error && <div role="alert" className="notice error">{error}</div>}
            </div>
            <div className="modal-foot">
              {dirty && <span className="muted">有未提交的内容</span>}
              <button type="button" className="secondary-button" onClick={closeForm}>取消</button>
              <button type="submit" className="primary-button" disabled={busy}>{busy ? '提交中…' : '提交申请'}</button>
            </div>
          </form>
        </div>
      )}
      {openRun && <RunDetail id={openRun} onClose={() => setOpenRun(null)} onChanged={() => undefined} />}
    </div>
  );
}

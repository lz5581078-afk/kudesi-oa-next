import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { FlowFieldsForm } from './FlowFields';
import { RunDetail } from './RunDetail';
import { flowApi, newRequestKey, type TemplateInfo } from './flowApi';

/** 申请中心：选一种流程、填表、提交。同一次填写用同一个 requestKey，重复点击不会重复发起。 */
export function ApplyPage() {
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<TemplateInfo | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const keyRef = useRef(newRequestKey());
  useEffect(() => { flowApi.templates().then(setTemplates).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, []);

  async function submit() {
    if (!sel) return;
    setBusy(true);
    setError('');
    try {
      const run = await flowApi.start(sel.key, values, keyRef.current);
      keyRef.current = newRequestKey();
      setSel(null);
      setValues({});
      setOpenRun(run.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '提交失败');
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="page-head"><h1>申请中心</h1></div>
      {error && !sel && <div role="alert" className="notice error">{error}</div>}
      <div className="card-grid">
        {templates?.map((t) => (
          <section key={t.key} className="card" style={{ padding: 16 }}>
            <h3>{t.label}</h3>
            <p className="muted">{t.description}</p>
            {t.active
              ? <button type="button" className="primary-button" onClick={() => { setSel(t); setValues({}); setError(''); }}>发起申请</button>
              : <span className="pill warn">管理员还没有配置并启用</span>}
          </section>
        ))}
      </div>
      {sel && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal card" role="dialog" aria-label={`发起${sel.label}`} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <div className="modal-head between"><strong>{sel.label}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={() => setSel(null)}>✕</button></div>
            <div className="modal-body">
              <FlowFieldsForm fields={sel.fields} templateKey={sel.key} values={values} onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))} />
              {error && <div role="alert" className="notice error">{error}</div>}
            </div>
            <div className="modal-foot">
              <button type="button" className="secondary-button" onClick={() => setSel(null)}>取消</button>
              <button type="submit" className="primary-button" disabled={busy}>{busy ? '提交中…' : '提交申请'}</button>
            </div>
          </form>
        </div>
      )}
      {openRun && <RunDetail id={openRun} onClose={() => setOpenRun(null)} onChanged={() => undefined} />}
    </div>
  );
}

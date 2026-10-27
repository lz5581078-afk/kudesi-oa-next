import { useCallback, useEffect, useState } from 'react';
import { liveApi, type RuleList, type RulesForm, type Trial } from './liveApi';
import { errText, money, ratePct, roi, todayText } from './liveFormat';
import { Modal } from './liveUi';

const blank = (f: RulesForm): RulesForm => JSON.parse(JSON.stringify(f)) as RulesForm;

function RuleView({ form }: { form: RulesForm }) {
  return (
    <div className="live-scroll">
      <p className="muted">档位边界：{form.boundary === 'min_inclusive' ? '含下限' : '含上限'} · 投产阈值 {form.roiThreshold} · 投产不足时主播扣 {form.belowRoiAnchorDeduct} 点、中控扣 {form.belowRoiControlDeduct} 点 · 运营固定 {form.operatorRate}%</p>
      <table className="data-table" aria-label="提成档位"><thead><tr><th>销售额下限（元）</th><th>上限（元）</th><th className="num">主播</th><th className="num">中控</th></tr></thead>
        <tbody>{form.tiers.map((t, i) => <tr key={i}><td>{t.min}</td><td>{t.max || '及以上'}</td><td className="num">{t.anchorRate}%</td><td className="num">{t.controlRate}%</td></tr>)}</tbody></table>
    </div>
  );
}

function Editor({ base, onClose, onDone }: { base: RulesForm; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState<RulesForm>(() => blank(base));
  const [from, setFrom] = useState(todayText());
  const [note, setNote] = useState('');
  const [sales, setSales] = useState('');
  const [ad, setAd] = useState('');
  const [trial, setTrial] = useState<Trial | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setTier = (i: number, k: keyof RulesForm['tiers'][number], v: string) => setForm((f) => ({ ...f, tiers: f.tiers.map((t, j) => (j === i ? { ...t, [k]: v } : t)) }));
  const addTier = () => setForm((f) => { const last = f.tiers[f.tiers.length - 1]; return { ...f, tiers: [...f.tiers.slice(0, -1), { ...last, max: String(Number(last.min) + 10000) }, { min: String(Number(last.min) + 10000), max: '', anchorRate: last.anchorRate, controlRate: last.controlRate }] }; });
  const dropTier = () => setForm((f) => (f.tiers.length < 2 ? f : { ...f, tiers: [...f.tiers.slice(0, -2), { ...f.tiers[f.tiers.length - 2], max: '' }] }));
  async function runTrial() {
    setError('');
    try { setTrial(await liveApi.trial({ rules: form, sales, adSpend: ad })); } catch (e) { setTrial(null); setError(errText(e)); }
  }
  async function save() {
    setBusy(true); setError('');
    try { await liveApi.createRule({ effectiveFrom: from, note: note.trim() || undefined, rules: form }); onDone(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="新增规则版本" size="wide" onClose={onClose} foot={<><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存为新版本'}</button></>}>
      {error && <div role="alert" className="notice error">{error}</div>}
      <p className="muted">规则只追加：新版本从生效日期当天起适用于场次日期，已有版本不能修改或删除；同一生效日期只能有一个版本。</p>
      <div className="live-fields">
        <label className="live-field">生效日期<input aria-label="生效日期" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="live-field">档位边界<select aria-label="档位边界" value={form.boundary} onChange={(e) => setForm({ ...form, boundary: e.target.value })}><option value="min_inclusive">含下限</option><option value="max_inclusive">含上限</option></select></label>
        <label className="live-field">投产阈值<input aria-label="投产阈值" value={form.roiThreshold} onChange={(e) => setForm({ ...form, roiThreshold: e.target.value })} /></label>
        <label className="live-field">投产不足主播扣（点）<input aria-label="主播扣减点数" value={form.belowRoiAnchorDeduct} onChange={(e) => setForm({ ...form, belowRoiAnchorDeduct: e.target.value })} /></label>
        <label className="live-field">投产不足中控扣（点）<input aria-label="中控扣减点数" value={form.belowRoiControlDeduct} onChange={(e) => setForm({ ...form, belowRoiControlDeduct: e.target.value })} /></label>
        <label className="live-field">运营提成比例（%）<input aria-label="运营比例" value={form.operatorRate} onChange={(e) => setForm({ ...form, operatorRate: e.target.value })} /></label>
        <label className="live-field wide">说明<input aria-label="规则说明" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <fieldset><legend>提成档位（销售额，元）</legend>
        {form.tiers.map((t, i) => (
          <div key={i} className="live-rule-row">
            <label className="live-field">下限<input aria-label={`第${i + 1}档下限`} value={t.min} onChange={(e) => setTier(i, 'min', e.target.value)} /></label>
            <label className="live-field">上限<input aria-label={`第${i + 1}档上限`} placeholder="及以上" value={t.max} onChange={(e) => setTier(i, 'max', e.target.value)} /></label>
            <label className="live-field">主播 %<input aria-label={`第${i + 1}档主播比例`} value={t.anchorRate} onChange={(e) => setTier(i, 'anchorRate', e.target.value)} /></label>
            <label className="live-field">中控 %<input aria-label={`第${i + 1}档中控比例`} value={t.controlRate} onChange={(e) => setTier(i, 'controlRate', e.target.value)} /></label>
          </div>
        ))}
        <div className="live-actions pad"><button type="button" className="secondary-button small" onClick={addTier}>加一档</button><button type="button" className="secondary-button small" onClick={dropTier} disabled={form.tiers.length < 2}>删最后一档</button></div>
      </fieldset>
      <fieldset><legend>试算（不保存）</legend>
        <div className="live-fields">
          <label className="live-field">销售额（元）<input aria-label="试算销售额" inputMode="decimal" value={sales} onChange={(e) => setSales(e.target.value)} /></label>
          <label className="live-field">投流费用（元，可空）<input aria-label="试算投流" inputMode="decimal" value={ad} onChange={(e) => setAd(e.target.value)} /></label>
          <div className="live-field" style={{ justifyContent: 'flex-end' }}><button type="button" className="secondary-button" onClick={() => void runTrial()}>试算</button></div>
        </div>
        {trial && <div className="live-preview" role="status"><span>第 {trial.tierIndex + 1} 档 · 投产 {roi(trial.roiScaled)}{trial.belowRoi ? '（不足，已扣减点数）' : ''}</span>
          <ul className="live-amounts">{([['主播', trial.anchor], ['中控', trial.control], ['运营', trial.operator]] as const).map(([n, v]) => <li key={n}><span>{n}</span><strong>{money(v.amountCents)}</strong><small>{ratePct(v.rateUnits)}</small></li>)}</ul></div>}
      </fieldset>
    </Modal>
  );
}

/** 提成规则：版本列表（只读）、新增版本（带试算）。 */
export function RulesTab() {
  const [d, setD] = useState<RuleList | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => { liveApi.rules().then((x) => { setD(x); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, []);
  useEffect(load, [load]);
  return (
    <div className="live-page">
      <div className="page-head"><p className="muted">提成按场次日期适用的规则版本计算；审核通过时保存当时的规则快照。</p>{d?.canManage && d.versions.length > 0 && <button type="button" className="primary-button" onClick={() => setEditing(true)}>新增规则版本</button>}</div>
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      {d && d.versions.length === 0 && <p className="muted card pad" role="status">还没有规则版本，请联系管理员初始化。</p>}
      {d?.versions.map((v) => (
        <section key={v.id} className="card live-section" aria-label={`规则 ${v.effectiveFrom}`}>
          <h2>{v.effectiveFrom} 起 {v.id === d.currentId && <span className="pill ok">当前生效</span>} <small className="muted">{v.creatorName ? `${v.creatorName} · ` : ''}{v.createdAt}{v.usedCount ? ` · 已用于 ${v.usedCount} 条提成` : ''}{v.note ? ` · ${v.note}` : ''}</small></h2>
          <div className="pad"><RuleView form={v.form} /></div>
        </section>
      ))}
      {editing && d && <Editor base={(d.versions.find((v) => v.id === d.currentId) ?? d.versions[0]).form} onClose={() => setEditing(false)} onDone={() => { setEditing(false); load(); }} />}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { resourceApi, type ResourceDto } from '../../resources/api';
import { Pager, SearchPick, centsToYuan, money, yuanToCents } from '../finance/common';

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
const errText = (e: unknown) => (e instanceof ApiError ? e.message : '保存失败');
const PAGE_SIZE = 20;
type Tab = 'plan' | 'sub' | 'broadband';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'plan', label: '手机套餐' },
  { key: 'sub', label: '主子卡费用' },
  { key: 'broadband', label: '宽带费用' },
];

interface Change { id: number; title: string; lines: string[]; values: Record<string, unknown> }

/**
 * 费用模块：集中维护手机号套餐、主子卡费用和宽带费用。
 * 不另存数据：保存时直接写回手机号档案 / 宽带账号档案，变更记录留在各自档案的操作记录里。
 * 列表走服务端搜索和分页（手机号很多）；勾选多条可一起改，保存前先预览改了什么。
 */
export function FeeSettingsPage() {
  const [tab, setTab] = useState<Tab>('plan');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ResourceDto[]>([]);
  const [total, setTotal] = useState(0);
  const [checked, setChecked] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [preview, setPreview] = useState<Change[] | null>(null);
  const [mode, setMode] = useState<'all' | 'main' | 'sub'>('all');
  // 批量修改表单：勾选“改这一项”才会写入
  const [use, setUse] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState({ carrier: '', plan: '', fee: '', days: '30', cycle: 'monthly', parentId: null as number | null, parentLabel: '' });
  const type = tab === 'broadband' ? 'broadband' : 'phones';

  const load = useCallback(async () => {
    try {
      const r = await resourceApi.list(type, { keyword, page, pageSize: PAGE_SIZE, showHidden: true });
      setItems(r.items);
      setTotal(r.total);
      setError('');
    } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
  }, [type, keyword, page]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setChecked([]); setPreview(null); setUse({}); }, [tab]);

  const shown = useMemo(
    () => (tab === 'sub' ? items.filter((p) => (mode === 'all' ? true : mode === 'sub' ? Boolean(p.data.parentPhoneId) : !p.data.parentPhoneId)) : items),
    [items, tab, mode],
  );
  const allChecked = shown.length > 0 && shown.every((p) => checked.includes(p.id));

  function buildChanges(): Change[] | string {
    const targets = items.filter((p) => checked.includes(p.id));
    if (!targets.length) return '请先勾选要修改的记录';
    const out: Change[] = [];
    let fee: number | null = null;
    if (use.fee) {
      fee = yuanToCents(form.fee);
      if (fee === null || Number.isNaN(fee) || fee < 0) return '费用金额不合法（元，最多两位小数）';
    }
    if (use.days && !(Number(form.days) >= 1 && Number(form.days) <= 3650)) return '充值周期应在 1 到 3650 天之间';
    if (use.plan && !form.plan.trim()) return '套餐名不能为空';
    for (const p of targets) {
      const values: Record<string, unknown> = {};
      const lines: string[] = [];
      const diff = (key: string, label: string, next: unknown, oldText: string, nextText: string) => {
        if (String(p.data[key] ?? '') === String(next ?? '')) return;
        values[key] = next;
        lines.push(`${label}：${oldText || '空'} → ${nextText || '空'}`);
      };
      if (type === 'phones') {
        if (use.carrier) diff('carrier', '运营商', form.carrier.trim() || null, String(p.data.carrier ?? ''), form.carrier.trim());
        if (use.plan) diff('plan', '套餐名', form.plan.trim(), String(p.data.plan ?? ''), form.plan.trim());
        if (use.fee) diff('monthlyFee', '费用', fee, p.data.monthlyFee ? centsToYuan(num(p.data.monthlyFee)) : '', centsToYuan(fee));
        if (use.days) diff('rechargeCycleDays', '充值周期(天)', Number(form.days), String(p.data.rechargeCycleDays ?? ''), form.days);
        if (use.parent) {
          if (form.parentId === p.id) return `${p.title}：不能把自己设为主卡`;
          diff('parentPhoneId', '主卡', form.parentId, p.refLabels.parentPhoneId ?? '', form.parentLabel || '无（设为主卡）');
        }
      } else {
        if (use.fee) diff('amount', '费用', fee, p.data.amount ? centsToYuan(num(p.data.amount)) : '', centsToYuan(fee));
        if (use.cycle) diff('cycle', '费用周期', form.cycle, String(p.data.cycle ?? ''), form.cycle === 'yearly' ? '每年' : '每月');
      }
      if (lines.length) out.push({ id: p.id, title: p.title, lines, values });
    }
    if (!out.length) return '没有需要修改的内容（先勾选“改这一项”并填写新值）';
    return out;
  }

  function doPreview() {
    setError(''); setOk('');
    const r = buildChanges();
    if (typeof r === 'string') return setError(r);
    setPreview(r);
  }

  async function doSave() {
    if (!preview) return;
    let done = 0;
    const failed: string[] = [];
    for (const c of preview) {
      try { await resourceApi.update(type, c.id, c.values); done++; } catch (e) { failed.push(`${c.title}：${errText(e)}`); }
    }
    setPreview(null);
    setOk(`已保存 ${done} 条，已同步到${type === 'phones' ? '手机号' : '宽带账号'}档案${failed.length ? `；${failed.length} 条失败` : ''}`);
    setError(failed.slice(0, 3).join('；'));
    setChecked([]);
    await load();
  }

  const toggle = (id: number) => setChecked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const useBox = (key: string, label: string) => (
    <label className="inline-check"><input type="checkbox" checked={Boolean(use[key])} onChange={(e) => setUse({ ...use, [key]: e.target.checked })} />改{label}</label>
  );

  return (
    <section className="page">
      <h1>费用模块</h1>
      <p className="muted">集中维护手机号套餐、主子卡费用和宽带费用；保存后直接写回手机号档案和宽带账号档案。</p>
      {error && <div role="alert" className="notice error">{error}</div>}
      {ok && <div role="status" className="notice ok-notice">{ok}</div>}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'tab active' : 'tab'} onClick={() => { setTab(t.key); setPage(1); setKeyword(''); }}>{t.label}</button>
        ))}
      </div>

      <div className="toolbar">
        <input aria-label="搜索" placeholder={tab === 'broadband' ? '搜索宽带账号' : '搜索号码'} value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
        {tab === 'sub' && (
          <select aria-label="主子卡" value={mode} onChange={(e) => setMode(e.target.value as 'all' | 'main' | 'sub')}>
            <option value="all">主卡和子卡</option><option value="main">只看主卡</option><option value="sub">只看子卡</option>
          </select>
        )}
        <span className="muted">已勾选 {checked.length} 条</span>
      </div>

      <div className="card">
        <h2>批量修改{checked.length ? `（${checked.length} 条）` : ''}</h2>
        <div className="form-grid compact">
          {type === 'phones' && tab === 'plan' && (
            <>
              <div>{useBox('carrier', '运营商')}<input aria-label="运营商" value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} /></div>
              <div>{useBox('plan', '套餐名')}<input aria-label="套餐名" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} /></div>
              <div>{useBox('fee', '费用')}<input aria-label="费用（元）" type="number" min="0" step="0.01" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} /></div>
            </>
          )}
          {tab === 'sub' && (
            <>
              <div>{useBox('parent', '主卡')}
                <SearchPick type="phones" value={form.parentId} label={form.parentLabel} placeholder="搜索主卡号码（不选 = 设为主卡）" ariaLabel="主卡" onChange={(id, label) => setForm({ ...form, parentId: id, parentLabel: label })} />
              </div>
              <div>{useBox('fee', '子卡费用')}<input aria-label="费用（元）" type="number" min="0" step="0.01" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} /></div>
              <div>{useBox('days', '充值周期')}<input aria-label="充值周期（天）" type="number" min="1" step="1" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} /></div>
            </>
          )}
          {tab === 'broadband' && (
            <>
              <div>{useBox('fee', '费用')}<input aria-label="费用（元）" type="number" min="0" step="0.01" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} /></div>
              <div>{useBox('cycle', '费用周期')}
                <select aria-label="费用周期" value={form.cycle} onChange={(e) => setForm({ ...form, cycle: e.target.value })}><option value="monthly">每月</option><option value="yearly">每年</option></select>
              </div>
            </>
          )}
        </div>
        <div className="form-actions"><button type="button" className="primary-button" onClick={doPreview}>预览修改</button></div>
        {preview && (
          <div role="region" aria-label="修改预览">
            <h3>将要修改 {preview.length} 条，请确认</h3>
            <ul>{preview.map((c) => <li key={c.id}><strong>{c.title}</strong>：{c.lines.join('；')}</li>)}</ul>
            <div className="form-actions">
              <button type="button" className="primary-button" onClick={() => void doSave()}>确认保存</button>
              <button type="button" className="secondary-button" onClick={() => setPreview(null)}>取消</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <table className="data-table">
          <thead>
            {tab === 'broadband' ? (
              <tr><th><input type="checkbox" aria-label="本页全选" checked={allChecked} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...shown.map((p) => p.id)])] : checked.filter((id) => !shown.some((p) => p.id === id)))} /></th><th>宽带账号</th><th>宽带位置</th><th>绑定手机号</th><th className="num">费用</th><th>状态</th></tr>
            ) : (
              <tr><th><input type="checkbox" aria-label="本页全选" checked={allChecked} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...shown.map((p) => p.id)])] : checked.filter((id) => !shown.some((p) => p.id === id)))} /></th><th>号码</th><th>主子卡</th><th>运营商</th><th>套餐</th><th className="num">费用</th><th className="num">充值周期</th></tr>
            )}
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td><input type="checkbox" aria-label={`勾选 ${p.title}`} checked={checked.includes(p.id)} onChange={() => toggle(p.id)} /></td>
                {tab === 'broadband' ? (
                  <>
                    <td>{p.title}</td><td>{p.refLabels.locationId ?? String(p.data.locationNote ?? '-')}</td><td>{p.refLabels.phoneId ?? '-'}</td>
                    <td className="num">{p.data.amount ? `${money(num(p.data.amount))} / ${p.data.cycle === 'yearly' ? '年' : '月'}` : '-'}</td>
                    <td>{p.status === 'normal' ? '正常' : p.status === 'suspended' ? '停机' : '注销'}</td>
                  </>
                ) : (
                  <>
                    <td>{p.title}</td>
                    <td>{p.data.parentPhoneId ? `子卡 / 主卡：${p.refLabels.parentPhoneId ?? p.data.parentPhoneId}` : '主卡'}</td>
                    <td>{String(p.data.carrier ?? '-')}</td><td>{String(p.data.plan ?? '-')}</td>
                    <td className="num">{p.data.monthlyFee ? money(num(p.data.monthlyFee)) : '-'}</td>
                    <td className="num">{p.data.rechargeCycleDays ? `${p.data.rechargeCycleDays} 天` : '-'}</td>
                  </>
                )}
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={7} className="muted">没有符合条件的记录。</td></tr>}
          </tbody>
        </table>
        <Pager page={page} total={total} pageSize={PAGE_SIZE} onPage={setPage} />
      </div>
    </section>
  );
}

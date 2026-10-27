import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  JST_CAPABILITY_GROUPS, JST_GRANTED_ENDPOINT_COUNT, JST_JOB_KIND_LABEL, JST_READINESS_LABEL, JST_RULES, JST_SYNC_TASKS, JST_TEST_RESULTS,
} from '@kudesi/shared';
import { api, ApiError } from '../../api/client';
import { CopyButton } from '../../resources/CopyValue';

interface Overview {
  switch: { enabled: boolean; note: string | null; updatedAt: string | null };
  priceSwitch: { enabled: boolean; note: string | null; updatedAt: string | null };
  senderConfigured: boolean;
  counts: Record<string, number>;
  byKind: Record<string, Record<string, number>>;
  oldestPendingAt: string | null;
  failures: Array<{ id: number; kind: string; resourceType: string; resourceId: number; attempts: number; lastError: string | null; createdAt: string }>;
}
const STATUS_LABEL: Record<string, string> = { pending: '排队中', sending: '发送中', done: '已完成', failed: '失败', cancelled: '已取消' };
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—');

/** 聚水潭同步能力中心：只读。上半部分是新系统真实的对外同步状态，下半部分是能力地图、旧系统实测记录和同步计划。不做任何外部调用。 */
export function JstSyncCenterPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [mod, setMod] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api<Overview>('/system/jst-center')); setError(''); } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const modules = useMemo(() => [...new Set(JST_TEST_RESULTS.map((r) => r.module))], []);
  const tests = JST_TEST_RESULTS.filter((r) => !mod || r.module === mod);
  const passed = JST_TEST_RESULTS.filter((r) => r.result === '已测通').length;
  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <section className="page jst-center">
      <div className="page-head"><h1>聚水潭同步能力中心</h1><button type="button" className="secondary-button" disabled={loading} onClick={() => void load()}>刷新</button></div>
      <p className="muted">基于旧系统记录的开放平台授权与接口实测结果，规划订单、商品、库存、售后、采购和财务的同步能力。本页只读展示，不会调用聚水潭，也不能在这里发起任何写入。</p>

      <div className="metric-row" aria-label="能力概览">
        <div className="metric"><span className="muted">已读取授权能力（旧系统记录）</span><strong>{JST_GRANTED_ENDPOINT_COUNT}+</strong><small className="muted">页面确认的可用接口数，部分分类明细未补全</small></div>
        <div className="metric"><span className="muted">已实测只读接口（旧系统记录）</span><strong>{passed}</strong><small className="muted">新系统没有连接聚水潭，不会重新测试</small></div>
        <div className="metric"><span className="muted">建议首批同步任务</span><strong>{JST_SYNC_TASKS.length}</strong><small className="muted">先只读同步，再逐步开放写入</small></div>
        <div className="metric"><span className="muted">写入类接口策略</span><strong>出站队列 + 总开关</strong><small className="muted">默认关闭，留痕可停止</small></div>
      </div>

      <h2 className="section-title">新系统当前的对外同步状态</h2>
      {error && <div role="alert" className="notice error">{error} <button type="button" className="link-button" onClick={() => void load()}>重试</button></div>}
      {!data && !error && <p className="muted" role="status">正在读取…</p>}
      {data && (
        <div className="card" style={{ padding: 16 }}>
          <dl className="kv-grid">
            <div><dt>外部写入总开关</dt><dd><span className={`pill ${data.switch.enabled ? 'warn' : 'ok'}`}>{data.switch.enabled ? '已打开' : '已关闭（不会发送）'}</span></dd></div>
            <div><dt>基本售价同步开关</dt><dd><span className={`pill ${data.priceSwitch.enabled ? 'warn' : 'ok'}`}>{data.priceSwitch.enabled ? '已打开' : '已关闭'}</span></dd></div>
            <div><dt>聚水潭发送器</dt><dd><span className={`pill ${data.senderConfigured ? 'warn' : 'muted'}`}>{data.senderConfigured ? '已接入' : '未接入（队列只积压，不发送）'}</span></dd></div>
            <div><dt>队列任务</dt><dd>{total === 0 ? '没有任务' : Object.entries(data.counts).map(([k, n]) => `${STATUS_LABEL[k] ?? k} ${n}`).join(' · ')}</dd></div>
            <div><dt>最早排队时间</dt><dd>{fmt(data.oldestPendingAt)}</dd></div>
          </dl>
          {Object.keys(data.byKind).length > 0 && (
            <div className="table-scroll"><table className="data-table compact"><thead><tr><th>任务类型</th>{Object.keys(STATUS_LABEL).map((s) => <th key={s} className="num">{STATUS_LABEL[s]}</th>)}</tr></thead>
              <tbody>{Object.entries(data.byKind).map(([k, v]) => <tr key={k}><td>{JST_JOB_KIND_LABEL[k] ?? k}</td>{Object.keys(STATUS_LABEL).map((s) => <td key={s} className="num">{v[s] ?? 0}</td>)}</tr>)}</tbody></table></div>
          )}
          {data.failures.length > 0 && (
            <div><strong>最近失败</strong>
              <ul>{data.failures.map((f) => <li key={f.id}>{JST_JOB_KIND_LABEL[f.kind] ?? f.kind} · {f.resourceType} #{f.resourceId} · 已试 {f.attempts} 次 · {f.lastError ?? '未知原因'}</li>)}</ul>
            </div>
          )}
          <p className="muted">查看、重试、取消任务和开关操作在 <Link to="/finance/jst-maintenance">财务 → 资料维护 → 同步队列</Link>（需要对应权限，开关只有公司管理员能动）。</p>
        </div>
      )}

      <h2 className="section-title">同步能力地图</h2>
      <div className="card-grid jst-capability-grid">
        {JST_CAPABILITY_GROUPS.map((g) => (
          <section key={g.name} className="card" style={{ padding: 16 }} aria-label={g.name}>
            <div className="between"><strong>{g.name}</strong><span className={`pill ${g.status === 'active' ? 'ok' : 'warn'}`}>{g.status === 'active' ? '旧系统：已启用' : '旧系统：测试中'}</span></div>
            <p>{g.summary}</p>
            <dl className="kv-grid">
              <div><dt>系统用途</dt><dd>{g.systemUse}</dd></div>
              <div><dt>同步建议</dt><dd>{g.syncPlan}</dd></div>
              <div><dt>新系统现状</dt><dd><span className={`pill ${g.readiness === 'queue' ? 'warn' : 'muted'}`}>{JST_READINESS_LABEL[g.readiness]}</span> {g.newSystem}</dd></div>
            </dl>
            <div className="pill-row">{g.tested.map((e) => <code key={e}>{e}</code>)}</div>
          </section>
        ))}
      </div>

      <div className="two-col">
        <div>
          <div className="between"><h2 className="section-title">已完成接口实测（旧系统记录）</h2>
            <select aria-label="按模块筛选" value={mod} onChange={(e) => setMod(e.target.value)}><option value="">全部模块</option>{modules.map((m) => <option key={m} value={m}>{m}</option>)}</select></div>
          <div className="table-scroll"><table className="data-table"><thead><tr><th>模块</th><th>接口</th><th>结果</th><th>样本</th></tr></thead>
            <tbody>{tests.map((r) => <tr key={r.endpoint}><td>{r.module}</td><td><code>{r.endpoint}</code> <CopyButton value={r.endpoint} label="接口地址" /></td><td><span className={`pill ${r.result === '已测通' ? 'ok' : 'warn'}`}>{r.result}</span></td><td>{r.sample}</td></tr>)}</tbody></table></div>
        </div>
        <div>
          <h2 className="section-title">首批同步任务建议</h2>
          <div className="table-scroll"><table className="data-table"><thead><tr><th>任务</th><th>频率</th><th>落地模块</th><th>阶段</th></tr></thead>
            <tbody>{JST_SYNC_TASKS.map((t) => <tr key={t.name}><td><strong>{t.name}</strong></td><td>{t.frequency}</td><td>{t.target}</td><td><span className="pill muted">{t.level}</span></td></tr>)}</tbody></table></div>
        </div>
      </div>

      <h2 className="section-title">写入与同步保护规则</h2>
      <ul className="jst-rule-list">{JST_RULES.map((r) => <li key={r.title}><strong>{r.title}</strong>：{r.text}</li>)}</ul>
    </section>
  );
}

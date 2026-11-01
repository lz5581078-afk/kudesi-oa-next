import { useEffect, useState } from 'react';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { Pager, money } from '../common';
import { jstApi, type ArchiveJob, type CategoryPreview, type CategoryRun, type CategoryScope, type PriceLog, type PriceRow } from './jstApi';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');
const when = (s: string) => new Date(s).toLocaleString('zh-CN', { hour12: false });
const yuan = (c: number | null) => (c === null ? '—' : money(c));

/** 同步队列页下半部分：基本售价同步、归档任务、分类同步。都只是“排队”，真正发送受总开关控制。 */
export function JstSyncExtras({ onQueued }: { onQueued: () => void }) {
  const { user, can } = useAuth();
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const canBundles = can('finance.bundle-sync.manage');
  const [tab, setTab] = useState<'price' | 'archive' | 'category'>('price');
  if (!canBundles) return null;
  return (
    <section className="card">
      <div className="pill-row">
        {([['price', '基本售价同步'], ['archive', '归档任务'], ...(isAdmin ? [['category', '分类同步']] : [])] as Array<[typeof tab, string]>).map(([k, label]) => (
          <button key={k} type="button" className={`mode-button${tab === k ? ' active' : ''}`} aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'price' && <PriceSync isAdmin={isAdmin} onQueued={onQueued} />}
      {tab === 'archive' && <ArchiveJobs />}
      {tab === 'category' && isAdmin && <CategorySync onQueued={onQueued} />}
    </section>
  );
}

const PRICE_ACTION: Record<string, [string, string]> = { enqueue: ['可同步', 'ok'], blocked: ['被拦截', 'bad'], same: ['已是最新', 'muted'] };
const LOG_STATUS: Record<string, string> = { queued: '已入队', success: '已同步', confirming: '待回查确认', blocked: '被拦截', failed: '失败' };

function PriceSync({ isAdmin, onQueued }: { isAdmin: boolean; onQueued: () => void }) {
  const [sw, setSw] = useState<{ enabled: boolean } | null>(null);
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [logs, setLogs] = useState<{ total: number; rows: PriceLog[] } | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = async () => {
    try { setSw(await jstApi.priceSwitch()); setRows((await jstApi.pricePreview()).rows); setLogs(await jstApi.priceLogs(page)); } catch (e) { setError(msg(e)); }
  };
  useEffect(() => { void load(); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  async function toggle(on: boolean) {
    if (on && !window.confirm('打开后，成本表算出的最低售价会作为基本售价写入聚水潭组合装（只改价格，不动子商品）。需要同步总开关也打开才会真正发送。确定吗？')) return;
    try { setSw(await jstApi.setPriceSwitch(on)); } catch (e) { setError(msg(e)); }
  }
  async function run() {
    setError(''); setNotice('');
    try { const r = await jstApi.priceRun(); setNotice(`入队 ${r.queued} 个，被拦截 ${r.blocked} 个，已是最新 ${r.same} 个（每次最多 25 个）。`); await load(); onQueued(); } catch (e) { setError(msg(e)); }
  }
  return (
    <div>
      <p className="muted">把成本表的“最低售价”写成聚水潭组合装的基本售价。只处理已验证并已同步到聚水潭的组合；运费、利润率、成本不齐，或还有没发完的任务时会被拦截。</p>
      {error && <div role="alert" className="notice error">{error}</div>}
      {notice && <div role="status" className="notice ok">{notice}</div>}
      <div className={`notice ${sw?.enabled ? 'ok' : ''}`}>
        <strong>基本售价同步开关：{sw?.enabled ? '已打开' : '已关闭（默认）'}</strong>
        <div className="row-actions">
          {isAdmin && (sw?.enabled ? <button type="button" className="primary-button" onClick={() => void toggle(false)}>关闭基本售价同步</button> : <button type="button" className="secondary-button" onClick={() => void toggle(true)}>打开基本售价同步</button>)}
          <button type="button" className="secondary-button" disabled={!sw?.enabled} onClick={() => void run()}>现在同步一批（最多 25 个）</button>
        </div>
      </div>
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>组合</th><th>结果</th><th className="num">聚水潭现价</th><th className="num">最低售价</th><th>原因</th></tr></thead>
        <tbody>
          {rows?.length === 0 && <tr><td colSpan={5} className="muted center">没有已同步到聚水潭的已验证组合</td></tr>}
          {rows?.map((r) => (
            <tr key={r.bundleId}><td><strong>{r.code}</strong><div className="muted">{r.name}</div></td>
              <td><span className={`pill ${PRICE_ACTION[r.action][1]}`}>{PRICE_ACTION[r.action][0]}</span></td>
              <td className="num">{yuan(r.currentCents)}</td><td className="num">{yuan(r.priceCents)}</td><td className="bad-text">{r.reason}</td></tr>
          ))}
        </tbody>
      </table></div>
      <h3>售价同步日志</h3>
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>时间</th><th>组合</th><th>结果</th><th className="num">价格</th><th>说明</th></tr></thead>
        <tbody>
          {logs?.rows.length === 0 && <tr><td colSpan={5} className="muted center">还没有日志</td></tr>}
          {logs?.rows.map((l) => <tr key={l.id}><td>{when(l.createdAt)}</td><td>{l.bundleName ?? `#${l.bundleId}`}</td><td>{LOG_STATUS[l.status] ?? l.status}</td><td className="num">{yuan(l.priceCents)}</td><td>{l.message}</td></tr>)}
        </tbody>
      </table></div>
      <Pager page={page} total={logs?.total ?? 0} pageSize={20} onPage={setPage} />
    </div>
  );
}

const ARCHIVE_STATUS: Record<string, [string, string]> = { pending: ['等待禁用', 'warn'], confirming: ['等待回查', 'warn'], success: ['已禁用', 'ok'], failed: ['需要处理', 'bad'] };

export function ArchiveJobs() {
  const [rows, setRows] = useState<ArchiveJob[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => jstApi.archiveJobs().then((r) => setRows(r.rows)).catch((e) => setError(msg(e)));
  useEffect(() => { void load(); }, []);
  async function recheck(id: number) {
    setError(''); setNotice('');
    try { const r = await jstApi.recheckArchive(id); setNotice(r.message); await load(); } catch (e) { setError(msg(e)); }
  }
  return (
    <div>
      <p className="muted">归档过的、上传过聚水潭的组合：OA 先归档，再由队列到聚水潭停用。复查只读聚水潭，不会再写入任何东西。</p>
      {error && <div role="alert" className="notice error">{error}</div>}
      {notice && <div role="status" className="notice ok">{notice}</div>}
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>时间</th><th>组合</th><th>状态</th><th>说明</th><th /></tr></thead>
        <tbody>
          {rows?.length === 0 && <tr><td colSpan={5} className="muted center">没有归档任务</td></tr>}
          {rows?.map((j) => (
            <tr key={j.id}><td>{when(j.createdAt)}<div className="muted">{j.actorName}</div></td><td><strong>{j.code}</strong><div className="muted">{j.name}</div><div className="muted">原因：{j.reason}</div></td>
              <td><span className={`pill ${ARCHIVE_STATUS[j.status]?.[1] ?? 'warn'}`}>{ARCHIVE_STATUS[j.status]?.[0] ?? j.status}</span></td><td>{j.message}</td>
              <td>{['failed', 'confirming'].includes(j.status) && <button type="button" className="secondary-button small" onClick={() => void recheck(j.id)}>复查</button>}</td></tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}

const ACTION: Record<string, string> = { create: '新增', update: '修改', bind: '关联已有', disable: '停用', retire: '收尾', conflict: '冲突' };
const RUN_STATUS: Record<string, string> = { queued: '排队中', running: '发送中', success: '已完成', failed: '失败' };

function CategorySync({ onQueued }: { onQueued: () => void }) {
  const [scope, setScope] = useState<CategoryScope>('bundle');
  const [preview, setPreview] = useState<CategoryPreview | null>(null);
  const [runs, setRuns] = useState<CategoryRun[]>([]);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const loadRuns = () => jstApi.categoryRuns(1).then((r) => setRuns(r.rows)).catch((e) => setError(msg(e)));
  useEffect(() => { void loadRuns(); }, []);
  async function look() {
    setError(''); setNotice(''); setAck(false); setPreview(null);
    try { setPreview(await jstApi.categoryPreview(scope)); } catch (e) { setError(msg(e)); }
  }
  async function exec() {
    if (!preview) return;
    setError('');
    try { const r = await jstApi.categoryExecute(scope, preview.signature); setNotice(`已加入队列 ${r.queued} 项${r.retired ? `，收尾 ${r.retired} 项` : ''}。只是排队，总开关打开后才会发送。`); setPreview(null); await loadRuns(); onQueued(); } catch (e) { setError(msg(e)); }
  }
  return (
    <div>
      <p className="muted">把 OA 的分类单向同步到聚水潭（最多 4 级；删除 = 停用；同名分类不会自动认领）。先看差异，确认后才入队。</p>
      {error && <div role="alert" className="notice error">{error}</div>}
      {notice && <div role="status" className="notice ok">{notice}</div>}
      <div className="toolbar">
        <select aria-label="分类类型" value={scope} onChange={(e) => { setScope(e.target.value as CategoryScope); setPreview(null); }}><option value="bundle">组合分类</option><option value="product">商品分类</option></select>
        <button type="button" className="secondary-button" onClick={() => void look()}>查看差异</button>
      </div>
      {preview && (
        <div>
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th>分类</th><th>动作</th><th>说明</th></tr></thead>
            <tbody>
              {preview.changes.length === 0 && <tr><td colSpan={3} className="muted center">两边一致，没有需要同步的</td></tr>}
              {preview.changes.map((c) => <tr key={c.localId} className={c.action === 'conflict' ? 'selected' : undefined}><td>{c.path}</td><td><span className={`pill ${c.action === 'conflict' ? 'bad' : 'ok'}`}>{ACTION[c.action] ?? c.action}</span></td><td>{c.message}</td></tr>)}
            </tbody>
          </table></div>
          {preview.conflicts > 0 && <div className="notice error">有 {preview.conflicts} 项冲突，请先在 OA 或聚水潭处理后重新查看差异，冲突未解决不能同步。</div>}
          {preview.changes.length > 0 && (
            <div className="row-actions">
              <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> 我已核对以上差异</label>
              <button type="button" className="primary-button" disabled={!ack || preview.conflicts > 0} onClick={() => void exec()}>确认并加入队列</button>
            </div>
          )}
        </div>
      )}
      <h3>同步记录</h3>
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>时间</th><th>类型</th><th>状态</th><th>内容</th></tr></thead>
        <tbody>
          {runs.length === 0 && <tr><td colSpan={4} className="muted center">还没有记录</td></tr>}
          {runs.map((r) => <tr key={r.id}><td>{when(r.createdAt)}</td><td>{r.scope === 'bundle' ? '组合分类' : '商品分类'}</td><td>{RUN_STATUS[r.status] ?? r.status}</td><td>{r.changes.map((c) => `${ACTION[c.action] ?? c.action} ${c.path}`).join('；')}{r.changes.some((c) => c.error) && <div className="bad-text">{r.changes.find((c) => c.error)?.error}</div>}</td></tr>)}
        </tbody>
      </table></div>
    </div>
  );
}

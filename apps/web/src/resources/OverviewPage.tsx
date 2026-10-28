import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ASSET_LOG_LABELS, getResourceDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { recordLink } from './recordLink';
import { useAppbarBare } from '../layout/AppbarSlot';
import { resourceApi, type DataIssuesResult, type ExpiringResult, type OverviewResult, type RecentChange } from './api';

const PREVIEW = 5;
const ACTION_LABEL: Record<string, string> = { create: '新建', update: '修改', status: '改状态', delete: '删除', archived: '归档', restored: '恢复', ...ASSET_LOG_LABELS };

/** 一块数据：读取中 / 失败可重试 / 内容。三块数据各自加载，一块失败不影响其他块。 */
function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: '', loading: true });
  const run = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: '' }));
    fn().then((data) => setState({ data, error: '', loading: false })).catch((e) => setState({ data: null, error: e instanceof ApiError ? e.message : '加载失败', loading: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { ...state, reload: run };
}

function Block({ title, meta, state, children }: { title: React.ReactNode; meta?: React.ReactNode; state: { loading: boolean; error: string; data: unknown; reload: () => void }; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="card-foot between"><strong>{title}</strong>{meta}</div>
      {state.loading && !state.data && <p className="muted pad">加载中…</p>}
      {state.error && <div role="alert" className="notice error m">{state.error} <button type="button" className="link-button" onClick={state.reload}>重新读取</button></div>}
      {!state.error && state.data !== null && children}
    </section>
  );
}

function ChangeRow({ c }: { c: RecentChange }) {
  const link = recordLink(c.type, c.resourceId);
  return (
    <li className="line-item between">
      <span>
        <small className="muted">{new Date(c.createdAt).toLocaleString('zh-CN')}　{c.typeLabel}　</small>
        {link ? <Link to={link}>{c.name}</Link> : c.name}
        <strong>　{ACTION_LABEL[c.action] ?? c.action}</strong>
        {c.note && <small className="muted">　{c.note}</small>}
      </span>
      <small className="muted">{c.actor}</small>
    </li>
  );
}

export function ResourceOverviewPage() {
  useAppbarBare();
  const [days, setDays] = useState(30);
  const [expFilter, setExpFilter] = useState<'all' | 'expired' | 'due_soon'>('all');
  const [openExp, setOpenExp] = useState<Record<string, boolean>>({});
  const [openIssue, setOpenIssue] = useState<Record<string, boolean>>({});
  const counts = useLoad<OverviewResult>(() => resourceApi.overview(), []);
  const exp = useLoad<ExpiringResult>(() => resourceApi.expiring(days), [days]);
  const issues = useLoad<DataIssuesResult>(() => resourceApi.dataIssues(), []);
  const recent = useLoad<RecentChange[]>(() => resourceApi.recentChanges(), []);
  const busy = counts.loading || exp.loading || issues.loading || recent.loading;

  // 数量磁贴按资料菜单的分组排：同一类放一起，和左侧菜单一致
  const groups = useMemo(() => {
    const by = new Map<string, NonNullable<typeof counts.data>['items']>();
    for (const i of counts.data?.items ?? []) {
      const g = getResourceDef(i.type)?.nav?.group ?? '其他';
      by.set(g, [...(by.get(g) ?? []), i]);
    }
    return [...by.entries()];
  }, [counts.data]);

  const expGroups = useMemo(() => {
    const m = new Map<string, { label: string; rows: ExpiringResult['rows'] }>();
    for (const r of (exp.data?.rows ?? []).filter((x) => expFilter === 'all' || x.status === expFilter)) {
      const g = m.get(r.type) ?? { label: r.typeLabel, rows: [] };
      g.rows.push(r);
      m.set(r.type, g);
    }
    return [...m.entries()];
  }, [exp.data, expFilter]);
  const expired = exp.data?.counts.expired ?? 0;
  const soon = exp.data?.counts.dueSoon ?? 0;

  return (
    <div className="stack">
      <div className="res-ov-bar">
        <span className="muted">各类资料数量、到期提醒、需要补充或核对的数据和最近的修改；点任意一项直达对应资料。</span>
        <button type="button" className="res-btn" disabled={busy} onClick={() => { counts.reload(); exp.reload(); issues.reload(); recent.reload(); }}>{busy ? '读取中…' : '刷新'}</button>
      </div>

      <Block title="资料数量" state={counts}>
        {groups.map(([group, items]) => (
          <div key={group} className="pad">
            <h2 className="section-title">{group}</h2>
            <div className="stats">
              {items.map((i) => (
                <Link key={i.type} to={`/resource/${i.type}`} className="card stat link-card">
                  <span className="muted">{i.label}</span>
                  <strong>{i.total}</strong>
                  {i.abnormal > 0 ? <span className="pill warn">异常 {i.abnormal}</span> : <span className="muted">无异常</span>}
                  {((i.inactive ?? 0) > 0 || (i.archived ?? 0) > 0) && <small className="muted">{[(i.inactive ?? 0) > 0 ? `停用/注销 ${i.inactive}` : '', (i.archived ?? 0) > 0 ? `已归档 ${i.archived}` : ''].filter(Boolean).join(' · ')}</small>}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </Block>

      <Block
        title={`即将到期 / 已过期${exp.data ? `（已过期 ${expired}，${days} 天内到期 ${soon}）` : ''}`}
        state={exp}
        meta={(
          <span className="pill-row">
            {([['all', `全部 ${expired + soon}`], ['expired', `已过期 ${expired}`], ['due_soon', `${days} 天内到期 ${soon}`]] as const).map(([k, l]) => (
              <button key={k} type="button" aria-pressed={expFilter === k} className={expFilter === k ? 'chip active' : 'chip'} onClick={() => setExpFilter(k)}>{l}</button>
            ))}
            <select aria-label="提前天数" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 30, 60, 90, 180, 366].map((d) => <option key={d} value={d}>{d} 天内</option>)}
            </select>
          </span>
        )}
      >
        {expGroups.length === 0 && <p className="muted pad">{expFilter === 'expired' ? '没有已过期的资料' : `${days} 天内没有到期的资料`}。营业执照年审、资质、商标、手机号充值、店铺授权、软件续费等到期事项都会出现在这里。</p>}
        {expGroups.map(([type, g]) => (
          <div key={type} className="pad">
            <h3 className="section-title">{g.label} <span className="pill">{g.rows.length}</span></h3>
            <table className="data-table">
              <thead><tr><th>名称</th><th>事项</th><th>日期</th><th>剩余</th></tr></thead>
              <tbody>
                {(openExp[type] ? g.rows : g.rows.slice(0, PREVIEW)).map((a) => (
                  <tr key={`${a.type}-${a.id}-${a.field}`}>
                    <td>{recordLink(a.type, a.id) ? <Link to={recordLink(a.type, a.id)!}>{a.name}</Link> : a.name}</td>
                    <td>{a.fieldLabel}</td>
                    <td>{a.dueDate}</td>
                    <td>{a.daysLeft < 0 ? <span className="pill bad">已过 {-a.daysLeft} 天</span> : <span className="pill warn">{a.daysLeft === 0 ? '今天到期' : `${a.daysLeft} 天`}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {g.rows.length > PREVIEW && <button type="button" className="link-button" onClick={() => setOpenExp((o) => ({ ...o, [type]: !o[type] }))}>{openExp[type] ? '收起' : `展开全部 ${g.rows.length} 条`}</button>}
          </div>
        ))}
      </Block>

      <Block title="数据问题" state={issues} meta={issues.data ? <span className="muted">共 {issues.data.total} 处，只读检查，改好资料后自动消失</span> : null}>
        {(issues.data?.groups ?? []).map((g) => {
          const open = Boolean(openIssue[g.key]);
          const rows = open ? g.rows : g.rows.slice(0, PREVIEW);
          return (
            <div key={g.key} className="pad" aria-label={`数据问题：${g.label}`}>
              <h3 className="section-title">{g.label} <span className={g.count ? 'pill warn' : 'pill'}>{g.count}</span></h3>
              <p className="muted">{g.count ? g.description : '没有发现这类问题。'}</p>
              {rows.length > 0 && (
                <ul className="plain-list">
                  {rows.map((r, i) => (
                    <li key={`${r.id}-${i}`}>{recordLink(r.type, r.id) ? <Link to={recordLink(r.type, r.id)!}>{r.name}</Link> : r.name}{r.detail ? <span className="muted">　{r.detail}</span> : null}{g.key.endsWith('_phone_text_unlinked') && <> <CreatePhoneButton type={r.type} id={r.id} onDone={issues.reload} /></>}</li>
                  ))}
                </ul>
              )}
              {g.rows.length > PREVIEW && <button type="button" className="link-button" onClick={() => setOpenIssue((o) => ({ ...o, [g.key]: !open }))}>{open ? '收起' : g.count > g.rows.length ? `展开最近 ${g.rows.length} 条（共 ${g.count} 条）` : `展开全部 ${g.rows.length} 条`}</button>}
              {open && g.count > g.rows.length && <p className="muted">只列出最近的 {g.rows.length} 条，到对应页面可以看到全部。</p>}
            </div>
          );
        })}
      </Block>

      <Block title="最近变更" state={recent} meta={<span className="muted">本公司最近 40 条资料修改</span>}>
        {(recent.data ?? []).length === 0 ? <p className="muted pad">还没有变更记录。新增、修改、停用、归档资料后会显示在这里。</p> : <ol className="plain-list pad">{recent.data!.map((c) => <ChangeRow key={c.id} c={c} />)}</ol>}
      </Block>
    </div>
  );
}

/** 数据问题里的“未建档手机号”：一键建立手机号档案并绑定（同号码已有档案就只绑定）。 */
export function CreatePhoneButton({ type, id, onDone }: { type: string; id: number; onDone: () => void }) {
  const [state, setState] = useState<{ busy: boolean; error: string; done: string }>({ busy: false, error: '', done: '' });
  if (state.done) return <span className="muted">{state.done}</span>;
  return (
    <>
      <button type="button" className="link-button" disabled={state.busy} onClick={async () => {
        setState({ busy: true, error: '', done: '' });
        try {
          const r = await resourceApi.createPhone(type, id);
          setState({ busy: false, error: '', done: r.created ? `已建立 ${r.number} 并绑定` : `已绑定 ${r.number}` });
          onDone();
        } catch (e) { setState({ busy: false, error: e instanceof ApiError ? e.message : '建档失败', done: '' }); }
      }}>{state.busy ? '正在建立…' : '建立手机号档案并绑定'}</button>
      {state.error && <span role="alert" className="bad-text"> {state.error}</span>}
    </>
  );
}

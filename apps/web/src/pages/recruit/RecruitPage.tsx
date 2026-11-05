import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RECRUIT_FIELD_LABELS, SPECIAL_PERMISSIONS } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { qrMatrix, qrSvgPath } from '../../lib/qr';
import { RecruitOpenings } from './RecruitOpenings';
import { recruitApi, type RecruitDetail, type RecruitInvite, type RecruitRow, type RecruitStats } from './recruitApi';
import { RecruitPrintSheet } from './RecruitPrintSheet';
import './recruit.css';

const EVENT_LABELS: Record<string, string> = { submitted: '提交了登记表', claimed: '认领跟进', printed: '打印了资料', id_view: '查看了身份证号' };
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '');
/** 只打印指定内容：打印期间给 body 加标记，打印样式据此隐藏其余页面 */
function printOnly(card?: HTMLElement | null) {
  document.body.classList.add('recruit-printing');
  card?.classList.add('printing');
  const done = () => { document.body.classList.remove('recruit-printing'); card?.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}
const errText = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');

function InvitePanel() {
  const { can } = useAuth();
  const canManage = can(SPECIAL_PERMISSIONS.recruitManage);
  const [rows, setRows] = useState<RecruitInvite[]>([]);
  const [label, setLabel] = useState(''), [channel, setChannel] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(() => recruitApi.invites().then(setRows).catch((e) => setError(errText(e))), []);
  useEffect(() => { void load(); }, [load]);
  const create = async () => {
    if (!label.trim() || busy) return;
    setBusy(true); setError('');
    try { await recruitApi.createInvite({ label: label.trim(), ...(channel.trim() ? { channel: channel.trim() } : {}) }); setLabel(''); setChannel(''); await load(); }
    catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  return (
    <section className="card recruit-invites">
      {error && <div className="notice error" role="alert">{error}</div>}
      {canManage && (
        <div className="toolbar">
          <input aria-label="二维码名称" placeholder="二维码名称，如 门店张贴 / 招聘网站" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
          <input aria-label="默认应聘渠道" placeholder="默认应聘渠道（可不填）" value={channel} maxLength={40} onChange={(e) => setChannel(e.target.value)} />
          <button className="primary" disabled={busy || !label.trim()} onClick={() => void create()}>生成招聘二维码</button>
        </div>
      )}
      {rows.length === 0 && <p className="muted">还没有招聘二维码。</p>}
      <div className="recruit-qr-list">
        {rows.map((r) => {
          const link = r.token ? `${window.location.origin}/apply#${r.token}` : '';
          const graphic = link ? qrSvgPath(qrMatrix(link)) : null;
          return (
            <article key={r.id} className={`recruit-qr${r.revokedAt ? ' revoked' : ''}`}>
              {graphic && <svg width="180" height="180" role="img" aria-label={`${r.label} 招聘二维码`} viewBox={`0 0 ${graphic.size} ${graphic.size}`}><rect width="100%" height="100%" fill="white" /><path d={graphic.path} fill="#111827" /></svg>}
              <div>
                <strong>{r.label}</strong>
                <small>{r.revokedAt ? '已停用' : '使用中'} · 已收到 {r.applicationCount} 份 · {r.creatorName} 创建于 {fmt(r.createdAt)}{r.channel ? ` · 默认渠道：${r.channel}` : ''}</small>
                {link && <div className="recruit-qr-actions">
                  <button onClick={() => void navigator.clipboard?.writeText(link)}>复制链接</button>
                  <button onClick={(e) => printOnly(e.currentTarget.closest<HTMLElement>('.recruit-qr'))}>打印二维码</button>
                  {canManage && <button className="danger" onClick={() => { if (window.confirm('停用后，已张贴的这个二维码将无法再填写，确定停用？')) void recruitApi.revokeInvite(r.id).then(load).catch((e) => setError(errText(e))); }}>停用</button>}
                </div>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Detail({ id, onChanged, onClose }: { id: number; onChanged: () => void; onClose: () => void }) {
  const { can, user } = useAuth();
  const [detail, setDetail] = useState<RecruitDetail | null>(null);
  const [idNo, setIdNo] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => recruitApi.get(id).then(setDetail).catch((e) => setError(errText(e))), [id]);
  useEffect(() => { setIdNo(null); setDetail(null); void load(); }, [load]);
  if (!detail) return <section className="card">{error ? <div className="notice error">{error}</div> : <p className="muted">加载中…</p>}</section>;
  const L = RECRUIT_FIELD_LABELS;
  const form = { ...detail.form, idNo: idNo ?? detail.form.idNo };
  const canManage = can(SPECIAL_PERMISSIONS.recruitManage);
  const act = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await load(); onChanged(); } catch (e) { setError(errText(e)); } };
  const print = async () => {
    setError('');
    try {
      let withId = false;
      if (detail.canViewId && idNo === null) { setIdNo((await recruitApi.revealId(id, 'print')).idNo); withId = true; } else withId = idNo !== null;
      await recruitApi.recordPrint(id, withId);
      setTimeout(() => printOnly(), 80);
      onChanged(); void load();
    } catch (e) { setError(errText(e)); }
  };
  const rows: Array<[string, string]> = [
    [L.name, form.name], [L.gender, form.gender], [L.ethnicity, form.ethnicity], [L.birthDate, form.birthDate], [L.marital, form.marital], [L.phone, form.phone],
    ['应聘岗位', detail.openingTitle], [L.education, form.education], [L.school, form.school], [L.graduationDate, form.graduationDate], [L.expectedSalary, form.expectedSalary], [L.sourceChannel, form.sourceChannel],
  ];
  return (
    <section className="card recruit-detail">
      <div className="toolbar">
        <button onClick={onClose}>← 返回列表</button>
        {canManage && detail.handlerId === null && <button className="primary" onClick={() => void act(() => recruitApi.claim(id))}>我来跟进</button>}
        <button className="primary" onClick={() => void print()}>打印面试资料</button>
        <span className="muted">{detail.handlerName ? `跟进人事：${detail.handlerName}（${fmt(detail.handledAt)}）` : '还没有人事认领'}{detail.handlerId === user?.id ? ' · 就是你' : ''}</span>
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      <dl className="recruit-dl">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || '—'}</dd></div>)}
        <div><dt>{L.idNo}</dt><dd>{form.idNo}{detail.canViewId && idNo === null && <button className="link" onClick={() => void recruitApi.revealId(id, 'view').then((r) => { setIdNo(r.idNo); void load(); }).catch((e) => setError(errText(e)))}>查看明文（会留下记录）</button>}</dd></div>
      </dl>
      {([[L.educationHistory, form.educationHistory], [L.workHistory, form.workHistory]] as const).map(([title, list]) => (
        <div key={title}><h3>{title}</h3>{list.length === 0 ? <p className="muted">未填写</p> : <ul className="recruit-history-view">{list.map((r, i) => <li key={i}><strong>{r.period}</strong> {r.org} {r.title}{r.note && <p>{r.note}</p>}</li>)}</ul>}</div>
      ))}
      <h3>{L.achievements}</h3><p className="recruit-text">{form.achievements || '未填写'}</p>
      <h3>{L.selfEvaluation}</h3><p className="recruit-text">{form.selfEvaluation || '未填写'}</p>
      <h3>处理记录</h3>
      <ul className="recruit-events">{detail.events.map((e) => <li key={e.id}>{fmt(e.createdAt)} · {e.actorName} {EVENT_LABELS[e.type] ?? e.type}</li>)}</ul>
      <RecruitPrintSheet detail={detail} form={form} company={user?.companyName ?? ''} />
    </section>
  );
}

function Applications({ openId, onOpen }: { openId: number | null; onOpen: (id: number | null) => void }) {
  const [rows, setRows] = useState<RecruitRow[]>([]), [total, setTotal] = useState(0), [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState(''), [handler, setHandler] = useState('any');
  const [stats, setStats] = useState<RecruitStats | null>(null), [error, setError] = useState('');
  const load = useCallback(() => {
    recruitApi.list({ keyword, handler, page }).then((r) => { setRows(r.rows); setTotal(r.total); }).catch((e) => setError(errText(e)));
    recruitApi.stats().then(setStats).catch(() => undefined);
  }, [keyword, handler, page]);
  useEffect(() => { void load(); }, [load]);
  const pages = useMemo(() => Math.max(1, Math.ceil(total / 30)), [total]);
  if (openId !== null) return <Detail id={openId} onChanged={load} onClose={() => onOpen(null)} />;
  return (
    <section className="card">
      {stats && <p className="recruit-stats">共 {stats.total} 份登记，{stats.unclaimed} 份还没人认领。{stats.handlers.length > 0 && <>人事跟进：{stats.handlers.map((h) => `${h.name} 认领 ${h.claimed}、打印 ${h.printed}`).join('；')}</>}</p>}
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="toolbar">
        <input aria-label="搜索" placeholder="姓名或手机号" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
        <select aria-label="跟进筛选" value={handler} onChange={(e) => { setHandler(e.target.value); setPage(1); }}>
          <option value="any">全部</option><option value="none">还没人认领</option><option value="mine">我在跟进</option>
        </select>
      </div>
      <table className="data-table cards-narrow">
        <thead><tr><th>登记时间</th><th>姓名</th><th>应聘岗位</th><th>学历/院校</th><th>期望薪资</th><th>手机号</th><th>渠道</th><th>跟进人事</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-label="登记时间">{fmt(r.createdAt)}</td>
              <td data-label="姓名">{r.name}（{r.gender}）{r.samePhoneCount > 1 && <span className="tag warn"> 重复登记 {r.samePhoneCount} 次</span>}</td>
              <td data-label="应聘岗位">{r.openingTitle || '—'}</td>
              <td data-label="学历/院校">{r.education}{r.school ? ` · ${r.school}` : ''}</td>
              <td data-label="期望薪资">{r.expectedSalary ?? '—'}</td>
              <td data-label="手机号">{r.phone}</td>
              <td data-label="渠道">{r.sourceChannel}</td>
              <td data-label="跟进人事">{r.handlerName ?? <span className="muted">未认领</span>}</td>
              <td><button onClick={() => onOpen(r.id)}>查看 / 打印</button></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={9} className="muted">还没有登记。到“招聘二维码”生成二维码，让求职者扫码填写。</td></tr>}
        </tbody>
      </table>
      {pages > 1 && <div className="toolbar"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span>{page} / {pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button></div>}
    </section>
  );
}

export function RecruitPage() {
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get('id')) || null;
  const [tab, setTab] = useState<'applications' | 'openings' | 'invites'>('applications');
  return (
    <div className="recruit-page">
      <div className="page-head"><h1>招聘管理</h1></div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'applications'} className={tab === 'applications' ? 'active' : ''} onClick={() => setTab('applications')}>求职者登记</button>
        <button role="tab" aria-selected={tab === 'openings'} className={tab === 'openings' ? 'active' : ''} onClick={() => setTab('openings')}>招聘岗位</button>
        <button role="tab" aria-selected={tab === 'invites'} className={tab === 'invites' ? 'active' : ''} onClick={() => setTab('invites')}>招聘二维码</button>
      </div>
      {tab === 'applications'
        ? <Applications openId={openId} onOpen={(id) => setParams(id === null ? {} : { id: String(id) })} />
        : tab === 'openings' ? <RecruitOpenings /> : <InvitePanel />}
    </div>
  );
}

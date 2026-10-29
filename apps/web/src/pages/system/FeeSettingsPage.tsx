import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { nextRechargeDate, todayShanghai, type LedgerBroadbandRow, type LedgerFocus, type LedgerPhoneRow, type LedgerResult, type LedgerSort, type LedgerView } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { AppbarHint, useAppbarBare, useHasAppbarSlot } from '../../layout/AppbarSlot';
import { SearchGlyph } from '../../resources/ResIcons';
import { PageHint } from '../../resources/PageHint';
import { useResourceCan } from '../../resources/useResourceCan';
import { Pager } from '../finance/common';
import { BroadbandView } from './fee/BroadbandView';
import { EditDialog } from './fee/EditDialog';
import { MainCardView, AllNumbersView, type PhoneActions } from './fee/PhoneViews';
import { SummaryBar } from './fee/SummaryBar';
import { feeApi, type RowEdit, type SaveOutcome } from './fee/feeApi';
import { yuan } from './fee/format';
import type { Change } from './fee/batch';
import './fee/fee.css';

const HINT = '通信费用台账：哪些号是主卡、各挂哪些子卡；每张卡多少钱、多久充一次、下次什么时候充；宽带多少钱、绑在哪个号上、用在哪个区域。数据就是手机号和宽带账号资料本身，这里改的和资料里改的是同一份，操作记录里会写“费用模块”。';
const PAGE_SIZE = 20;

const TABS: Array<{ key: LedgerView; label: string }> = [
  { key: 'main', label: '按主卡' },
  { key: 'all', label: '全部号码' },
  { key: 'broadband', label: '宽带' },
];
const CHIPS: Record<LedgerView, Array<{ key: LedgerFocus | ''; label: string }>> = {
  main: [{ key: '', label: '全部' }, { key: 'soon', label: '7 天内要充' }, { key: 'overdue', label: '逾期' }, { key: 'nofee', label: '未设费用' }, { key: 'standalone', label: '独立号码' }],
  all: [{ key: '', label: '全部' }, { key: 'main', label: '主卡' }, { key: 'sub', label: '子卡' }, { key: 'soon', label: '需充值' }, { key: 'overdue', label: '逾期' }, { key: 'nofee', label: '未设费用' }, { key: 'standalone', label: '独立号码' }],
  broadband: [{ key: '', label: '全部' }, { key: 'unbound', label: '未绑定手机号' }, { key: 'expiring', label: '30 天内到期' }, { key: 'expired', label: '已到期' }, { key: 'nofee', label: '未设费用' }],
};
const asView = (v: string | null): LedgerView => (v === 'all' || v === 'broadband' ? v : 'main');

/**
 * 费用模块 = 通信费用台账。不另存数据：手机号费用来自手机号资料，宽带费用来自宽带资料；
 * 列表和汇总由服务端聚合（手机号很多），这里只负责显示和就地修改——修改走资料自己的保存通道。
 */
export function FeeSettingsPage() {
  const [params] = useSearchParams();
  const [view, setView] = useState<LedgerView>(asView(params.get('tab')));
  const [focus, setFocus] = useState<LedgerFocus | ''>((params.get('focus') as LedgerFocus | null) ?? '');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [qLive, setQLive] = useState(params.get('q') ?? '');
  const [carrier, setCarrier] = useState('');
  const [who, setWho] = useState('');
  const [area, setArea] = useState<number | null>(null);
  const [sort, setSort] = useState<LedgerSort | undefined>(undefined);
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LedgerResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [phonePick, setPhonePick] = useState<Map<number, LedgerPhoneRow>>(new Map());
  const [bbPick, setBbPick] = useState<Map<number, LedgerBroadbandRow>>(new Map());
  const [editing, setEditing] = useState<{ kind: 'phones'; rows: LedgerPhoneRow[] } | { kind: 'broadband'; rows: LedgerBroadbandRow[] } | null>(null);
  const hasAppbar = useHasAppbarSlot();
  useAppbarBare();
  const canPhone = useResourceCan('phones');
  const canBroadband = useResourceCan('broadband');
  const reqId = useRef(0);

  useEffect(() => { const t = setTimeout(() => { setQLive(q); setPage(1); }, 250); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const r = await feeApi.ledger({ view, q: qLive, focus, carrier, user: who, location: area, sort, dir, page, pageSize: PAGE_SIZE });
      if (id !== reqId.current) return;
      setData(r);
      setError('');
    } catch (e) {
      if (id === reqId.current) setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [view, qLive, focus, carrier, who, area, sort, dir, page]);
  useEffect(() => { void load(); }, [load]);

  const go = (v: LedgerView, f: LedgerFocus | '' = '') => {
    setView(v); setFocus(f); setPage(1); setCarrier(''); setWho(''); setArea(null); setSort(undefined); setDir('asc'); setPhonePick(new Map()); setBbPick(new Map());
  };
  const onSort = (k: LedgerSort) => { if (sort === k) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(k); setDir('asc'); } setPage(1); };

  const report = (o: SaveOutcome, noun: string) => {
    if (o.failed.length) {
      const first = o.failed.slice(0, 3).map((f) => `${f.title}：${f.conflict ? '刚被别人修改过，请刷新后再改' : f.message}`).join('；');
      setNotice({ tone: 'error', text: `已保存 ${o.done} 条${noun}，${o.failed.length} 条没保存：${first}` });
    } else setNotice({ tone: 'ok', text: `已保存 ${o.done} 条，已同步到${noun}档案，操作记录里可以看到。` });
  };
  const saveChanges = async (type: 'phones' | 'broadband', changes: Change[]) => {
    const outcome = await feeApi.save(type, changes.map((c) => c.edit));
    report(outcome, type === 'phones' ? '手机号' : '宽带账号');
    if (!outcome.failed.length) { setEditing(null); setPhonePick(new Map()); setBbPick(new Map()); }
    await load();
  };

  const today = todayShanghai();
  const recharge = async (rows: LedgerPhoneRow[]) => {
    const first = rows[0];
    const next = nextRechargeDate({ lastRechargeAt: today, rechargeCycleDays: first.cycleDays });
    const text = rows.length === 1 ? `${first.number}：最后充值日记为 ${today}，下次充值日更新为 ${next}。` : `${rows.length} 张号码的最后充值日都记为 ${today}，下次充值日按各自的充值周期推算。`;
    if (!window.confirm(text)) return;
    const edits: RowEdit[] = rows.map((r) => ({ id: r.id, version: r.version, title: r.number, data: { lastRechargeAt: today } }));
    report(await feeApi.save('phones', edits), '手机号');
    setPhonePick(new Map());
    await load();
  };
  const bind = async (row: LedgerPhoneRow, parentId: number) => {
    report(await feeApi.save('phones', [{ id: row.id, version: row.version, title: row.number, data: { parentPhoneId: parentId } }]), '手机号');
    await load();
  };

  const phoneActions: PhoneActions = {
    canEdit: canPhone('edit'),
    canSeeFees: Boolean(data?.canSeeFees),
    checked: phonePick,
    onCheck: (r, on) => setPhonePick((m) => { const n = new Map(m); if (on) n.set(r.id, r); else n.delete(r.id); return n; }),
    onEdit: (r) => setEditing({ kind: 'phones', rows: [r] }),
    onRecharge: (r) => void recharge([r]),
    onBind: bind,
  };
  const bbActions = {
    canEdit: canBroadband('edit'),
    canSeeFees: Boolean(data?.canSeeFees),
    checked: bbPick,
    onCheck: (r: LedgerBroadbandRow, on: boolean) => setBbPick((m) => { const n = new Map(m); if (on) n.set(r.id, r); else n.delete(r.id); return n; }),
    onEdit: (r: LedgerBroadbandRow) => setEditing({ kind: 'broadband', rows: [r] }),
  };

  const visiblePhones = useMemo(() => (data?.view === 'main' ? (data.groups ?? []).flatMap((g) => [g.main, ...(expanded.has(g.main.id) ? g.children : [])]) : data?.rows ?? []), [data, expanded]);
  const picked = view === 'broadband' ? bbPick.size : phonePick.size;
  const toggleAll = (on: boolean) => {
    if (view === 'broadband') setBbPick((m) => { const n = new Map(m); for (const r of data?.broadband ?? []) { if (on) n.set(r.id, r); else n.delete(r.id); } return n; });
    else setPhonePick((m) => { const n = new Map(m); for (const r of visiblePhones) { if (on) n.set(r.id, r); else n.delete(r.id); } return n; });
  };
  const allExpanded = data?.groups ? data.groups.filter((g) => g.children.length).every((g) => expanded.has(g.main.id)) : false;
  const hint = <PageHint text={HINT} />;
  const filtered = Boolean(qLive || carrier || who || area || focus);

  return (
    <section className="fee-page res-page">
      {hasAppbar && <AppbarHint>{hint}</AppbarHint>}
      {error && <div role="alert" className="notice error">{error}</div>}
      {notice && <div role={notice.tone === 'error' ? 'alert' : 'status'} className={notice.tone === 'error' ? 'notice error' : 'notice ok-notice'}>{notice.text}<button type="button" className="fee-x" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button></div>}
      {data && <SummaryBar s={data.summary} canSeeFees={data.canSeeFees} current={{ view, focus }} onPick={(p) => go(p.view, p.focus)} />}

      <div className="res-main fee-main-card">
        <div className="fee-tabrow">
        <div className="res-tabs fee-tabs" role="tablist">
          {TABS.filter((t) => t.key !== 'broadband' || data?.canSeeBroadband !== false).map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={view === t.key} className={view === t.key ? 'res-tab on' : 'res-tab'} onClick={() => go(t.key)}>
              {t.label}
              {data && t.key === 'main' && <i>{data.summary.mainCount}</i>}
              {data && t.key === 'all' && <i>{data.summary.mainCount + data.summary.subCount}</i>}
              {data && t.key === 'broadband' && data.summary.broadbandCount !== null && <i>{data.summary.broadbandCount}</i>}
            </button>
          ))}
        </div>
        {!hasAppbar && <span className="fee-hint-inline">{hint}</span>}
        </div>
        <div className="res-bar fee-bar">
          <label className="res-search">
            <SearchGlyph />
            <input aria-label="搜索" placeholder={view === 'broadband' ? '搜索宽带账号、区域、手机号' : '搜索号码、套餐、使用人'} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="fee-chips" role="group" aria-label="快捷筛选">
            {CHIPS[view].map((c) => (
              <button key={c.key || 'all'} type="button" className={focus === c.key ? 'fee-chip on' : 'fee-chip'} aria-pressed={focus === c.key} onClick={() => { setFocus(c.key); setPage(1); }}>{c.label}</button>
            ))}
          </div>
          {view !== 'broadband' ? (
            <>
              <select aria-label="运营商" value={carrier} onChange={(e) => { setCarrier(e.target.value); setPage(1); }}>
                <option value="">全部运营商</option>
                {data?.carriers.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select aria-label="使用人" value={who} onChange={(e) => { setWho(e.target.value); setPage(1); }}>
                <option value="">全部使用人</option>
                {data?.users.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </>
          ) : (
            <select aria-label="使用区域" value={area ?? ''} onChange={(e) => { setArea(e.target.value ? Number(e.target.value) : null); setPage(1); }}>
              <option value="">全部区域</option>
              {data?.areas?.map((a) => <option key={a.id} value={a.id}>{a.path}（{a.count}）</option>)}
            </select>
          )}
          <span className="res-bar-gap" />
          {view === 'main' && <button type="button" className="res-btn" onClick={() => setExpanded(allExpanded ? new Set() : new Set((data?.groups ?? []).map((g) => g.main.id)))}>{allExpanded ? '折叠全部' : '展开全部'}</button>}
          <label className="check-line fee-all"><input type="checkbox" aria-label="全选本页" onChange={(e) => toggleAll(e.target.checked)} /><span className="fee-all-t">全选本页</span></label>
        </div>

        {picked > 0 && (
          <div className="fee-batch" role="region" aria-label="批量操作">
            <strong>已选 {picked} {view === 'broadband' ? '条宽带' : '张号码'}</strong>
            {view === 'broadband'
              ? bbActions.canEdit && <button type="button" className="res-btn" onClick={() => setEditing({ kind: 'broadband', rows: [...bbPick.values()] })}>批量修改…</button>
              : phoneActions.canEdit && (
                <>
                  <button type="button" className="res-btn" onClick={() => setEditing({ kind: 'phones', rows: [...phonePick.values()] })}>批量修改…</button>
                  <button type="button" className="res-btn" onClick={() => void recharge([...phonePick.values()])}>记录充值</button>
                </>
              )}
            <button type="button" className="res-btn" onClick={() => { setPhonePick(new Map()); setBbPick(new Map()); }}>清除选择</button>
          </div>
        )}

        <div className="res-table-scroll fee-scroll">
          {!data && !error && <div className="res-loading" role="status">加载中…</div>}
          {data && view === 'main' && <MainCardView groups={data.groups ?? []} orphans={data.orphans ?? []} a={phoneActions} expanded={expanded} onToggle={(id) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })} onBindOrphan={bind} />}
          {data && view === 'all' && <AllNumbersView rows={data.rows ?? []} a={phoneActions} sort={sort ?? 'next'} dir={dir} onSort={onSort} />}
          {data && view === 'broadband' && <BroadbandView rows={data.broadband ?? []} a={bbActions} sort={sort ?? 'carrier'} dir={dir} onSort={onSort} />}
        </div>
        <div className="fee-foot">
          <span className="muted">
            {data && filtered ? `符合条件 ${data.total} ${view === 'main' ? '张主卡' : view === 'all' ? '张号码' : '条宽带'}` : ''}
            {data?.filteredMonthlyCents !== undefined ? `${filtered ? ' · ' : ''}折合月均 ${yuan(data.filteredMonthlyCents)}${view === 'broadband' ? '（宽带单独汇总，不含手机）' : ''}` : ''}
          </span>
          <Pager page={page} total={data?.total ?? 0} pageSize={PAGE_SIZE} onPage={setPage} />
        </div>
      </div>

      {editing?.kind === 'phones' && <EditDialog kind="phones" rows={editing.rows} canSeeFees={Boolean(data?.canSeeFees)} onClose={() => setEditing(null)} onSave={(c) => saveChanges('phones', c)} />}
      {editing?.kind === 'broadband' && <EditDialog kind="broadband" rows={editing.rows} canSeeFees={Boolean(data?.canSeeFees)} onClose={() => setEditing(null)} onSave={(c) => saveChanges('broadband', c)} />}
    </section>
  );
}

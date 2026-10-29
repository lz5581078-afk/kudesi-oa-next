import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { DocDetail } from './DocDetail';
import { money } from './common';
import { CopyButton, DateChips, plainYuan } from './fin-ui';
import { financeApi, type SettlementRow, type UnsettledRow } from './financeApi';
import { ExportButton, Field, FilterBar, GroupSwitch, QueryPage, QueryPanel, QueryTable, SummaryCards, stamp, type Col } from './query/QueryKit';

interface F { from: string; to: string; docType: string; keyword: string }
const EMPTY: F = { from: '', to: '', docType: '', keyword: '' };
const has = (text: string, kw: string) => kw.trim().split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w.toLowerCase()));

/** 两张收付款查询表共用的取数/筛选逻辑：日期、单据类型由服务器筛，关键词在已取回的结果里本地筛。 */
function useQuery<R>(fetcher: (p: { from?: string; to?: string; docType?: string }) => Promise<R[]>, text: (r: R) => string) {
  const [draft, setDraft] = useState<F>(EMPTY);
  const [applied, setApplied] = useState<F>(EMPTY);
  const [all, setAll] = useState<R[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<Date | null>(null);
  const load = useCallback((f: F) => {
    setError(''); setBusy(true);
    fetcher({ from: f.from || undefined, to: f.to || undefined, docType: f.docType || undefined })
      .then((r) => { setAll(r); setAt(new Date()); })
      .catch((e) => { setAll([]); setError(e instanceof ApiError ? e.message : '加载失败'); })
      .finally(() => setBusy(false));
  }, [fetcher]);
  useEffect(() => { load(EMPTY); }, [load]);
  const rows = all === null ? null : all.filter((r) => !applied.keyword.trim() || has(text(r), applied.keyword));
  return {
    draft, setDraft, applied, rows, error, busy, at,
    query: () => { setApplied(draft); load(draft); },
    reset: () => { setDraft(EMPTY); setApplied(EMPTY); load(EMPTY); },
    refresh: () => load(applied),
    filtered: !!(applied.from || applied.to || applied.docType || applied.keyword.trim()),
  };
}

function Filters({ q, placeholder }: { q: ReturnType<typeof useQuery<never>>; placeholder: string }) {
  const { draft, setDraft } = q;
  return (
    <FilterBar onQuery={q.query} onReset={q.reset} busy={q.busy}>
      <Field label="关键词" wide><input type="search" aria-label="关键词" placeholder={placeholder} value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} /></Field>
      <Field label="日期范围">
        <span className="qk-range"><input type="date" aria-label="开始日期" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /><span className="muted">至</span><input type="date" aria-label="结束日期" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></span>
      </Field>
      <Field label="单据类型"><select aria-label="单据类型" value={draft.docType} onChange={(e) => setDraft({ ...draft, docType: e.target.value })}><option value="">收款单和付款单</option><option value="receipt">收款单</option><option value="payment">付款单</option></select></Field>
      <div className="qk-field wide"><span>快捷日期</span><DateChips from={draft.from} to={draft.to} onChange={(a, b) => setDraft({ ...draft, from: a, to: b })} /></div>
    </FilterBar>
  );
}

const DocLink = ({ id, no, type, onOpen }: { id: number; no: string; type?: string; onOpen: (id: number) => void }) => (
  <span className="mono"><button type="button" className="link-button" onClick={(e) => { e.stopPropagation(); onOpen(id); }}>{no}</button> <CopyButton text={no} label={`单号 ${no}`} />{type && <> <span className="muted">{type}</span></>}</span>
);

/** 收付款结算明细表：每张收付款单把钱分给了哪几张单据（哪个商品）。 */
export function SettlementDetailPage() {
  const fetcher = useCallback((p: { from?: string; to?: string; docType?: string }) => financeApi.settlementDetail(p), []);
  const q = useQuery<SettlementRow>(fetcher, (r) => `${r.docNo} ${r.partyName} ${r.sourceDocNo} ${r.productName}`);
  const [group, setGroup] = useState('none');
  const [docId, setDocId] = useState<number | null>(null);
  const rows = q.rows;
  const total = (l: SettlementRow[]) => money(l.reduce((s, r) => s + r.amountCents, 0));
  const cols: Array<Col<SettlementRow>> = [
    { key: 'date', head: '日期', cell: (r) => r.docDate, csv: (r) => r.docDate },
    { key: 'doc', head: '收付款单', primary: true, cell: (r) => <DocLink id={r.docId} no={r.docNo} type={r.typeLabel} onOpen={setDocId} />, csv: (r) => r.docNo },
    { key: 'party', head: '往来对象', cell: (r) => r.partyName || '—', csv: (r) => r.partyName },
    { key: 'by', head: '结算方式', cell: (r) => r.settleByLabel, csv: (r) => r.settleByLabel },
    { key: 'src', head: '被结算单据', cell: (r) => <DocLink id={r.sourceDocId} no={r.sourceDocNo} type={r.sourceTypeLabel} onOpen={setDocId} />, csv: (r) => r.sourceDocNo },
    { key: 'prod', head: '商品', cell: (r) => r.productName || '—', csv: (r) => r.productName },
    { key: 'amt', head: '结算金额', num: true, cell: (r) => money(r.amountCents), sum: total, csv: (r) => plainYuan(r.amountCents) },
  ];
  const list = rows ?? [];
  return (
    <div className={docId ? 'split' : undefined}>
      <div className="split-main">
        <QueryPage title="收付款结算明细表" subtitle="每张已过账收付款单把钱分给了哪几张单据、哪个商品。点单号可查看原单据。"
          actions={<>{q.at && <span className="muted qk-stamp">数据时间 {stamp(q.at)}</span>}<button type="button" className="secondary-button small" disabled={q.busy} onClick={q.refresh}>刷新</button><ExportButton name="收付款结算明细.csv" cols={cols} rows={rows} label="导出明细" /></>}>
          <Filters q={q as never} placeholder="收付款单号、往来对象、被结算单据或商品" />
          {q.error && <div role="alert" className="notice error">{q.error}</div>}
          {rows !== null && <SummaryCards items={[
            { label: '结算笔数', value: list.length },
            { label: '收付款单数', value: new Set(list.map((r) => r.docId)).size },
            { label: '被结算单据数', value: new Set(list.map((r) => r.sourceDocId)).size },
            { label: '结算金额合计', value: total(list), tone: 'accent' },
          ]} />}
          <QueryPanel title="结算明细" hint={rows && rows.length >= 500 ? '最多显示最近 500 笔，请缩小日期范围' : undefined}
            actions={<GroupSwitch value={group} onChange={setGroup} options={[['none', '平铺'], ['party', '按往来对象'], ['doc', '按收付款单']]} />}>
            <QueryTable cols={cols} rows={rows} rowKey={(r) => r.id} caption="结算明细" footLabel={() => '合计'} loading="正在加载…"
              group={group === 'party' ? { key: (r) => r.partyName || '无往来对象', label: (k, l) => <><strong>{k}</strong> <span className="muted">{l.length} 笔</span></> }
                : group === 'doc' ? { key: (r) => `${r.docNo}｜${r.typeLabel}`, label: (k, l) => <><strong>{k.split('｜')[0]}</strong> <span className="muted">{k.split('｜')[1]} · {l.length} 笔</span></> } : null}
              empty={q.filtered ? '没有符合条件的结算明细，请调整条件后重新查询' : '这段时间没有按单据/按商品结算的收付款单'} />
          </QueryPanel>
        </QueryPage>
      </div>
      {docId && <DocDetail key={docId} id={docId} onClose={() => setDocId(null)} onChanged={() => undefined} />}
    </div>
  );
}

/** 未完全结算收付款单查询：已过账的收款单/付款单里，还有钱没分给具体单据的。按金额结算的整张都算没分配。 */
export function UnsettledReceiptsPage() {
  const fetcher = useCallback((p: { from?: string; to?: string; docType?: string }) => financeApi.unsettledReceipts(p), []);
  const q = useQuery<UnsettledRow>(fetcher, (r) => `${r.docNo} ${r.partyName}`);
  const [group, setGroup] = useState('none');
  const [docId, setDocId] = useState<number | null>(null);
  const rows = q.rows;
  const sum = (k: 'totalCents' | 'allocatedCents' | 'unallocatedCents') => (l: UnsettledRow[]) => money(l.reduce((s, r) => s + r[k], 0));
  const cols: Array<Col<UnsettledRow>> = [
    { key: 'date', head: '日期', cell: (r) => r.docDate, csv: (r) => r.docDate },
    { key: 'doc', head: '单号', primary: true, cell: (r) => <DocLink id={r.id} no={r.docNo} type={r.typeLabel} onOpen={setDocId} />, csv: (r) => r.docNo },
    { key: 'party', head: '往来对象', cell: (r) => r.partyName || '—', csv: (r) => r.partyName },
    { key: 'by', head: '结算方式', cell: (r) => r.settleByLabel, csv: (r) => r.settleByLabel },
    { key: 'total', head: '本次结算金额', num: true, cell: (r) => money(r.totalCents), sum: sum('totalCents'), csv: (r) => plainYuan(r.totalCents) },
    { key: 'alloc', head: '已分配到单据', num: true, cell: (r) => money(r.allocatedCents), sum: sum('allocatedCents'), csv: (r) => plainYuan(r.allocatedCents) },
    { key: 'un', head: '未分配', num: true, cell: (r) => <strong>{money(r.unallocatedCents)}</strong>, sum: sum('unallocatedCents'), csv: (r) => plainYuan(r.unallocatedCents) },
  ];
  const list = rows ?? [];
  return (
    <div className={docId ? 'split' : undefined}>
      <div className="split-main">
        <QueryPage title="未完全结算收付款单" subtitle="收到的钱（或付出的钱）还有一部分没有对应到具体的销售单/采购单。可以新开一张按单据结算的收付款单把它们对上，也可以保持按金额结算。"
          actions={<>{q.at && <span className="muted qk-stamp">数据时间 {stamp(q.at)}</span>}<button type="button" className="secondary-button small" disabled={q.busy} onClick={q.refresh}>刷新</button><ExportButton name="未完全结算收付款单.csv" cols={cols} rows={rows} label="导出明细" /></>}>
          <Filters q={q as never} placeholder="单号或往来对象" />
          {q.error && <div role="alert" className="notice error">{q.error}</div>}
          {rows !== null && <SummaryCards items={[
            { label: '未完全结算单据', value: `${list.length} 张` },
            { label: '本次结算金额合计', value: sum('totalCents')(list) },
            { label: '已分配到单据', value: sum('allocatedCents')(list) },
            { label: '未分配合计', value: sum('unallocatedCents')(list), tone: list.length ? 'warn' : undefined },
          ]} />}
          <QueryPanel title="未完全结算的收付款单" hint={rows && rows.length >= 1000 ? '最多显示最近 1000 张，请缩小日期范围' : undefined}
            actions={<GroupSwitch value={group} onChange={setGroup} options={[['none', '平铺'], ['party', '按往来对象'], ['type', '按单据类型']]} />}>
            <QueryTable cols={cols} rows={rows} rowKey={(r) => r.id} caption="未完全结算收付款单" footLabel={() => '合计'} loading="正在加载…"
              group={group === 'party' ? { key: (r) => r.partyName || '无往来对象', label: (k, l) => <><strong>{k}</strong> <span className="muted">{l.length} 张</span></> }
                : group === 'type' ? { key: (r) => r.typeLabel, label: (k, l) => <><strong>{k}</strong> <span className="muted">{l.length} 张</span></> } : null}
              empty={q.filtered ? '没有符合条件的单据，请调整条件后重新查询' : '没有未完全结算的收付款单'} />
          </QueryPanel>
        </QueryPage>
      </div>
      {docId && <DocDetail key={docId} id={docId} onClose={() => setDocId(null)} onChanged={() => undefined} />}
    </div>
  );
}

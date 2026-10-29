import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { DocDetail } from './DocDetail';
import { SearchPick, money } from './common';
import { financeApi, type StockLedger, type StockRow } from './financeApi';
import { CopyButton, plainYuan, usePersisted } from './fin-ui';
import { ExportButton, Field, FilterBar, GroupSwitch, QueryPage, QueryPanel, QueryTable, SummaryCards, stamp, type Col } from './query/QueryKit';

interface Filters { keyword: string; warehouseId: number | null; warehouseName: string; stockStatus: string; asOf: string }
const EMPTY: Filters = { keyword: '', warehouseId: null, warehouseName: '', stockStatus: '', asOf: '' };
const qtyText = (n: number) => String(Math.round(n * 10000) / 10000);

/**
 * 库存查询（按旧版 10-24 的版式）：查询条件（商品/仓库/库存状态，另有“截至日期”看历史库存）→ 汇总卡 → 已过账库存表。
 * 表可平铺，也可按仓库、按商品分组并带小计；点一行的“流水”看这个商品在这个仓库的每一笔入库/出库（可点单号看原单据）。
 * 库存成本、平均单位成本由服务端按“成本查看”权限决定是否返回，没有权限时这两列不出现。
 */
export function InventoryPage() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<Date | null>(null);
  const [view, setView] = usePersisted<{ group: string }>('finance.inventory.view', { group: 'none' });
  const [sel, setSel] = useState<StockRow | null>(null);
  const [ledger, setLedger] = useState<StockLedger | null>(null);
  const [docId, setDocId] = useState<number | null>(null);

  const load = useCallback((f: Filters) => {
    setError(''); setBusy(true);
    financeApi.inventory({ keyword: f.keyword.trim() || undefined, warehouseId: f.warehouseId ?? undefined, asOf: f.asOf || undefined, stockStatus: f.stockStatus || undefined })
      .then((r) => { setRows(r); setAt(new Date()); })
      .catch((e) => { setRows([]); setError(e instanceof ApiError ? e.message : '加载失败'); })
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => { load(EMPTY); }, [load]);
  useEffect(() => {
    if (!sel) { setLedger(null); return; }
    setLedger(null);
    financeApi.inventoryLedger({ productId: sel.productId, warehouseId: sel.warehouseId, asOf: applied.asOf || undefined }).then(setLedger).catch((e) => setError(e instanceof ApiError ? e.message : '流水加载失败'));
  }, [sel, applied.asOf]);

  const query = () => { setApplied(draft); setSel(null); load(draft); };
  const reset = () => { setDraft(EMPTY); setApplied(EMPTY); setSel(null); load(EMPTY); };
  const filtered = applied.keyword || applied.warehouseId || applied.asOf || applied.stockStatus;

  const hasCost = !!rows?.some((r) => r.amountCents !== null);
  const list = rows ?? [];
  const units = new Set(list.map((r) => r.unit));
  const sumQty = (l: StockRow[]) => (new Set(l.map((r) => r.unit)).size > 1 ? '—' : qtyText(l.reduce((s, r) => s + r.qty, 0)));
  const sumAmount = (l: StockRow[]) => money(l.reduce((s, r) => s + (r.amountCents ?? 0), 0));

  const cols: Array<Col<StockRow>> = [
    { key: 'code', head: '商品编码', cell: (r) => <span className="mono">{r.code} <CopyButton text={r.code} label={`商品编码 ${r.code}`} /></span>, csv: (r) => r.code },
    { key: 'name', head: '商品名称', primary: true, cell: (r) => r.productName || '历史商品', csv: (r) => r.productName },
    { key: 'wh', head: '仓库', cell: (r) => r.warehouseName, csv: (r) => r.warehouseName },
    { key: 'qty', head: '数量', num: true, cell: (r) => <span className={r.qty < 0 ? 'neg' : r.qty === 0 ? 'muted' : undefined}>{qtyText(r.qty)}</span>, sum: sumQty, csv: (r) => r.qty },
    { key: 'unit', head: '单位', cell: (r) => r.unit, csv: (r) => r.unit },
    ...(hasCost ? [
      { key: 'amount', head: '库存成本', num: true, cell: (r: StockRow) => money(r.amountCents), sum: sumAmount, csv: (r: StockRow) => plainYuan(r.amountCents) },
      { key: 'avg', head: '平均单位成本', num: true, cell: (r: StockRow) => money(r.avgCostCents), csv: (r: StockRow) => plainYuan(r.avgCostCents) },
    ] : []),
    { key: 'op', head: '操作', action: true, cell: (r) => <button type="button" className="link-button" onClick={(e) => { e.stopPropagation(); setSel(r); }}>流水</button> },
  ];
  const group = useMemo(() => {
    if (view.group === 'warehouse') return { key: (r: StockRow) => r.warehouseName || '未知仓库', label: (k: string, l: StockRow[]) => <><strong>{k}</strong> <span className="muted">{l.length} 个商品</span></> };
    if (view.group === 'product') return { key: (r: StockRow) => `${r.code}｜${r.productName}`, label: (k: string, l: StockRow[]) => <><strong>{k.split('｜')[1] || k}</strong> <span className="muted">{k.split('｜')[0]} · 分布在 {l.length} 个仓库</span></> };
    return null;
  }, [view.group]);

  const cards = [
    { label: '库存行数', value: list.length },
    { label: '商品种类', value: new Set(list.map((r) => r.productId)).size },
    { label: '涉及仓库', value: new Set(list.map((r) => r.warehouseId)).size },
    { label: '缺货行数', value: list.filter((r) => r.qty <= 0).length, tone: list.some((r) => r.qty <= 0) ? 'warn' as const : undefined },
    ...(hasCost ? [{ label: '库存成本合计', value: sumAmount(list), tone: 'accent' as const }] : []),
  ];

  return (
    <div className={docId ? 'split' : undefined}>
      <div className="split-main">
        <QueryPage
          title="库存查询"
          subtitle={<>按商品、仓库和库存状态查询实时库存。数据来自已过账的采购入库、销售、退货等单据，不允许为负；“缺货”是数量已经到 0 的商品。{applied.asOf ? <strong> 当前显示截至 {applied.asOf} 的历史库存。</strong> : null}</>}
          actions={<>{at && <span className="muted qk-stamp">数据时间 {stamp(at)}</span>}<button type="button" className="secondary-button small" disabled={busy} onClick={() => load(applied)}>刷新</button><ExportButton name={`库存-${applied.asOf || '当前'}.csv`} cols={cols} rows={rows} /></>}
        >
          <FilterBar onQuery={query} onReset={reset} busy={busy}>
            <Field label="商品" wide><input type="search" aria-label="商品" placeholder="商品编码或名称，多个词用空格分开" value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} /></Field>
            <Field label="仓库"><SearchPick ariaLabel="仓库" type="finance-warehouses" value={draft.warehouseId} label={draft.warehouseName} placeholder="全部仓库" onChange={(id, name) => setDraft({ ...draft, warehouseId: id, warehouseName: name })} /></Field>
            <Field label="库存状态"><select aria-label="库存状态" value={draft.stockStatus} onChange={(e) => setDraft({ ...draft, stockStatus: e.target.value })}><option value="">全部状态</option><option value="normal">库存正常</option><option value="out">缺货</option></select></Field>
            <Field label="截至日期"><input type="date" aria-label="截止日期" value={draft.asOf} onChange={(e) => setDraft({ ...draft, asOf: e.target.value })} /></Field>
          </FilterBar>
          {error && <div role="alert" className="notice error">{error}</div>}
          {rows !== null && <SummaryCards items={cards} />}
          <QueryPanel title="已过账库存" hint={rows ? `${rows.length} 行${units.size > 1 ? '（含多种单位，数量合计不相加）' : ''}` : undefined} actions={<GroupSwitch value={view.group} onChange={(g) => setView({ group: g })} options={[['none', '平铺'], ['warehouse', '按仓库'], ['product', '按商品']]} />}>
            <QueryTable cols={cols} rows={rows} rowKey={(r) => `${r.warehouseId}-${r.productId}`} group={group} selectedKey={sel ? `${sel.warehouseId}-${sel.productId}` : null} caption="已过账库存"
              loading="正在读取已过账库存…" empty={filtered ? '没有符合条件的库存，请调整条件后重新查询' : '还没有库存。先做一张采购入库单并过账，库存就出来了'} />
          </QueryPanel>
          {sel && (
            <QueryPanel title={`库存流水 · ${sel.productName}（${sel.warehouseName}）`} hint={applied.asOf ? `截至 ${applied.asOf}` : undefined} actions={<button type="button" className="secondary-button small" onClick={() => setSel(null)}>关闭流水</button>}>
              {ledger && <SummaryCards items={[{ label: '累计入库', value: qtyText(ledger.inQty) }, { label: '累计出库', value: qtyText(ledger.outQty) }, { label: '结存数量', value: `${qtyText(ledger.closingQty)} ${sel.unit}` }, ...(ledger.closingAmountCents !== null ? [{ label: '结存成本', value: money(ledger.closingAmountCents) }] : [])]} />}
              <QueryTable<StockLedger['rows'][number]> rows={ledger?.rows ?? null} rowKey={(r) => r.id} caption="库存流水" foot={false} empty="这个商品在这个仓库没有库存变动"
                cols={[
                  { key: 'date', head: '日期', cell: (r) => r.entryDate },
                  { key: 'no', head: '单号', primary: true, cell: (r) => <button type="button" className="link-button mono" onClick={() => setDocId(r.documentId)}>{r.docNo}</button> },
                  { key: 'type', head: '类型', cell: (r) => r.typeLabel },
                  { key: 'party', head: '往来对象', cell: (r) => r.partyName || '—' },
                  { key: 'qty', head: '数量变动', num: true, cell: (r) => <span className={r.qty < 0 ? 'neg' : undefined}>{r.qty > 0 ? '+' : ''}{qtyText(r.qty)}</span> },
                  { key: 'bal', head: '结存数量', num: true, cell: (r) => qtyText(r.balanceQty) },
                  ...(ledger?.closingAmountCents != null ? [{ key: 'amt', head: '金额变动', num: true, cell: (r: StockLedger['rows'][number]) => money(r.amountCents) }] : []),
                ]} />
            </QueryPanel>
          )}
        </QueryPage>
      </div>
      {docId && <DocDetail key={docId} id={docId} onClose={() => setDocId(null)} onChanged={() => undefined} />}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { SearchPick, money } from './common';
import { financeApi, type StockRow } from './financeApi';
import { CopyButton, downloadCsv, plainYuan } from './fin-ui';

/** 库存状况表（管家婆式）：选仓库或全部仓库，可查某一天的历史库存；每行有编码、名称、单位、数量、成本均价、成本金额。没有成本权限的人看不到金额。 */
export function InventoryPage() {
  const [keyword, setKeyword] = useState('');
  const [wh, setWh] = useState<{ id: number | null; name: string }>({ id: null, name: '' });
  const [asOf, setAsOf] = useState('');
  const [stock, setStock] = useState('');
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    financeApi.inventory({ keyword, warehouseId: wh.id ?? undefined, asOf: asOf || undefined, stockStatus: stock || undefined }).then(setRows).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [keyword, wh.id, asOf, stock]);
  const hasCost = rows?.some((r) => r.amountCents !== null);
  const totalQty = (rows ?? []).reduce((s, r) => s + r.qty, 0);
  const totalAmount = (rows ?? []).reduce((s, r) => s + (r.amountCents ?? 0), 0);
  const empty = rows?.length === 0;
  return (
    <div>
      <div className="page-head between"><h1>库存查询</h1><button type="button" className="secondary-button small" disabled={!rows?.length} onClick={() => downloadCsv(`库存-${asOf || '当前'}.csv`, ['仓库', '商品编码', '商品名称', '单位', '库存数量', ...(hasCost ? ['成本均价', '成本金额'] : [])], (rows ?? []).map((r) => [r.warehouseName, r.code, r.productName, r.unit, r.qty, ...(hasCost ? [plainYuan(r.avgCostCents), plainYuan(r.amountCents)] : [])]))}>导出当前结果</button></div>
      <p className="muted">库存来自已过账的采购入库、销售、退货等单据，不允许为负；“缺货”是数量已经卖到 0 的商品。{asOf ? `当前显示截至 ${asOf} 的历史库存。` : ''}</p>
      <div className="toolbar">
        <input className="search-box" type="search" aria-label="搜索商品" placeholder="商品名称或编码" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <SearchPick ariaLabel="仓库" type="finance-warehouses" value={wh.id} label={wh.name} placeholder="全部仓库" onChange={(id, name) => setWh({ id, name })} />
        <select aria-label="库存状态" value={stock} onChange={(e) => setStock(e.target.value)}>
          <option value="">全部状态</option><option value="normal">库存正常</option><option value="out">缺货</option>
        </select>
        <label className="check-line">截至<input type="date" aria-label="截止日期" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        {(keyword || wh.id || asOf || stock) && <button type="button" className="ghost-button" onClick={() => { setKeyword(''); setWh({ id: null, name: '' }); setAsOf(''); setStock(''); }}>清除条件</button>}
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>仓库</th><th>商品编码</th><th>商品名称</th><th>单位</th><th>库存数量</th>{hasCost && <><th>成本均价</th><th>成本金额</th></>}</tr></thead>
        <tbody>
          {rows === null && !error && <tr><td colSpan={7} className="muted">正在读取库存…</td></tr>}
          {empty && <tr><td colSpan={7} className="empty-state muted">{keyword || wh.id || asOf || stock ? '没有符合条件的库存，试试清除条件' : '还没有库存。先做一张采购入库单并过账，库存就出来了'}</td></tr>}
          {rows?.map((r) => (
            <tr key={`${r.warehouseId}-${r.productId}`}><td>{r.warehouseName}</td><td className="mono">{r.code} <CopyButton text={r.code} label={`商品编码 ${r.code}`} /></td><td>{r.productName}</td><td>{r.unit}</td><td className={`num${r.qty < 0 ? ' neg' : ''}`}>{r.qty}</td>{hasCost && <><td className="num">{money(r.avgCostCents)}</td><td className="num">{money(r.amountCents)}</td></>}</tr>
          ))}
        </tbody>
        {rows && rows.length > 0 && <tfoot><tr><th colSpan={4}>合计（{rows.length} 行）</th><th className="num">{totalQty}</th>{hasCost && <><th /><th className="num">{money(totalAmount)}</th></>}</tr></tfoot>}
      </table></div>
    </div>
  );
}

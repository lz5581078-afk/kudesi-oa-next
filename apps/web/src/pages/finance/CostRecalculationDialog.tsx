import { useState } from 'react';
import { sumUnitCents } from '@kudesi/shared';
import { FinanceModal } from './FinanceModal';
import { money } from './common';
import type { RecalculationPreview } from './costVersionsApi';

export function CostRecalculationDialog({ preview,busy,error,onClose,onConfirm }: {preview:RecalculationPreview;busy:boolean;error:string;onClose:()=>void;onConfirm:()=>void}) {
  const [keyword,setKeyword]=useState(''),[onlyChanged,setOnlyChanged]=useState(true);
  const rows=preview.rows.filter(row=>(!onlyChanged || row.previous!==row.proposed) && (!keyword.trim() || `${row.code} ${row.name}`.toLowerCase().includes(keyword.trim().toLowerCase())));
  return <FinanceModal title="自动重算差异预检" busy={busy} onClose={onClose}>
    <p>计算日期 {preview.businessDate}。比较已保存成本与现行规则候选值；候选值已包含辅助分摊和人工特殊调整；确认后保存最终六科目成本。</p>
    <div className="toolbar"><span>参与计算 {preview.rows.length} 个SKU</span><span>成本有变化 {preview.changed} 项</span><span>首次登记 {preview.rows.filter(r=>r.settingId===null).length} 项</span></div>
    {error && <div role="alert" className="notice error">{error}</div>}
    <div className="toolbar"><input aria-label="搜索重算差异" placeholder="SKU编码 / 名称" value={keyword} onChange={e=>setKeyword(e.target.value)}/><label className="check-line"><input type="checkbox" checked={onlyChanged} onChange={e=>setOnlyChanged(e.target.checked)}/>仅显示有变化或首次生成</label></div>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>SKU编码 / 名称</th><th>当前已保存成本</th><th>按现行规则重算</th><th>变化</th><th>计算提醒</th></tr></thead><tbody>
      {rows.slice(0,300).map(row=><tr key={`${row.skuType}-${row.skuId}`}><td><strong>{row.code}</strong><div>{row.name}</div></td><td>{row.previous===null?'尚无快照':money(row.previous)}</td><td>{money(row.proposed)}</td><td>{row.previous!==null && row.proposed!==null?money(sumUnitCents([row.proposed,-row.previous])):'—'}</td><td>{row.issues.join('；') || '检查通过'}</td></tr>)}
      {!rows.length && <tr><td colSpan={5} className="muted">当前筛选下没有差异，已保存成本与候选值一致。</td></tr>}
    </tbody></table></div>
    {rows.length>300 && <p className="muted">仅显示前300项，请使用搜索进一步定位。</p>}
    {!!preview.warnings?.length && <details><summary>查看非阻断提醒（{preview.warnings.length}）</summary><ul>{preview.warnings.slice(0,100).map((warning,i)=><li key={i}>{warning}</li>)}</ul></details>}
    {preview.issues.length>0 && <details><summary>查看计算提醒（{preview.issues.length}）</summary><ul>{preview.issues.slice(0,100).map((issue,i)=><li key={i}>{issue}</li>)}</ul></details>}
    <div className="row-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || !preview.ready} onClick={onConfirm}>确认按预检结果更新成本快照</button></div>
  </FinanceModal>;
}

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { CostSnapshotRow, MarginHistoryRow } from './financeApi';

const fields = [
  ['code', 'SKU组合编码'], ['name', 'SKU名称'], ['productCostCents', '成本'], ['preShipCostCents', '预发货成本'],
  ['weightG', '计费重量（kg）'], ['categoryId', '分类ID'], ['carrierName', '使用快递'], ['freightCents', '历史固定运费'], ['explicitMarginPercent', '利润率'],
] as const;
function value(key: string, raw: unknown) {
  if (raw === undefined) return '未记录';
  if (raw === null || raw === '') return '未设置';
  if (key === 'code' || key === 'name' || key === 'carrierName' || key === 'categoryId') return String(raw);
  const n = Number(raw);
  if (!Number.isFinite(n)) return '未记录';
  if (key === 'weightG') return String(Number((n / 1000).toFixed(6)));
  if (key === 'explicitMarginPercent') return `${n}%`;
  return `¥${(n / 100).toLocaleString('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 6 })}`;
}
/** 全局历史与SKU内层历史共用同一份逐字段前后对比，只展示登记时留存的值。 */
export function CostHistoryRecords({ rows, busy = false }: { rows: CostSnapshotRow[]; busy?: boolean }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return <div className="table-scroll finance-cost-history-records"><table className="data-table">
    <thead><tr>{['生效时间', 'SKU', '变更内容', '操作人', '修改原因', '详情'].map(label => <th key={label}>{label}</th>)}</tr></thead>
    <tbody>{!rows.length && <tr><td colSpan={6} className="empty-state muted">{busy ? '正在加载…' : '暂无成本变更记录'}</td></tr>}
      {rows.map(row => <Fragment key={row.id}><tr>
        <td>{new Date(row.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</td>
        <td><strong>{row.name || '未记录名称'}</strong><small>{row.code}</small></td>
        <td>{row.eventLabel || '资料调整'}<small>{row.changes.map(change => fields.find(([key]) => key === change.field)?.[1] || change.label).join('、') || '资料核对'}</small></td>
        <td>{row.actorName}</td><td>{row.reason || '旧记录未填写'}</td>
        <td><button type="button" className="secondary-button small" aria-label={`查看记录${row.id}`} aria-expanded={expanded === row.id} onClick={() => setExpanded(current => current === row.id ? null : row.id)}>{expanded === row.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button></td>
      </tr>{expanded === row.id && <tr><td colSpan={6}><div className="finance-cost-history-comparison"><table className="data-table"><thead><tr><th>字段</th><th>变更前</th><th>变更后</th></tr></thead>
        <tbody>{fields.map(([key, label]) => {
          const change = row.changes.find(item => item.field === key);
          const before = row.before?.[key] ?? (row.before && key in row.before ? null : change?.before);
          return <tr key={key} className={change ? 'changed' : undefined}><th>{label}</th><td>{value(key, before)}</td><td>{value(key, row[key])}</td></tr>;
        })}</tbody></table></div><p className="muted">历史固定运费仅留档；当前快递预估不会改写此记录。</p></td></tr>}</Fragment>)}
    </tbody>
  </table></div>;
}


/** 分类历史采用同一逐行展开交互，只比较当时记录的本级利润率。 */
export function CostMarginHistoryRecords({ rows, busy = false }: { rows: MarginHistoryRow[]; busy?: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const rate = (percent: number | null) => percent === null ? '未设置' : `${percent}%`;
  return <div className="table-scroll finance-cost-history-records"><table className="data-table">
    <thead><tr>{['生效时间','分类','变更内容','操作人','修改原因','详情'].map(label=><th key={label}>{label}</th>)}</tr></thead>
    <tbody>{!rows.length && <tr><td colSpan={6} className="empty-state muted">{busy?'正在加载…':'暂无成本变更记录'}</td></tr>}
      {rows.map(row=><Fragment key={row.id}><tr>
        <td>{new Date(row.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</td><td><strong>{row.scopeName}</strong></td>
        <td>分类利润率调整<small>利润率</small></td><td>{row.actorName}</td><td>{row.reason || '旧记录未填写'}</td>
        <td><button type="button" className="secondary-button small" aria-label={`查看分类记录${row.id}`} aria-expanded={expanded===row.id} onClick={()=>setExpanded(current=>current===row.id?null:row.id)}>{expanded===row.id?<ChevronUp size={16}/>:<ChevronDown size={16}/>}</button></td>
      </tr>{expanded===row.id && <tr><td colSpan={6}><div className="finance-cost-history-comparison"><table className="data-table"><thead><tr><th>字段</th><th>变更前</th><th>变更后</th></tr></thead><tbody><tr className="changed"><th>利润率</th><td>{rate(row.beforePercent)}</td><td>{rate(row.afterPercent)}</td></tr></tbody></table></div><p className="muted">未设置表示继承上级规则。</p></td></tr>}</Fragment>)}
    </tbody>
  </table></div>;
}

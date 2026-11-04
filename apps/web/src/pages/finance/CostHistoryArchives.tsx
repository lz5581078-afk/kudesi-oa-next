import { useEffect, useState } from 'react';
import { useCostIdentityKey } from './CostIdentityBoundary';
import { resourceApi, type ResourceDto } from '../../resources/api';

async function records(type: string, versionId?: number) {
  const out: ResourceDto[] = [];
  for (let page = 1; ; page++) {
    const result = await resourceApi.list(type, { page, pageSize: 200, showHidden: true, ...(versionId ? { fieldKey: 'versionId', fieldValue: versionId } : {}) });
    out.push(...result.items);
    if (out.length >= result.total || !result.items.length) return out;
  }
}
const text = (v: unknown) => v == null ? '' : String(v);
const amount = (v: unknown) => v === undefined ? '未记录' : v === null ? '未设置' : typeof v === 'number' && Number.isFinite(v) ? `¥${(v / 100).toLocaleString('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 6 })}` : '未记录';
const status: Record<string, string> = { draft: '草稿', active: '已启用', inactive: '已停用' };
/** 旧版版本档案只读入口；沿用统一资料权限，只读已留存值，不调用当前来源试算。 */
export function CostHistoryArchives({ onTotal }: { onTotal?: (total: number) => void }) {
  const identity = useCostIdentityKey();
  return <CostHistoryArchivesContent key={identity} onTotal={onTotal}/>;
}

function CostHistoryArchivesContent({ onTotal }: { onTotal?: (total: number) => void }) {
  const [versions, setVersions] = useState<ResourceDto[] | null>(null);
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [selected, setSelected] = useState<ResourceDto | null>(null);
  const [section, setSection] = useState<'sku' | 'auxiliary'>('sku');
  const [rows, setRows] = useState<ResourceDto[] | null>(null);
  const [error, setError] = useState(''), [detailError, setDetailError] = useState('');
  useEffect(() => {
    let active = true;
    void records('finance-cost-versions').then(async list => {
      if (!active) return;
      onTotal?.(list.length);
      setVersions(list.sort((a,b) => Number(Boolean(b.data.isDefault)) - Number(Boolean(a.data.isDefault)) || b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id));
      // 列表只取一条SKU及总数；分批读取，避免下载所有版本的成本内容。
      for (let offset = 0; active && offset < list.length; offset += 8) {
        await Promise.all(list.slice(offset, offset + 8).map(async version => {
          try {
            const result = await resourceApi.list('finance-cost-skus', { page: 1, pageSize: 1, showHidden: true, fieldKey: 'versionId', fieldValue: version.id });
            if (active) setCounts(current => ({ ...current, [version.id]: result.total }));
          } catch { /* 统一资源权限拒绝时不暴露SKU数量，详情会显示读取原因。 */ }
        }));
      }
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [onTotal]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setRows(null); setDetailError('');
    void records(section === 'sku' ? 'finance-cost-skus' : 'finance-cost-auxiliary', selected.id).then(result => { if (active) setRows(result); }).catch(e => { if (active) setDetailError((e as Error).message); });
    return () => { active = false; };
  }, [selected, section]);
  return <section className="finance-history-archives" aria-label="旧版成本档案">
    <p className="muted">旧版档案保留原加价率口径，与当前SKU成本分开留存。</p>
    {error && <p role="alert" className="notice error">{error}</p>}
    <div className="table-scroll"><table className="data-table"><thead><tr>{['版本', '原状态', '适用期间', 'SKU数', '详情'].map(label => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{versions?.map(version => <tr key={version.id}><td>{text(version.data.versionName) || version.title}</td><td>{status[version.status] || version.status}</td><td>{text(version.data.effectiveFrom) || '未设置'} 至 {text(version.data.effectiveTo) || '长期'}</td><td>{counts[version.id] ?? '未记录'}</td><td><button type="button" className="secondary-button small" onClick={() => { if (selected?.id !== version.id || section !== 'sku') setRows(null); setDetailError(''); setSelected(version); setSection('sku'); }}>查看档案</button></td></tr>)}</tbody>
    </table></div>
    {!error && !versions?.length && <p className="empty-state muted">{versions === null ? '正在加载…' : '暂无旧版档案'}</p>}
    {selected && <section className="finance-history-archive-detail" aria-label="成本档案内容">
      <header className="between"><h3>{text(selected.data.versionName) || selected.title}</h3><button type="button" className="icon-button" aria-label="收起档案" onClick={() => setSelected(null)}>✕</button></header>
      <nav className="toolbar" aria-label="档案内容"><button type="button" className="secondary-button" aria-pressed={section === 'sku'} onClick={() => { if (section !== 'sku') setRows(null); setSection('sku'); }}>SKU成本与底价</button><button type="button" className="secondary-button" aria-pressed={section === 'auxiliary'} onClick={() => { if (section !== 'auxiliary') setRows(null); setSection('auxiliary'); }}>辅助成本</button></nav>
      {detailError && <p role="alert" className="notice error">{detailError}</p>}
      <div className="table-scroll"><table className="data-table"><thead><tr>{(section === 'sku' ? ['SKU编码', '名称', '预发货成本', '总成本', '加价率', '公司底价'] : ['编码', '名称', '金额', '单位', '适用范围', '备注']).map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows?.map(row => {
          const snapshot = row.data.snapshot && typeof row.data.snapshot === 'object' && !Array.isArray(row.data.snapshot) ? row.data.snapshot as Record<string, unknown> : {};
          return section === 'sku' ? <tr key={row.id}><td>{text(snapshot.code ?? row.data.skuCode)}</td><td>{text(snapshot.name ?? row.data.skuName) || row.title}</td><td>{amount(snapshot.preShipCostCents)}</td><td>{amount(snapshot.costIncludingFreightCents)}</td><td>{snapshot.markupPercent === undefined ? '未记录' : snapshot.markupPercent === null ? '未设置' : `${text(snapshot.markupPercent)}%`}</td><td>{amount(snapshot.minPriceCents)}</td></tr>
            : <tr key={row.id}><td>{text(row.data.costCode)}</td><td>{text(row.data.costName) || row.title}</td><td>{amount(row.data.amount)}</td><td>{text(row.data.unitName)}</td><td>{text(row.data.applyScope)}</td><td>{text(row.data.note)}</td></tr>;
        })}</tbody>
      </table></div>
      {!detailError && !rows?.length && <p className="empty-state muted">{rows === null ? '正在加载…' : section === 'sku' ? '该旧版档案未录入SKU成本' : '该旧版档案未录入辅助成本'}</p>}
    </section>}
  </section>;
}

import { Fragment } from 'react';
import { COMPOSITION_GROUP_LABEL, createChecker, getResourceDef, multiplyUnitCents, productLayoutKey, resolveProductSections, type ResolvedNode, type CompositionGroup } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import type { ResourceDto } from './api';
import { FinanceFields, FinanceSection, DetailRowsState, detailMoney, detailNumber, detailWeight, useFinanceDetailRows } from './FinanceDetailFields';
import { ProductCostSummary } from './ProductCostSummary';
import { CompositionResult, FreightHistory } from './ReferenceProductFields';
import { calculateDraftFacts } from './useProductDraftFacts';
import { needsZeroReason } from './productFormGrid';
import { FileList } from './FilesField';

const def = getResourceDef('finance-products')!;
const productRef = (row: ResourceDto): [string, number] | null => typeof row.data.laborId === 'number' ? ['finance-labor-costs', row.data.laborId] : typeof row.data.componentId === 'number' ? ['finance-products', row.data.componentId] : null;
const sourceRef = () => null;

function ProductSources({ record, canCost }: { record: ResourceDto; canCost: boolean }) {
  const { rows, error } = useFinanceDetailRows('finance-product-sources', 'productId', record.id, record.updatedAt, sourceRef);
  const ordered = rows ? [...rows].sort((a, b) => b.row.updatedAt.localeCompare(a.row.updatedAt) || b.row.id - a.row.id) : null;
  const latest = ordered?.find(({ row }) => row.status === 'active')?.row.id;
  return <FinanceSection title="供货来源" hint="同一原料可维护多个产区和供应商"><DetailRowsState error={error} loading={!rows && !error} empty={false} />{ordered?.map(({ row }, index) => <section className="finance-source-card" key={row.id}>
    <header><strong>来源 {String(index + 1).padStart(2, '0')}</strong>{row.id === latest && <span>当前最新成本</span>}{row.status !== 'active' && <span>已停用</span>}</header>
    <dl className="finance-view-fields"><div><dt>供应商名称</dt><dd>{row.refLabels.supplierId || '未填写'}</dd></div><div><dt>产区</dt><dd>{String(row.data.originArea || '未填写')}</dd></div>{record.data.archiveType === 'shipping_material' && <div><dt>系统规格</dt><dd>{String(row.data.systemSpec || '未填写')}</dd></div>}{canCost && <div><dt>采购价</dt><dd>{detailMoney(row.data.purchasePrice)}</dd></div>}</dl>
  </section>)}{rows?.length === 0 && <p className="finance-view-empty">未维护供货来源</p>}</FinanceSection>;
}

function ProductComposition({ record, canCost }: { record: ResourceDto; canCost: boolean }) {
  const { rows, error } = useFinanceDetailRows('finance-product-boms', 'productId', record.id, record.updatedAt, productRef);
  const oem = record.data.supplyMode === 'supplier_oem';
  const groups: string[] = oem ? ['oem_package'] : ['raw', 'package', 'oem_package', 'labor'];
  const groupOf = (row: NonNullable<typeof rows>[number]) => row.row.data.laborId ? 'labor' : !row.item ? 'unknown' : ['package', 'oem_package'].includes(String(row.item.data.archiveType)) ? String(row.item.data.archiveType) : 'raw';
  if (rows?.some(r => !groups.includes(groupOf(r)))) groups.push('unknown');
  const inGroup = (group: string, r: NonNullable<typeof rows>[number]) => group === 'unknown' ? !groups.filter(g => g !== 'unknown').includes(groupOf(r)) : groupOf(r) === group;
  const facts = calculateDraftFacts((rows ?? []).map(({ row, item }) => ({ kind: row.data.laborId ? 'labor' as const : 'component' as const, id: Number(row.data.laborId || row.data.componentId) || null, group: (row.data.laborId ? 'labor' : item?.data.archiveType === 'package' || item?.data.archiveType === 'oem_package' ? item.data.archiveType : 'raw') as CompositionGroup, qty: detailNumber(row.data.qty) ?? '', loss: detailNumber(row.data.lossPercent) ?? '' })), new Map((rows ?? []).flatMap(({ row, item }) => item ? [[`${row.data.laborId ? 'labor' : 'component'}:${item.id}`, item] as const] : [])), canCost);
  return <FinanceSection title={oem ? '供应商OEM组成' : '生产资料与成本'} hint={oem ? '记录供应商使用公司OEM包装形成外购成品的物理组成' : '记录自产成品消耗的原料、产品包装和人工成本'}>
    <DetailRowsState error={error} loading={!rows && !error} empty={false} />
    {!oem && rows && <div className="finance-production-overview">{[['原料', ['raw']], ['包装', ['package', 'oem_package']], ['人工', ['labor']]].map(([title, keys], i) => <div key={String(title)}><small>{String(i + 1).padStart(2, '0')}</small><strong>{title}</strong><span>{rows.filter(r => (keys as string[]).includes(groupOf(r))).length} 项</span></div>)}</div>}
    {rows && groups.map(group => <section className="finance-production-group" key={group}><h4>{COMPOSITION_GROUP_LABEL[group as CompositionGroup]?.title ?? '暂不可读的组成'}</h4>{!rows.some(r => inGroup(group, r)) ? <p className="finance-view-empty">暂无{COMPOSITION_GROUP_LABEL[group as CompositionGroup]?.title ?? '组成'}</p> : <div className="finance-composition-list">{rows.filter(r => inGroup(group, r)).map(({ row, item }) => {
      const qty = detailNumber(row.data.qty), price = detailNumber(item?.data[group === 'labor' ? 'unitPrice' : 'totalCost']);
      const weight = group === 'labor' ? null : detailNumber(item?.data.weightG);
      let subtotal: number | null = null;
      try { if (qty !== null && price !== null) subtotal = multiplyUnitCents(price, qty, group === 'labor' ? 0 : Number(row.data.lossPercent || 0)); } catch { /* 无效历史行保留为未维护 */ }
      return <article className={`finance-composition-card${oem ? ' is-oem' : ''}`} key={row.id}><div className="finance-composition-main"><label><span>{group === 'labor' ? '人工项目' : group === 'raw' ? '原料档案' : group === 'package' ? '产品包装档案' : 'OEM包装档案'}</span><input value={item?.title || row.refLabels.laborId || row.refLabels.componentId || '资料暂不可读'} readOnly /></label><small>{item?.refLabels.categoryId || ''} · {String(item?.data.purchaseSpec || item?.data.unitName || '未维护系统规格')}</small></div><div className="finance-composition-metrics"><label><span>{oem ? '个数/用量' : '使用倍数'}</span><input aria-label={`${item?.title || row.id}用量`} value={qty ?? ''} readOnly />{Number(row.data.lossPercent) > 0 && <small>损耗 {String(row.data.lossPercent)}%</small>}</label>{canCost && <><div><span>{group === 'labor' ? '人工单价' : '采购价'}</span><strong>{detailMoney(item?.data[group === 'labor' ? 'unitPrice' : 'purchasePrice'])}</strong></div>{group !== 'labor' && !oem && <div><span>运费 / 装卸费</span><strong>{detailMoney(item?.data.freight)} / {detailMoney(item?.data.handlingFee)}</strong></div>}</>}<div><span>{group === 'raw' ? '每倍重量' : '单件重量'}</span><strong>{group === 'labor' ? '不计重量' : detailWeight(weight)}</strong></div><div className="is-total"><span>{oem ? '包装费用' : '本项成本'}</span>{canCost && <strong>{detailMoney(subtotal)}</strong>}<small>重量 {group === 'labor' ? '不计重量' : detailWeight(qty === null || weight === null ? null : qty * weight)}</small></div></div></article>;
    })}</div>}</section>)}
    {rows && <CompositionResult facts={facts} values={record.data} canCost={canCost} />}
  </FinanceSection>;
}

/** 查看态读取编辑器的同一份分区和节点；业务块保留专用只读展示。 */
export function FinanceProductDetail({ record }: { record: ResourceDto }) {
  const { user } = useAuth();
  const can = (permission: string) => !!user && createChecker(user.permissions)(permission) && !(record.warehouseMode && ['product.cost.view', 'product.cost.edit', 'product.price.view'].includes(permission));
  const canCost = can('product.cost.view');
  const key = productLayoutKey(record.data);
  const sections = resolveProductSections(record.data, { canUse: can });
  const fields = (keys: Array<string | [string, string]>) => <FinanceFields def={def} record={record} keys={keys} />;
  const block = (node: Extract<ResolvedNode, { kind: 'block' }>) => {
    switch (node.block) {
      case 'category': return fields([['categoryId', '所属分类']]);
      case 'code': return <output data-field="code" className="finance-code-value">{String(record.data.code || '—')}</output>;
      case 'fullName': return <div data-field="basicInfoFullName" className="finance-full-name"><small>基础信息全名</small><output>{String(record.data.basicInfoFullName || '未填写')}</output></div>;
      case 'capacities': {
        const capacities = String(record.data.capacities ?? '').split(/\r?\n/).filter(Boolean);
        return <><div data-field="capacities" className="finance-capacities">{capacities.length ? capacities.map((text, i) => <span key={i}>{text}</span>) : '未填写'}</div></>;
      }
      case 'finishedNames': return <div data-field="rawFinishedNames" className="finance-finished-names">{String(record.data.rawFinishedNames ?? '').split(/\r?\n/).filter(Boolean).map((text, i) => <div key={i}><span>{String(i + 1).padStart(2, '0')}</span><input aria-label={`第${i + 1}条成品名`} value={text} readOnly /></div>)}{!record.data.rawFinishedNames && <p>暂无成品名</p>}</div>;
      case 'supplySources': return <ProductSources record={record} canCost={canCost} />;
      case 'composition': return <ProductComposition record={record} canCost={canCost} />;
      case 'weight': return <><dl className="finance-view-fields"><div data-field="weightG"><dt>{key === 'shipping_material' ? '物料重量' : '重量'}</dt><dd>{detailWeight(record.data.weightG)}</dd></div></dl>{fields(node.fields.filter(f => f.key !== 'weightG').map(f => [f.key, f.label]))}</>;
      case 'breakdown': return null; // 组成区已有成本和重量结果。
      case 'costSummary': return canCost ? <><ProductCostSummary def={def} record={record} reference />{record.data.migrationNotice && fields(['migrationNotice'])}</> : null;
    }
  };
  const renderNodes = (nodes: readonly ResolvedNode[]) => <div className="finance-layout-grid">{nodes.map((node, i) => {
    if (node.kind === 'field') {
      if (node.field.key === 'zeroValueReason' && !needsZeroReason(record.data)) return null;
      const f = node.field;
      return <div key={f.key} data-layout-field={f.key} data-field={f.type === 'files' ? f.key : undefined} className={['textarea','files','attrs','json','refs'].includes(f.type) || node.wide ? 'wide' : undefined}>{f.type === 'files' ? <><span>{f.label}</span><FileList ids={Array.isArray(record.data[f.key]) ? record.data[f.key] as number[] : []} files={record.files} /></> : fields([[f.key, f.label]])}</div>;
    }
    return <div key={`${node.block}-${i}`} className="wide">{block(node)}</div>;
  })}</div>;
  const ordered = sections.filter(sec => !(record.warehouseMode && ['sources','production','logistics','total','cost'].includes(sec.id)) && !(record && ['package','oem_package'].includes(key) && sec.id === 'category') && !(key === 'custom' && ['cost','total','photos'].includes(sec.id))).sort((a,b) => Number(a.id === 'gift') - Number(b.id === 'gift'));
  return <>{ordered.map(sec => {
    let nodes = sec.nodes.filter(n => !(key === 'custom' && (n.kind === 'field' && n.field.key === 'note' || n.kind === 'block' && n.block === 'fullName')));
    const extras = ['raw','shipping_material'].includes(key) && sec.id === 'base' ? nodes.filter(n => n.kind === 'field' && n.field.key === 'note' || n.kind === 'block' && n.block === 'fullName') : [];
    if (extras.length) nodes = nodes.filter(n => !extras.includes(n));
    if (sec.id === 'sources') return <Fragment key={sec.id}><ProductSources record={record} canCost={canCost} /></Fragment>;
    if (sec.id === 'production' && nodes.some(n => n.kind === 'block' && n.block === 'composition')) return <Fragment key={sec.id}><ProductComposition record={record} canCost={canCost} /></Fragment>;
    if (['gift','extra'].includes(sec.id)) return <details key={sec.id} data-sec={sec.id} className="finance-detail-extra"><summary>{sec.id === 'gift' ? '赠品简称设置' : sec.title}</summary>{renderNodes(nodes)}</details>;
    return <FinanceSection key={sec.id} title={sec.id === 'stock' && ['package','oem_package'].includes(key) ? '库存' : sec.title} className={`finance-layout-section section-${sec.id}`}>{renderNodes(nodes)}{extras.length > 0 && <div className="finance-layout-extra">{renderNodes(extras)}</div>}{sec.id === 'logistics' && canCost && <FreightHistory productId={record.id} values={record.data} />}</FinanceSection>;
  })}{key === 'custom' && <details className="finance-detail-extra"><summary>更多设置</summary>{sections.filter(sec => ['cost','total','photos'].includes(sec.id)).map(sec => <FinanceSection key={sec.id} title={sec.title}>{renderNodes(sec.nodes)}</FinanceSection>)}{renderNodes(sections.find(sec => sec.id === 'base')?.nodes.filter(n => n.kind === 'field' && n.field.key === 'note' || n.kind === 'block' && n.block === 'fullName') ?? [])}</details>}</>;
}

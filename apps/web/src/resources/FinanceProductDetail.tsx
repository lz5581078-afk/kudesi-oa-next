import { FolderTree } from 'lucide-react';
import { COMPOSITION_GROUP_LABEL, createChecker, getResourceDef, multiplyUnitCents, productLayoutKey, type CompositionGroup } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import type { ResourceDto } from './api';
import { FinanceFields, FinanceSection, DetailRowsState, detailMoney, detailNumber, detailWeight, useFinanceDetailRows } from './FinanceDetailFields';
import { ProductCostSummary } from './ProductCostSummary';
import { CompositionResult, FreightHistory } from './ReferenceProductFields';
import { calculateDraftFacts } from './useProductDraftFacts';
import { referenceRecordLabel } from './referenceFormLayout';
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

/** 24 号源码的查看态有独立字段顺序，不能把新增/编辑表单禁用后充当查看。 */
export function FinanceProductDetail({ record }: { record: ResourceDto }) {
  const { user } = useAuth();
  const canCost = !!user && createChecker(user.permissions)('product.cost.view') && !record.warehouseMode;
  const key = productLayoutKey(record.data), label = referenceRecordLabel(def.key, record.data);
  const packaging = ['package', 'oem_package'].includes(key), purchased = ['purchased_original', 'purchased_oem'].includes(key), self = key === 'self_made';
  const sourceMaterial = ['raw', 'shipping_material'].includes(key);
  const fields = (keys: Array<string | [string, string]>) => <FinanceFields def={def} record={record} keys={keys} />;
  const fullName = <div className="finance-full-name"><small>基础信息全名</small><output>{String(record.data.basicInfoFullName || '未填写')}</output></div>;
  const code = <FinanceSection title={packaging ? key === 'package' ? '产品包装编号' : 'OEM包装编号' : sourceMaterial ? '系统自动编号' : `${label}编号`} className="finance-code-card"><output>{String(record.data.code || '—')}</output></FinanceSection>;
  const capacities = String(record.data.capacities ?? '').split(/\r?\n/).filter(Boolean);
  return <>
    {!packaging && <FinanceSection title="所属分类"><div className="finance-category-value"><FolderTree size={18} /><span>{record.refLabels.categoryId || '未设置分类'}</span></div></FinanceSection>}
    {packaging && code}
    <FinanceSection title={packaging ? '包装基础信息' : '基础资料'}>
      {packaging ? <>{fields(['packagingCategory', ['name', '包装名称'], 'brandId'])}<dl className="finance-view-fields"><div><dt>尺寸</dt><dd>{[record.data.dimensions, record.data.dimensionUnit].filter(Boolean).join(' ') || '未填写'}</dd></div></dl></> : fields([
        ['name', `${label}名称`], ...(!sourceMaterial ? ['brandId'] : []), ['specQty', sourceMaterial ? '规格' : self || purchased ? '名称规格' : '规格数量'], ['specUnit', key === 'shipping_material' ? '规格单位' : key === 'raw' || self || purchased ? '名称单位' : '单位'],
        ...(self ? ['productPackagingSpec', 'productPackagingUnit'] : []), ...(self || purchased ? ['purchaseSpec'] : []), ...(purchased ? ['supplyMode'] : []), ...(sourceMaterial ? [['materialCode', key === 'raw' ? '原料生产编码' : '物料生产编码'] as [string, string]] : []), ...(!sourceMaterial && !self && !purchased ? [['shape', '形态样式'] as [string, string]] : []),
      ])}
      {fields([['note', '备注']])}{fullName}
    </FinanceSection>
    {!packaging && code}
    {packaging && <><FinanceSection title="容量组"><div className="finance-capacities">{capacities.length ? capacities.map((text, i) => <span key={i}>{text}</span>) : '未填写'}</div></FinanceSection><FinanceSection title="生产与重量">{fields(['printingCompany', 'purchaseSpec'])}<dl className="finance-view-fields"><div><dt>重量</dt><dd>{detailWeight(record.data.weightG)}</dd></div></dl></FinanceSection><FinanceSection title="库存">{fields(['orderStock', 'actualStock', ...(canCost ? ['purchasePrice'] : [])])}</FinanceSection></>}
    {!record.warehouseMode && (self || key === 'purchased_oem') && <ProductComposition record={record} canCost={canCost} />}
    {key === 'raw' && <FinanceSection title="原料成品名"><div className="finance-finished-names">{String(record.data.rawFinishedNames ?? '').split(/\r?\n/).filter(Boolean).map((text, i) => <div key={i}><span>{String(i + 1).padStart(2, '0')}</span><input aria-label={`第${i + 1}条成品名`} value={text} readOnly /></div>)}{!record.data.rawFinishedNames && <p>暂无成品名</p>}</div></FinanceSection>}
    {!record.warehouseMode && ['raw', 'shipping_material'].includes(key) && <ProductSources record={record} canCost={canCost} />}
    {!packaging && <FinanceSection title={self ? '计量与成本结果' : purchased ? '采购计价' : key === 'shipping_material' ? '物料重量' : '系统规格与重量'}>{fields([...(key === 'raw' || self ? ['purchaseSpec'] : []), ...(purchased && !record.warehouseMode ? ['supplierId'] : []), ...(canCost && (self || purchased) ? [['purchasePrice', key === 'purchased_oem' ? '原料采购价' : self ? '总采购价' : '采购价'] as [string, string]] : [])])}<dl className="finance-view-fields"><div><dt>{key === 'shipping_material' ? '物料重量' : '称重重量'}</dt><dd>{detailWeight(record.data.weightG)}</dd></div></dl></FinanceSection>}
    {canCost && <><FinanceSection title="运费与装卸费" hint="两项费用分别维护、统一汇总，并与当前系统规格和采购价一起留存历史">{fields(['freight', 'handlingFee'])}<FreightHistory key={record.updatedAt} productId={record.id} values={record.data} /></FinanceSection><ProductCostSummary def={def} record={record} reference /></>}
    <FinanceSection title="商品照片"><FileList ids={Array.isArray(record.data.photos) ? record.data.photos as number[] : []} files={record.files} /></FinanceSection>
  </>;
}

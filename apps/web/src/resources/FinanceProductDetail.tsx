import {useUnitOptions,fieldOptions} from './unitOptions';
import { LOGISTICS_CENT_SCALE, productCapacity, UNIT_OPTIONS, sourcePriceTime, unitYuanText } from '@kudesi/shared';
import { Fragment } from 'react';
import { FolderTree } from 'lucide-react';
import { COMPOSITION_GROUP_LABEL, createChecker, getResourceDef, multiplyUnitCents, productLayoutKey, resolveProductSections, type ResolvedNode, type CompositionGroup } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import type { ResourceDto } from './api';
import { FinanceFields, FinanceSection, DetailRowsState, detailMoney, detailNumber, detailWeight, useFinanceDetailRows } from './FinanceDetailFields';
import { CompositionResult } from './ReferenceProductFields';
import {ProductViewTotal,ProductViewProcurement,ProductViewFreightHistory} from './ProductArchiveViewCosts';
import { calculateDraftFacts } from './useProductDraftFacts';
import {BomDraft,bomDraftRowFromRecord,type BomDraftRow} from './BomDraft';
import { needsZeroReason } from './productFormGrid';
import { FileList } from './FilesField';
import { ProductArchivePhotos } from './ProductArchivePhotos';
import './productArchiveView.css';

const def = getResourceDef('finance-products')!;
const productRef = (row: ResourceDto): [string, number] | null => typeof row.data.laborId === 'number' ? ['finance-labor-costs', row.data.laborId] : typeof row.data.componentId === 'number' ? ['finance-products', row.data.componentId] : null;
const sourceRef = (row: ResourceDto): [string,number] | null => typeof row.data.supplierId==='number' ? ['finance-suppliers',row.data.supplierId] : null;
const sourceUnitMoney = (value: unknown) => { const n = detailNumber(value); if (n === null) return '待补齐'; const [whole, fraction = ''] = unitYuanText(n).split('.'); return `¥${whole}.${fraction.padEnd(3, '0')}`; };

function ProductSources({ record, canCost }: { record: ResourceDto; canCost: boolean }) {
  const { rows, error } = useFinanceDetailRows('finance-product-sources', 'productId', record.id, record.updatedAt, sourceRef);
  const ordered = rows ? [...rows].sort((a, b) => sourcePriceTime(b.row.data.priceUpdatedAt, b.row.updatedAt) - sourcePriceTime(a.row.data.priceUpdatedAt, a.row.updatedAt) || new Date(b.row.updatedAt).getTime()-new Date(a.row.updatedAt).getTime() || b.row.id - a.row.id) : null;
  const latest = ordered?.find(({ row }) => row.status === 'active')?.row.id;
  const shipping=record.data.archiveType==='shipping_material';
  return <section className="finance-view-section raw-supply-source-section" aria-label="供货来源"><div className="raw-view-section-head"><div><strong>供货来源</strong><span>同一{shipping?'发货物料':'原料'}可维护多个产区和供应商；系统采用最近更新的有效采购价作为最新成本。</span></div></div><DetailRowsState error={error} loading={!rows&&!error} empty={false}/><div className="raw-supply-source-list">{ordered?.map(({row,item},index)=><article key={row.id} className={`raw-supply-source-row${row.id===latest?' is-latest':''}`}><header><span>来源 {String(index+1).padStart(2,'0')}</span>{row.id===latest&&<b>当前最新成本</b>}</header><div className="raw-supply-source-grid"><label><span>供应商名称 <em>必填</em></span><input readOnly aria-label="供应商名称" value={row.refLabels.supplierId||''}/><small className="raw-supplier-code-hint">简称编号：{item?String(item.data.shortCode||'未设置'):'暂不可读'}</small></label><label><span>产区 <em>必填</em></span><input readOnly aria-label="产区" placeholder={`请输入${shipping?'发货物料':'原料'}产区`} value={String(row.data.originArea||'')}/></label>{shipping&&<label><span>系统规格 <em>必填</em></span><input readOnly aria-label="来源系统规格" value={String(row.data.systemSpec||'')}/></label>}{canCost&&<label><span className="raw-supply-field-head"><span>采购价 <em>必填</em></span><small>元/{String(shipping?row.data.systemSpec||'系统规格':record.data.purchaseSpec||'系统规格')}</small></span><div className="purchase-price-input"><b>¥</b><input type="number" readOnly aria-label="来源采购价" step="0.000001" value={detailNumber(row.data.purchasePrice)===null?'':unitYuanText(Number(row.data.purchasePrice))}/></div></label>}</div></article>)}</div>{rows?.length===0&&<p className="finance-view-empty">未维护供货来源</p>}</section>;

}

export function ProductComposition({ record, canCost, sourceProfile = false }: { record: ResourceDto; canCost: boolean; sourceProfile?: boolean }) {
  const { rows, error } = useFinanceDetailRows('finance-product-boms', 'productId', record.id, record.updatedAt, productRef);
  const oem = record.data.supplyMode === 'supplier_oem';
  const groups: string[] = oem ? ['oem_package'] : ['raw', 'package', 'oem_package', 'labor'];
  const groupOf = (row: NonNullable<typeof rows>[number]) => row.row.data.laborId || row.row.data.importLineKind==='labor' ? 'labor' : !row.item ? 'unknown' : ['package', 'oem_package'].includes(String(row.item.data.archiveType)) ? String(row.item.data.archiveType) : 'raw';
  if (rows?.some(r => !groups.includes(groupOf(r)))) groups.push('unknown');
  const inGroup = (group: string, r: NonNullable<typeof rows>[number]) => group === 'unknown' ? !groups.filter(g => g !== 'unknown').includes(groupOf(r)) : groupOf(r) === group;
  const facts = calculateDraftFacts((rows ?? []).map(({ row, item }) => ({ kind: row.data.laborId ? 'labor' as const : 'component' as const, id: Number(row.data.laborId || row.data.componentId) || null, group: (row.data.laborId ? 'labor' : item?.data.archiveType === 'package' || item?.data.archiveType === 'oem_package' ? item.data.archiveType : 'raw') as CompositionGroup, qty: detailNumber(row.data.qty) ?? '', loss: detailNumber(row.data.lossPercent) ?? '' })), new Map((rows ?? []).flatMap(({ row, item }) => item ? [[`${row.data.laborId ? 'labor' : 'component'}:${item.id}`, item] as const] : [])), canCost);
  if (sourceProfile) {
    if (rows?.length === 0) return null;
    return <FinanceSection title={oem ? '供应商OEM组成' : '生产资料与成本'}>
      <DetailRowsState error={error} loading={!rows && !error} empty={false} />
      {rows && groups.filter(group => rows.some(row => inGroup(group, row))).map(group => <section key={group} className="base-profile-source-section"><h4>{COMPOSITION_GROUP_LABEL[group as CompositionGroup]?.title ?? '暂不可读的组成'}</h4><dl>{rows.filter(row => inGroup(group, row)).map(({ row, item }) => <div key={row.id}><dt>{item?.title || (row.data.importLineKind==='labor'?String(row.data.importLaborName||'人工费用'):undefined) || row.refLabels.laborId || row.refLabels.componentId || '资料暂不可读'}</dt><dd><span>{detailNumber(row.data.qty) ?? '未维护'} {String(item?.data.purchaseSpec || item?.data.unitName || row.data.unitName || '')}</span>{canCost && <small> · {sourceUnitMoney(item?.data[group === 'labor' ? 'unitPrice' : 'purchasePrice'])}</small>}</dd></div>)}</dl></section>)}
    </FinanceSection>;
  }
  if(rows&&!rows.some(row=>groupOf(row)==='unknown')){
    const draftRows:BomDraftRow[]=rows.map(({row,item})=>bomDraftRowFromRecord(row,item?.data.archiveType));
    const records=new Map(rows.flatMap(({row,item})=>item?[[`${row.data.laborId?'labor':'component'}:${item.id}`,row.data.laborId?{...item,data:{...item.data,unitPrice:row.bomCostFacts?.unitCost??null}}:item] as const]:[]));
    return <FinanceSection title={oem?'供应商OEM组成':'生产资料与成本'} step={oem?'02':undefined} hint={oem?'记录供应商使用公司OEM包装形成外购成品的物理组成':'记录自产成品消耗的原料、产品包装和人工成本'}>
      {!oem&&<><div className="finance-production-overview">{[['原料',['raw']],['包装',['package','oem_package']],['人工',['labor']]].map(([title,keys],index)=><div key={String(title)}><small>{String(index+1).padStart(2,'0')}</small><strong>{title}</strong><span>{rows.filter(row=>(keys as string[]).includes(groupOf(row))).length} 项</span></div>)}</div><p className="product-production-overview-hint">选择档案和用量后，采购价、重量及成本会自动汇总。</p></>}
      <BomDraft reference readOnly groups={(oem?['oem_package']:['raw','package','oem_package','labor']) as CompositionGroup[]} rows={draftRows} records={records} canCost={canCost} onChange={()=>{}}/>
    </FinanceSection>;
  }
  return <FinanceSection title={oem ? '供应商OEM组成' : '生产资料与成本'} hint={oem ? '记录供应商使用公司OEM包装形成外购成品的物理组成' : '记录自产成品消耗的原料、产品包装和人工成本'}>
    <DetailRowsState error={error} loading={!rows && !error} empty={false} />
    {!oem && rows && <div className="finance-production-overview">{[['原料', ['raw']], ['包装', ['package', 'oem_package']], ['人工', ['labor']]].map(([title, keys], i) => <div key={String(title)}><small>{String(i + 1).padStart(2, '0')}</small><strong>{title}</strong><span>{rows.filter(r => (keys as string[]).includes(groupOf(r))).length} 项</span></div>)}</div>}
    {rows && groups.map(group => <section className="finance-production-group" key={group}><h4>{COMPOSITION_GROUP_LABEL[group as CompositionGroup]?.title ?? '暂不可读的组成'}</h4>{!rows.some(r => inGroup(group, r)) ? <p className="finance-view-empty">暂无{COMPOSITION_GROUP_LABEL[group as CompositionGroup]?.title ?? '组成'}</p> : <div className="finance-composition-list">{rows.filter(r => inGroup(group, r)).map(({ row, item }) => {
      const qty = detailNumber(row.data.qty), price = detailNumber(item?.data[group === 'labor' ? 'unitPrice' : 'totalCost']);
      const weight = group === 'labor' ? null : detailNumber(item?.data.weightG);
      let subtotal: number | null = null;
      try { if (qty !== null && price !== null) subtotal = multiplyUnitCents(price, qty, group === 'labor' ? 0 : Number(row.data.lossPercent || 0),6,LOGISTICS_CENT_SCALE); } catch { /* 无效历史行保留为未维护 */ }
      return <article className={`finance-composition-card${oem ? ' is-oem' : ''}`} key={row.id}><div className="finance-composition-main"><label><span>{group === 'labor' ? '人工项目' : group === 'raw' ? '原料档案' : group === 'package' ? '产品包装档案' : 'OEM包装档案'}</span><input value={item?.title || (row.data.importLineKind==='labor'?String(row.data.importLaborName||'人工费用'):undefined) || row.refLabels.laborId || row.refLabels.componentId || '资料暂不可读'} readOnly /></label><small>{item?.refLabels.categoryId || ''} · {String(item?.data.purchaseSpec || item?.data.unitName || '未维护系统规格')}</small></div><div className="finance-composition-metrics"><label><span>{oem ? '个数/用量' : '使用倍数'}</span><input aria-label={`${item?.title || row.id}用量`} value={qty ?? ''} readOnly />{Number(row.data.lossPercent) > 0 && <small>损耗 {String(row.data.lossPercent)}%</small>}</label>{canCost && <><div><span>{group === 'labor' ? '人工单价' : '采购价'}</span><strong>{detailMoney(item?.data[group === 'labor' ? 'unitPrice' : 'purchasePrice'])}</strong></div>{group !== 'labor' && !oem && <div><span>运费 / 装卸费</span><strong>{detailMoney(item?.data.freight)} / {detailMoney(item?.data.handlingFee)}</strong></div>}</>}<div><span>{group === 'raw' ? '每倍重量' : '单件重量'}</span><strong>{group === 'labor' ? '不计重量' : detailWeight(weight)}</strong></div><div className="is-total"><span>{oem ? '包装费用' : '本项成本'}</span>{canCost && <strong>{detailMoney(subtotal)}</strong>}<small>重量 {group === 'labor' ? '不计重量' : detailWeight(qty === null || weight === null ? null : qty * weight)}</small></div></div></article>;
    })}</div>}</section>)}
    {rows && <CompositionResult facts={facts} values={record.data} canCost={canCost} />}
  </FinanceSection>;
}

/** 查看态读取编辑器的同一份分区和节点；业务块保留专用只读展示。 */
export function FinanceProductDetail({ record, onChanged }: { record: ResourceDto; onChanged?:()=>void }) {
  const { user } = useAuth();
  const can = (permission: string) => !!user && createChecker(user.permissions)(permission) && !(record.warehouseMode && ['product.cost.view', 'product.cost.edit', 'product.price.view'].includes(permission));
  const canCost = can('product.cost.view');
  const key = productLayoutKey(record.data);
  const units=useUnitOptions(),systemOptions=fieldOptions(def.fields.find(field=>field.key==='purchaseSpec')!,record.data,units);
  const systemSpec=String(record.data.purchaseSpec||'');
  const sections = resolveProductSections(record.data, { canUse: can });
  const fields = (keys: Array<string | [string, string]>) => <FinanceFields def={def} record={record} keys={keys} plain />;
  const block = (node: Extract<ResolvedNode, { kind: 'block' }>) => {
    switch (node.block) {
      case 'category': return <div data-field="categoryId" className="finance-view-category"><FolderTree size={18} /><strong>{record.refLabels.categoryId || '未填写'}</strong></div>;
      case 'code': return <><small className="product-view-code-hint">{['package','oem_package'].includes(key)?'系统根据分类、品牌、名称和全部适用容量生成':['raw','shipping_material'].includes(key)?`由分类、${key==='raw'?'原料':'发货物料'}名称、规格和${key==='shipping_material'?'规格单位':'名称单位'}自动生成`:'由分类、名称、可选品牌、规格和可选形态样式生成'}</small><output data-field="code" className="finance-code-value">{String(record.data.code || '—')}</output></>;
      case 'fullName': return <div data-field="basicInfoFullName" className="finance-full-name"><small>基础信息全名</small><output>{String(record.data.basicInfoFullName || '未填写')}</output></div>;
      case 'capacities': {
        const capacities = String(record.data.capacities ?? '').split(/\r?\n/).filter(Boolean);
        return <><div data-field="capacities" className="finance-capacities">{capacities.length ? capacities.map((text, i) => {const parsed=productCapacity(text),label=units.spec_unit?.find(option=>option.value===parsed.unit)?.label||UNIT_OPTIONS.find(option=>option.value===parsed.unit)?.label||parsed.unit;return <span key={i}>{parsed.quantityText||'-'} {label}</span>;}) : '未填写'}</div></>;
      }
      case 'finishedNames': {
        const names=String(record.data.rawFinishedNames??'').split(/\r?\n/).filter(Boolean);
        const facts=Array.isArray(record.data.__finishedNameDetails)?record.data.__finishedNameDetails as Array<{name:string;code:string|null;fullName:string}>:[];
        return <div data-field="rawFinishedNames" className="finance-finished-names">{names.map((name,i)=>{const candidates=facts.filter(fact=>fact.name===name),fact=candidates.length===1?candidates[0]:undefined;return <div key={i}><span>{String(i+1).padStart(2,'0')}</span><label><span>原料成品名</span><input aria-label={`第${i+1}条成品名`} value={name} readOnly/></label><label><span>编号</span><output>{fact?.code||'未记录'}</output></label><div className="finance-finished-full-name"><span>原料成品基础信息全名</span><output>{fact?.fullName||'未读取'}</output></div></div>;})}{!names.length&&<p>未配置</p>}</div>;
      }
      case 'supplySources': return <ProductSources record={record} canCost={canCost} />;
      case 'composition': return <ProductComposition record={record} canCost={canCost} />;
      case 'weight': return <><dl className="finance-view-fields"><div data-field="weightG"><dt>{key === 'shipping_material' ? '物料重量' : key==='self_made'?'称重重量':'重量'}</dt><dd>{['package','oem_package'].includes(key)&&typeof record.data.weightG==='number'?`${record.data.weightG/(record.data.weightUnit==='g'?1:record.data.weightUnit==='jin'?500:1000)} ${record.data.weightUnit==='g'?'克':record.data.weightUnit==='jin'?'斤':'千克'}`:key!=='custom'&&detailNumber(record.data.weightG)!==null?`${Number(record.data.weightG)/1000} kg`:detailWeight(record.data.weightG)}</dd></div></dl>{key==='custom'&&fields(node.fields.filter(f => f.key !== 'weightG').map(f => [f.key, f.label]))}</>;
      case 'breakdown': return null; // 组成区已有成本和重量结果。
      case 'costSummary': return canCost ? <><ProductViewTotal record={record} />{record.data.migrationNotice && fields(['migrationNotice'])}</> : null;
    }
  };
  const renderNodes = (nodes: readonly ResolvedNode[]) => <div className="finance-layout-grid">{nodes.map((node, i) => {
    if (node.kind === 'field') {
      if (node.field.key === 'zeroValueReason' && !needsZeroReason(record.data)) return null;
      const f = node.field.key === 'name' ? { ...node.field, label: ({ self_made: '自产成品名称', purchased_original: '原装采购成品名称', purchased_oem: '供应商OEM成品名称' } as Record<string, string>)[key] || node.field.label } : node.field;
      if(f.key==='supplyMode'&&key==='purchased_oem')return <dl key={f.key} className="finance-view-fields"><div data-field={f.key}><dt>{f.label}</dt><dd>供应商OEM</dd></div></dl>;
      if(f.key==='note')return <div key={f.key} data-field="note" className="wide product-view-note"><span>备注</span><p>{String(record.data.note||'未填写')}</p></div>;
      if(['package','oem_package'].includes(key)&&['orderStock','actualStock','purchasePrice'].includes(f.key))return <dl key={f.key} className="finance-view-fields"><div data-field={f.key}><dt>{f.label}</dt><dd>{f.key==='purchasePrice'?`${sourceUnitMoney(record.data.purchasePrice)} / ${String(record.data.purchaseSpec||'系统规格')}`:detailNumber(record.data[f.key])===null?'0.00':Number(record.data[f.key]).toFixed(2)}</dd></div></dl>;
      if(['package','oem_package'].includes(key)&&f.key==='dimensions')return <dl key={f.key} className="finance-view-fields"><div data-field="dimensions"><dt>尺寸</dt><dd data-field="dimensionUnit">{record.data.dimensions?`${String(record.data.dimensions)} ${record.optionLabels?.dimensionUnit||String(record.data.dimensionUnit||'')}`.trim():'未填写'}</dd></div></dl>;
      if (['giftShortName', 'giftCodeShortName'].includes(f.key)) return <label key={f.key} className="finance-gift-field" data-field={f.key}><span>{f.label}</span><input aria-label={f.label} readOnly value={String(record.data[f.key] ?? '')} placeholder={f.key === 'giftShortName' ? '例如：购种合同、拌种剂10克' : '例如：HT、BZJ10G，仅字母和数字'} /></label>;
      return <div key={f.key} data-layout-field={f.key} data-field={f.type === 'files' ? f.key : undefined} className={['textarea','files','attrs','json','refs'].includes(f.type) || node.wide ? 'wide' : undefined}>{f.type === 'files' ? <><span>{f.label}</span><FileList ids={Array.isArray(record.data[f.key]) ? record.data[f.key] as number[] : []} files={record.files} /></> : fields([[f.key, f.label]])}</div>;
    }
    return <div key={`${node.block}-${i}`} className="wide">{block(node)}</div>;
  })}</div>;
  const viewOrder = !['package', 'oem_package'].includes(key) ? ['category', 'gift', 'base', 'code'] : [];
  const ordered = sections.filter(sec => !(!canCost&&['total','cost'].includes(sec.id)) && !(record.warehouseMode && ['sources','production','logistics','total','cost','result','pricing'].includes(sec.id)) && !(record && ['package','oem_package'].includes(key) && sec.id === 'category') && !(key === 'custom' && ['cost','total','photos'].includes(sec.id))).sort((a,b) => { const rank = (id: string) => { const index = viewOrder.indexOf(id); return index < 0 ? viewOrder.length : index; }; return rank(a.id) - rank(b.id); });
  return <div className={`product-archive-view is-${key}`}>{ordered.map(sec => {
    let nodes = sec.nodes.filter(n => !(key!=='custom'&&n.kind==='field'&&['shape','weightManual'].includes(n.field.key))).filter(n => !(key === 'custom' && (n.kind === 'field' && n.field.key === 'note' || n.kind === 'block' && n.block === 'fullName')));
    if(['package','oem_package'].includes(key)){
      if(sec.id==='base')nodes=nodes.filter(n=>!(n.kind==='field'&&n.field.key==='dimensionUnit'));
      if(sec.id==='stock')nodes=nodes.filter(n=>!(n.kind==='field'&&n.field.key==='purchaseSpec'));
      if(sec.id==='production')nodes=[...nodes,{kind:'field',field:def.fields.find(f=>f.key==='purchaseSpec')!}];
    }
    if (sec.id === 'base' && ['self_made', 'purchased_original', 'purchased_oem'].includes(key)) {
      const measured = sections.filter(s => ['measure', 'result', 'pricing'].includes(s.id)).flatMap(s => s.nodes).filter(n => n.kind === 'field' && n.field.key === 'purchaseSpec' || key === 'self_made' && n.kind === 'block' && n.block === 'weight');
      const tail = nodes.filter(n => n.kind === 'field' && n.field.key === 'note' || n.kind === 'block' && n.block === 'fullName');
      nodes = [...nodes.filter(n => !tail.includes(n)), ...measured, ...(key.startsWith('purchased_') ? [{ kind: 'field' as const, field: { ...def.fields.find(f => f.key === 'supplyMode')!, label: '供货方式' } }] : []), ...tail];
    }
    const extras = sec.id === 'base' ? nodes.filter(n => n.kind === 'field' && n.field.key === 'note' || n.kind === 'block' && n.block === 'fullName') : [];
    if (extras.length) nodes = nodes.filter(n => !extras.includes(n));
    if(key==='raw'&&sec.id==='measure')return null;
    if(key==='shipping_material'&&sec.id==='weight'){
      const grams=detailNumber(record.data.weightG),unit=String(record.data.weightUnit||'kg'),factor=unit==='g'?1:unit==='jin'?500:1000;
      return <section key={sec.id} className="finance-view-section shipping-weight-section" aria-label="物料重量"><div className="raw-view-section-head"><strong>物料重量</strong></div><div className="shipping-weight-grid"><label><span>单件重量 <em>必填</em></span><input aria-label="发货物料单件重量" type="number" min="0" step="any" readOnly value={grams===null?'':grams/factor}/></label><label><span>重量单位</span><select aria-label="发货物料重量单位" disabled value={unit}><option value="g">克（g）</option><option value="kg">千克（kg）</option><option value="jin">斤</option></select></label><div className="shipping-weight-result"><span>核算重量</span><output>{grams===null?'未填写':`${grams/1000} kg`}</output></div></div></section>;
    }
    if(sec.id==='logistics')return <section key={sec.id} className="finance-view-section product-view-freight-section" aria-label="运费与装卸费">
      {key==='raw'&&<div className="product-view-measurement"><label><span>系统规格 <em>必填</em></span><select data-field="purchaseSpec" aria-label="系统规格" disabled value={systemSpec}><option value="">请选择系统规格</option>{systemSpec&&!systemOptions.some(option=>option.value===systemSpec)&&<option value={systemSpec}>{systemSpec}</option>}{systemOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label><span>重量（kg） <em>必填</em></span><input data-field="weightG" aria-label="重量（kg）" readOnly type="number" min="0" step="0.000001" value={detailNumber(record.data.weightG)===null?'':Number(record.data.weightG)/1000}/></label></div>}
      <div className="raw-view-section-head"><strong>运费与装卸费</strong><span>两项费用分别维护、统一汇总，并与当前系统规格和采购价一起留存历史</span></div>
      {canCost&&<div className="product-view-freight-detail"><div className="product-view-freight-inputs">{[['freight','运费'],['handlingFee','装卸费']].map(([field,label])=><label key={field}><span>{label}{systemSpec?`（元/${systemSpec}）`:''}</span><div className="purchase-price-input"><b>¥</b><input data-field={field} aria-label={label} type="number" readOnly min="0" step="0.00000001" value={detailNumber(record.data[field])===null?'':unitYuanText(Number(record.data[field]),LOGISTICS_CENT_SCALE)}/></div></label>)}</div><ProductViewFreightHistory record={record}/></div>}
    </section>;
    if (sec.id === 'sources') return <Fragment key={sec.id}><ProductSources record={record} canCost={canCost} /></Fragment>;
    if (sec.id === 'production' && nodes.some(n => n.kind === 'block' && n.block === 'composition')) return <Fragment key={sec.id}><ProductComposition record={record} canCost={canCost} /></Fragment>;
    if (['result','pricing'].includes(sec.id) && ['self_made','purchased_original','purchased_oem'].includes(key)) return <ProductViewProcurement key={sec.id} record={record} canCost={canCost}/>;
    if (sec.id === 'photos') return <FinanceSection key={sec.id} title="档案图片"><ProductArchivePhotos record={record} onChanged={onChanged}/></FinanceSection>;
    if (sec.id === 'extra' && key !== 'custom') return null;
    if (sec.id === 'extra') return <details key={sec.id} data-sec={sec.id} className="finance-detail-extra"><summary>{sec.title}</summary>{renderNodes(nodes)}</details>;
    return <FinanceSection key={sec.id} title={sec.id==='total'?'总成本价（含运费、装卸费）':sec.id === 'base' ? (['package', 'oem_package'].includes(key) ? sec.title : '基础资料') : sec.id === 'code' ? ({ self_made: '自产成品编号', purchased_original: '原装采购成品编号', purchased_oem: '供应商OEM成品编号', package: '产品包装编号', oem_package: 'OEM包装编号' } as Record<string,string>)[key] || sec.title : sec.id === 'stock' && ['package','oem_package'].includes(key) ? '库存' : sec.title} className={`finance-layout-section section-${sec.id}`}>{sec.id === 'gift' && sec.hint && <p className="reference-gift-hint">{sec.hint}</p>}{renderNodes(nodes)}{extras.length > 0 && <div className="finance-layout-extra">{renderNodes(extras)}</div>}{sec.id === 'logistics' && canCost && <ProductViewFreightHistory record={record} />}</FinanceSection>;
  })}{key === 'custom' && <details className="finance-detail-extra"><summary>更多设置</summary>{sections.filter(sec => ['cost','total','photos'].includes(sec.id)).map(sec => <FinanceSection key={sec.id} title={sec.title}>{renderNodes(sec.nodes)}</FinanceSection>)}{renderNodes(sections.find(sec => sec.id === 'base')?.nodes.filter(n => n.kind === 'field' && n.field.key === 'note' || n.kind === 'block' && n.block === 'fullName') ?? [])}</details>}</div>;
}

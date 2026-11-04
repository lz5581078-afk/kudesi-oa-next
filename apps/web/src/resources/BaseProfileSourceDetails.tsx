import { useEffect, useState, type ReactNode } from 'react';
import { FolderTree } from 'lucide-react';
import { getResourceDef, LOGISTICS_CENT_SCALE,sumUnitCents, unitYuanText } from '@kudesi/shared';
import type { ResourceDto } from './api';
import { resourceApi } from './api';
import { displayValue } from './format';
import { BaseProfileSourceExtras } from './BaseProfileSource';
import { currentProductPurchasePrice as sourcePurchasePrice } from './productPurchasePrice';
import { PurchasePriceHistory } from './ProductPurchaseHistory';
import './baseProfileSourceDetails.css';
const number = (v: unknown): number | null => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const money = (value: unknown) => { if (number(value) === null) return '待补齐'; const [whole, fraction = ''] = unitYuanText(Number(value),LOGISTICS_CENT_SCALE).split('.'); return `¥${whole}.${fraction.padEnd(3, '0')}`; };
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="base-source-detail-section" aria-label={title}><header><strong>{title}</strong>{hint && <span>{hint}</span>}</header>{children}</section>;
}
function ReadField({ label, value, suffix, prefix }: { label: string; value: unknown; suffix?: string; prefix?: string }) {
  return <label><span>{label}</span><div className="base-source-read-input">{prefix && <b>{prefix}</b>}<input aria-label={label} readOnly value={String(value ?? '')}/>{suffix && <b>{suffix}</b>}</div></label>;
}
export { currentProductPurchasePrice as sourcePurchasePrice } from './productPurchasePrice';
function SourceFreightHistory({ source }: { source: ResourceDto }) {
  const [open, setOpen] = useState(false), [rows, setRows] = useState<ResourceDto[] | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true; setRows(null); setError('');
    (async () => {
      const rows: ResourceDto[] = [];
      for (let page = 1; alive; page++) {
        const result = await resourceApi.list('finance-product-freight-history', { fieldKey: 'productId', fieldValue: source.id, page, pageSize: 200, showHidden: true });
        if (!alive) return;
        rows.push(...result.items); if (!result.items.length || rows.length >= result.total) break;
      }
      if (alive) setRows(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id));
    })().catch(() => { if (alive) setError('历史运费装卸费读取失败'); });
    return () => { alive = false; };
  }, [open, source.id]);
  return <><button type="button" className="secondary-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>历史运费装卸费</button>{open && <div>{error ? <p role="alert">{error}</p> : rows === null ? <p>读取中…</p> : !rows.length ? <p>暂无历史运费装卸费。</p> : rows.map(row => <div className="base-source-history-row" key={row.id}><strong>{number(row.data.freight) === null || number(row.data.handlingFee) === null ? '待补齐' : money(sumUnitCents([Number(row.data.freight), Number(row.data.handlingFee)],LOGISTICS_CENT_SCALE))}</strong><span>运费 {money(row.data.freight)}</span><span>装卸费 {money(row.data.handlingFee)}</span><span>系统规格 {String(row.data.systemSpec || row.data.purchaseSpec || '—')}</span><span>{source.data.supplyMode === 'supplier_oem' ? '原料采购价' : '采购价'} {money(row.data.purchasePrice)}</span><span>{new Date(row.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</span></div>)}</div>}</>;
}
export function BaseProfileSourceDetails({ source, canCost }: { source: ResourceDto; canCost: boolean }) {
  const d = source.data, type = String(d.archiveType), oem = d.supplyMode === 'supplier_oem';
  const packaging = ['package', 'oem_package'].includes(type), raw = ['raw', 'shipping_material'].includes(type), purchased = type === 'purchased';
  const name = type === 'raw' ? '原料' : type === 'shipping_material' ? '发货物料' : oem ? '供应商 OEM 成品' : purchased ? '原装采购成品' : type === 'self_made' ? '自产成品' : '产品包装';
  const def = getResourceDef('finance-products')!;
  const formatted = (key: string) => { const field = def.fields.find(field => field.key === key); return field ? displayValue(field, source) : String(d[key] ?? ''); };
  const spec = String(d.purchaseSpec || ''), purchase = sourcePurchasePrice(source), freight = number(d.freight), handling = number(d.handlingFee), total = number(d.totalCost);
  const packageUnit = String(d.weightUnit || 'g');
  const packageWeight = number(d.weightG) === null ? '—' : `${Number(d.weightG) / (packageUnit === 'kg' ? 1000 : packageUnit === 'jin' ? 500 : 1)} ${{g:'克',kg:'千克',jin:'斤'}[packageUnit] || packageUnit}`;
  const logistics = freight === null || handling === null ? null : sumUnitCents([freight, handling],LOGISTICS_CENT_SCALE);
  return <div className="base-source-details">
    {!packaging && <Section title="所属分类"><div className="base-source-category"><FolderTree size={18}/><span>{source.refLabels.categoryId || '未设置分类'}</span></div></Section>}
    {packaging && <Section title={type === 'oem_package' ? 'OEM包装编号' : '产品包装编号'} hint="系统根据分类、品牌、名称和全部适用容量生成"><output className="base-source-code">{String(d.code || '—')}</output></Section>}
    <Section title={packaging ? '包装基础信息' : '基础资料'}><dl className="base-source-static-fields">
      {packaging && <div><dt>包装类别</dt><dd>{formatted('packagingCategory') || '未填写'}</dd></div>}
      <div><dt>{packaging ? '包装' : name}名称</dt><dd>{String(d.name || source.title || '—')}</dd></div>
      {!raw && <div><dt>品牌</dt><dd>{source.refLabels.brandId || '未填写'}</dd></div>}
      {!packaging && <><div><dt>{raw ? '规格' : '名称规格'}</dt><dd>{String(d.specQty ?? '—')}</dd></div>
      <div><dt>{type === 'shipping_material' ? '规格单位' : '名称单位'}</dt><dd>{formatted('specUnit') || '—'}</dd></div></>}
      {raw && <div><dt>{type === 'shipping_material' ? '物料' : '原料'}生产编码</dt><dd>{String(d.materialCode || '未填写')}</dd></div>}
      {purchased && <><div><dt>系统规格</dt><dd>{spec || '未填写'}</dd></div><div><dt>供货方式</dt><dd>{oem ? '供应商OEM' : '原装采购'}</dd></div></>}
      {packaging && <div><dt>尺寸</dt><dd>{[d.dimensions, formatted('dimensionUnit')].filter(Boolean).join(' ') || '未填写'}</dd></div>}
    </dl></Section>
    {!packaging && <Section title={type === 'raw' ? '系统自动编号' : `${name}编号`}><output className="base-source-code">{String(d.code || '—')}</output></Section>}
    {packaging && <><Section title="容量组"><div className="base-source-capacities">{String(d.capacities || '').split(/\r?\n/).filter(Boolean).map((value, index) => <span key={index}>{value}</span>)}{!String(d.capacities || '').trim() && <span>未填写</span>}</div></Section><Section title="生产与重量"><dl className="base-source-static-fields"><div><dt>包装印刷公司</dt><dd>{String(d.printingCompany || '未填写')}</dd></div><div><dt>重量</dt><dd>{packageWeight}</dd></div><div><dt>系统规格</dt><dd>{spec || '未填写'}</dd></div></dl></Section><Section title="库存"><dl className="base-source-static-fields"><div><dt>订单库存</dt><dd>{Number(d.orderStock || 0).toFixed(2)}</dd></div><div><dt>实际库存</dt><dd>{Number(d.actualStock || 0).toFixed(2)}</dd></div>{canCost && <div><dt>采购价</dt><dd>{purchase === null ? '未填写' : `${money(purchase)} / ${spec || '系统规格'}`}</dd></div>}</dl></Section></>}

    <BaseProfileSourceExtras source={source} canCost={canCost}/>
    {purchased && <Section title="采购计价" hint="系统规格用于采购价和后续业务单据"><div className="base-source-procurement"><ReadField label="称重重量" value={number(d.weightG) === null ? '' : Number(d.weightG) / 1000} suffix="kg"/></div>{canCost && <PurchasePriceHistory key={source.id+":"+source.updatedAt} record={source} total={oem} priceField={<ReadField label={`${oem ? '总采购价' : '采购价'}${spec ? `（元/${spec}）` : ''}`} value={purchase === null ? '' : unitYuanText(purchase,LOGISTICS_CENT_SCALE)} prefix="¥"/>}/>}</Section>}
    {canCost && <><Section title="运费与装卸费" hint="两项费用分别维护、统一汇总"><div className="base-source-logistics"><ReadField label={`运费${spec ? `（元/${spec}）` : ''}`} value={freight === null ? '' : unitYuanText(freight,LOGISTICS_CENT_SCALE)} prefix="¥"/><ReadField label={`装卸费${spec ? `（元/${spec}）` : ''}`} value={handling === null ? '' : unitYuanText(handling,LOGISTICS_CENT_SCALE)} prefix="¥"/><div><small>运费装卸费汇总</small><strong>{money(logistics)}</strong></div><div><small>关联系统规格</small><strong>{spec || '未维护'}</strong></div><div><small>关联采购价</small><strong>{money(purchase)}</strong></div></div><SourceFreightHistory key={`${source.id}:${source.updatedAt}`} source={source}/></Section>
    <Section title="总成本价（含运费、装卸费）"><div className="base-source-totals"><div><small>采购价</small><strong>{money(purchase)}</strong></div><div><small>运费＋装卸费</small><strong>{money(logistics)}</strong></div><div><small>总成本价{spec ? `（元/${spec}）` : ''}</small><strong>{total === null ? '待补齐核算资料' : money(total)}</strong></div></div></Section></>}
  </div>;
}

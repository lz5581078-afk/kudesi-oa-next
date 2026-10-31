import { useEffect, useState } from 'react';
import { createChecker, multiplyUnitCents, sumUnitCents } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { DetailRowsState, FinanceSection, detailMoney, detailNumber, detailWeight, useFinanceDetailRows, type DetailRow } from './FinanceDetailFields';
import { referenceRecordLabel } from './referenceFormLayout';

const baseRef = (row: ResourceDto): [string, number] | null => typeof row.data.productId === 'number' ? ['finance-products', row.data.productId] : null;
const bundleRef = (row: ResourceDto): [string, number] | null => typeof row.data.laborId === 'number' ? ['finance-labor-costs', row.data.laborId] : typeof row.data.baseCodeId === 'number' ? ['finance-base-codes', row.data.baseCodeId] : null;
const times = (value: unknown, qty: unknown) => {
  const price = detailNumber(value), count = detailNumber(qty);
  if (price === null || count === null) return null;
  try { return multiplyUnitCents(price, count); } catch { return null; }
};
const total = (values: Array<number | null>) => values.length && values.every((n): n is number => n !== null) ? sumUnitCents(values) : null;

function CodeSummary({ record, source }: { record: ResourceDto; source?: ResourceDto | null }) {
  const bundle = record.type === 'finance-bundles', d = record.data;
  // 自动款式编码使用统一命名器的 +ZP- 赠品段；手改款式无法据此推断主款式。
  const mainStyle = d.mainStyleCode || (!d.manualStyleCode ? String(d.styleCode || '').split('+ZP-')[0] : '');
  const category = [record.refLabels.categoryId || record.refLabels.codeCategoryId || source?.refLabels.categoryId, record.refLabels.codeBrandId || source?.refLabels.brandId, d.varietyName].filter(Boolean).join(' / ');
  const facts = [
    { title: '商品名称', value: d.name || record.title, sub: d.shortName },
    ...(bundle ? [{ title: '主款式编码', value: mainStyle, sub: '不包含赠品' }] : []),
    { title: '款式编码', value: d.styleCode },
    { title: bundle ? '平台' : '分类 / 品牌 / 品种', value: bundle ? record.refLabels.platformId : category },
    { title: '规格', value: bundle ? d.propertiesValue : d.spec || [source?.data.specQty, source?.data.specUnit].filter(v => v != null && v !== '').join(''), sub: bundle ? d.costVersionName : undefined },
  ];
  return <div className={`finance-code-summary${bundle ? ' is-bundle' : ''}`}>{facts.map(f => <div key={f.title}><span>{f.title}</span><strong>{String(f.value ?? '—') || '—'}</strong>{!!f.sub && <small>{String(f.sub)}</small>}</div>)}</div>;
}

function ComponentTable({ rows, bundle = false, canCost, canPrice }: { rows: DetailRow[]; bundle?: boolean; canCost: boolean; canPrice: boolean }) {
  return <div className="finance-detail-table"><table><thead><tr><th>{bundle ? '商品' : '商品档案'}</th><th>规格</th><th>数量</th>{canCost && <th>成本小计</th>}{(!bundle && canCost || bundle && canPrice) && <th>{bundle ? '销售小计' : '采购小计'}</th>}<th>重量小计</th></tr></thead><tbody>{rows.map(({ row, item }) => {
    const d = item?.data ?? {}, qty = detailNumber(row.data.qty), weight = detailNumber(d.weightG);
    const cost = times(d[bundle ? 'cost' : 'totalCost'], qty), other = bundle && row.data.role === 'gift' ? qty !== null && qty > 0 ? 0 : null : times(d[bundle ? 'salePrice' : 'purchasePrice'], qty);
    return <tr key={row.id} className={row.data.role === 'gift' ? 'finance-gift-line' : undefined}><td><strong>{String(d.name || item?.title || row.refLabels.productId || row.refLabels.baseCodeId || '资料暂不可读')}</strong><small>{String(d.code || '无编码')}{!bundle && item ? ` · ${referenceRecordLabel('finance-products', d)}` : ''}</small></td><td>{String(d.spec || d.purchaseSpec || [d.specQty, d.specUnit].filter(v => v != null && v !== '').join('') || row.data.unit || '—')}</td><td>{qty ?? '—'}</td>{canCost && <td>{detailMoney(cost)}</td>}{(!bundle && canCost || bundle && canPrice) && <td>{detailMoney(other)}</td>}<td>{detailWeight(qty === null || weight === null ? null : qty * weight)}</td></tr>;
  })}</tbody></table></div>;
}

interface References { level: string; label: string; items: Array<{ source: string; sourceId: number; sourceLabel: string; name: string; detail: string }> }
function BaseReferences({ record }: { record: ResourceDto }) {
  const [refs, setRefs] = useState<References | null>(null), [error, setError] = useState('');
  useEffect(() => { let alive = true; setRefs(null); setError(''); api<References>(`/finance/base-codes/${record.id}/references`).then(r => alive && setRefs(r)).catch(e => alive && setError(e instanceof Error ? e.message : '引用读取失败')); return () => { alive = false; }; }, [record.id, record.updatedAt]);
  return <FinanceSection title="引用情况" hint={refs && <span className={`pill ${refs.level === 'effective' ? 'warn' : 'ok'}`}>{refs.label}</span>}>{error ? <p role="alert">引用情况读取失败：{error}</p> : !refs ? <p>读取中…</p> : !refs.items.length ? <p className="finance-view-empty">当前没有组合 BOM 或聚水潭普通商品镜像引用。</p> : <div className="finance-reference-list">{refs.items.map((r, i) => <div key={`${r.source}:${r.sourceId}:${i}`}><strong>{r.sourceLabel} · {r.name}</strong><span>{r.detail}</span></div>)}</div>}</FinanceSection>;
}

export function FinanceBaseCodeDetail({ record }: { record: ResourceDto }) {
  const { user } = useAuth();
  const canCost = !!user && createChecker(user.permissions)('product.cost.view');
  const [source, setSource] = useState<ResourceDto | null>(null), [sourceError, setSourceError] = useState('');
  const [canonical, setCanonical] = useState<ResourceDto | null>(null);
  useEffect(() => { let alive = true; setSource(null); setSourceError(''); setCanonical(null);
    (async () => {
      const base = typeof record.data.canonicalId === 'number' ? await resourceApi.get('finance-base-codes', record.data.canonicalId) : record;
      if (alive) setCanonical(base);
      if (typeof base.data.productId === 'number') {
        const found = await resourceApi.get('finance-products', base.data.productId);
        if (alive) setSource(found);
      } else if (alive && base.data.origin !== 'composed') setSourceError('未关联来源商品档案');
    })().catch(e => alive && setSourceError(e instanceof Error ? e.message : '来源资料暂不可读'));
    return () => { alive = false; };
  }, [record]);
  const { rows, error } = useFinanceDetailRows('finance-base-code-lines', 'baseCodeId', Number(record.data.canonicalId) || record.id, record.updatedAt, baseRef);
  const composed = (canonical ?? record).data.origin === 'composed';
  const components = composed ? rows : source ? [{ row: { ...source, data: { qty: 1 }, refLabels: {} }, item: source }] : null;
  const cost = components ? total(components.map(r => times(r.item?.data.totalCost, r.row.data.qty))) : null;
  const purchase = components ? total(components.map(r => times(r.item?.data.purchasePrice, r.row.data.qty))) : null;
  return <><CodeSummary record={record} source={source} /><FinanceSection title="商品组成明细" hint={components ? `共 ${components.length} 项` : undefined}>
    <DetailRowsState error={sourceError || error} loading={!components && !sourceError && !error} empty={components?.length === 0} />
    {components && components.length > 0 && <><ComponentTable rows={components} canCost={canCost} canPrice={false} /><div className="finance-detail-total"><span>合计</span>{canCost && <><b>成本 {detailMoney(record.data.cost ?? cost)}</b><b>采购 {detailMoney(record.data.purchasePrice ?? purchase)}</b></>}<b>重量 {detailWeight(record.data.weightG)}</b></div></>}
  </FinanceSection><BaseReferences record={record} /></>;
}

export function FinanceBundleDetail({ record }: { record: ResourceDto }) {
  const { user } = useAuth();
  const can = user ? createChecker(user.permissions) : () => false;
  const { rows, error } = useFinanceDetailRows('finance-bundle-lines', 'bundleId', record.id, record.updatedAt, bundleRef);
  const roles = new Set(['main', 'package', 'gift', 'labor']);
  const groups = [['main', '主商品'], ['package', '包装'], ['gift', '赠品'], ['other', '其他组成']];
  const labor = rows?.filter(r => r.row.data.role === 'labor');
  return <><CodeSummary record={record} /><DetailRowsState error={error} loading={!rows && !error} empty={false} />{rows && groups.map(([role, title]) => {
    const lines = rows.filter(r => role === 'other' ? !roles.has(String(r.row.data.role)) : r.row.data.role === role);
    return <FinanceSection key={role} title={title} hint={`${lines.length} 项`} className={`role-${role}`}>{lines.length ? <ComponentTable rows={lines} bundle canCost={can('product.cost.view')} canPrice={can('product.price.view')} /> : <p className="finance-view-empty">{role === 'package' ? '当前BOM未维护包装组成。' : '无'}</p>}</FinanceSection>;
  })}{!!labor?.length && <FinanceSection title="人工" hint={`${labor.length} 项`}>{labor.map(({ row, item }) => <div className="finance-labor-row" key={row.id}><strong>{item?.title || row.refLabels.laborId || '人工资料暂不可读'}</strong><span>{String(row.data.qty ?? '—')} {String(item?.data.unitName || row.data.unit || '')}</span>{can('product.cost.view') && <span>{detailMoney(times(item?.data.unitPrice, row.data.qty))}</span>}</div>)}</FinanceSection>}</>;
}

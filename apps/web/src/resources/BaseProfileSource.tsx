import { useEffect, useState } from 'react';
import { createChecker, unitYuanText } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { resourceApi, type ResourceDto } from './api';
import { ProductComposition } from './FinanceProductDetail';

export function BaseProfileSourceExtras({ source, canCost: allowedCost = true }: { source: ResourceDto; canCost?: boolean }) {
  const { user } = useAuth();
  const [state, setState] = useState<{ key: string; rows: ResourceDto[] | null; error: string }>({ key: '', rows: null, error: '' });
  const [retry, setRetry] = useState(0);
  const canCost = allowedCost && !!user && createChecker(user.permissions)('product.cost.view');
  const hasComposition = source.data.archiveType === 'self_made' || source.data.archiveType === 'purchased' && source.data.supplyMode === 'supplier_oem';
  const hasSources = ['raw', 'shipping_material'].includes(String(source.data.archiveType));
  const key = JSON.stringify([user?.companyId, user?.id, source.id, source.updatedAt, hasSources, user?.permissions]);
  useEffect(() => {
    if (!hasSources) return;
    let alive = true;
    setState({ key, rows: null, error: '' });
    (async () => {
      const rows: ResourceDto[] = [];
      for (let page = 1; alive; page++) {
        const result = await resourceApi.list('finance-product-sources', { fieldKey: 'productId', fieldValue: source.id, page, pageSize: 200 });
        if (!alive) return;
        rows.push(...result.items);
        if (!result.items.length || rows.length >= result.total) break;
      }
      if (alive) setState({ key, rows, error: '' });
    })().catch(() => { if (alive) setState({ key, rows: null, error: '供货来源暂不可读。' }); });
    return () => { alive = false; };
  }, [key, retry]);
  const { rows: sources, error } = state.key === key ? state : { rows: null, error: '' };
  return <>
    {hasSources && <section className="base-source-detail-section" aria-label="供货来源"><header><strong>供货来源</strong><span>同一{source.data.archiveType === 'shipping_material' ? '发货物料' : '原料'}可维护多个产区和供应商</span></header>
      {error ? <p role="alert">{error}<button type="button" onClick={() => setRetry(n => n + 1)}>重试</button></p> : sources === null ? <p>读取中…</p> : !sources.length ? <p className="base-profile-source-empty">未维护供货来源</p> : sources.map((row, index) => {
        const spec = String(row.data.systemSpec || source.data.purchaseSpec || '');
        return <section key={row.id} className="base-source-supply-row"><header>来源 {String(index + 1).padStart(2, '0')}</header><div className="base-source-supply-grid">
          <label><span>供应商名称</span><input readOnly value={row.refLabels.supplierId || ''}/></label>
          <label><span>产区</span><input readOnly value={String(row.data.originArea || '')}/></label>
          <label><span>系统规格</span><input readOnly value={spec}/></label>
          {canCost && <label><span>采购价{spec && <small>元/{spec}</small>}</span><div className="base-source-read-input"><b>¥</b><input readOnly value={row.data.purchasePrice == null ? '' : unitYuanText(Number(row.data.purchasePrice))}/></div></label>}
        </div></section>;
      })}
    </section>}
    {hasComposition && <ProductComposition key={key} record={source} canCost={canCost} sourceProfile/>}
  </>;
}

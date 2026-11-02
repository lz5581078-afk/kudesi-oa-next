import type { LiveProductEntry, LiveProductSnapshot } from '@kudesi/shared';

export const productLabel = (p: LiveProductSnapshot) => `${p.name || p.code}${p.spec ? `（${p.spec}）` : ''}`;
export const productText = (products?: LiveProductSnapshot[]) => products?.map(productLabel).join('、') || '未填写';
export const emptyManualProduct = (): LiveProductSnapshot => ({ id: null, code: '', name: '', spec: '' });
export const productEntries = (products: LiveProductSnapshot[]): LiveProductEntry[] => products
  .filter((p) => p.id !== null || p.name.trim())
  .map((p) => p.id === null ? { name: p.name.trim() } : { productId: p.id });

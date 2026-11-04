import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { resourceFields } from './resourceFieldLayout';
import { FinanceFields } from './FinanceDetailFields';
import type { ResourceDto } from './api';
const scope = vi.hoisted(() => ({ allow: [] as string[] }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, companyId: 1, permissions: { isCompanyAdmin: false, allow: scope.allow, deny: [] } } }) }));
afterEach(cleanup);
describe('上传内容布局继承多项查看权限', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])('成本=%s 价格=%s才同时满足payload查看', (cost, price) => {
    scope.allow = [...(cost ? ['product.cost.view'] : []), ...(price ? ['product.price.view'] : [])];
    const def = getResourceDef('finance-jst-uploads')!, payload = '{"costPrice":1.2345,"salePrice":2.3456}';
    const record: ResourceDto = { id: 1, type: def.key, title: 'SYNTHETIC-SKU', status: 'queued', statusReason: null, data: { skuId: 'SYNTHETIC-SKU', payload }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' };
    expect(resourceFields(def, record.data, record.status, key => scope.allow.includes(key)).some(field => field.key === 'payload')).toBe(cost && price);
    render(<FinanceFields def={def} record={record} keys={['skuId', 'payload']} />);
    expect(screen.getByText('SYNTHETIC-SKU')).toBeTruthy(); expect(!!screen.queryByText(payload)).toBe(cost && price);
  });
});

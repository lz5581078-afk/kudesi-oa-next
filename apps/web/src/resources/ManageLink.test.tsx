import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { ManageLink } from './ManageLink';

afterEach(cleanup);
describe('商品表单的管理入口', () => {
  const f = (k: string) => getResourceDef('finance-products')!.fields.find((x) => x.key === k)!;
  it('单位、品牌、供应商字段有“管理”链接，在新标签页打开；普通字段没有', () => {
    render(<><ManageLink field={f('specUnit')} /><ManageLink field={f('brandId')} /><ManageLink field={f('supplierId')} /><ManageLink field={f('name')} /></>);
    for (const n of ['管理单位与规格', '管理品牌', '管理供应商']) {
      const a = screen.getByRole('link', { name: n }) as HTMLAnchorElement;
      expect(a.target).toBe('_blank');
      expect(a.getAttribute('href')).toMatch(/^\//);
    }
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });
});

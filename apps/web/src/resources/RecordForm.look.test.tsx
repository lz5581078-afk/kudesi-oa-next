import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS } from '@kudesi/shared';

const auth = { user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const list = vi.fn();
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return {
    ...mod,
    resourceApi: { ...mod.resourceApi, create: (...a: unknown[]) => create(...a), update: (...a: unknown[]) => update(...a), remove: (...a: unknown[]) => remove(...a), similarCheck: vi.fn().mockResolvedValue({ blocked: [], warnings: [] }), list: (...a: unknown[]) => list(...a), get: vi.fn().mockResolvedValue({ id: 1, title: '组件', data: { archiveType: 'raw' } }) },
    draftApi: { ...mod.draftApi, get: vi.fn().mockResolvedValue({ draft: null }), save: vi.fn(), remove: vi.fn() },
  };
});
import { RecordForm } from './RecordForm';

const def = FINANCE_RESOURCE_DEFS.find((d) => d.key === 'finance-products')!;
const saved = { id: 9, type: 'finance-products', title: '苹果', status: 'active', statusReason: null, data: {}, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '' };

beforeEach(() => {
  create.mockReset().mockResolvedValue(saved);
  update.mockReset().mockResolvedValue(saved);
  remove.mockReset().mockResolvedValue({});
  list.mockReset().mockImplementation(async (type: string) => (type === 'finance-suppliers' ? { items: [{ id: 3, title: '供应商甲', status: 'active', data: {} }], total: 1 } : { items: [], total: 0 }));
});
afterEach(cleanup);


const open = (initial: Record<string, unknown>) => render(<RecordForm def={def} record={null} initial={initial} onClose={() => undefined} onSaved={() => undefined} />);

describe('24号商品档案表单：上下文、双列字段、零值说明', () => {
  it('分区提示在标题旁，分类用上下文卡片，不显示侧边分区导航', () => {
    const { container } = open({ archiveType: 'raw' });
    expect(container.querySelector('.rf-sec-hint')).toBeNull();
    expect([...container.querySelectorAll('.rf-sec small.muted')].filter((e) => !e.closest('.files-input'))).toHaveLength(0); // 照片区的“不超过 10 MB”只在 CSS 里收起
    expect(container.querySelector('.rf-sec-title small')).toBeTruthy();
    const anchors = [...container.querySelectorAll('.rf-anchors .rf-anchor')];
    expect(anchors.length).toBe(0); // 手机端这一排横向滑动成分区标签
    expect(container.querySelectorAll('.rf-anchors i').length).toBe(0);
    expect(container.querySelector('.required-hint')).toBeNull();
  });

  it('零值说明默认不出现，运费填 0 后才出现；规格和单位使用双列字段', () => {
    const { container } = open({ archiveType: 'raw', specQty: 500 });
    expect(container.querySelector('[data-field="zeroValueReason"]')).toBeNull();
    expect(container.querySelector('[data-field="specQty"]')?.className).toContain('s6');
    expect(container.querySelector('[data-field="specUnit"]')?.className).toContain('s6');
    expect(container.querySelector('[data-field="freight"]')?.className).toContain('s6');
    expect(container.querySelector('[data-field="handlingFee"]')?.className).toContain('s6');
    cleanup();
    const again = open({ archiveType: 'raw', freight: 0 });
    expect(again.container.querySelector('[data-field="zeroValueReason"]')).toBeTruthy();
  });

  it('“管理单位与规格”改成单位字段旁的小链接', () => {
    const { container } = open({ archiveType: 'raw' });
    const link = container.querySelector('[data-field="specUnit"] a.rf-manage') as HTMLAnchorElement;
    expect(link.getAttribute('aria-label')).toBe('管理单位与规格');
    expect(link.textContent).toBe('管理名称单位');
  });
});

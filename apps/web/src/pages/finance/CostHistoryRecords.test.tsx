import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CostHistoryRecords } from './CostHistoryRecords';
import type { CostSnapshotRow } from './financeApi';
afterEach(cleanup);
const row = (id = 1): CostSnapshotRow => ({ id, bundleId: 7, code: `SKU-${id}`, name: `合成SKU${id}`, revision: 2, reason: '合成变更原因', actorName: '合成操作人', createdAt: '2026-10-24T00:00:00Z', eventLabel: '验证更新成本', preShipCostCents: 123.4567, weightG: 1023.2, freightCents: 0, marginPercent: null, minPriceCents: 200, before: { code: 'SKU-OLD', name: '旧名称', preShipCostCents: 100, weightG: 1000, freightCents: null, marginPercent: null, minPriceCents: 150 }, changes: [{ field: 'preShipCostCents', label: '发货前成本', before: 100, after: 123.4567 }] });
describe('成本历史逐字段对照', () => {
  it('展开后展示全部留存字段，成本三位元和kg，未知与零分开', () => {
    render(<CostHistoryRecords rows={[row()]} />);
    expect(screen.queryByText('变更前')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看记录1' }));
    expect(screen.getByText('SKU-OLD')).toBeTruthy();
    expect(screen.getByText('旧名称')).toBeTruthy();
    expect(screen.getByText('¥1.235')).toBeTruthy();
    expect(screen.getByText('1.0232')).toBeTruthy();
    const freight = screen.getByText('历史固定运费').closest('tr')!;
    expect(within(freight).getByText('未设置')).toBeTruthy();
    expect(within(freight).getByText('¥0.000')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看记录1' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '查看记录1' }));
    expect(screen.queryByText('变更前')).toBeNull();
  });
  it('首版缺少前值显示未记录，保持一次只展开一条', () => {
    render(<CostHistoryRecords rows={[{ ...row(), before: null, changes: [], revision: 1 }, row(2)]} />);
    fireEvent.click(screen.getByRole('button', { name: '查看记录1' }));
    expect(screen.getAllByText('未记录')).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: '查看记录2' }));
    expect(screen.getAllByText('变更前')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '查看记录1' }).getAttribute('aria-expanded')).toBe('false');
  });
});

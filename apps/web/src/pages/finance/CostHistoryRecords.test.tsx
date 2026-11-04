import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CostHistoryRecords, CostMarginHistoryRecords } from './CostHistoryRecords';
import type { CostSnapshotRow } from './financeApi';
afterEach(cleanup);
const row = (id = 1): CostSnapshotRow => ({ id, bundleId: 7, code: `SKU-${id}`, name: `合成SKU${id}`, revision: 2, reason: '合成变更原因', actorName: '合成操作人', createdAt: '2026-10-24T00:00:00Z', eventLabel: '验证更新成本', preShipCostCents: 123.4567, productCostCents: 123.4567, categoryId: 3, carrierName: '合成快递', weightG: 1023.2, freightCents: 0, marginPercent: null, explicitMarginPercent: null, minPriceCents: 200, before: { code: 'SKU-OLD', name: '旧名称', preShipCostCents: 100, weightG: 1000, freightCents: null, marginPercent: null, explicitMarginPercent: null, minPriceCents: 150 }, changes: [{ field: 'preShipCostCents', label: '发货前成本', before: 100, after: 123.4567 }] });
describe('成本历史逐字段对照', () => {
  it('展开后展示全部留存字段，成本最多六位元和kg，未知与零分开', () => {
    render(<CostHistoryRecords rows={[row()]} />);
    expect(screen.queryByText('变更前')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看记录1' }));
    expect(screen.getByText('SKU-OLD')).toBeTruthy();
    expect(screen.getByText('旧名称')).toBeTruthy();
    expect(screen.getAllByText('¥1.234567')).toHaveLength(2);
    expect(screen.getByText('合成快递')).toBeTruthy();
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
    expect(screen.getAllByText('未记录')).toHaveLength(9);
    fireEvent.click(screen.getByRole('button', { name: '查看记录2' }));
    expect(screen.getAllByText('变更前')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '查看记录1' }).getAttribute('aria-expanded')).toBe('false');
  });
  it('利润率显示当时的单品覆盖值，未知、继承及明确零值分开，不拿生效20%补未知', () => {
    const entries = [
      { ...row(1), marginPercent: 20, explicitMarginPercent: undefined },
      { ...row(2), marginPercent: 20, explicitMarginPercent: null },
      { ...row(3), marginPercent: 0, explicitMarginPercent: 0 },
    ];
    render(<CostHistoryRecords rows={entries} />);
    for (const [index, expected] of ['未记录', '未设置', '0%'].entries()) {
      fireEvent.click(screen.getByRole('button', { name: `查看记录${index + 1}` }));
      const cells = screen.getByText('利润率').closest('tr')!.querySelectorAll('td');
      expect(cells[1].textContent).toBe(expected);
    }
    expect(screen.queryByText('20%')).toBeNull();
  });
});


it('分类利润率历史逐行展开原前后值，未设置继承与0%明确区分', () => {
  render(<CostMarginHistoryRecords rows={[{id:'margin-1',createdAt:'2026-11-03T00:00:00Z',actorName:'合成人员',scopeName:'苹果分类',beforePercent:null,afterPercent:0,reason:''},{id:'margin-2',createdAt:'2026-11-03T00:00:00Z',actorName:'合成人员',scopeName:'梨分类',beforePercent:12.345678,afterPercent:null,reason:'合成原因'}]}/>);
  fireEvent.click(screen.getByRole('button',{name:'查看分类记录margin-1'}));
  expect(screen.getByText('未设置')).toBeTruthy();expect(screen.getByText('0%')).toBeTruthy();
  expect(screen.getByText('未设置表示继承上级规则。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'查看分类记录margin-2'}));
  expect(screen.queryByText('0%')).toBeNull();expect(screen.getByText('12.345678%')).toBeTruthy();
  expect(screen.getAllByText('变更前')).toHaveLength(1);
});

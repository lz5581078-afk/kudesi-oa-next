import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkuSpec, WarehouseSpec } from '@kudesi/shared';
import { api } from '../../api/client';
import { SkuApplyFields, SkuPreview, SkuWarehouseFields } from './SkuApply';

vi.mock('../../api/client', async (orig) => ({ ...(await orig<typeof import('../../api/client')>()), api: vi.fn() }));
const apiMock = vi.mocked(api);

function Harness({ initial }: { initial: Record<string, unknown> }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <SkuApplyFields values={v} onChange={(k, x) => setV((c) => ({ ...c, [k]: x }))} />
      <pre data-testid="out">{JSON.stringify(v)}</pre>
    </>
  );
}

beforeEach(() => {
  apiMock.mockImplementation(async (path: string) => {
    if (path.includes('kind=meta')) return { scenarios: [{ id: 5, name: '标准' }], platforms: [{ id: 1, name: '淘宝' }, { id: 2, name: '抖音' }], bundleCategories: [{ id: 9, name: '礼盒 / 水果礼盒' }] };
    if (path.includes('kind=main')) return { items: [{ id: 11, code: 'APPLE-A', name: '苹果', spec: '5斤' }] };
    if (path.includes('kind=names')) return { items: [{ id: 11, code: 'APPLE-A', name: '苹果' }] };
    return { items: [] };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SKU 批量申请表单', () => {
  it('可以选场景、平台，添加规格并搜索主商品', async () => {
    render(<Harness initial={{ specs: [] }} />);
    await screen.findByText('淘宝');
    fireEvent.click(screen.getByLabelText('淘宝'));
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('组合分类'), { target: { value: '9' } });
    fireEvent.click(screen.getByText('＋ 添加规格'));
    fireEvent.change(screen.getByLabelText('规格 1 名称'), { target: { value: '苹果礼盒' } });
    fireEvent.click(screen.getByText('＋ 添加主商品'));
    fireEvent.click(await screen.findByText('APPLE-A', {}, { timeout: 2000 }));
    await waitFor(() => {
      const out = JSON.parse(screen.getByTestId('out').textContent!);
      expect(out.platformIds).toEqual([1]);
      expect(out.scenarioId).toBe(5);
      expect(out.bundleCategoryId).toBe(9);
      expect(out.specs[0]).toMatchObject({ name: '苹果礼盒', main: [{ baseCodeId: 11, qty: 1 }], gift: [] });
    });
  });

  it('重新提交时，已填的商品按编号回填名称', async () => {
    const specs: SkuSpec[] = [{ name: '旧规格', main: [{ baseCodeId: 11, qty: 2 }], gift: [] }];
    render(<Harness initial={{ specs }} />);
    expect(await screen.findByText('APPLE-A 苹果')).toBeTruthy();
  });
});

describe('仓库配置与规格明细', () => {
  it('没选物料的类别要求填写不需要的原因', () => {
    const onChange = vi.fn();
    const specs: SkuSpec[] = [{ name: '规格甲', main: [{ baseCodeId: 11, qty: 1 }], gift: [] }];
    render(<SkuWarehouseFields specs={specs} values={{}} onChange={onChange} />);
    expect(screen.getAllByText(/不需要.*的原因/)).toHaveLength(4); // 包装、标签/说明书、其他打包材料、人工
    fireEvent.change(screen.getAllByPlaceholderText('没有选物料时必须写明原因')[0], { target: { value: '客户自备' } });
    const sent = onChange.mock.calls[0][1] as WarehouseSpec[];
    expect(sent[0].notRequired.package).toBe('客户自备');
  });

  it('规格明细：没有成本权限时不显示成本列；显示将生成的编码和是否沿用已有', async () => {
    apiMock.mockResolvedValueOnce({
      runId: 1, status: 'running', batchName: '测试', scenario: '标准', platforms: [{ id: 1, name: '淘宝' }], warehouseDone: true, canCost: false, planError: '', costNote: '',
      specs: [{ name: '甲', note: '', reuseReason: '', weightG: 100, notRequired: {}, lines: [{ roleLabel: '主商品', code: 'APPLE-A', name: '苹果', qty: 2, weightG: 50 }], warehouse: [], targets: [{ platformName: '淘宝', code: 'ZH-TB-APPLE-A*2', name: '组合-苹果×2', reuse: null }], created: [] }],
    });
    render(<SkuPreview runId={1} refreshKey={0} />);
    expect(await screen.findByText('ZH-TB-APPLE-A*2')).toBeTruthy();
    expect(screen.queryByText('单价成本')).toBeNull();
    expect(screen.getByText('新建')).toBeTruthy();
  });
});

describe('SKU 批量申请：复制与套用', () => {
  it('复制规格带出商品；删除有内容的规格要先确认；仓库配置可套用到其他规格', async () => {
    const specs: SkuSpec[] = [{ name: '苹果礼盒', main: [{ baseCodeId: 11, qty: 2 }], gift: [] }];
    render(<Harness initial={{ specs }} />);
    await screen.findByText('淘宝');
    fireEvent.click(screen.getByText('复制这个规格'));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('out').textContent!).specs).toHaveLength(2));
    const copy = JSON.parse(screen.getByTestId('out').textContent!).specs[1];
    expect(copy).toMatchObject({ name: '苹果礼盒（副本）', main: [{ baseCodeId: 11, qty: 2 }] });
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getAllByText('删除这个规格')[1]);
    expect(JSON.parse(screen.getByTestId('out').textContent!).specs).toHaveLength(2);
    fireEvent.click(screen.getAllByText('删除这个规格')[1]);
    await waitFor(() => expect(JSON.parse(screen.getByTestId('out').textContent!).specs).toHaveLength(1));
    expect(ask).toHaveBeenCalledTimes(2);
    ask.mockRestore();
  });

  it('仓库配置：把一个规格的包装等套用到其他规格', async () => {
    const specs: SkuSpec[] = [{ name: 'A', main: [], gift: [] }, { name: 'B', main: [], gift: [] }];
    const first: WarehouseSpec = { lines: [{ role: 'package', baseCodeId: 31, qty: 1 }], notRequired: { label: '无' } };
    function WH() {
      const [v, setV] = useState<Record<string, unknown>>({ config: [first, { lines: [], notRequired: {} }] });
      return <><SkuWarehouseFields specs={specs} values={v} onChange={(k, x) => setV((c) => ({ ...c, [k]: x }))} /><pre data-testid="wh">{JSON.stringify(v)}</pre></>;
    }
    render(<WH />);
    fireEvent.click(screen.getByLabelText('把规格 A 的配置套用到其他规格'));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('wh').textContent!).config[1]).toEqual(first));
  });
});


describe('SKU 批量申请：数量系列、独立办理、历史配置', () => {
  it('数量系列：按 1,2,5 生成三个规格（主商品数量不同，赠品照旧）；输入不合法会提示', async () => {
    const specs: SkuSpec[] = [{ name: '苹果礼盒', main: [{ baseCodeId: 11, qty: 1 }], gift: [{ baseCodeId: 12, qty: 1 }] }];
    render(<Harness initial={{ specs }} />);
    await screen.findByText('淘宝');
    fireEvent.change(screen.getByLabelText('规格 1 数量系列'), { target: { value: '1, 1' } });
    fireEvent.click(screen.getByText('按数量生成规格'));
    expect(screen.getByRole('alert').textContent).toContain('不重复的正整数');
    fireEvent.change(screen.getByLabelText('规格 1 数量系列'), { target: { value: '1, 2，5' } });
    fireEvent.click(screen.getByText('按数量生成规格'));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('out').textContent!).specs).toHaveLength(4));
    const out = JSON.parse(screen.getByTestId('out').textContent!).specs;
    expect(out.slice(1).map((x: SkuSpec) => [x.name, x.main[0].qty, x.gift.length])).toEqual([['苹果礼盒 · 1件', 1, 1], ['苹果礼盒 · 2件', 2, 1], ['苹果礼盒 · 5件', 5, 1]]);
  });

  it('两个以上规格才出现“独立办理”，勾选写进表单值', async () => {
    const specs: SkuSpec[] = [{ name: 'A', main: [{ baseCodeId: 11, qty: 1 }], gift: [] }];
    render(<Harness initial={{ specs }} />);
    await screen.findByText('淘宝');
    expect(screen.queryByLabelText(/每个规格独立办理/)).toBeNull();
    fireEvent.click(screen.getByText('＋ 添加规格'));
    fireEvent.click(screen.getByLabelText(/每个规格独立办理/));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('out').textContent!).splitSpecs).toBe(true));
  });

  it('仓库：复用历史配置（按主商品列出，填入后带出物料名称，已有内容先确认）', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.includes('history-config')) return { items: [{ runId: 7, title: 't', specName: '旧规格', exact: true, status: 'completed', config: { lines: [{ role: 'package', baseCodeId: 31, qty: 2 }], notRequired: { label: '没有标签' } } }], names: { b31: 'BOX-A 纸箱' } };
      return { items: [] };
    });
    const specs: SkuSpec[] = [{ name: 'A', main: [{ baseCodeId: 11, qty: 1 }], gift: [] }];
    function WH() {
      const [v, setV] = useState<Record<string, unknown>>({});
      return <><SkuWarehouseFields specs={specs} values={v} onChange={(k, x) => setV((c) => ({ ...c, [k]: x }))} /><pre data-testid="wh">{JSON.stringify(v)}</pre></>;
    }
    render(<WH />);
    fireEvent.click(screen.getByLabelText('复用规格 A 的历史仓库配置'));
    await screen.findByText(/申请 #7 · 主商品相同/);
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('mainIds=11'));
    fireEvent.click(screen.getByLabelText('填入申请 #7 的配置'));
    await screen.findByText(/已复用历史配置/);
    expect(screen.getByText('BOX-A 纸箱')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('wh').textContent!).config[0]).toEqual({ lines: [{ role: 'package', baseCodeId: 31, qty: 2 }], notRequired: { label: '没有标签' } });
  });
});

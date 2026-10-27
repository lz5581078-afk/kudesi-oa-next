import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from '../../../resources/api';
import { BundleManualDialog } from './BundleManualDialog';
import { BundleVerifyDialog, GenerateDialog } from './BundleDialogs';
import { LineEditor, toLineInput, type LineRow } from './BundleLineEditor';
import { jstApi } from './jstApi';
import { useState } from 'react';

vi.mock('./jstApi', async (orig) => {
  const real = await orig<typeof import('./jstApi')>();
  return { ...real, jstApi: { bundleReport: vi.fn(), bundleVerify: vi.fn(), bundlePreview: vi.fn(), bundleGenerate: vi.fn() } };
});
vi.mock('../../../resources/api', async (orig) => {
  const real = await orig<typeof import('../../../resources/api')>();
  return { ...real, resourceApi: { list: vi.fn(), categoryTree: vi.fn(), update: vi.fn(), get: vi.fn() } };
});
const j = vi.mocked(jstApi);
const r = vi.mocked(resourceApi);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const dto = (over: Record<string, unknown> = {}) => ({ id: 7, title: 'ZH-A', status: 'verified', data: { code: 'ZH-A', name: '组合A', ...over }, refLabels: {} }) as never;

describe('组合构成行编辑器', () => {
  function Harness() {
    const [rows, setRows] = useState<LineRow[]>([{ role: 'main', baseCodeId: 3, qty: 2, label: 'APPLE' }]);
    return <><LineEditor rows={rows} onChange={setRows} /><pre data-testid="out">{JSON.stringify(rows.map(toLineInput))}</pre></>;
  }
  it('展开“更多”能填单位、损耗率、必需、进聚水潭、成本归集/处理、排序、生效失效日', () => {
    r.list.mockResolvedValue({ items: [], total: 0 } as never);
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('单位'), { target: { value: 'J' } });
    fireEvent.click(screen.getByText('更多'));
    fireEvent.change(screen.getByLabelText('损耗率'), { target: { value: '3' } });
    fireEvent.click(screen.getByLabelText('必需'));
    fireEvent.click(screen.getByLabelText('进入聚水潭组合装'));
    fireEvent.change(screen.getByLabelText('成本归集'), { target: { value: 'production' } });
    fireEvent.change(screen.getByLabelText('成本处理'), { target: { value: 'reference_only' } });
    fireEvent.change(screen.getByLabelText('排序'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('生效日'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('失效日'), { target: { value: '2026-12-31' } });
    expect(JSON.parse(screen.getByTestId('out').textContent!)[0]).toEqual({
      role: 'main', baseCodeId: 3, qty: 2, unit: 'J', lossRate: 3, isRequired: false, includeInJst: false, costBucket: 'production', costTreatment: 'reference_only', sortOrder: 2, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31',
    });
  });
  it('用途里有辅料，可加人工行', () => {
    render(<LineEditor rows={[]} allowLabor onChange={() => undefined} />);
    expect(screen.getByText('＋ 加人工')).toBeTruthy();
  });
});

describe('批量生成：组合分类必选', () => {
  it('没选组合分类不能检查；选了以后带着分类去预览', async () => {
    r.list.mockImplementation(async (type: string) => ({ items: type === 'finance-platforms' ? [{ id: 1, title: '淘宝', data: {} }] : type === 'finance-scenarios' ? [{ id: 2, title: '自销', data: {} }] : type === 'finance-base-codes' ? [{ id: 3, title: 'APPLE', data: { name: '苹果' } }] : [], total: 1 }) as never);
    r.categoryTree.mockResolvedValue({ field: 'bundleCategoryId', total: 0, uncategorized: 0, nodes: [{ id: 5, title: '礼盒', status: 'active', parentId: 0, sort: 0, count: 0 }, { id: 6, title: '水果礼盒', status: 'active', parentId: 5, sort: 0, count: 0 }] } as never);
    j.bundlePreview.mockResolvedValue({ targets: [], namingRule: false });
    render(<GenerateDialog onClose={() => undefined} onDone={() => undefined} />);
    fireEvent.focus(screen.getByLabelText('基础编码'));
    fireEvent.click(await screen.findByRole('option', { name: /APPLE/ }));
    fireEvent.click(await screen.findByLabelText(/淘宝/));
    const check = screen.getByRole('button', { name: '保存前检查' }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText('礼盒 / 水果礼盒')).toBeTruthy());
    expect(check.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('组合分类'), { target: { value: '6' } });
    expect(check.disabled).toBe(false);
    fireEvent.click(check);
    await waitFor(() => expect(j.bundlePreview).toHaveBeenCalled());
    expect(j.bundlePreview.mock.calls[0][1][0]).toMatchObject({ platformId: 1, scenarioId: 2, bundleCategoryId: 6 });
  });
});

describe('手改编码和名称', () => {
  it('填了手改值必须写原因；清空全部就恢复自动', async () => {
    r.update.mockResolvedValue({} as never);
    render(<BundleManualDialog bundle={dto()} onClose={() => undefined} onDone={() => undefined} />);
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('组合名称'), { target: { value: '新名字' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('改码改名原因'), { target: { value: '平台要求改名' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(r.update).toHaveBeenCalled());
    expect(r.update.mock.calls[0][2]).toMatchObject({ manualName: '新名字', manualReason: '平台要求改名' });
  });
});

describe('核对验证：问题清单', () => {
  it('列出全部验证问题，有问题的不能验证', async () => {
    j.bundleReport.mockResolvedValue({
      id: 1, code: 'ZH-A', name: '组合A', styleCode: '', shortName: '', status: 'pending', components: [], totalWeightG: 0, pendingRevision: null, signature: 's', issues: ['组合分类不存在或已停用', '规格值未填写'],
      secondVerification: false, baselineMissing: false, changes: [], outbound: { sku_id: 'ZH-A', i_id: '', name: '组合A', short_name: '', weight: 0 }, uploadSignature: 'u', uploadedCode: null, replacing: false, jstStatus: 'not_synced',
    });
    render(<BundleVerifyDialog ids={[1]} isAdmin onClose={() => undefined} onDone={() => undefined} />);
    expect(await screen.findByText('规格值未填写')).toBeTruthy();
    expect(screen.getByText(/验证前需要先处理这 2 个问题/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '验证 0 个' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

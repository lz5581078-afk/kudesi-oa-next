import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFlowTemplate } from '@kudesi/shared';
import { api } from '../../api/client';
import { FlowFieldsForm } from './FlowFields';
import { PurchasePanel } from './PurchasePanel';

vi.mock('../../api/client', async (orig) => ({ ...(await orig<typeof import('../../api/client')>()), api: vi.fn() }));
vi.mock('../../resources/RecordForm', async (orig) => ({
  ...(await orig<typeof import('../../resources/RecordForm')>()),
  RefSelect: ({ onChange }: { onChange: (v: number | null) => void }) => <select aria-label="入库仓库" onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}><option value="">选仓库</option><option value="3">一号仓</option></select>,
}));
const apiMock = vi.mocked(api);
const tpl = getFlowTemplate('purchase-request')!;

function Harness({ fields, initial, step, context }: { fields: typeof tpl.fields; initial: Record<string, unknown>; step?: boolean; context?: Record<string, unknown> }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <FlowFieldsForm fields={[...fields]} templateKey="purchase-request" values={v} context={step ? context : undefined} onChange={(k, x) => setV((c) => ({ ...c, [k]: x }))} />
      <pre data-testid="out">{JSON.stringify(v)}</pre>
    </>
  );
}
const out = () => JSON.parse(screen.getByTestId('out').textContent!);

beforeEach(() => {
  apiMock.mockImplementation(async (path: string) => {
    if (path.includes('/flow/purchase/options?keyword')) return { items: [{ id: 11, code: 'APPLE', name: '苹果', spec: '千克' }] };
    if (path.includes('/flow/purchase/options?ids')) return { items: [{ id: 11, code: 'APPLE', name: '苹果', spec: '' }, { id: 12, code: 'PEAR', name: '梨', spec: '' }] };
    return {};
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('采购申请表单', () => {
  it('搜索商品、加入明细、改数量单位；已选的不再出现在搜索结果里', async () => {
    render(<Harness fields={tpl.fields} initial={{ lines: [] }} />);
    fireEvent.click(screen.getByText('＋ 添加商品'));
    fireEvent.click(await screen.findByText('APPLE', {}, { timeout: 2000 }));
    await waitFor(() => expect(out().lines).toEqual([{ productId: 11, qty: 1 }]));
    fireEvent.change(await screen.findByLabelText('数量'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText('单位'), { target: { value: '箱' } });
    expect(out().lines).toEqual([{ productId: 11, qty: 2.5, unit: '箱' }]);
  });
  it('预计单价按元输入，存成“分”（最多 4 位小数）', async () => {
    render(<Harness fields={tpl.fields} initial={{ lines: [{ productId: 11, qty: 100 }] }} />);
    const input = await screen.findByLabelText('苹果单价（元）');
    fireEvent.change(input, { target: { value: '12.505' } });
    expect(out().estimates).toEqual([{ productId: 11, unitPriceCents: 1250.5 }]);
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(out().estimates).toEqual([]);
  });
});

describe('办理表单', () => {
  it('采购方案：按申请里的商品逐个填单价', async () => {
    render(<Harness step fields={tpl.stepFields.plan} initial={{}} context={{ lines: [{ productId: 11, qty: 2 }, { productId: 12, qty: 1 }] }} />);
    fireEvent.change(await screen.findByLabelText('梨单价（元）'), { target: { value: '8' } });
    expect(out().prices).toEqual([{ productId: 12, unitPriceCents: 800 }]);
    // 系统算出的金额是只读字段，不在表单里出现（readonly 在表单里不显示金额输入也不影响提交）
    expect(screen.getByLabelText('梨单价（元）')).toBeTruthy();
  });
  it('到货验收：默认每个商品一行，合格数量跟着到货数量走', async () => {
    apiMock.mockImplementation(async (path: string) => (path.includes('/summary') ? { canSeeMoney: false, lines: [{ productId: 11, code: 'A', name: '苹果', qty: 2, unit: '', note: '', received: 1, accepted: 1 }], supplier: null, orderNo: null, paymentMode: null, promisedArrivalDate: null, inbound: null, canGenerateDraft: false, acceptedCount: 0 } : { items: [{ id: 11, code: 'APPLE', name: '苹果', spec: '' }] }));
    render(<Harness step fields={tpl.stepFields.receive} initial={{}} context={{ lines: [{ productId: 11, qty: 2 }], _runId: 5 }} />);
    await waitFor(() => expect(out().lines).toEqual([{ productId: 11, receivedQty: 0, acceptedQty: 0 }]));
    fireEvent.change(screen.getByLabelText('苹果本次到货数量'), { target: { value: '1.5' } });
    expect(out().lines).toEqual([{ productId: 11, receivedQty: 1.5, acceptedQty: 1.5 }]);
    fireEvent.change(screen.getByLabelText('苹果本次合格数量'), { target: { value: '1' } });
    expect(out().lines).toEqual([{ productId: 11, receivedQty: 1.5, acceptedQty: 1 }]);
    expect(await screen.findByText(/已累计到货 1、合格 1/)).toBeTruthy();
  });
  it('下单：账期付款时不显示付款账户、金额、流水号', () => {
    render(<Harness step fields={tpl.stepFields.order} initial={{ paymentMode: 'credit' }} />);
    expect(screen.queryByText('付款账户')).toBeNull();
    expect(screen.queryByText(/本次付款金额/)).toBeNull();
    cleanup();
    render(<Harness step fields={tpl.stepFields.order} initial={{ paymentMode: 'prepay' }} />);
    expect(screen.getByText('付款账户')).toBeTruthy();
  });
});

describe('采购摘要', () => {
  const base = { canSeeMoney: false, lines: [{ productId: 11, code: 'APPLE', name: '苹果', qty: 100, unit: '箱', note: '', received: null, accepted: null }], supplier: { id: 1, name: '果园' }, orderNo: 'PO-1', paymentMode: 'prepay', promisedArrivalDate: '2026-10-10', inbound: null, canGenerateDraft: false, acceptedCount: 0 };
  it('没有成本权限：不显示金额和单价列，并提示原因', async () => {
    apiMock.mockResolvedValue(base);
    render(<PurchasePanel runId={1} refreshKey={0} onChanged={() => undefined} />);
    expect(await screen.findByText('果园')).toBeTruthy();
    expect(screen.queryByText('采购金额')).toBeNull();
    expect(screen.queryByText('单价')).toBeNull();
    expect(screen.getByText(/成本查看/)).toBeTruthy();
  });
  it('有权限：显示金额；入库登记时选仓库后生成草稿', async () => {
    apiMock.mockImplementation(async (path: string, opts?: unknown) => {
      if (path.includes('inbound-draft')) { void opts; return { docId: 9, docNo: 'CGRK20261010001', already: false }; }
      return { ...base, canSeeMoney: true, totalCents: 127050, paidCents: 127050, lines: [{ ...base.lines[0], unitPriceCents: 1250.5 }], canGenerateDraft: true, acceptedCount: 1 };
    });
    const changed = vi.fn();
    render(<PurchasePanel runId={1} refreshKey={0} onChanged={changed} />);
    expect((await screen.findAllByText('¥1,270.50')).length).toBeGreaterThan(0);
    expect(screen.getByText('¥12.505')).toBeTruthy();
    const btn = screen.getByText('生成采购入库单草稿') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('入库仓库'), { target: { value: '3' } });
    fireEvent.click(btn);
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(apiMock.mock.calls.some(([p, o]) => String(p).includes('inbound-draft') && JSON.stringify((o as { body: unknown }).body) === '{"warehouseId":3}')).toBe(true);
    expect(await screen.findByText(/已生成采购入库单草稿 CGRK20261010001/)).toBeTruthy();
  });
});

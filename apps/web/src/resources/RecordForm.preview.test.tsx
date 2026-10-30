import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TotalCostPreview } from './RecordForm';

afterEach(cleanup);
describe('商品表单：总成本预览', () => {
  it('采购价 + 运费 + 装卸费 实时相加', () => {
    render(<TotalCostPreview values={{ archiveType: 'purchased', purchasePrice: 1000, freight: 250, handlingFee: 50 }} />);
    expect(screen.getByLabelText('总成本预览').textContent).toContain('= ¥13');
  });
  it('什么都没填时不显示；自制品没有采购价时提示去构成页签', () => {
    const { container } = render(<TotalCostPreview values={{ archiveType: 'raw' }} />);
    expect(container.textContent).toBe('');
    cleanup();
    render(<TotalCostPreview values={{ archiveType: 'self_made', freight: 100 }} />);
    expect(screen.getByRole('status').textContent).toContain('构成（BOM）');
  });
  it('未完成的非法单价不导致预览崩溃，微额报价按定点规则汇总', () => {
    const {unmount}=render(<TotalCostPreview values={{archiveType:'raw',purchasePrice:NaN}} idle/>);
    expect(screen.getByLabelText('总成本预览').textContent).toContain('—');
    unmount();
    render(<TotalCostPreview values={{archiveType:'raw',purchasePrice:.0001,freight:.0002,handlingFee:.0003}}/>);
    expect(screen.getByLabelText('总成本预览').querySelector('.rf-total-sum strong')?.textContent).toBe('¥0.000006');
  });

});

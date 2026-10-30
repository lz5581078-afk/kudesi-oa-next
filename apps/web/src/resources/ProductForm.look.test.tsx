import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { FieldHint } from './FieldHint';
import { fieldSpan, needsZeroReason } from './productFormGrid';
import { WeightBlock } from './ProductFormParts';
import { TotalCostPreview } from './RecordForm';

afterEach(cleanup);
const f = (k: string) => getResourceDef('finance-products')!.fields.find((x) => x.key === k)!;

describe('商品表单外观：减字、栅格、汇总条', () => {
  it('说明文字默认不当正文渲染，悬停提示（ⓘ）带着文字', () => {
    const { container } = render(<label><span className="rf-label">规格<FieldHint text="与名称单位一起参与编码" /></span><input /></label>);
    expect(container.querySelector('small.muted')).toBeNull();
    const tip = screen.getByLabelText('与名称单位一起参与编码');
    expect(tip.getAttribute('data-tip')).toBe('与名称单位一起参与编码');
    fireEvent.mouseEnter(tip);
    expect(tip.dataset.pos).toBeTruthy();
    expect(render(<FieldHint text="" />).container.textContent).toBe('');
  });

  it('栅格：采购价/运费/装卸费并排（4），规格数量+单位+包装规格短字段四个一行（3），长文本和照片整行（12）', () => {
    expect(['purchasePrice', 'freight', 'handlingFee'].map((k) => fieldSpan(f(k)))).toEqual([4, 4, 4]);
    expect(['specQty', 'specUnit', 'productPackagingSpec', 'productPackagingUnit'].map((k) => fieldSpan(f(k)))).toEqual([3, 3, 3, 3]);
    expect(['name', 'brandId'].map((k) => fieldSpan(f(k)))).toEqual([6, 6]);
    for (const k of ['note', 'capacities', 'photos', 'zeroValueReason', 'basicInfoFullName', 'categoryId']) expect(fieldSpan(f(k)), k).toBe(12);
    // 栅格合计：运费区三项并排刚好一行
    expect(fieldSpan(f('purchasePrice')) * 3).toBe(12);
  });

  it('零值说明只在采购价/运费/装卸费明确填 0（或已写过说明）时才需要出现', () => {
    expect(needsZeroReason({})).toBe(false);
    expect(needsZeroReason({ freight: '', handlingFee: 0.2 })).toBe(false);
    expect(needsZeroReason({ freight: 0 })).toBe(true);
    expect(needsZeroReason({ handlingFee: '0' })).toBe(true);
    expect(needsZeroReason({ freight: 1, zeroValueReason: '装卸费：自提' })).toBe(true);
  });

  it('重量块：人工修正和输入同一行，自动换算说明改成一行短字 + ⓘ', () => {
    const { container } = render(<WeightBlock values={{ archiveType: 'raw', weightG: 500 }} onChange={() => undefined} manualOnly={false} />);
    expect(container.querySelector('.rf-weight > .rf-check')).toBeTruthy();
    expect(container.querySelector('.rf-auto')?.textContent).toBe('自动换算：500 克');
    expect(container.querySelector('.rf-check .rf-hint')).toBeTruthy();
    expect(container.querySelector('small.muted')).toBeNull();
  });

  it('总成本汇总条：采购价 + 运费 + 装卸费 = 总成本；没填时用 — 占位也画出来', () => {
    render(<TotalCostPreview values={{ archiveType: 'purchased', purchasePrice: 100, freight: 50, handlingFee: 25 }} idle />);
    const bar = screen.getByLabelText('总成本预览');
    expect(bar.querySelector('.rf-total-sum strong')?.textContent).toBe('¥1.75');
    cleanup();
    const { container } = render(<TotalCostPreview values={{ archiveType: 'raw' }} idle />);
    expect(container.querySelector('.rf-total-sum strong')?.textContent).toBe('—');
  });
});

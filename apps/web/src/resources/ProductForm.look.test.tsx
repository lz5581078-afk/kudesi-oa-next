import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it,vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import { FieldHint } from './FieldHint';
import { fieldSpan, needsZeroReason } from './productFormGrid';
import { WeightBlock } from './ProductFormParts';
import {formatCompositionCost} from './FinanceCompositionPicker';
import { MoneyControl,TotalCostPreview } from './RecordForm';

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

it('原版商品重量为独立人工修正按钮，自动值只读且不会写回缺失事实',()=>{const change=vi.fn();render(<WeightBlock reference defaultUnit="kg" values={{archiveType:'raw'}} onChange={change} manualOnly={false}/>);expect((screen.getByLabelText('重量') as HTMLInputElement).readOnly).toBe(true);expect((screen.getByLabelText('重量') as HTMLInputElement).value).toBe('0');expect(change).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'人工修正重量'}));expect(change).toHaveBeenCalledWith({weightManual:true});});
it('原版商品新建成本预览最低三位，仅展示空预览不修改金额事实',()=>{const values={archiveType:'raw'};render(<TotalCostPreview reference emptyAsZero values={values} idle/>);expect(screen.getByLabelText('总成本预览').querySelector('.rf-total-sum strong')?.textContent).toBe('¥0.000');expect(values).toEqual({archiveType:'raw'});});

it('旧档案未知金额保持待补齐，不能借新建0预览推成历史事实',()=>{render(<TotalCostPreview reference values={{archiveType:'raw',purchasePrice:100}} idle/>);expect(screen.getByLabelText('总成本预览').querySelector('.rf-total-sum strong')?.textContent).toBe('待补齐');});

it('原价显示保留8位元事实且至少3位，输入显示不截旧价也不改6位输入契约',()=>{expect(formatCompositionCost(0.000001,6)).toBe('¥0.00000001');expect(formatCompositionCost(100)).toBe('¥1.000');expect(formatCompositionCost(20.0001)).toBe('¥0.200001');const change=vi.fn();render(<MoneyControl value={0.000001} scale={4} displayDecimals={8} appearance={{nativeNumber:true,currency:'¥'}} ariaLabel="原采购价" onChange={change}/>);const input=screen.getByLabelText('原采购价') as HTMLInputElement;expect(input.value).toBe('0.00000001');expect(input.step).toBe('0.000001');expect(change).not.toHaveBeenCalled();});
it('自产重量为只读kg无人工按钮；包装原单位选择重解释当前数值而发货物料保持物理换算',()=>{const change=vi.fn(),view=render(<WeightBlock reference automaticOnly fixedUnit="kg" defaultUnit="kg" values={{archiveType:'self_made',weightG:1500,weightManual:true}} onChange={change} manualOnly={false}/>);expect((screen.getByLabelText('重量') as HTMLInputElement).readOnly).toBe(true);expect((screen.getByLabelText('重量') as HTMLInputElement).value).toBe('1.5');expect(screen.queryByRole('button',{name:'人工修正重量'})).toBeNull();expect(screen.queryByRole('combobox')).toBeNull();view.unmount();render(<WeightBlock reference referencePackaging values={{archiveType:'package',weightG:14,weightUnit:'g'}} onChange={change} manualOnly/>);expect([...((screen.getByLabelText('重量输入单位') as HTMLSelectElement).options)].map(option=>option.value)).toEqual(['g','kg']);fireEvent.change(screen.getByLabelText('重量输入单位'),{target:{value:'kg'}});expect(change).toHaveBeenLastCalledWith({weightUnit:'kg',weightManual:true,weightG:14000});});

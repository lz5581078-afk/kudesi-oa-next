import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferenceLines } from './ReferenceProductFields';
import { resetUnitOptionsForTest } from './unitOptions';
vi.mock('./ManageLink', () => ({ ManageLink: ({ onChoose }: { onChoose: (value: string) => void }) => <button type="button" aria-label="管理单位" onClick={() => onChoose('ROLL')}>管理单位</button> }));
afterEach(cleanup);
beforeEach(() => resetUnitOptionsForTest({ spec_unit: [{ value: 'G', label: '克' }, { value: 'KG', label: '千克' }, { value: 'ROLL', label: '卷' }] }));
function Form({ initial = '', defaultUnit }: { initial?: string; defaultUnit?: string }) { const [value, setValue] = useState(initial); return <><ReferenceLines kind="capacities" defaultUnit={defaultUnit} value={value} onChange={setValue} /><output aria-label="保存容量">{value}</output><button type="button" onClick={() => setValue('')}>清空表单</button></>; }
describe('包装容量行交互', () => {
  it('初始至少一行，先选单位再填数量以及清空数量都保留单位', () => {
    render(<Form />);
    expect(screen.getByRole('button', { name: '删除第1条容量' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('第1条容量单位'), { target: { value: 'KG' } });
    expect((screen.getByLabelText('第1条容量单位') as HTMLSelectElement).value).toBe('KG');
    fireEvent.change(screen.getByLabelText('第1条容量'), { target: { value: '2.5' } });
    expect(screen.getByLabelText('保存容量').textContent).toBe('2.5KG');
    fireEvent.change(screen.getByLabelText('第1条容量'), { target: { value: '' } });
    expect((screen.getByLabelText('第1条容量单位') as HTMLSelectElement).value).toBe('KG');
  });
  it('内层单位维护回填当前容量行，删除和清空后仍有一条空行', () => {
    render(<Form initial="2KG" />);
    fireEvent.click(screen.getByRole('button', { name: '管理单位' }));
    expect(screen.getByLabelText('保存容量').textContent).toBe('2ROLL');
    fireEvent.click(screen.getByRole('button', { name: '增加容量' }));
    fireEvent.change(screen.getByLabelText('第2条容量单位'), { target: { value: 'G' } });
    fireEvent.change(screen.getByLabelText('第2条容量'), { target: { value: '5' } });
    expect(screen.getByLabelText('保存容量').textContent).toBe('2ROLL\n5G');
    fireEvent.click(screen.getByRole('button', { name: '删除第1条容量' }));
    expect(screen.getByLabelText('保存容量').textContent).toBe('5G');
    fireEvent.click(screen.getByRole('button', { name: '清空表单' }));
    expect((screen.getByLabelText('第1条容量') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: '删除第1条容量' }).hasAttribute('disabled')).toBe(true);
  });
  it('新建首行等待默认单位，默认显示不改父表单，手工清空后不覆盖', () => {
    const { rerender } = render(<Form />);
    rerender(<Form defaultUnit="G" />);
    expect((screen.getByLabelText('第1条容量单位') as HTMLSelectElement).value).toBe('G');
    expect(screen.getByLabelText('保存容量').textContent).toBe('');
    fireEvent.change(screen.getByLabelText('第1条容量单位'), { target: { value: '' } });
    expect(screen.getByLabelText('保存容量').textContent).toBe(' ');
    rerender(<Form defaultUnit="KG" />);
    expect((screen.getByLabelText('第1条容量单位') as HTMLSelectElement).value).toBe('');
  });

  it('草稿保留显式空行和清空的单位，不重新套新建默认值', () => {
    render(<Form initial={'2KG\n '} defaultUnit="G" />);
    expect((screen.getByLabelText('第1条容量单位') as HTMLSelectElement).value).toBe('KG');
    expect((screen.getByLabelText('第2条容量单位') as HTMLSelectElement).value).toBe('');
    expect(screen.getByLabelText('保存容量').textContent).toBe('2KG\n ');
  });

  it('纯数字单位能先选、填数量和清空，不与数量粘连', () => {
    resetUnitOptionsForTest({ spec_unit: [{ value: '123', label: '数字单位' }] });
    render(<Form />);
    fireEvent.change(screen.getByLabelText('第1条容量单位'), { target: { value: '123' } });
    expect((screen.getByLabelText('第1条容量单位') as HTMLSelectElement).value).toBe('123');
    fireEvent.change(screen.getByLabelText('第1条容量'), { target: { value: '2' } });
    expect(screen.getByLabelText('保存容量').textContent).toBe('2 123');
    fireEvent.change(screen.getByLabelText('第1条容量'), { target: { value: '' } });
    expect((screen.getByLabelText('第1条容量单位') as HTMLSelectElement).value).toBe('123');
  });

});

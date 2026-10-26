import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { MoneyControl } from './RecordForm';
function Form({scale}:{scale:number}){const [value,set]=useState<unknown>(0);return <><MoneyControl value={value} scale={scale} onChange={set}/><output>{String(value)}</output></>}
describe('单价输入',()=>{
  afterEach(cleanup);
  it('保留连续输入的小数，不把0.0025元截成0分',()=>{
    render(<Form scale={4}/>);const input=screen.getByRole('textbox');
    for(const text of ['0.','0.0','0.00','0.002','0.0025'])fireEvent.change(input,{target:{value:text}});
    expect(screen.getByRole('status').textContent).toBe('0.25');
    expect((input as HTMLInputElement).value).toBe('0.0025');
  });
  it('普通金额不允许分以下精度，也不会保留旧值假装输入成功',()=>{
    render(<Form scale={0}/>);fireEvent.change(screen.getByRole('textbox'),{target:{value:'0.0025'}});
    expect(screen.getByRole('status').textContent).toBe('NaN');
  });
});

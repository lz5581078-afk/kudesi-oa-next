import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { QueryTable, type Col } from './QueryKit';
const rows = Array.from({length:25},(_,index)=>({id:index+1,name:`合成${index+1}`,amount:index+1,kind:index%2?'乙':'甲'}));
const cols: Col<typeof rows[number]>[] = [
  {key:'name',head:'名称',cell:row=>row.name,csv:row=>row.name},
  {key:'kind',head:'类型',cell:row=>row.kind,csv:row=>row.kind},
  {key:'amount',head:'金额',cell:row=>String(row.amount),csv:row=>row.amount},
];
const table = (data=rows) => <QueryTable cols={cols} rows={data} rowKey={row=>row.id} empty="无合成结果" foot={false} caption="合成列表" controls={{storageKey:'synthetic.query.columns'}}/>;
beforeEach(()=>localStorage.clear()); afterEach(cleanup);
it('完整数据分页、数值三态稳定排序和多条短语搜索共用同一表格',()=>{
  render(table());
  expect(screen.getAllByRole('row')).toHaveLength(21);
  fireEvent.click(screen.getByRole('button',{name:'下一页'}));
  expect(screen.getByText('合成25')).toBeTruthy(); expect(screen.queryByText('合成1',{exact:true})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'金额'}));
  expect(within(screen.getAllByRole('row')[1]).getByText('1',{exact:true})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'金额'}));
  expect(within(screen.getAllByRole('row')[1]).getByText('25',{exact:true})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'金额'}));
  expect(within(screen.getAllByRole('row')[1]).getByText('1',{exact:true})).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox',{name:'合成列表搜索'}),{target:{value:'合成2 甲'}});
  expect(screen.getByText('无合成结果')).toBeTruthy();
  fireEvent.doubleClick(screen.getByRole('textbox',{name:'合成列表搜索'}));
  fireEvent.change(screen.getByRole('textbox',{name:'多条搜索内容'}),{target:{value:'合成21\n合成23\n合成21'}});
  fireEvent.click(screen.getByRole('button',{name:'开始搜索'}));
  expect(screen.getByText('筛选 2/25 条')).toBeTruthy();
  expect(screen.getByPlaceholderText('已启用 2 条搜索条件')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'下一页'})).toBeNull();
  expect(screen.getByText('合成21')).toBeTruthy(); expect(screen.queryByText('合成22')).toBeNull();
});
it('列设置持久化、恢复和Escape关闭；无匹配仍保留表头和可恢复的搜索',()=>{
  const view=render(table());
  fireEvent.click(screen.getByRole('button',{name:'显示字段'}));
  fireEvent.click(screen.getByRole('checkbox',{name:'金额'}));
  expect(screen.queryByRole('columnheader',{name:/^金额/})).toBeNull();
  fireEvent.keyDown(document,{key:'Escape'});
  expect(screen.queryByRole('checkbox',{name:/^金额/})).toBeNull();
  view.unmount(); render(table());
  expect(screen.queryByRole('columnheader',{name:/^金额/})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'显示字段'}));
  fireEvent.click(screen.getByRole('button',{name:'恢复默认'}));
  expect(screen.getByRole('columnheader',{name:/^金额/})).toBeTruthy();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole('checkbox',{name:/^金额/})).toBeNull();
  fireEvent.change(screen.getByRole('textbox',{name:'合成列表搜索'}),{target:{value:'不存在'}});
  expect(screen.getByText('无合成结果')).toBeTruthy();
  expect(screen.getByRole('columnheader',{name:/^名称/})).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox',{name:'合成列表搜索'}),{target:{value:''}});
  expect(screen.getByText('共 25 条')).toBeTruthy();
});

it('列宽拖动按88到720约束并持久化，重新打开仍保留',()=>{
  const view=render(table());const handle=screen.getByRole('button',{name:'调整名称列宽'});
  fireEvent(handle,new MouseEvent('pointerdown',{clientX:100,bubbles:true}));
  fireEvent(handle,new MouseEvent('pointermove',{clientX:150,bubbles:true}));
  fireEvent(handle,new MouseEvent('pointerup',{clientX:150,bubbles:true}));
  expect(JSON.parse(localStorage.getItem('synthetic.query.columns.widths')!)).toMatchObject({name:190});
  view.unmount();render(table());
  expect((document.querySelector('col') as HTMLElement).style.width).toBe('190px');
  const next=screen.getByRole('button',{name:'调整名称列宽'});
  fireEvent(next,new MouseEvent('pointerdown',{clientX:100,bubbles:true}));
  fireEvent(next,new MouseEvent('pointermove',{clientX:-1000,bubbles:true}));
  fireEvent(next,new MouseEvent('pointerup',{bubbles:true}));
  expect(JSON.parse(localStorage.getItem('synthetic.query.columns.widths')!)).toMatchObject({name:88});
});
it('金额升降序均把空值放最后，零值参与正常排序',()=>{
  const data=[{id:1,name:'空值',amount:null},{id:2,name:'零值',amount:0},{id:3,name:'正值',amount:1}];
  const fields:Col<typeof data[number]>[]=[{key:'name',head:'名称',cell:row=>row.name,csv:row=>row.name},{key:'amount',head:'金额',cell:row=>row.amount===null?'-':row.amount,csv:row=>row.amount}];
  render(<QueryTable cols={fields} rows={data} rowKey={row=>row.id} empty="无" foot={false} controls={{storageKey:'synthetic.empty-sort'}}/>);
  fireEvent.click(screen.getByRole('button',{name:'金额'}));
  expect(within(screen.getAllByRole('row')[1]).getByText('零值')).toBeTruthy();
  expect(within(screen.getAllByRole('row')[3]).getByText('空值')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'金额'}));
  expect(within(screen.getAllByRole('row')[1]).getByText('正值')).toBeTruthy();
  expect(within(screen.getAllByRole('row')[3]).getByText('空值')).toBeTruthy();
});
it('读取完成后立即翻页不会被迟到归位覆盖，清除搜索回到第一页',()=>{
  const view=render(<QueryTable cols={cols} rows={null} rowKey={row=>row.id} empty="无" foot={false} caption="合成列表" controls={{storageKey:'synthetic.page-transition'}}/>);
  view.rerender(<QueryTable cols={cols} rows={rows} rowKey={row=>row.id} empty="无" foot={false} caption="合成列表" controls={{storageKey:'synthetic.page-transition'}}/>);
  fireEvent.click(screen.getByRole('button',{name:'下一页'}));expect(screen.getByText('合成25')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox',{name:'合成列表搜索'}),{target:{value:'合成2'}});
  fireEvent.click(screen.getByRole('button',{name:'清空'}));
  expect(screen.getByText('合成1',{exact:true})).toBeTruthy();expect(screen.queryByText('合成25')).toBeNull();
});

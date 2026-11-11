// @vitest-environment jsdom
import type { DesktopSaleSnapshot } from '@kudesi/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopAfterSalesLogistics, DesktopAfterSalesSourcePanel } from './DesktopAfterSalesSourcePanel';

const snapshot: DesktopSaleSnapshot = {
  afterSaleId: '90000001',
  internalOrderId: '90010001',
  sourceCompany: '验收公司',
  capturedAt: '2026-11-06T00:00:00.000Z',
  fields: {
    售后商品明细: '商品信息：名称一\n商品编码：A01\n白色 24 件 · 实收数量/金额：1 / 9.00 · 原订单单价/采购价：10.00 / 5.00\n商品信息：名称二 · 实收数量/金额：2 / 13.00 · 原订单单价/采购价：10.00 / 5.00',
    实退金额明细: '商品应退金额：10.00\n应退运费：1.00\n优惠/差额：-2.00\n商家实退：9.00',
    退货物流明细: '时间：2026-11-06 09:00:00 · 状态：已签收 · 物流描述：仓库已签收',
    发货物流明细: '时间：2026-11-06 08:00:00 · 状态：已出库 · 物流描述：仓库已出库',
  },
};

afterEach(cleanup);

describe('聚水潭明细展示', ()=>{
  it('按商品明细源表头与记录分行展示，并保留商品描述换行', ()=>{
    render(<DesktopAfterSalesSourcePanel kind="goods" snapshot={snapshot}/>);
    const table = within(screen.getByRole('table',{name:'商品明细'}));
    expect(table.getAllByRole('columnheader').map(cell=>cell.textContent)).toEqual([
      '商品信息', '商品简称', '类型', '单价', '申请数量', '退款金额', '实收数量/金额', '次品数量',
      '线上金额', '备注', '原订单单价/采购价', '进仓时间', '操作',
    ]);
    expect(table.getAllByRole('row')).toHaveLength(3);
    expect(table.getAllByRole('cell')[0].textContent).toBe('名称一\n商品编码：A01\n白色 24 件');
    expect(table.getByText('2 / 13.00')).toBeTruthy();
  });

  it('退款按明细字段顺序排列，并分别使用退货和发货的物流记录', ()=>{
    const {rerender} = render(<DesktopAfterSalesSourcePanel kind="refund" snapshot={snapshot}/>);
    expect(screen.getAllByRole('term').map(term=>term.textContent)).toEqual([
      '商品应退金额', '应退运费', '卖家应补', '优惠/差额', '换货金额', '买家应补', '实退金额',
    ]);
    rerender(<DesktopAfterSalesSourcePanel kind="tracking" snapshot={snapshot}/>);
    expect(screen.getByRole('cell',{name:'仓库已签收'})).toBeTruthy();
    expect(screen.queryByText('仓库已出库')).toBeNull();
    rerender(<DesktopAfterSalesSourcePanel kind="shipping" snapshot={snapshot}/>);
    expect(screen.getByRole('cell',{name:'仓库已出库'})).toBeTruthy();
    expect(screen.queryByText('仓库已签收')).toBeNull();
  });
});

it('快递100在当前弹窗显示，切回系统查询仍使用已归档物流',async()=>{
  render(<DesktopAfterSalesLogistics kind="tracking" snapshot={snapshot} queryProvider={async()=>({...snapshot,provider:'kuaidi100',fields:{
    退货物流明细:'时间：2026-11-06 10:00:00 · 状态：已签收 · 物流描述：快递100签收',
  }})}/>);
  expect(screen.getByRole('cell',{name:'仓库已签收'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'快递100查询'}));
  expect(await screen.findByRole('cell',{name:'快递100签收'})).toBeTruthy();
  expect(screen.queryByText('仓库已签收')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'系统查询'}));
  expect(screen.getByRole('cell',{name:'仓库已签收'})).toBeTruthy();
});

it('快递100只在隔离的 OA 弹窗内加载已校验的查询页',async()=>{
  render(<DesktopAfterSalesLogistics kind="tracking" snapshot={snapshot} queryProvider={async()=>({...snapshot,
    provider:'kuaidi100',providerUrl:'https://m.kuaidi100.com/result.jsp?nu=SF123456789',fields:{},
  })}/>);
  fireEvent.click(screen.getByRole('button',{name:'快递100查询'}));
  const frame=await screen.findByTitle('快递100物流查询');
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(screen.queryByText('仓库已签收')).toBeNull();
});

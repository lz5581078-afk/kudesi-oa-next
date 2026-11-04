import { describe, expect, it } from 'vitest';
import { allocateDiscount, buildEntries, docTotal, DOC_TYPE_MAP, validateDoc, type DocInput } from './finance-documents';

const sum = (e: Array<{ amount: number }>) => e.reduce((s, x) => s + x.amount, 0);
const prod = (id: number, qty: number, price: number) => ({ productId: id, qty, unitPriceCents: price });
it('已有分账户编辑的全额分配要求继续保留，部分收款明确选择部分模式',()=>{
  const input:DocInput={type:'receipt',date:'2026-10-24',partyId:7,settlementMode:'full',paidCents:600,accounts:[{role:'in',bankAccountId:5,amountCents:600}],lines:[{itemName:'合成回款',qty:1,unitPriceCents:1000}]};
  expect(validateDoc(input).join()).toContain('各账户金额合计');expect(validateDoc({...input,settlementMode:'part'})).toEqual([]);expect(validateDoc({...input,accounts:null,bankAccountId:5})).toEqual([]);
});
it.each(['advance-receipt','receipt','payment','prepayment'] as const)('%s 模式只提供默认，明确填写3元不被全款或未付标签改记为10元或0元',type=>{
  const incoming=type==='advance-receipt'||type==='receipt';
  for(const settlementMode of ['full','credit'] as const){
    if(settlementMode==='credit'&&!DOC_TYPE_MAP.get(type)!.ui.payModes.some(item=>item.mode==='credit'))continue;
    const input:DocInput={type,date:'2026-10-24',partyId:7,bankAccountId:5,settlementMode,paidCents:300,lines:[{itemName:'合成用途',qty:1,unitPriceCents:1000}]};
    expect(validateDoc(input)).toEqual([]);const entries=buildEntries(input,()=>null);expect(entries.find(entry=>entry.kind==='bank')?.amount).toBe(incoming?300:-300);expect(sum(entries)).toBe(0);
    expect(buildEntries({...input,paidCents:0,bankAccountId:null},()=>null).some(entry=>entry.kind==='bank')).toBe(false);
    expect(buildEntries({...input,paidCents:0,settlementMode:null},()=>null).find(entry=>entry.kind==='bank')?.amount).toBe(incoming?1000:-1000);
  }
});

describe('整单优惠（管家婆优惠金额/抹零）', () => {
  it('把优惠按行金额比例摊开，尾差补在最后一行，合计等于优惠', () => {
    expect(allocateDiscount([1000, 2000, 3000], 100)).toEqual([16, 33, 51]);
    expect(allocateDiscount([5, 0, 5], 1)).toEqual([0, 0, 1]);
    expect(allocateDiscount([100], 0)).toEqual([0]);
  });
  it('销售单：单据金额、应收、销售收入都按优惠后计，借贷平衡，成本不受影响', () => {
    const input: DocInput = { type: 'sale', date: '2026-10-29', partyId: 1, warehouseId: 2, discountCents: 300, lines: [prod(9, 10, 1000)] };
    const def = DOC_TYPE_MAP.get('sale')!;
    expect(docTotal(def, input)).toBe(9700);
    const e = buildEntries(input, () => 400);
    expect(sum(e)).toBe(0);
    expect(e.find((x) => x.kind === 'revenue')!.amount).toBe(-9700);
    expect(e.find((x) => x.kind === 'cogs')!.amount).toBe(4000);
  });
  it('采购入库：优惠摊进库存成本，应付按优惠后', () => {
    const input: DocInput = { type: 'purchase-in', date: '2026-10-29', partyId: 1, warehouseId: 2, discountCents: 100, lines: [prod(1, 1, 3000), prod(2, 1, 1000)] };
    const e = buildEntries(input, () => null);
    expect(sum(e)).toBe(0);
    expect(e.filter((x) => x.kind === 'inventory').map((x) => x.amount)).toEqual([2925, 975]);
    expect(e.find((x) => x.kind === 'payable')!.amount).toBe(-3900);
  });
  it('采购退货：库存按优惠后转出', () => {
    const e = buildEntries({ type: 'purchase-return', date: '2026-10-29', partyId: 1, warehouseId: 2, discountCents: 100, lines: [prod(1, 1, 3000), prod(2, 1, 1000)] }, () => null);
    expect(sum(e)).toBe(0);
    expect(e.filter((x) => x.kind === 'inventory').map((x) => x.amount)).toEqual([-2925, -975]);
  });
  it('只有商品类单据能填优惠，优惠不能大于等于明细合计', () => {
    expect(validateDoc({ type: 'expense', date: '2026-10-29', discountCents: 1, lines: [{ feeItemId: 1, qty: 1, unitPriceCents: 500 }] }).join()).toContain('只有商品类单据能填优惠金额');
    expect(validateDoc({ type: 'sale', date: '2026-10-29', partyId: 1, warehouseId: 1, discountCents: 1000, lines: [prod(1, 1, 1000)] }).join()).toContain('优惠金额必须小于明细合计');
    expect(validateDoc({ type: 'sale', date: '2026-10-29', partyId: 1, warehouseId: 1, discountCents: 999, lines: [prod(1, 1, 1000)] })).toEqual([]);
  });
});

describe('费用单用预付款结算（旧版“用预付款结算”）', () => {
  const base: DocInput = { type: 'expense', date: '2026-10-29', partyId: 7, partyKind: 'supplier', lines: [{ feeItemId: 3, qty: 1, unitPriceCents: 10000 }] };
  it('预付冲抵 + 当场付款 + 余额挂应付，借贷平衡', () => {
    const input = { ...base, offsetCents: 4000, paidCents: 3000, bankAccountId: 5 };
    expect(validateDoc(input)).toEqual([]);
    const e = buildEntries(input, () => null);
    expect(sum(e)).toBe(0);
    expect(e.find((x) => x.kind === 'prepayment')!.amount).toBe(-4000);
    expect(e.find((x) => x.kind === 'payable')!.amount).toBe(-3000);
    expect(e.find((x) => x.kind === 'bank')!.amount).toBe(-3000);
  });
  it('全部用预付款结算时不用选付款账户，也不挂应付', () => {
    const input = { ...base, offsetCents: 10000, paidCents: 0 };
    expect(validateDoc(input)).toEqual([]);
    expect(buildEntries(input, () => null).some((x) => x.kind === 'payable')).toBe(false);
  });
  it('冲抵必须选往来对象；冲抵不能超过单据金额', () => {
    expect(validateDoc({ ...base, partyId: null, offsetCents: 1000, paidCents: 9000, bankAccountId: 1 }).join()).toContain('冲抵预付款要先选择');
    expect(validateDoc({ ...base, offsetCents: 20000 }).join()).toContain('冲抵金额不能超过单据金额');
  });
});


describe('其他收入的自由项目金额行', () => {
  const input: DocInput = { type: 'other-income', date: '2026-10-24', bankAccountId: 5, lines: [{ itemName: '废纸回收', qty: 1, unitPriceCents: 1234 }] };
  it('没有费用档案ID也可记收入，金额按原值入账且借贷平衡', () => {
    expect(validateDoc(input)).toEqual([]);
    expect(buildEntries(input, () => null)).toEqual(expect.arrayContaining([{ kind: 'other_income', accountId: 0, subId: 0, amount: -1234, qty: null }, { kind: 'bank', accountId: 5, subId: 0, amount: 1234, qty: null }]));
    expect(sum(buildEntries(input, () => null))).toBe(0);
  });
  it('新金额行要求项目和分精度，同时兼容旧费用项目行', () => {
    expect(validateDoc({ ...input, lines: [{ qty: 1, unitPriceCents: 1234 }] }).join()).toContain('请填写收入项目');
    expect(validateDoc({ ...input, lines: [{ itemName: '回收', qty: 1, unitPriceCents: 12.3 }] }).join()).toContain('最多两位小数');
    expect(validateDoc({ ...input, lines: [{ feeItemId: 9, qty: 2, unitPriceCents: 150 }] })).toEqual([]);
  });
});

describe('金额单的用途合计与实际收付', () => {
  it.each(['advance-receipt', 'receipt', 'payment', 'prepayment'] as const)('%s 部分收付只按实际金额动银行及往来，旧单仍按全额', (type) => {
    const input: DocInput = { type, date: '2026-10-24', partyId: 7, bankAccountId: 5, settlementMode: 'part', paidCents: 300, lines: [{ itemName: '货款', qty: 1, unitPriceCents: 1000 }] };
    expect(validateDoc(input)).toEqual([]);
    const entries = buildEntries(input, () => null);
    expect(sum(entries)).toBe(0);
    expect(Math.abs(entries.find(entry => entry.kind === 'bank')!.amount)).toBe(300);
    expect(Math.abs(entries.find(entry => entry.kind !== 'bank')!.amount)).toBe(300);
    const legacy = buildEntries({ ...input, settlementMode: null, paidCents: 0 }, () => null);
    expect(Math.abs(legacy.find(entry => entry.kind === 'bank')!.amount)).toBe(1000);
  });
  it('暂未付款不产生银行变动，不强制账户；超付和按总额分配结算被拒绝', () => {
    const input: DocInput = { type: 'payment', date: '2026-10-24', partyId: 7, settlementMode: 'credit', paidCents: 0, lines: [{ itemName: '货款', qty: 1, unitPriceCents: 1000 }] };
    expect(validateDoc(input)).toEqual([]);
    expect(buildEntries(input, () => null).some(entry => entry.kind === 'bank')).toBe(false);
    expect(validateDoc({ ...input, bankAccountId: 5, settlementMode: 'part', paidCents: 1100 }).join()).toContain('必须在0和本单合计之间');
    expect(validateDoc({ ...input, bankAccountId: 5, settlementMode: 'part', paidCents: 300, settleBy: 'doc', settlements: [{ sourceDocId: 1, amountCents: 1000 }] }).join()).toContain('结算单据合计');
  });
  it('分账户只收付部分金额，合计不能超过用途总额', () => {
    const input: DocInput = { type: 'receipt', date: '2026-10-24', partyId: 7, settlementMode: 'part', paidCents: 300, accounts: [{ role: 'in', bankAccountId: 5, amountCents: 100 }, { role: 'in', bankAccountId: 6, amountCents: 200 }], lines: [{ itemName: '回款', qty: 1, unitPriceCents: 1000 }] };
    expect(validateDoc(input)).toEqual([]);
    expect(buildEntries(input, () => null).filter(entry => entry.kind === 'bank').map(entry => entry.amount)).toEqual([100, 200]);
  });
});

describe('费用自由相关单位的开立与挂账过账', () => {
  it.each(['part', 'credit', 'offset'] as const)('%s 可以先开立，但没有真实往来ID时不能构造挂账分录', mode => {
    const input: DocInput = { type: 'expense', date: '2026-10-24', counterpartyName: '合成司机', settlementMode: mode, paidCents: mode === 'part' ? 100 : 0, offsetCents: mode === 'offset' ? 1000 : 0, bankAccountId: 5, lines: [{ feeItemId: 7, qty: 1, unitPriceCents: 1000 }] };
    expect(validateDoc(input, 'issue')).toEqual([]);
    expect(validateDoc(input, 'post').join()).toContain('挂账往来档案');
    expect(() => buildEntries(input, () => null)).toThrow('PARTY_ACCOUNT_REQUIRED');
    const bound = { ...input, partyId: 9 };
    expect(validateDoc(bound, 'post')).toEqual([]);
    expect(buildEntries(bound, () => null).every(entry => !['payable', 'prepayment'].includes(entry.kind) || entry.accountId === 9)).toBe(true);
  });
  it('相关单位与摘要各自限制长度，不能挤入备注字段', () => {
    const input: DocInput = { type: 'expense', date: '2026-10-24', paidCents: 1000, bankAccountId: 5, lines: [{ feeItemId: 7, qty: 1, unitPriceCents: 1000 }] };
    expect(validateDoc({ ...input, counterpartyName: '字'.repeat(161), summary: '字'.repeat(256) })).toEqual(expect.arrayContaining(['相关单位最多160字', '单据摘要最多255字']));
  });
});

it('费用明确选择欠款或预付冲抵时，空实付不回退全款；旧模式为空仍兼容原默认', () => {
  const input: DocInput = { type: 'expense', date: '2026-10-24', partyId: 9, bankAccountId: 5, paidCents: null, lines: [{ feeItemId: 7, qty: 1, unitPriceCents: 1000 }] };
  expect(buildEntries({ ...input, settlementMode: 'credit' }, () => null).some(entry => entry.kind === 'bank')).toBe(false);
  expect(buildEntries(input, () => null).find(entry => entry.kind === 'bank')?.amount).toBe(-1000);
});

it('费用目录为空的手工费用类型按原金额入账，不生成虚构费用档案',()=>{
  const input:DocInput={type:'expense',date:'2026-11-03',bankAccountId:5,lines:[{itemName:'合成手工费用',qty:1,unitPriceCents:1234}]};
  expect(validateDoc(input)).toEqual([]);
  const entries=buildEntries(input,()=>null);expect(entries.reduce((sum,row)=>sum+row.amount,0)).toBe(0);
  expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({kind:'expense',accountId:0,amount:1234})]));
  expect(validateDoc({...input,lines:[{itemName:' ',qty:1,unitPriceCents:1234}]}).join()).toContain('费用类型');
  expect(validateDoc({...input,lines:[{itemName:'字'.repeat(513),qty:1,unitPriceCents:1234}]}).join()).toContain('512');
});

import {expect,it} from 'vitest';
import {financeBankReferenceLabel,financeBookingReferenceLabel} from './finance-reference-labels';
it('挂账对象分别显示原资料编号，不把商品名称规格或品牌混入挂账名称',()=>{
  expect(financeBookingReferenceLabel('licenses',{companyName:'合成主体',licenseNo:'L001'},'别名')).toBe('合成主体 · L001');
  expect(financeBookingReferenceLabel('stores',{name:'合成店',storeNo:'S001',platform:'pdd'},'别名')).toBe('合成店 · S001');
  expect(financeBookingReferenceLabel('phones',{number:'18500000000'},'别名')).toBe('18500000000');
  expect(financeBookingReferenceLabel('fixed-assets',{name:'合成设备',assetNo:'A001'},'别名')).toBe('合成设备 · A001');
  expect(financeBookingReferenceLabel('finance-products',{name:'合成商品',code:'P001',specQty:500,specUnit:'包',brandId:9},'别名')).toBe('合成商品 · P001');
});
it('银行只保留原类型、所属主体店铺和尾四位，缺少卡号时不伪造尾号',()=>{
  expect(financeBankReferenceLabel({kind:'store_public',accountName:'合成账户',ownerName:'合成户主',accountNo:'6222000000001234'},'别名','合成店')).toBe('店铺公户 · 合成店 · 尾号1234');
  expect(financeBankReferenceLabel({kind:'cashier_account',ownerName:'合成户主'},'别名')).toBe('公司出纳账户 · 合成户主');
});
it('200字名称加200字资料编号完整保留，512容量涵盖原资料显示值',()=>{
  const name='名'.repeat(200),code='号'.repeat(200);expect(financeBookingReferenceLabel('stores',{name,storeNo:code},'')).toBe(`${name} · ${code}`);
});

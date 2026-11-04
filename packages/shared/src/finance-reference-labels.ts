const text=(value:unknown)=>value===null||value===undefined?'':String(value).trim();
const join=(name:string,code:unknown)=>[name,text(code)].filter(Boolean).join(' · ');
const bankKinds:Record<string,string>={company_public:'公司公户',company_card:'公司银行卡',cashier_account:'公司出纳账户',store_public:'店铺公户',store_personal_card:'店铺个人银行卡'};

/** 财务资料身份展示只包含名称、编号和卡号尾四位，不带报价、成本或完整卡号。 */
export function financeBankReferenceLabel(data:Record<string,unknown>,title:string,storeName=''):string{
  const owner=storeName||text(data.ownerName)||text(data.accountName)||title||'未命名账户';
  const suffix=text(data.accountNo).slice(-4);
  return `${bankKinds[text(data.kind)]||'资金账户'} · ${owner}${suffix?` · 尾号${suffix}`:''}`;
}

/** 费用挂账对象与商品行名称规格是两种原展示口径。 */
export function financeBookingReferenceLabel(type:string,data:Record<string,unknown>,title:string,storeName=''):string{
  if(type==='bank-accounts')return financeBankReferenceLabel(data,title,storeName);
  if(type==='licenses')return join(text(data.companyName)||title||'未命名执照',data.licenseNo);
  if(type==='stores')return join(text(data.name)||title||'未命名店铺',data.storeNo);
  if(type==='phones')return text(data.number)||title||'未命名手机号';
  if(type==='fixed-assets')return join(text(data.name)||title||'未命名资产',data.assetNo);
  return join(text(data.name)||text(data.partnerName)||title||'未命名资料',data.code);
}

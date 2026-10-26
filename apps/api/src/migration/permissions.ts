import { allGrantableKeys } from '@kudesi/shared';
const resourceTypes:Record<string,string>={
  'business-licenses':'licenses','phone-numbers':'phones','partner-profiles':'partners','bank-overview':'bank-accounts','bank-accounts':'bank-accounts','bank-u-shields':'u-shields','self-media-accounts':'self-media','wechat-accounts':'wechat','broadband-accounts':'broadband','account-service-memos':'memos','software-accounts':'software','company-locations':'locations','archive-items':'archives',
};
const pages:Record<string,string>={
  'finance-cost-table':'finance.cost-table','finance-business-journey':'finance.history','finance-cash-bank-query':'finance.cash-bank','finance-inventory-query':'finance.inventory','finance-draft-center':'finance.drafts','finance-master-data-import':'finance.master-import',
  'finance-sales-voucher':'finance.doc-sale','finance-online-sales-voucher':'finance.doc-online-sale','finance-sales-return-voucher':'finance.doc-sale-return','finance-customer-prepay-voucher':'finance.doc-advance-receipt','finance-supplier-prepay-voucher':'finance.doc-prepayment','finance-purchase-inbound-voucher':'finance.doc-purchase-in','finance-purchase-return-voucher':'finance.doc-purchase-return','finance-other-income-voucher':'finance.doc-other-income','finance-expense-voucher':'finance.doc-expense','finance-receipt-voucher':'finance.doc-receipt','finance-payment-voucher':'finance.doc-payment','finance-transfer-voucher':'finance.doc-transfer',
};
/** 仅对应明确相同的页面/资料动作；不将旧菜单权限扩大成管理员或外部写入。 */
export function mapLegacyPermission(old:string):string|null {
  const valid=allGrantableKeys();if(valid.has(old))return old;
  const parts=old.split('.');let candidate='';
  if(parts[0]==='resources'&&parts.length===3){const action=({detail:'view',deactivate:'disable'} as Record<string,string>)[parts[2]]??parts[2];candidate=`resource.${resourceTypes[parts[1]]??parts[1]}.${action}`;}
  else if(parts.length===2 && parts[1]==='view'){
    const resource=({'finance-product-base-codes':'finance-base-codes','finance-product-bundles':'finance-bundles','finance-expenses':'finance-fee-items','express-price-table':'finance-express-prices'} as Record<string,string>)[parts[0]]??parts[0];
    candidate=pages[parts[0]]?pages[parts[0]]+'.view':'resource.'+resource+'.view';
  }
  return valid.has(candidate)?candidate:null;
}

import { validUnitCents, yuanToPreciseCents } from '@kudesi/shared';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { Company, ResourceRecord } from '../entities';
import { ResourcesService } from '../resources/resources.service';

/** 仅在普通商品实际回读身份核对完成后调用；售价异常不把已确认的外部写入变成待重发。 */
export async function recordTrustedJstMirrorSalePrice(ds: DataSource, resources: ResourcesService, companyId: number, sku: string, remote: Record<string, unknown>, warn: (message: string) => void) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !sku || remote.sku_id !== sku) { warn('普通商品镜像身份不一致，未保存镜像'); return; }
  let salePrice: number | undefined;
  const prices = [remote.s_price, remote.sale_price].filter(value=>value !== undefined && value !== null && value !== '');
  if (prices.length) {
    try {
      const cents = prices.map(value=>{if(typeof value!=='number'&&typeof value!=='string')throw new Error();const n=yuanToPreciseCents(value);if(n<0||!validUnitCents(n))throw new Error();return n;});
      if (cents.some(n=>n!==cents[0])) throw new Error();
      salePrice=cents[0];
    } catch { warn('普通商品回读售价无效或精度超限，保留既有镜像售价'); }
  }
  const sys:AuthUser={id:0,companyId,name:'聚水潭回读镜像',permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
  try {
    await ds.transaction(async em=>{
      if (!await em.findOne(Company,{where:{id:companyId},lock:{mode:'pessimistic_write'}})) return;
      const existing=await em.findOne(ResourceRecord,{where:{companyId,type:'finance-jst-skus',uniqueKey:sku.toLowerCase()},lock:{mode:'pessimistic_write'}});
      if (existing && existing.data.goodsType!=='normal') { warn('普通商品与组合镜像身份冲突，未改动镜像');return; }
      const values={skuId:sku,goodsType:'normal',...(typeof remote.i_id==='string'?{styleId:remote.i_id}:{}),...(typeof remote.name==='string'?{name:remote.name}:{})};
      const record=existing??await resources.createRecord(em,sys,'finance-jst-skus',values,'普通商品已成功回读，保存白名单镜像');
      await resources.patchData(em,sys,'finance-jst-skus',record.id,{...values,...(salePrice===undefined?{}:{salePrice})},'普通商品已成功回读，保存实际售价');
    });
  } catch { warn('普通商品已回读确认，镜像暂未保存；不会因此重新发送外部写入'); }
}

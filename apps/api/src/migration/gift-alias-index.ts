import type { DataSource,EntityManager } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import type { ResourcesService } from '../resources/resources.service';
import { ResourceRecord } from '../entities';

/** The source table is a derived uniqueness index, not additional products.
 * Accept its data only after every column and original null is accounted for
 * by the corresponding native product's real detail response. */
export async function verifyGiftAliasIndex(ctx:{em:EntityManager;resources:ResourcesService;user:AuthUser;sourceCompanyId:number;lookup(type:string,id:unknown):number|undefined},rows:Array<Record<string,unknown>>){
  const fail=()=>Error('旧赠品别名索引与原商品/原生页面不一致，禁止丢弃或自动补名');
  if(!ctx.em.queryRunner?.isTransactionActive||ctx.em.queryRunner.data.legacyImport!==true)throw fail();
  const names=new Set<string>(),codes=new Set<string>(),products=new Set<string>();
  const bound=Object.create(ctx.em.connection) as DataSource;Object.defineProperty(bound,'manager',{value:ctx.em});
  const viewer=Object.create(ctx.resources) as ResourcesService;Object.defineProperty(viewer,'dataSource',{value:bound});
  for(const row of rows){
    if(Object.keys(row).sort().join(',')!=='code_key,company_id,name_key,product_id'||String(row.company_id)!==String(ctx.sourceCompanyId)||typeof row.product_id!=='string'||!row.product_id||products.has(row.product_id))throw fail();
    products.add(row.product_id);const id=ctx.lookup('finance-products',row.product_id);
    const product=id?await ctx.em.findOneBy(ResourceRecord,{id,companyId:ctx.user.companyId,type:'finance-products'}):null;
    if(!product||!['raw','purchased','shipping_material'].includes(String(product.data.archiveType)))throw fail();
    const view=await viewer.get(ctx.user,'finance-products',product.id);
    if(['giftShortName','giftCodeShortName'].some(k=>view.data[k]!=null&&typeof view.data[k]!=='string'))throw fail();
    const name=String(view.data.giftShortName??'').normalize('NFKC').trim().replace(/\s/g,'').toLocaleLowerCase('zh-CN')||null;
    const code=String(view.data.giftCodeShortName??'').normalize('NFKC').trim().toUpperCase()||null;
    if(row.name_key!==name||row.code_key!==code||(name&&names.has(name))||(code&&codes.has(code)))throw fail();
    if(name)names.add(name);if(code)codes.add(code);
  }
  return rows.length;
}

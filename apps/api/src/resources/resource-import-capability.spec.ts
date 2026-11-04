import type { EntityManager } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import {trustedResourceImport,withTrustedResourceImport} from './resource-import-capability';
const user={id:1,companyId:2} as AuthUser;
it('只有同em/公司/用户的内部scope具能力，完成和异常后都撤销，body或runner flag无效',async()=>{
  const em={queryRunner:{data:{profile:'base_codes',trustedResourceImport:true}}} as unknown as EntityManager;
  expect(trustedResourceImport(em,user)).toBe(false);
  await withTrustedResourceImport(em,user,'base_codes',async()=>{
    expect(trustedResourceImport(em,user,'base_codes')).toBe(true);
    expect(trustedResourceImport({...em} as EntityManager,user)).toBe(false);
    expect(trustedResourceImport(em,{...user,companyId:3})).toBe(false);
    expect(trustedResourceImport(em,{...user,id:3})).toBe(false);
    expect(trustedResourceImport(em,user,'bundle_codes')).toBe(false);
  });
  expect(trustedResourceImport(em,user)).toBe(false);
  await expect(withTrustedResourceImport(em,user,'base_codes',async()=>{throw new Error('synthetic');})).rejects.toThrow('synthetic');
  expect(trustedResourceImport(em,user)).toBe(false);
});

import { scryptSync } from 'node:crypto';
import { AuthService } from './auth.service';
import { encodeLegacyPassword, verifyPassword } from './password';

describe('迁入账号登录升级', () => {
  const salt='0123456789abcdef0123456789abcdef';
  function setup(status='active', affected=1) {
    let row:any={id:10,companyId:20,account:'legacy-test',name:'测试人员',status,passwordHash:encodeLegacyPassword(salt,scryptSync('original-password',salt,64).toString('hex')),positionId:null,extraPositionIds:[],isCompanyAdmin:false};
    const users:any={find:jest.fn(async()=>[{...row}]),findOneOrFail:jest.fn(async()=>({...row})),update:jest.fn(async(_:unknown,patch:unknown)=>{if(affected)row={...row,...patch as object};return {affected};})};
    const jwt:any={signAsync:jest.fn(async()=> 'test-token')};
    const companies:any={findOne:jest.fn(async()=>({id:20,name:'测试公司',status:'active'}))};
    const admins:any={findOne:jest.fn(async()=>null)};
    const audits:any={create:(x:unknown)=>x,save:jest.fn()};
    const service=new AuthService(jwt,companies,admins,users,{} as any,{find:async()=>[]} as any,{find:async()=>[]} as any,audits);
    return {service,users,jwt,row:()=>row};
  }
  it('原密码登录后升级bcrypt，返回值不含任何凭据',async()=>{
    const x=setup();const result=await x.service.login('legacy-test','original-password');
    expect(x.row().passwordHash).toMatch(/^\$2/);expect(await verifyPassword('original-password',x.row().passwordHash)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('legacy-scrypt');expect(JSON.stringify(result)).not.toContain(x.row().passwordHash);
  });
  it('错误密码、停用账号不升级、不签发令牌',async()=>{
    for(const [status,password] of [['active','wrong'],['disabled','original-password']]){
      const x=setup(status);await expect(x.service.login('legacy-test',password)).rejects.toThrow();expect(x.users.update).not.toHaveBeenCalled();expect(x.jwt.signAsync).not.toHaveBeenCalled();
    }
  });
  it('登录期间密码已被重置则不签发令牌',async()=>{
    const x=setup('active',0);await expect(x.service.login('legacy-test','original-password')).rejects.toThrow();expect(x.jwt.signAsync).not.toHaveBeenCalled();
  });
  it('原密码可用于直接改密；并发改密冲突会被拒绝',async()=>{
    const ok=setup();await ok.service.changePassword(10,20,'original-password','new-password-123');expect(await verifyPassword('new-password-123',ok.row().passwordHash)).toBe(true);
    const conflict=setup('active',0);await expect(conflict.service.changePassword(10,20,'original-password','new-password-123')).rejects.toThrow(/已变更/);
  });
});

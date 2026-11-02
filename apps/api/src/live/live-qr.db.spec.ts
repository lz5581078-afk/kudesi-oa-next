import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { LiveQrService } from './live-qr.service';

const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('公司通用长期二维码（真实数据库）',()=>{
  let ds:DataSource,service:LiveQrService,admin:AuthUser,other:AuthUser;
  const key=randomBytes(32),crypto=()=>new CryptoService({test:key},'test');
  beforeAll(async()=>{
    ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test_live_qr'}),migrationsRun:true} as never);await ds.initialize();
    const company=await ds.manager.save(Company,ds.manager.create(Company,{code:`qr${randomBytes(5).toString('hex')}`,name:'二维码隔离测试',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:`qr${randomBytes(5).toString('hex')}`,passwordHash:'!test-only',name:'二维码管理员',status:'active',mustChangePassword:false}));
    admin={id:u.id,companyId:company.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    other={...admin,permissions:{isCompanyAdmin:false,allow:['features.live-desk.view'],deny:[]}};
    service=new LiveQrService(ds,crypto());
  },30000);
  afterAll(async()=>{if(ds?.isInitialized)await ds.destroy();});
  it('查看不隐式生成；普通员工不能查看或换码，旧固定链接无效',async()=>{
    expect(await service.read(admin)).toEqual({token:null,version:0});
    await expect(service.read(other)).rejects.toThrow(/权限/);
    await expect(service.generate(other,0)).rejects.toThrow(/权限/);
    await expect(service.assert(other)).rejects.toThrow(/已失效/);
  });
  it('同一码持久保存、无时间期限，换码立即作废旧码',async()=>{
    const first=await service.generate(admin,0);expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(service.assert(other,first.token)).resolves.toBeUndefined();
    const restarted=new LiveQrService(ds,crypto());expect(await restarted.read(admin)).toEqual(first);
    const now=jest.spyOn(Date,'now').mockReturnValue(new Date('2099-01-01').getTime());
    try{await expect(restarted.assert(other,first.token)).resolves.toBeUndefined();}finally{now.mockRestore();}
    const second=await restarted.generate(admin,first.version);expect(second.token).not.toBe(first.token);
    await expect(service.assert(other,first.token)).rejects.toThrow(/已失效/);
    await expect(service.assert(other,second.token)).resolves.toBeUndefined();
    const [row]=await ds.query('SELECT * FROM live_checkin_qr_codes WHERE company_id=?',[admin.companyId]);
    expect(row.qr_token_cipher).not.toContain(second.token);
    const logs=await ds.query("SELECT detail FROM audit_logs WHERE company_id=? AND action='live.qr.generate'",[admin.companyId]);expect(JSON.stringify(logs)).not.toContain(second.token);
  });
  it('公司码不绑定房间且拒绝伪造与跨公司使用',async()=>{
    const {token}=await service.read(admin);
    await expect(service.assert(other,'x'.repeat(43))).rejects.toThrow(/已失效/);
    await expect(service.assert({...other,companyId:0},token!)).rejects.toThrow(/已失效/);
    const [row]=await ds.query('SELECT COUNT(*) n FROM live_checkin_qr_codes WHERE company_id=?',[admin.companyId]);
    expect(Number(row.n)).toBe(1);
    // No room records were created: generating/checking the company code never binds to any room.
    await expect(service.assert(other,token!)).resolves.toBeUndefined();
  });
  it('两个管理员同时换码，只接受相同版本的一次操作',async()=>{
    const current=await service.read(admin);
    const results=await Promise.allSettled([service.generate(admin,current.version),service.generate(admin,current.version)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    const next=await service.read(admin);expect(next.version).toBe(current.version+1);
    await expect(service.assert(other,current.token!)).rejects.toThrow(/已失效/);
    await expect(service.assert(other,next.token!)).resolves.toBeUndefined();
  });
});

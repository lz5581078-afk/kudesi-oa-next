import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { Company, User, ResourceRecord } from '../entities';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { LiveRoomQrService } from './live-room-qr.service';

const d=process.env.RESOURCE_DB_TEST==='1'?describe:describe.skip;
d('直播间长期二维码（真实数据库）',()=>{
  let ds:DataSource,service:LiveRoomQrService,admin:AuthUser,other:AuthUser,room:number,room2:number;
  const key=randomBytes(32),crypto=()=>new CryptoService({test:key},'test');
  beforeAll(async()=>{
    ds=new DataSource({...buildDataSourceOptions({...process.env,DB_NAME:process.env.TEST_DB_NAME??'kudesi_oa_test_live_qr'}),migrationsRun:true} as never);await ds.initialize();
    const company=await ds.manager.save(Company,ds.manager.create(Company,{code:`qr${randomBytes(5).toString('hex')}`,name:'二维码隔离测试',status:'active'}));
    const u=await ds.manager.save(User,ds.manager.create(User,{companyId:company.id,account:`qr${randomBytes(5).toString('hex')}`,passwordHash:'!test-only',name:'二维码管理员',status:'active',mustChangePassword:false}));
    admin={id:u.id,companyId:company.id,name:u.name,permissions:{isCompanyAdmin:true,allow:[],deny:[]}};
    other={...admin,permissions:{isCompanyAdmin:false,allow:['features.live-desk.view'],deny:[]}};
    const rec=async(name:string,data:Record<string,unknown>)=>(await ds.manager.save(ResourceRecord,ds.manager.create(ResourceRecord,{companyId:company.id,type:'locations',title:name,uniqueKey:randomBytes(8).toString('hex'),status:'normal',searchText:name,data}))).id;
    const corridor=await rec('西走廊办公室',{name:'西走廊办公室',locationType:'floor'});
    room=await rec('直播间-北1',{name:'直播间-北1',locationType:'room',parentId:corridor});
    room2=await rec('直播间-南1',{name:'直播间-南1',locationType:'room',parentId:corridor});
    service=new LiveRoomQrService(ds,crypto());
  },30000);
  afterAll(async()=>{if(ds?.isInitialized)await ds.destroy();});
  it('查看不隐式生成；普通员工不能查看或换码，旧固定链接无效',async()=>{
    expect(await service.read(admin,room)).toEqual({token:null,version:0});
    await expect(service.read(other,room)).rejects.toThrow(/权限/);
    await expect(service.generate(other,room,0)).rejects.toThrow(/权限/);
    await expect(service.assert(other,room)).rejects.toThrow(/已失效/);
  });
  it('同一码持久保存、无时间期限，换码立即作废旧码且保留房间资料',async()=>{
    await ds.query('INSERT INTO live_room_settings(company_id,room_id,updated_by,owner_user_id,products) VALUES (?,?,?,?,?)',[admin.companyId,room,admin.id,admin.id,'玉米']);
    const first=await service.generate(admin,room,0);expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(service.assert(other,room,first.token)).resolves.toBeUndefined();
    const restarted=new LiveRoomQrService(ds,crypto());expect(await restarted.read(admin,room)).toEqual(first);
    const now=jest.spyOn(Date,'now').mockReturnValue(new Date('2099-01-01').getTime());
    try{await expect(restarted.assert(other,room,first.token)).resolves.toBeUndefined();}finally{now.mockRestore();}
    const second=await restarted.generate(admin,room,first.version);expect(second.token).not.toBe(first.token);
    await expect(service.assert(other,room,first.token)).rejects.toThrow(/已失效/);
    await expect(service.assert(other,room,second.token)).resolves.toBeUndefined();
    const [row]=await ds.query('SELECT * FROM live_room_settings WHERE company_id=? AND room_id=?',[admin.companyId,room]);
    expect(row.products).toBe('玉米');expect(Number(row.owner_user_id)).toBe(admin.id);expect(row.qr_token_cipher).not.toContain(second.token);
    const logs=await ds.query("SELECT detail FROM audit_logs WHERE company_id=? AND action='live.room.qr.generate'",[admin.companyId]);expect(JSON.stringify(logs)).not.toContain(second.token);
  });
  it('拒绝伪造、跨房间、跨公司及已停用直播间',async()=>{
    const {token}=await service.read(admin,room);
    await expect(service.assert(other,room,'x'.repeat(43))).rejects.toThrow(/已失效/);
    await expect(service.assert(other,room2,token!)).rejects.toThrow(/已失效/);
    await expect(service.assert({...other,companyId:0},room,token!)).rejects.toThrow(/不存在/);
    await ds.query("UPDATE resource_records SET status='inactive' WHERE company_id=? AND id=?",[admin.companyId,room]);
    await expect(service.assert(other,room,token!)).rejects.toThrow(/停用/);
    await ds.query("UPDATE resource_records SET status='normal' WHERE company_id=? AND id=?",[admin.companyId,room]);
  });
  it('两个管理员同时换码，只接受相同版本的一次操作',async()=>{
    const current=await service.read(admin,room);
    const results=await Promise.allSettled([service.generate(admin,room,current.version),service.generate(admin,room,current.version)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    const next=await service.read(admin,room);expect(next.version).toBe(current.version+1);
    await expect(service.assert(other,room,current.token!)).rejects.toThrow(/已失效/);
    await expect(service.assert(other,room,next.token!)).resolves.toBeUndefined();
  });
});

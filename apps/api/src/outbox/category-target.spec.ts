import {Test} from '@nestjs/testing';
import {ExternalConfigService} from '../integrations/external-config.service';
import {JushuitanSenderFactory} from './jushuitan-sender';
it('分类授权指纹按可信账号/企业/appKey/baseUrl生成；换令牌不改目标且从不输出凭证',async()=>{
 const cfg={targetKey:'jst:1:10001',coid:'10001',name:'合成授权企业',accessToken:'SYNTHETIC-TOKEN',appKey:'SYNTHETIC-APP-KEY',appSecret:'SYNTHETIC-SECRET',baseUrl:'https://openapi.jushuitan.com/'};
 const jst=jest.fn(async()=>({...cfg})),module=await Test.createTestingModule({providers:[JushuitanSenderFactory,{provide:ExternalConfigService,useValue:{jst,ds:{query:jest.fn()}}}]}).compile();const factory=module.get(JushuitanSenderFactory),first=await factory.forCompany(1),key=first.categoryTarget!.key;expect(first.categoryTarget).toEqual({key:expect.stringMatching(/^[a-f0-9]{64}$/),name:cfg.name,coid:cfg.coid});expect(first.targetKey).toBe(cfg.targetKey);expect(JSON.stringify(first.categoryTarget)).not.toMatch(/APP-KEY|SECRET|TOKEN|example.invalid/);
 cfg.accessToken='SYNTHETIC-NEW-TOKEN';expect((await factory.forCompany(1)).categoryTarget?.key).toBe(key);cfg.baseUrl=cfg.baseUrl.slice(0,-1);expect((await factory.forCompany(1)).categoryTarget?.key).toBe(key);
 for(const field of ['targetKey','coid','appKey'] as const){const old=cfg[field];cfg[field]=old+'changed';expect((await factory.forCompany(1)).categoryTarget?.key).not.toBe(key);cfg[field]=old;}cfg.baseUrl='https://dev-api.jushuitan.com/';expect((await factory.forCompany(1)).categoryTarget?.key).not.toBe(key);await module.close();
});

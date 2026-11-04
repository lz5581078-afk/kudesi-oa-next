import { Body, Controller, Module, Post, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IsString, MaxLength } from 'class-validator';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { configureBodyParsers } from './body-parsers';

class ValueDto { @IsString() @MaxLength(100) value!: string }
class AudioDto { @IsString() @MaxLength(5130000) audio!: string }
@Controller()
class ProbeController {
  @Post('ordinary') ordinary(@Body() dto: ValueDto) { return { value: dto.value }; }
  @Post('collector/file') file(@Body() dto: AudioDto) { return { bytes: dto.audio.length }; }
  @Post('desktop-after-sales-collection/1/commit') salePage(@Body() dto: AudioDto) { return { bytes: dto.audio.length }; }
  @Post('desktop-after-sales/import') saleDetail(@Body() dto: AudioDto) { return { bytes: dto.audio.length }; }
}
const login = jest.fn(async (_account: string, _password: string) => { throw new UnauthorizedException('账号或密码不正确'); });
@Module({ controllers: [AuthController, ProbeController], providers: [{ provide: AuthService, useValue: { login } }] })
class ProbeModule {}

describe('真实Nest启动的请求体解析（无数据库、无实际账号）', () => {
  let app: NestExpressApplication, base: string;
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(ProbeModule, { logger: false, bodyParser: false });
    configureBodyParsers(app);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  beforeEach(() => login.mockClear());
  afterAll(async () => { await app?.close(); });
  const post = (path: string, body: string, contentType = 'application/json') => fetch(base + '/api/' + path,
    { method: 'POST', headers: { 'Content-Type': contentType }, body });
  it('有效JSON账号密码到达真实登录控制器，返回凭据错误401而非缺参数400', async () => {
    const credentials = { account: 'isolated-test-staff', password: 'not-a-real-password' };
    const response = await post('auth/login', JSON.stringify(credentials));
    expect(response.status).toBe(401);
    expect(login).toHaveBeenCalledWith(credentials.account, credentials.password);
  });
  it('普通JSON和表单编码请求都能读取字段', async () => {
    const response = await post('ordinary', JSON.stringify({ value: '中文业务参数' }));
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ value: '中文业务参数' });
    expect((await post('auth/login', new URLSearchParams({ account: 'form-staff', password: 'form-test-password' }).toString(), 'application/x-www-form-urlencoded')).status).toBe(401);
    expect(login).toHaveBeenCalledWith('form-staff', 'form-test-password');
  });
  it('音频JSON超过100KB仍可解析，普通接口继续拒绝过大请求', async () => {
    const audio = 'a'.repeat(200000);
    const response = await post('collector/file', JSON.stringify({ audio }));
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ bytes: audio.length });
    expect((await post('auth/login', JSON.stringify({ account: 'x', password: audio }))).status).toBe(413);
    expect(login).not.toHaveBeenCalled();
  });
  it('超过6MB的音频请求仍被拒绝', async () => {
    expect((await post('collector/file', JSON.stringify({ audio: 'a'.repeat(6 * 1024 * 1024 + 1) }))).status).toBe(413);
  });
  it('售后页及详情可超过普通100KB限制，但各自上限仍生效',async()=>{
    const body=JSON.stringify({audio:'x'.repeat(200000)});
    expect((await post('desktop-after-sales-collection/1/commit',body)).status).toBe(201);
    expect((await post('desktop-after-sales/import',body)).status).toBe(201);
    expect((await post('desktop-after-sales/import',JSON.stringify({audio:'x'.repeat(1024*1024+1)}))).status).toBe(413);
    expect((await post('desktop-after-sales-collection/1/commit',JSON.stringify({audio:'x'.repeat(6*1024*1024+1)}))).status).toBe(413);
  });
  it('无效JSON、缺字段、多余字段仍拒绝，不进入登录服务', async () => {
    for (const body of ['{"account":', '{}', JSON.stringify({ account: 'x', password: 'x', companyId: 1 })])
      expect((await post('auth/login', body)).status).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });
});

import { createServer, Server } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { UnauthorizedException } from '@nestjs/common';
import { CollectorRealtimeService } from '../collector/collector-realtime.service';
const { attachWebRtcSignalingServer } = require('./legacy-runtime/vendor/server/modules/session-manager/webrtc-signaling-server');
describe('店铺远程与采集器共享 WebSocket 升级入口',()=>{
  let server:Server,collector:CollectorRealtimeService,signaling:{close:()=>Promise<void>},base:string;
  const clients:WebSocket[]=[],guard={canActivate:jest.fn(async()=>{throw new UnauthorizedException();})};
  const original=process.env.KUDESI_SESSION_ENGINE;
  beforeEach(()=>{process.env.KUDESI_SESSION_ENGINE='legacy';guard.canActivate.mockClear();});
  afterEach(async()=>{for(const ws of clients.splice(0))ws.terminate();await signaling?.close();collector?.onModuleDestroy();if(server?.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));if(original===undefined)delete process.env.KUDESI_SESSION_ENGINE;else process.env.KUDESI_SESSION_ENGINE=original;});
  async function start(order:'collector-first'|'legacy-first',legacy=true){
    server=createServer();collector=new CollectorRealtimeService({httpAdapter:{getHttpServer:()=>server}} as any,guard as any,{} as any,{} as any);
    const attach=()=>{signaling=attachWebRtcSignalingServer({server,ticketStore:{consume:(ticket:string,role:string)=>{if(ticket!==role+'-fixture')throw Error('invalid ticket');return{role,binding:{companyId:10,userId:1,shopId:1,deviceId:'fixture-device',browserSessionId:'fixture-browser',remoteSessionId:'fixture-session'}};}},authorize:async()=>true,authenticationTimeoutMs:150,logger:{info:()=>{},warn:()=>{}},onSessionClosed:async()=>{}});};
    if(order==='collector-first'){collector.onApplicationBootstrap();if(legacy)attach();}else{if(legacy)attach();collector.onApplicationBootstrap();}
    server.listen(0,'127.0.0.1');await once(server,'listening');base='ws://127.0.0.1:'+(server.address() as {port:number}).port;
  }
  async function connect(path='/api/session-manager/webrtc'){const ws=new WebSocket(base+path);clients.push(ws);await once(ws,'open');return ws;}
  const message=(ws:WebSocket)=>once(ws,'message').then(([raw])=>JSON.parse(String(raw)));
  it.each(['collector-first','legacy-first'] as const)('%s：有效票据配对和信令转发正常',async order=>{
    await start(order);const viewer=await connect(),waiting=message(viewer);viewer.send(JSON.stringify({type:'authenticate',role:'viewer',ticket:'viewer-fixture'}));expect(await waiting).toEqual({type:'waiting'});
    const agent=await connect(),pairedViewer=message(viewer),pairedAgent=message(agent);agent.send(JSON.stringify({type:'authenticate',role:'agent',ticket:'agent-fixture'}));expect(await pairedViewer).toEqual({type:'paired'});expect(await pairedAgent).toEqual({type:'paired'});
    const received=message(viewer);agent.send(JSON.stringify({type:'offer',sdp:'synthetic-offer'}));expect(await received).toEqual({type:'offer',sdp:'synthetic-offer'});expect(guard.canActivate).not.toHaveBeenCalled();
  });
  it.each(['collector-first','legacy-first'] as const)('%s：无有效票据仍1008拒绝',async order=>{await start(order);const ws=await connect(),closed=once(ws,'close');ws.send(JSON.stringify({type:'authenticate',role:'viewer',ticket:'invalid'}));expect((await closed)[0]).toBe(1008);});
  it('不提交认证帧仍按原协议超时拒绝',async()=>{await start('collector-first');const ws=await connect();expect((await once(ws,'close'))[0]).toBe(1008);});
  it('采集器自身路径仍走原认证，匿名401且不调用外部服务',async()=>{await start('collector-first');const ws=new WebSocket(base+'/api/collector/realtime');clients.push(ws);const[error]=await once(ws,'error');expect(String(error)).toContain('401');expect(guard.canActivate).toHaveBeenCalledTimes(1);});
  it.each(['/unknown','/api/session-manager/webrtc-extra'])('未知路径%s继续拒绝',async path=>{await start('collector-first');const ws=new WebSocket(base+path);clients.push(ws);await expect(once(ws,'open')).rejects.toThrow();expect(guard.canActivate).not.toHaveBeenCalled();});
  it('未启用旧引擎时不开放其升级路径',async()=>{delete process.env.KUDESI_SESSION_ENGINE;await start('collector-first',false);const ws=new WebSocket(base+'/api/session-manager/webrtc');clients.push(ws);await expect(once(ws,'open')).rejects.toThrow();expect(guard.canActivate).not.toHaveBeenCalled();});
});

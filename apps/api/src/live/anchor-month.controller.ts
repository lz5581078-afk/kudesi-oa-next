import { Controller, Get, Injectable, Param, ParseIntPipe, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { liveToText, resourcePermission } from '@kudesi/shared';
import { AuthenticatedOnly, AuthUser, CurrentUser } from '../common/auth.decorators';
import { can, liveClock, liveFail, SESSION_SELECT, type Row } from './live-core';
import { loadLiveAccess } from './live-access';
import { computeDayEstimate, loadEstimateInputs, type Inputs } from './live-day-estimate';

export function currentAnchorMonth(now:Date) {
  const at=liveToText(now)!; const month=at.slice(0,7);
  const next=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)).toISOString().slice(0,7);
  return {month,asOf:at,from:month+'-01',until:next+'-01'};
}
const json=(x:unknown):Row=>typeof x==='string'?JSON.parse(x):x??{};
export function anchorWorkedTime(s:Row,input:Inputs,now:string) {
  const clock=input.checkins.find(c=>Number(c.session_id)===Number(s.id)&&c.role==='anchor'&&Number(c.user_id)===Number(s.anchor_user_id));
  const wage=input.wages.find(w=>Number(w.session_id)===Number(s.id)&&w.role==='anchor'&&Number(w.user_id)===Number(s.anchor_user_id));
  const report=input.reports.find(r=>Number(r.session_id)===Number(s.id)&&r.role==='anchor');
  const manual=report?.manual_actor_id;
  const correction=json(clock?.confirmation_json).autoCheckout?.reviewCorrection?.endAt;
  const unknown=Boolean(json(clock?.confirmation_json).autoCheckout&&!correction&&s.status!=='approved') || (s.checkin_mode&&!clock&&!manual&&!wage);
  const start=wage?.start_text||clock?.start_text||s.start_text;
  const reportedEnd=wage?.end_text||correction||clock?.end_text||report?.end_text||s.end_text;
  // Ended/locked sessions must never keep growing as if still broadcasting.
  const end=[reportedEnd,now].filter(Boolean).sort()[0];
  const missing=unknown||!start||(!reportedEnd&&s.status!=='live')||start>end;
  return {startAt:start??null,endAt:reportedEnd??null,minutes:missing?null:Math.max(0,Math.round((Date.parse(end.replace(' ','T')+'+08:00')-Date.parse(start.replace(' ','T')+'+08:00'))/60000))};
}
export function indexMonthInputs(input:Inputs) {
  const result=new Map<number,Inputs>();
  for(const key of ['snapshots','reports','checkins','wages','commissions'] as const)for(const row of input[key]){
    const id=Number(row.session_id);if(!result.has(id))result.set(id,{...input,snapshots:[],reports:[],checkins:[],wages:[],commissions:[]});
    result.get(id)![key].push(row);
  }
  return result;
}
export function computeAnchorMonth(sessions:Row[],input:Inputs,userId:number,now:string,commissionVisible:boolean,indexed=indexMonthInputs(input)) {
  const rows=sessions.filter(s=>Number(s.anchor_user_id)===userId).map(s=>{
    const current=indexed.get(Number(s.id))??{...input,snapshots:[],reports:[],checkins:[],wages:[],commissions:[]};
    const worked=anchorWorkedTime(s,current,now),v=computeDayEstimate([s],now,current,commissionVisible,true);
    const ledger=commissionVisible&&s.status==='approved'?current.wages.find(w=>w.role==='anchor'&&Number(w.user_id)===userId):undefined;
    return {wageCents:ledger?.amount_cents==null?null:Number(ledger.amount_cents),id:Number(s.id),date:s.session_day,roomId:Number(s.room_id),roomName:s.room_name||`直播间 #${s.room_id}`,status:s.status,...worked,
      turnoverCents:v.missingSalesSessions?null:v.turnoverCents,
      commissionCents:commissionVisible&&!v.costs?.missingSessions?v.costs?.commissionCents??0:null,estimated:s.status!=='approved'};
  });
  return {userId,sessions:rows,summary:{wageCents:commissionVisible?rows.reduce((n,r)=>n+(r.wageCents??0),0):null,pendingWageSessions:commissionVisible?rows.filter(r=>r.wageCents===null).length:0,sessionCount:rows.length,minutes:rows.reduce((n,r)=>n+(r.minutes??0),0),turnoverCents:rows.reduce((n,r)=>n+(r.turnoverCents??0),0),commissionCents:commissionVisible?rows.reduce((n,r)=>n+(r.commissionCents??0),0):null,
    missingTimeSessions:rows.filter(r=>r.minutes===null).length,missingSalesSessions:rows.filter(r=>r.turnoverCents===null).length,missingCommissionSessions:commissionVisible?rows.filter(r=>r.commissionCents===null).length:0,estimatedSessions:rows.filter(r=>r.estimated).length}};
}
@Injectable()
export class AnchorMonthService {
  constructor(@InjectDataSource() private readonly ds:DataSource) {}
  async read(user:AuthUser,ids:number[],detail=false) {
    const access=await loadLiveAccess(this.ds.manager,user);
    if(!access.canView&&!can(user,resourcePermission('workforce','view')))liveFail('没有查看直播资料的权限',403);
    if(!ids.length||ids.length>200||ids.some(id=>!Number.isSafeInteger(id)||id<=0))liveFail('人员编号不正确',400);
    ids=[...new Set(ids)];
    const people:Row[]=await this.ds.query(`SELECT u.id,u.name,u.employment_type FROM users u WHERE u.company_id=? AND u.id IN (?) ${access.canView?'':"AND EXISTS(SELECT 1 FROM resource_records r WHERE r.company_id=u.company_id AND r.type='workforce' AND JSON_UNQUOTE(JSON_EXTRACT(r.data,'$.userId'))=CAST(u.id AS CHAR))"}`,[user.companyId,ids]);
    if(people.length!==ids.length)liveFail('人员不存在',404);
    const period=currentAnchorMonth(liveClock.now());
    const sessions:Row[]=await this.ds.query(`${SESSION_SELECT} WHERE s.company_id=? AND s.anchor_user_id IN (?) AND s.session_date>=? AND s.session_date<? AND s.start_at<=? AND s.status IN ('live','pending_report','submitted','returned','approved') ORDER BY s.start_at DESC,s.id DESC`,[user.companyId,ids,period.from,period.until,period.asOf]);
    const input=await loadEstimateInputs(this.ds.manager,access,sessions,period.asOf,true);
    if(sessions.length)input.wages=await this.ds.query("SELECT session_id,user_id,role,amount_cents,DATE_FORMAT(start_at,'%Y-%m-%d %H:%i:%s') start_text,DATE_FORMAT(end_at,'%Y-%m-%d %H:%i:%s') end_text FROM live_wage_records WHERE company_id=? AND session_id IN (?) AND role='anchor'",[user.companyId,sessions.map(s=>Number(s.id))]);
    // No external sales polling and no new ledger entries: use existing shared snapshots/reports.
    const indexed=indexMonthInputs(input);
    const items=people.map(p=>{
      const result=computeAnchorMonth(sessions,input,Number(p.id),period.asOf,access.canViewAll,indexed);
      return {...result,name:p.name,employmentType:p.employment_type,sessions:detail?result.sessions:undefined};
    });
    return {month:period.month,asOf:period.asOf,canViewCommission:access.canViewAll,canOpenSession:access.canView,items};
  }
}
class MonthQuery { @IsOptional() @IsString() @MaxLength(2400) ids?:string; }
@Controller('live/anchor-month')
export class AnchorMonthController {
  constructor(private readonly service:AnchorMonthService) {}
  @AuthenticatedOnly() @Get() batch(@CurrentUser() user:AuthUser,@Query() query:MonthQuery) {
    return this.service.read(user,(query.ids??'').split(',').map(Number));
  }
  @AuthenticatedOnly() @Get(':userId') detail(@CurrentUser() user:AuthUser,@Param('userId',ParseIntPipe) id:number) {
    return this.service.read(user,[id],true);
  }
}

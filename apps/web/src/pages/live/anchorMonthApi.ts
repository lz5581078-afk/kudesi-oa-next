import { api } from '../../api/client';
export interface AnchorMonthSummary {sessionCount:number;minutes:number;turnoverCents:number;commissionCents:number|null;missingTimeSessions:number;missingSalesSessions:number;missingCommissionSessions:number;estimatedSessions:number}
export interface AnchorMonthSession {id:number;date:string;roomId:number;roomName:string;status:string;startAt:string|null;endAt:string|null;minutes:number|null;turnoverCents:number|null;commissionCents:number|null;estimated:boolean}
export interface AnchorMonthPerson {userId:number;name:string;employmentType:string;summary:AnchorMonthSummary;sessions?:AnchorMonthSession[]}
export interface AnchorMonthData {month:string;asOf:string;canViewCommission:boolean;canOpenSession:boolean;items:AnchorMonthPerson[]}
export const anchorMonthApi={
 read:(id:number)=>api<AnchorMonthData>(`/live/anchor-month/${id}`),
 batch:async(ids:number[])=>{
   const pages=await Promise.all(Array.from({length:Math.ceil(ids.length/200)},(_,i)=>api<AnchorMonthData>(`/live/anchor-month?ids=${ids.slice(i*200,i*200+200).join(',')}`)));
   if(new Set(pages.map(p=>p.month)).size>1)throw new Error('月份已切换，请重新读取');
   return {...pages[0],items:pages.flatMap(p=>p.items)};
 },
};

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { FlowService } from '../flow/flow.service';
import { LiveOrderSource } from './live-order-source';
import { captureOrders, persistCapture } from './live-order-capture';
import { Row, liveClock, lockCompany, sessionRow, wallNow } from './live-core';
import { finishCheckedOutRoom } from './live-checkout-state';

@Injectable()
export class LiveCheckinClosureService {
  private readonly log = new Logger(LiveCheckinClosureService.name);
  constructor(@InjectDataSource() private readonly ds:DataSource,private readonly auth:AuthService,private readonly flow:FlowService,private readonly orders:LiveOrderSource){}
  async scan(){
    // Reconcile saved checkouts left live by older code, independently of the 30-minute report lock.
    const checkedOut: Row[] = await this.ds.query(`SELECT s.id,s.company_id FROM live_sessions s
      JOIN live_session_checkins c ON c.company_id=s.company_id AND c.session_id=s.id AND c.role='control' AND c.user_id=s.control_user_id AND c.end_at IS NOT NULL
      WHERE s.checkin_mode=1 AND s.status='live' AND NOT EXISTS (
        SELECT 1 FROM live_session_checkins a WHERE a.company_id=s.company_id AND a.session_id=s.id AND a.role='anchor' AND a.user_id=s.anchor_user_id AND a.end_at IS NULL
      ) ORDER BY s.id LIMIT 100`);
    for (const row of checkedOut) {
      try {
        await this.ds.transaction(async em => {
          await lockCompany(em, Number(row.company_id));
          await finishCheckedOutRoom(em, Number(row.company_id), await sessionRow(em, Number(row.company_id), Number(row.id), true));
        });
      } catch (e) { this.log.error(`直播下播状态同步失败 #${row.id}：${(e as Error).message}`); }
    }
    const due:Row[]=await this.ds.query("SELECT id,company_id FROM live_sessions WHERE checkin_mode=1 AND report_deadline<=? AND status IN ('live','pending_report') AND flow_run_id IS NULL ORDER BY report_deadline LIMIT 100",[wallNow(liveClock.now())]);
    for(const row of due){
      try{
        const s=await this.ds.transaction(async em=>{
          await lockCompany(em,Number(row.company_id));const s=await sessionRow(em,Number(row.company_id),Number(row.id),true);
          if(!['live','pending_report'].includes(s.status))return null;
          await em.query("UPDATE live_sessions SET report_locked_at=COALESCE(report_locked_at,report_deadline),end_at=COALESCE(end_at,(SELECT MAX(r.end_at) FROM live_session_reports r WHERE r.company_id=? AND r.session_id=?)),status='pending_report' WHERE company_id=? AND id=?",[row.company_id,row.id,row.company_id,row.id]);
          await em.query("UPDATE live_schedules SET status='finished' WHERE company_id=? AND session_id=? AND status='live'",[row.company_id,row.id]);
          return sessionRow(em,Number(row.company_id),Number(row.id));
        });
        if(!s)continue;
        // Final bounds, not the earlier person's partial window, determine the saved order set.
        try{
          const capture=await captureOrders(this.orders,Number(row.company_id),s,s.end_text);
          await this.ds.transaction(async em=>{await lockCompany(em,Number(row.company_id));const latest=await sessionRow(em,Number(row.company_id),Number(row.id),true);if(latest.status==='pending_report'&&latest.end_text===s.end_text)await persistCapture(em,Number(row.company_id),Number(row.id),capture,liveClock.now());});
        }catch(e){await this.ds.query("UPDATE live_sessions SET orders_capture_status='pending',orders_capture_error=? WHERE company_id=? AND id=? AND status='pending_report'",[String((e as Error).message).slice(0,500),row.company_id,row.id]);}
        const [person]:Row[]=await this.ds.query("SELECT u.id FROM users u JOIN companies c ON c.id=u.company_id AND c.status='active' WHERE u.company_id=? AND u.status='active' AND u.id IN (?,?) ORDER BY u.id=? DESC LIMIT 1",[row.company_id,s.anchor_user_id,s.control_user_id,s.started_by]);
        if(!person)throw new Error('本场主播、中控账号均不可用，请管理员处理审核提交');
        const me=await this.auth.me(Number(person.id),Number(row.company_id));
        await this.flow.start({id:Number(person.id),companyId:Number(row.company_id),name:me.name,permissions:me.permissions},'live-session-review',{sessionId:Number(row.id)},`live_auto_${row.id}`,{internal:true});
        await this.ds.query('UPDATE live_sessions SET auto_submit_error=NULL WHERE company_id=? AND id=?',[row.company_id,row.id]);
      }catch(e){await this.ds.query('UPDATE live_sessions SET auto_submit_error=? WHERE company_id=? AND id=?',[String((e as Error).message).slice(0,500),row.company_id,row.id]);}
    }
    // Recover incomplete external reads even after the review todo has been created.
    const pending:Row[]=await this.ds.query("SELECT id,company_id FROM live_sessions WHERE checkin_mode=1 AND report_locked_at IS NOT NULL AND orders_capture_status='pending' AND status IN ('pending_report','submitted','returned') LIMIT 100");
    for(const row of pending)try{
      const s=await sessionRow(this.ds.manager,Number(row.company_id),Number(row.id));
      const capture=await captureOrders(this.orders,Number(row.company_id),s,s.end_text);
      await this.ds.transaction(async em=>{
        await lockCompany(em,Number(row.company_id));const latest=await sessionRow(em,Number(row.company_id),Number(row.id),true);
        if(latest.status==='approved'||latest.end_text!==s.end_text)return;
        await persistCapture(em,Number(row.company_id),Number(row.id),capture,liveClock.now());
        await em.query('UPDATE live_sessions SET revision=revision+1 WHERE company_id=? AND id=?',[row.company_id,row.id]);
      });
    }catch(e){await this.ds.query("UPDATE live_sessions SET orders_capture_error=? WHERE company_id=? AND id=? AND orders_capture_status='pending'",[String((e as Error).message).slice(0,500),row.company_id,row.id]);}
    return due.length;
  }
}

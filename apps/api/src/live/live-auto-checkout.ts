import { liveComputeWage, liveFromText, liveToText } from '@kudesi/shared';
import type { EntityManager } from 'typeorm';
import { liveFail, type Row } from './live-core';

/** Caller holds company/session locks. Preserve original reporting evidence. */
export async function autoCheckout(em: EntityManager, companyId: number, session: Row) {
  await em.query(`UPDATE live_session_checkins SET end_at=GREATEST(start_at,?),
    confirmation_json=JSON_SET(COALESCE(confirmation_json,JSON_OBJECT()),'$.autoCheckout',JSON_OBJECT('reason','missing-report','lockedAt',?))
    WHERE company_id=? AND session_id=? AND end_at IS NULL`,
  [session.report_deadline,session.report_deadline,companyId,session.id]);
}

/** Explicit reviewer input is required even for people who receive no hourly wage. */
export async function requireCheckoutCorrections(em: EntityManager, companyId: number, sessionId: number, form: {wageEndAt?:string;controlWageEndAt?:string;operatorEndAt?:string}) {
  const rows: Row[] = await em.query(`SELECT role,DATE_FORMAT(start_at,'%Y-%m-%d %H:%i:%s') startAt
    FROM live_session_checkins WHERE company_id=? AND session_id=? AND JSON_EXTRACT(confirmation_json,'$.autoCheckout') IS NOT NULL`,[companyId,sessionId]);
  return rows.map(row=>{
    const label=({anchor:'主播',control:'中控',operator:'运营'} as Record<string,string>)[row.role]??row.role;
    const value=row.role==='anchor'?form.wageEndAt:row.role==='control'?form.controlWageEndAt:form.operatorEndAt;
    const endAt=liveToText(liveFromText(value));
    if(!endAt)liveFail(`${label}未报下播，下播时间异常，请在审核中修复下播时间后再继续`,400);
    // Reuse attendance duration rules, independently of whether this person earns hourly pay.
    liveComputeWage({startAt:row.startAt,endAt:endAt!,hourlyRateCents:1});
    return {role:String(row.role),endAt:endAt!};
  });
}

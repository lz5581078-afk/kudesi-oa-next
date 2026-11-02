import { liveMonthBounds, liveToday, type PersonalLiveIncome } from '@kudesi/shared';
import { EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { commissionOnlyControl, loadLiveAccess } from './live-access';
import { liveClock, num, type Row } from './live-core';

/** 本人收入不随管理权限扩大范围；按审核时快照归属，调岗不重分类旧提成。 */
export async function personalLiveIncome(em:EntityManager,user:AuthUser):Promise<PersonalLiveIncome> {
  const month=liveToday(liveClock.now()).slice(0,7),bounds=liveMonthBounds(month);
  const role="CASE WHEN role='control' AND JSON_EXTRACT(rule_snapshot,'$.controlCommissionOnly')=true THEN 'operator' ELSE role END";
  const [access,commissionOnly,commissions,wages]=await Promise.all([
    loadLiveAccess(em,user),commissionOnlyControl(em,user.companyId,user.id),
    em.query(`SELECT ${role} income_role,COALESCE(SUM(amount_cents),0) total FROM live_commission_records WHERE company_id=? AND user_id=? AND session_date>=? AND session_date<? GROUP BY income_role`,[user.companyId,user.id,bounds.from,bounds.until]) as Promise<Row[]>,
    em.query('SELECT role,COALESCE(SUM(amount_cents),0) total,COALESCE(SUM(minutes),0) minutes FROM live_wage_records WHERE company_id=? AND user_id=? AND session_date>=? AND session_date<? GROUP BY role',[user.companyId,user.id,bounds.from,bounds.until]) as Promise<Row[]>,
  ]);
  const earned=(r:string)=>commissions.some(x=>x.income_role===r)||wages.some(x=>x.role===r);
  const amounts=(r:string)=>({wageCents:num(wages.find(x=>x.role===r)?.total),wageMinutes:num(wages.find(x=>x.role===r)?.minutes),commissionCents:num(commissions.find(x=>x.income_role===r)?.total)});
  return {
    month,
    anchor:{visible:access.isAnchor||earned('anchor'),...amounts('anchor')},
    control:{visible:access.isLiveControl||(access.isControl&&!access.isOperations&&!commissionOnly)||earned('control'),...amounts('control')},
    operator:{visible:!!access.isOperations||commissionOnly||earned('operator'),commissionCents:num(commissions.find(x=>x.income_role==='operator')?.total)},
  };
}

import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import { lockCompany } from '../live/live-core';
import { unfiledTrialSql } from './trial-status';

export async function createTrialPerson(ds: DataSource, actor: AuthUser, input: { name: string; hourlyRateCents?: number }) {
  const name = input.name.trim();
  const rate = input.hourlyRateCents ?? null;
  if (!name || name.length > 50) throw new BadRequestException('请填写试播主播姓名（最多50字）');
  if (rate !== null && (!Number.isSafeInteger(rate) || rate < 1 || rate > 100_000_000)) {
    throw new BadRequestException('请输入有效的试播时薪');
  }

  return ds.transaction(async em => {
    await lockCompany(em, actor.companyId);
    const [duplicate] = await em.query(
      `SELECT u.id FROM users u WHERE u.company_id=? AND u.name=? AND u.status='active' AND ${unfiledTrialSql('u')}`,
      [actor.companyId, name],
    );
    if (duplicate) throw new BadRequestException('已有同名试播主播，请从列表选择；如为不同人员，请在姓名后加区分信息');
    const result = await em.query(
      `INSERT INTO users(company_id,account,password_hash,name,status,must_change_password,live_trial,employment_type,pay_type,hourly_rate)
       VALUES (?,NULL,'!no-login',?,'active',0,1,'part_time','hourly',?)`,
      [actor.companyId, name, rate],
    );
    await em.query(
      'INSERT INTO audit_logs(company_id,actor_id,action,resource_type,resource_id,detail) VALUES(?,?,?,?,?,?)',
      [actor.companyId, actor.id, 'live.trial.create', 'user', String(result.insertId), JSON.stringify({ name, hourlyRateCents: rate })],
    );
    return { id: Number(result.insertId), name };
  });
}

import { FlowAdapter } from '../flow/flow-adapters';
import { closedDay, liveFail } from './live-core';
import { createChecker } from '@kudesi/shared';
import { dailyRow, assertNoLivePaidOverlap } from './daily-work-core';
export const dailyWorkReview: FlowAdapter = {
  key: 'live-daily-work-review',
  async title(em, c, p) {
    const r = await dailyRow(em, c, Number(p.workId));
    return `${r.user_name} ${r.day} 日常工作审核`;
  },
  async validateStart({ em, user, payload, run }) {
    const r = await dailyRow(em, user.companyId, Number(payload.workId), true);
    if (run && Number(run.payload.workId) !== Number(r.id))
      liveFail('不能更换原日常工作记录', 400);
    if (
      Number(r.user_id) !== user.id &&
      !createChecker(user.permissions)('live.manage')
    )
      liveFail('只能提交本人的日常工作', 403);
    if (
      !['pending', 'returned'].includes(r.status) ||
      !r.actual_end ||
      !r.report
    )
      liveFail('请先结束日常工作并填写工作内容');
    if (await closedDay(em, user.companyId, r.day,{dailyWorkId:Number(r.id)}))
      liveFail('该日期已进入工资结算，不能修改审核');
    payload.summary = `${r.user_name} · ${r.role === 'anchor' ? '主播' : '中控'}\n工作：${r.content}\n排班：${r.planned_start_text} 至 ${r.planned_end_text}\n实际：${r.actual_start_text} 至 ${r.actual_end_text}\n完成内容：${r.report}\n实际 ${r.minutes} 分钟；时薪 ${(Number(r.hourly_rate_cents) / 100).toFixed(2)} 元；预计工资 ${((Number(r.hourly_rate_cents) * Number(r.minutes)) / 6000).toFixed(2)} 元。`;
  },
  async onStart({ em, user, payload, run }) {
    await em.query(
      "UPDATE live_daily_work SET status='submitted',flow_run_id=?,return_reason=NULL,approved_minutes=NULL,review_note=NULL,amount_cents=ROUND(hourly_rate_cents*minutes/60) WHERE company_id=? AND id=?",
      [run.id, user.companyId, payload.workId],
    );
  },
  async canResubmit({ em, user, run }) {
    const r = await dailyRow(em, run.companyId, Number(run.payload.workId));
    return (
      Number(r.user_id) === user.id ||
      createChecker(user.permissions)('live.manage')
    );
  },
  async onResubmit(ctx) {
    await dailyWorkReview.onStart!(ctx);
  },
  async onPass({ em, user, run, payload, stepKey, form }) {
    if (stepKey !== 'review') return;
    const r = await dailyRow(em, run.companyId, Number(payload.workId), true);
    if (r.status !== 'submitted' || Number(r.flow_run_id) !== run.id)
      liveFail('工作审核状态已变化，请刷新');
    const minutes =
        form.payMinutes == null ? Number(r.minutes) : Number(form.payMinutes),
      note = String(form.wageNote ?? '').trim();
    if (
      !Number.isInteger(minutes) ||
      minutes < 0 ||
      minutes > Number(r.minutes)
    )
      liveFail('计薪分钟数必须在0与实际工时之间', 400);
    if (minutes !== Number(r.minutes) && !note)
      liveFail('调整计薪时长必须填写原因', 400);
    await em.query(
      'UPDATE live_daily_work SET approved_minutes=?,amount_cents=?,review_note=?,updated_by=? WHERE company_id=? AND id=?',
      [
        minutes,
        Math.round((Number(r.hourly_rate_cents) * minutes) / 60),
        note || null,
        user.id,
        run.companyId,
        r.id,
      ],
    );
  },
  async onReturn({ em, run, payload }, { reason, toSubmit }) {
    if (toSubmit)
      await em.query(
        "UPDATE live_daily_work SET status='returned',return_reason=? WHERE company_id=? AND id=? AND flow_run_id=?",
        [reason, run.companyId, payload.workId, run.id],
      );
  },
  async onFinish({ em, run, payload, user, reason }, outcome) {
    const r = await dailyRow(em, run.companyId, Number(payload.workId), true);
    if (Number(r.flow_run_id) !== run.id) liveFail('工作审核状态已变化');
    if (outcome === 'completed') {
      if (Number(r.amount_cents) > 0)
        await assertNoLivePaidOverlap(
          em,
          run.companyId,
          Number(r.user_id),
          r.actual_start_text,
          r.actual_end_text,
        );
      if (await closedDay(em, run.companyId, r.day,{dailyWorkId:Number(r.id)}))
        liveFail('该日期已进入工资结算，不能重复入账');
      await em.query(
        "UPDATE live_daily_work SET status='approved',approved_minutes=COALESCE(approved_minutes,minutes),updated_by=? WHERE company_id=? AND id=?",
        [user.id, run.companyId, r.id],
      );
    } else
      await em.query(
        "UPDATE live_daily_work SET status='pending',flow_run_id=NULL,return_reason=?,updated_by=? WHERE company_id=? AND id=?",
        [
          reason || '审核未通过，请核对后重新提交',
          user.id,
          run.companyId,
          r.id,
        ],
      );
  },
};

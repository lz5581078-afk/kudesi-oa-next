import { PersonPhotoName } from './PersonPhotoName';
import type { SessionDetail } from './liveApi';
import { SessionDuration } from './SessionDuration';
import { money } from './liveFormat';

/** Display the control's actual report as the trial anchor's basis, without inventing an anchor report. */
export function TrialProxyPerformance({session}:{session:SessionDetail}) {
  if(!session.anchorTrial)return null;
  const reporter=session.trialProxyReporter;
  const report=session.reports.find(r=>r.role==='control'&&r.reporter.id===reporter?.id);
  return <section className="notice warn" aria-label="主播业绩（试播代报）">
    <strong>主播业绩（试播代报）</strong>
    <p>试播主播：<PersonPhotoName personId={session.anchor.id} name={session.anchor.name}/> · 代报中控：{reporter?.name??'待核实'}</p>
    <p>上播：{session.startAt} · 下播：{session.endAt??'尚未下播'}<SessionDuration start={session.startAt} end={session.endAt} live={session.status === 'live'}/></p>
    <p>有效营业额：{!report||report.pending?'待核对':money(report.salesCents)} · 有效订单：{!report||report.pending?'待归集':`${report.orderCount} 单`}</p>
    <small>该主播业绩由中控代报，工资及提成按本场实际时间、有效订单和审核结果核算。</small>
  </section>;
}

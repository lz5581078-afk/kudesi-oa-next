import { LIVE_PLATFORMS } from '@kudesi/shared';
import type { ReviewPreview } from './liveApi';
import { RoleAmounts } from './liveUi';
import { minutesText, money, roi } from './liveFormat';

/** 分平台明细与跨平台合计明确区分；单平台不再重复显示同一提成。 */
export function ReviewPreviewAmounts({preview}: {preview:ReviewPreview}) {
  const platforms=preview.platforms??[];
  return <>
    <span>最终销售额 {money(preview.finalSalesCents)} · 投流 {money(preview.adSpendCents)} · 投产 {roi(preview.roiScaled)}{preview.belowRoi?'（不足，已扣减点数）':''} · 规则版本 {preview.ruleVersion.effectiveFrom} 起</span>
    {platforms.map(p=><div key={p.platform} role="group" aria-label={`${LIVE_PLATFORMS[p.platform]??'原场次'}提成`}><strong>{LIVE_PLATFORMS[p.platform]??'原场次'} · 营业额 {money(p.finalSalesCents)} · 投流 {money(p.adSpendCents)}</strong><RoleAmounts anchor={p.anchor} control={preview.control?p.control:null} operator={preview.operator?p.operator:null}/></div>)}
    {!platforms.length&&<RoleAmounts anchor={preview.anchor} control={preview.control} operator={preview.operator}/>}
    {platforms.length>1&&<div role="group" aria-label="提成合计"><strong>提成合计（包含以上各平台）</strong><RoleAmounts hideRates anchor={preview.anchor} control={preview.control} operator={preview.operator}/></div>}
    {preview.operatorDoubledAsControl&&<small className="muted">运营兼任中控，不另算运营提成</small>}
    <div>主播计时工资：{minutesText(preview.wage.minutes)} × {money(preview.wage.hourlyRateCents)}/小时 = <strong>{money(preview.wage.amountCents)}</strong>（{preview.wage.rateSource==='archive'?'档案时薪':'手填时薪'}）</div>
    {preview.controlWage&&<div>中控计时工资：{minutesText(preview.controlWage.minutes)} × {money(preview.controlWage.hourlyRateCents)}/小时 = <strong>{money(preview.controlWage.amountCents)}</strong></div>}
    <div className="live-review-pay" role="group" aria-label="本场预计应发"><strong>本场预计应发（提成＋计时工资）</strong><span>主播 <b>{money(preview.anchor.amountCents+preview.wage.amountCents)}</b></span>{preview.control&&<span>中控 <b>{money(preview.control.amountCents+(preview.controlWage?.amountCents??0))}</b></span>}{preview.operator&&<span>运营 <b>{money(preview.operator.amountCents)}</b></span>}<small>以上为审核试算，审核通过后记录本场收入。</small></div>
  </>;
}

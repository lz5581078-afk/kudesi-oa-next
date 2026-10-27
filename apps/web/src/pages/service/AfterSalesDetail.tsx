import { useCallback, useEffect, useState } from 'react';
import { afterSalesTypeLabel } from '@kudesi/shared';
import { CopyButton } from '../../resources/CopyValue';
import { fmtTime } from '../flow/flowApi';
import { money } from '../finance/common';
import { CaseFiles, DetailModal, DueText, FlowStrip, FollowUps, StageTag, errText, useNow } from './CaseParts';
import { serviceApi, type CaseDetailDto } from './serviceApi';

/** 售后工单详情：工单内容、办理进度（去办理）、凭证、跟进记录、同订单的其他工单。 */
export function AfterSalesDetail({ id, onClose, onChanged, onOpenOther }: { id: number; onClose: () => void; onChanged: () => void; onOpenOther: (id: number) => void }) {
  const [d, setD] = useState<CaseDetailDto | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [key, setKey] = useState(0);
  const now = useNow();
  const load = useCallback(() => {
    setLoading(true);
    return serviceApi.asDetail(id).then((r) => { setD(r); setError(''); }).catch((e) => setError(errText(e, '加载失败'))).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { void load(); }, [load, key]);
  const changed = () => { setKey((k) => k + 1); onChanged(); };
  const urlOf = useCallback((fid: number) => serviceApi.asFileUrl(id, fid), [id]);

  if (!d) return <div className="modal-backdrop"><div className="modal card"><div className="modal-body">{error ? <div role="alert" className="notice error">{error}</div> : '加载中…'}<button type="button" className="secondary-button" onClick={onClose}>关闭</button></div></div></div>;
  return (
    <DetailModal label="售后工单详情" title={<>{d.caseNo} · {afterSalesTypeLabel(d.caseType)}</>} tags={<StageTag stage={d.stage} returned={d.returnedBack} />}
      sub={<>登记人 {d.createdByName} · {fmtTime(d.createdAt)}</>} onClose={onClose} onRefresh={() => setKey((k) => k + 1)} refreshing={loading}>
      {error && <div role="alert" className="notice error">{error}</div>}
      {d.overdue && <div role="alert" className="notice error">这张工单已经超时，已进入“兜底监督”，请尽快处理{d.supervisors.length ? `（主管：${d.supervisors.join('、')}）` : ''}。</div>}
      <section>
        <h3 className="section-title">工单内容</h3>
        <dl className="kv-grid">
          <div><dt>订单号</dt><dd className="mono">{d.orderNo} <CopyButton value={d.orderNo} label="订单号" /></dd></div>
          <div><dt>工单编号</dt><dd className="mono">{d.caseNo} <CopyButton value={d.caseNo} label="工单编号" /></dd></div>
          <div><dt>店铺</dt><dd>{d.storeName}</dd></div>
          <div><dt>买家</dt><dd>{d.buyerName || '—'}{d.buyerName && <> <CopyButton value={d.buyerName} label="买家" /></>}</dd></div>
          <div><dt>售后类型</dt><dd>{afterSalesTypeLabel(d.caseType)}</dd></div>
          <div><dt>申请金额</dt><dd>{money(d.amountCents)}</dd></div>
          <div><dt>剩余时间</dt><dd><DueText dueAt={d.dueAt} open={d.open} now={now} /></dd></div>
          <div><dt>当前办理人</dt><dd>{d.open ? d.handlers.join('、') || '—' : '已办结'}</dd></div>
          {d.dueDate && <div><dt>要求办结日期</dt><dd>{d.dueDate.slice(0, 10)}</dd></div>}
          <div className="wide"><dt>原因</dt><dd>{d.reason}</dd></div>
          {d.resolution && <div className="wide"><dt>处理结果</dt><dd>{d.resolution}</dd></div>}
          {d.refundCents !== null && d.refundCents !== undefined && <div><dt>实际退款/补偿</dt><dd>{money(d.refundCents)}</dd></div>}
        </dl>
        {d.sameOrder.length > 0 && (
          <div className="notice warn">
            这个订单还有 {d.sameOrder.length} 条其他售后记录，避免重复处理：
            {d.sameOrder.map((o) => <button key={o.id} type="button" className="link-button" onClick={() => onOpenOther(o.id)}> {o.caseNo}（{afterSalesTypeLabel(o.caseType)}）</button>)}
          </div>
        )}
      </section>
      <FlowStrip runId={d.runId} refreshKey={key} onChanged={changed} />
      <CaseFiles files={d.files} editable={d.open} urlOf={urlOf} title="凭证与截图"
        onAdd={async (f) => { await serviceApi.asUpload(id, f); changed(); }} onRemove={async (fid) => { await serviceApi.asRemoveFile(id, fid); changed(); }} />
      <FollowUps logs={d.logs} canWrite canUrge={d.open} onAdd={async (c, k) => { await serviceApi.asLog(id, c, k); changed(); }} />
    </DetailModal>
  );
}

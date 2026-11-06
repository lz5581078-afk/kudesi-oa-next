import {useState,useEffect,useRef} from 'react';
import {X} from 'lucide-react';
import './skuApplicationDetail.css';

export type SkuSourceAction = 'submit' | 'approve' | 'return' | 'cancel' | 'reject';
const labels: Record<SkuSourceAction,string> = {
  submit: '提交', approve: '审核并更新成本表', return: '退回上一步', cancel: '废除', reject: '拒绝并废除',
};

interface Props {
  action: SkuSourceAction;
  count: number;
  busy: boolean;
  error?: string;
  syncMode?: 'automatic' | 'optional' | 'off';
  onClose: () => void;
  onConfirm: (comment: string, syncToJst?: boolean) => Promise<void>;
}

/** 旧单按审核人勾选登记同步，新申请按原流程自动登记。 */
export function SkuActionDialog({action,count,busy,error,syncMode='automatic',onClose,onConfirm}: Props) {
  const [comment,setComment] = useState('');
  const [confirmed,setConfirmed] = useState(false);
  const [syncToJst,setSyncToJst] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);

  const approving = action === 'approve';
  const needsReason = action === 'return' || action === 'cancel' || action === 'reject';
  const canConfirm = !busy && (!approving || confirmed) && (!needsReason || !!comment.trim());
  const title = `${labels[action]} ${count} 个规格`;

  return <div className="modal-backdrop sku-action-backdrop">
    <form role="dialog" aria-modal="true" aria-label={title} className="sku-source-action"
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        if (!busy) onClose();
      }}
      onSubmit={event => {
        event.preventDefault();
        if (!canConfirm) return;
        if (approving && syncMode === 'optional') void onConfirm(comment, syncToJst);
        else void onConfirm(comment);
      }}>
      <header>
        <h2>{title}</h2>
        <button ref={close} type="button" aria-label="关闭动作确认" disabled={busy} onClick={onClose}><X size={18}/></button>
      </header>
      <div className="sku-source-action-body">
        {error && <p className="notice error" role="alert">{error}</p>}
        {(action === 'cancel' || action === 'reject') &&
          <p>确认后废除所选规格，关闭当前待办并保留{action === 'reject' ? '拒绝理由' : '废除原因'}。</p>}
        {approving && <>
          <p>最后审核通过时，将生成或复用已验证组合编码，并更新成本表的SKU编码、名称及成本。{syncMode === 'automatic' && '审核后自动登记聚水潭同步任务，上传状态单独显示。'}</p>
          <label className="sku-source-action-check">
            <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/>
            已核对所选规格、发货组成和成本，确认更新成本表{syncMode === 'automatic' && '并同步聚水潭'}
          </label>
          {syncMode === 'optional' && <label className="sku-source-action-check">
            <input type="checkbox" checked={syncToJst} disabled={busy} onChange={event => setSyncToJst(event.target.checked)}/>
            通过后加入聚水潭同步队列
          </label>}
        </>}
        <label>{needsReason ? '原因（必填）' : '备注'}
          <textarea maxLength={500} value={comment} disabled={busy} onChange={event => setComment(event.target.value)}/>
        </label>
      </div>
      <footer><button type="submit" className="primary-button" disabled={!canConfirm}>
        {approving ? '审核并更新成本表' : '确认'}{busy ? '处理中' : ''}
      </button></footer>
    </form>
  </div>;
}

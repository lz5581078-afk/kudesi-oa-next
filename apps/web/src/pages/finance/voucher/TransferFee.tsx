import { money, yuanToCents } from '../common';

/** 转款单的手续费（承担方）和“先登记为在途”（A8 资金调拨单：转出账户、转入账户、金额、手续费及承担方；对方确认到账后才入账） */
export function TransferFee({ fee, setFee, bearer, setBearer, inTransit, setInTransit, outName, inName }: {
  fee: string; setFee: (v: string) => void; bearer: 'out' | 'in'; setBearer: (v: 'out' | 'in') => void; inTransit: boolean; setInTransit: (v: boolean) => void; outName: string; inName: string;
}) {
  const feeC = yuanToCents(fee);
  return (
    <section className="transfer-fee" aria-label="手续费与在途">
      <div className="form-grid">
        <label>手续费（元）<input inputMode="decimal" aria-label="转款手续费" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="没有就留空" /></label>
        <label>手续费承担方
          <select aria-label="手续费承担方" value={bearer} onChange={(e) => setBearer(e.target.value as 'out' | 'in')} disabled={!feeC}>
            <option value="out">转出方承担（从转出账户多扣）</option>
            <option value="in">转入方承担（转入账户少收）</option>
          </select>
        </label>
      </div>
      {!!feeC && !Number.isNaN(feeC) && <p className="muted">手续费 <b>{money(feeC)}</b> 由{bearer === 'out' ? `转出账户${outName ? `「${outName}」` : ''}` : `转入账户${inName ? `「${inName}」` : ''}`}承担，计入财务费用。</p>}
      <label className="check-line transit-check">
        <input type="checkbox" aria-label="先登记为在途" checked={inTransit} onChange={(e) => setInTransit(e.target.checked)} />
        先登记为“在途”：过账时只从转出账户扣款，转入账户等对方确认到账后（在单据详情点“确认入账”）才增加
      </label>
      {inTransit && bearer === 'in' && !!feeC && <p className="muted">转入方承担的手续费，到确认入账那一刻才从转入账户扣。</p>}
    </section>
  );
}

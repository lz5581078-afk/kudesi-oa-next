import { useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { resourceApi, type Relation, type ResourceDto } from './api';
import { StoresPopButton } from './StoresPop';

/** 列表行里的“点击查看”小弹窗（24 号旧版的 data-chip / link-button 弹窗）：只读，点按钮不会打开详情。 */
function Pop({ title, label, children, onOpen }: { title: string; label: string; children: ReactNode; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="row-act" onClick={(e) => { e.stopPropagation(); setOpen(true); onOpen?.(); }}>{label}</button>
      {open && (
        <div className="modal-backdrop" role="presentation" onClick={(e) => e.stopPropagation()}>
          <div className="modal card" role="dialog" aria-label={title}>
            <div className="modal-head"><strong>{title}</strong></div>
            <div className="modal-body">{children}</div>
            <div className="modal-foot"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>关闭</button></div>
          </div>
        </div>
      )}
    </>
  );
}

/** 这条资料关联的某一类资料（引用字段 + 手动关联），如合作人的“关联营业执照 / 关联店铺”、商标的授权店铺。 */
export function RelatedPop({ type, row, target, label, title }: { type: string; row: ResourceDto; target: string; label: string; title: string }) {
  const [items, setItems] = useState<Relation[] | null>(null);
  const [error, setError] = useState('');
  const load = () => { resourceApi.relations(type, row.id).then((r) => setItems([...new Map(r.filter((x) => x.type === target).map((x) => [x.id, x])).values()])).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); };
  return (
    <Pop title={`${row.title} / ${title}`} label={label} onOpen={load}>
      {error && <div role="alert" className="notice error">{error}</div>}
      {items === null && !error && <p className="muted">加载中…</p>}
      {items?.length === 0 && <p className="muted">暂无{title}，可在详情的“关联”里维护</p>}
      {items?.map((x) => <div key={x.id} className="line-item between"><span>{x.title}</span><small className="muted">{x.relation === 'manual' ? '手动关联' : ''}</small></div>)}
    </Pop>
  );
}

const LOC_LINES: Array<[string, string, string?]> = [
  ['locationId', '资料总位置'], ['originalLocationId', '正本位置', 'originalState'], ['copyLocationId', '副本位置', 'copyState'], ['sealLocationId', '印章总位置'],
  ['officialLocationId', '公章', 'officialState'], ['financeLocationId', '财务章', 'financeState'], ['legalLocationId', '法人章', 'legalState'], ['invoiceLocationId', '发票章', 'invoiceState'], ['ktBoardLocationId', 'KT 板'],
];

/** 营业执照“存放位置 点击查看”：总位置、正副本、四枚印章、KT 板各在哪，缺失的标出来，借出情况一并给出。 */
export function LicenseLocationPop({ row }: { row: ResourceDto }) {
  const d = row.data;
  return (
    <Pop title={`${row.title} / 存放位置`} label="存放位置">
      {LOC_LINES.map(([key, label, state]) => {
        const missing = state && d[state] === 'missing';
        return <div key={key} className="line-item between"><span>{label}</span><span>{missing ? <b className="bad-text">实物缺失</b> : (row.refLabels[key] ?? <span className="muted">未填写</span>)}</span></div>;
      })}
      <div className="line-item between"><span>借用情况</span><span>{String(d.borrowedSummary ?? '') || '未借出'}</span></div>
    </Pop>
  );
}

/** 哪些资料的列表行带“查看”小弹窗；没有返回 undefined */
export function viewPopsFor(type: string): ((row: ResourceDto) => ReactNode) | undefined {
  const stores = (row: ResourceDto, licenseId: number | null) => <StoresPopButton licenseId={licenseId} count={-1} title={`${row.title} / 关联店铺`} compact />;
  switch (type) {
    case 'licenses': return (row) => <span className="row-acts" onClick={(e) => e.stopPropagation()}>{stores(row, row.id)}<LicenseLocationPop row={row} /></span>;
    case 'tax-profiles': return (row) => <span className="row-acts" onClick={(e) => e.stopPropagation()}>{stores(row, typeof row.data.licenseId === 'number' ? row.data.licenseId : null)}</span>;
    case 'qualifications': return (row) => <span className="row-acts" onClick={(e) => e.stopPropagation()}>{stores(row, typeof row.data.licenseId === 'number' ? row.data.licenseId : null)}</span>;
    case 'partners': return (row) => <span className="row-acts" onClick={(e) => e.stopPropagation()}><RelatedPop type="partners" row={row} target="licenses" label="营业执照" title="关联营业执照" /><RelatedPop type="partners" row={row} target="stores" label="店铺" title="关联店铺" /><RelatedPop type="partners" row={row} target="bank-accounts" label="银行卡" title="关联银行账户" /></span>;
    case 'trademarks': return (row) => <span className="row-acts" onClick={(e) => e.stopPropagation()}><RelatedPop type="trademarks" row={row} target="stores" label="授权店铺" title="授权店铺" /></span>;
    default: return undefined;
  }
}

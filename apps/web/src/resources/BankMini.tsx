import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RESOURCE_VIEWS, formatYuan } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';
import { CopyButton } from './CopyValue';

const KIND: Record<string, string> = { company_public: '公司公户', company_card: '公司银行卡', cashier_account: '公司出纳账户', store_public: '店铺公户', store_personal_card: '店铺个人银行卡' };
const STATUS: Record<string, string> = { normal: '正常', abnormal: '异常', inactive: '停用' };

/** 在合作人等资料里列出关联的银行账户：类型、开户行、账号、保管人、当前余额、状态（旧系统“关联银行卡/账户”），点标题打开账户。 */
export function BankMini({ ids }: { ids: number[] }) {
  const [rows, setRows] = useState<ResourceDto[] | null>(null);
  const key = ids.join(',');
  useEffect(() => {
    let live = true;
    void Promise.all(ids.map((id) => resourceApi.get('bank-accounts', id).catch(() => null))).then((r) => { if (live) setRows(r.filter((x): x is ResourceDto => !!x)); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (ids.length === 0) return <p className="muted">没有关联银行账户</p>;
  if (!rows) return <p className="muted">加载中…</p>;
  return (
    <>
      {rows.map((b) => {
        const view = RESOURCE_VIEWS.find((v) => v.tab === b.data.kind);
        const no = typeof b.data.accountNo === 'string' ? b.data.accountNo : '';
        const parts = [KIND[String(b.data.kind)] ?? '', String(b.data.bank ?? ''), b.refLabels.keeperUserId ? `保管人 ${b.refLabels.keeperUserId}` : '', typeof b.data.currentBalance === 'number' ? `余额 ${formatYuan(b.data.currentBalance)}` : '', STATUS[b.status] ?? b.status].filter(Boolean);
        return (
          <div key={b.id} className="line-item col">
            <strong>{view ? <Link to={`/resource/${view.id}?open=${b.id}`}>{b.title}</Link> : b.title}</strong>
            <small className="muted">{parts.join(' · ')}{no && <> · <span className="mono">{no}</span> <CopyButton value={no} label="账号" /></>}</small>
          </div>
        );
      })}
    </>
  );
}

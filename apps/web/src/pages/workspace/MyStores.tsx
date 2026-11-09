import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { navPageByKey } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { ArrowUpRight, Package, Store } from 'lucide-react';
import { FinanceModal } from '../finance/FinanceModal';
import { workspaceApi, type MyStore } from './workspaceApi';
import './myStores.css';

export function CompanyProductsLink() {
  const { can } = useAuth();
  const products = navPageByKey('features.company-products');
  return products && can(products.permission)
    ? <Link to={products.path}><Package size={17} /> {products.label}<ArrowUpRight size={15} /></Link>
    : null;
}

export function MyStores() {
  const { can } = useAuth();
  const pricing = navPageByKey('finance.pricing-debug');
  const [open, setOpen] = useState(false);
  return <section className="card ws-section" aria-label="功能导航">
    <div className="ws-head"><h2>功能导航</h2></div>
    <div className="desk-action-list"><button type="button" onClick={() => setOpen(true)}><Store size={17} /> 我的店铺<ArrowUpRight size={15} /></button>
      <CompanyProductsLink />
      {pricing && can(pricing.permission) && <Link to={pricing.path}>{pricing.label}<ArrowUpRight size={15} /></Link>}
    </div>
    {open && <MyStoresDialog onClose={() => setOpen(false)} />}
  </section>;
}

function MyStoresDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<MyStore[] | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [platform, setPlatform] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setError(false);
    workspaceApi.myStores().then(data => { if (active) setRows(data); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [retry]);
  const groups = new Map<string, { label: string; count: number }>();
  for (const row of rows ?? []) {
    const group = groups.get(row.platform) ?? { label: row.platformLabel, count: 0 };
    group.count++;
    groups.set(row.platform, group);
  }
  const visible = rows?.filter(row => platform === null || row.platform === platform) ?? [];
  return <FinanceModal title="我的店铺" subtitle="当前登录账号负责的店铺" onClose={onClose} className="my-stores-modal">
    {error ? <div role="alert" className="notice error">店铺读取失败。<button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div>
      : !rows ? <p role="status">正在读取店铺…</p>
      : rows.length === 0 ? <div className="empty-state">暂无分配给你的店铺</div>
      : <>
        <div className="my-stores-summary"><strong>共 {rows.length} 家店铺</strong><span className="muted">覆盖 {groups.size} 个平台</span></div>
        <div className="my-stores-platforms" role="group" aria-label="按平台切换店铺">
          <button type="button" aria-pressed={platform === null} onClick={() => setPlatform(null)}>全部 <strong>{rows.length}</strong></button>
          {[...groups].map(([key, group]) => <button key={key} type="button" aria-pressed={platform === key} onClick={() => setPlatform(key)}>{group.label} <strong>{group.count}</strong></button>)}
        </div>
        <ul className="my-stores-list" aria-label="店铺列表">
          {visible.map(row => <li key={row.id}><Store size={18} aria-hidden="true" /><div><strong>{row.name}</strong><span className="muted">{row.platformLabel}</span></div></li>)}
        </ul>
      </>}
  </FinanceModal>;
}

import { useState } from "react";
import {
  LIVE_PLATFORMS,
  type LiveChannel,
  type LiveChannelInput,
} from "@kudesi/shared";
import type { Options } from "./liveApi";

export function initialChannels(
  row?: {
    channels?: LiveChannel[];
    douyinAccount: { id: number };
    store: { id: number } | null;
  } | null,
): LiveChannelInput[] {
  return row?.channels?.length
    ? row.channels.map((c) => ({
        accountId: c.accountId,
        storeIds: c.storeIds,
      }))
    : row
      ? [
          {
            accountId: row.douyinAccount.id,
            storeIds: row.store ? [row.store.id] : [],
          },
        ]
      : [];
}
export function ChannelPicker({
  options,
  value,
  onChange,
}: {
  options: Options;
  value: LiveChannelInput[];
  onChange: (value: LiveChannelInput[]) => void;
}) {
  const [platform, setPlatform] = useState(() => options.douyinAccounts.find(a => a.id === value[0]?.accountId)?.platform ?? "douyin");
  const storesFor = (account: Options['douyinAccounts'][number]) =>
    options.stores.filter(s => account.storeIds?.includes(s.id) && s.platform === account.platform);
  const accounts = options.douyinAccounts.filter(a => a.platform === platform || value.some(c => c.accountId === a.id));
  const storeCount = new Set(value.flatMap(c => c.storeIds)).size;
  return (
    <fieldset className="wide live-channel-picker">
      <legend>本场直播账号与店铺</legend>
      <p className="live-channel-help">勾选本场使用的直播账号。只有一个关联店铺时自动选中；关联多个店铺时，请选择本场参与的店铺，可多选。</p>
      <div className="live-channel-toolbar">
        <label className="live-field">查看平台
          <select aria-label="直播平台" value={platform} onChange={e => setPlatform(e.target.value)}>
            {Object.entries(LIVE_PLATFORMS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <span role="status">本场已选 <strong>{value.length}</strong> 个账号 · <strong>{storeCount}</strong> 个店铺</span>
      </div>
      {!options.douyinAccounts.some(a => a.platform === platform) && <p className="muted">该平台暂无有直播权限的账号，请先在自媒体账号档案中开启直播权限。</p>}
      <div className="live-account-grid">
        {accounts.map(account => {
          const selected = value.find(c => c.accountId === account.id);
          const stores = storesFor(account);
          const selectStores = (ids: number[]) => onChange(value.map(c => c.accountId === account.id ? { ...c, storeIds: ids } : c));
          return <div key={account.id} className={`live-account-card${selected ? ' selected' : ''}`}>
            <label className="live-account-choice">
              <input type="checkbox" aria-label={account.name} checked={!!selected} onChange={e => onChange(e.target.checked
                ? [...value, { accountId: account.id, storeIds: stores.length === 1 ? [stores[0].id] : [] }]
                : value.filter(c => c.accountId !== account.id))} />
              <span><strong>{LIVE_PLATFORMS[account.platform ?? ""] ?? '其他平台'} · {account.name}</strong>
                {!selected && <small>{stores.length === 1 ? `关联店铺：${stores[0].name}，选账号即选店铺` : stores.length ? `关联 ${stores.length} 个店铺，选账号后选择本场店铺` : '暂无可用关联店铺'}</small>}
              </span>
            </label>
            {selected && <div className="live-account-stores">
              {stores.length === 1 ? <div className="live-auto-store">
                <span className="live-store-caption">本场店铺</span>
                <strong>{stores[0].name}</strong>
                {selected.storeIds.includes(stores[0].id) ? <small>已自动选中，无需再次勾选</small> : <button type="button" className="link-button" onClick={() => selectStores([stores[0].id])}>使用此店铺</button>}
                {!stores[0].hasJstShop && <small>未绑定聚水潭，可人工核定业绩</small>}
              </div> : stores.length > 1 ? <fieldset className="live-store-options">
                <legend>选择本场店铺（可多选）</legend>
                <small className="muted">只选择本场实际参与的店铺，至少选择一个。</small>
                <div className="live-chips">{stores.map(store => <label key={store.id}>
                  <input type="checkbox" aria-label={`${account.name}关联${store.name}`} checked={selected.storeIds.includes(store.id)} onChange={e => selectStores(e.target.checked ? [...selected.storeIds, store.id] : selected.storeIds.filter(id => id !== store.id))} />
                  <span>{store.name}{!store.hasJstShop && <small>未绑定聚水潭，可人工核定</small>}</span>
                </label>)}</div>
                {!selected.storeIds.length && <p className="live-selection-hint">尚未选择本场店铺</p>}
              </fieldset> : <p className="notice warn">此账号暂无同平台关联店铺，请先补全自媒体账号档案中的关联店铺。</p>}
            </div>}
          </div>;
        })}
      </div>
      {value.filter(c => !options.douyinAccounts.some(a => a.id === c.accountId)).map(c => <div className="notice warn" key={c.accountId}>历史账号 #{c.accountId} 已不可用，请移除并重新选择。 <button type="button" className="link-button" onClick={() => onChange(value.filter(v => v.accountId !== c.accountId))}>移除历史账号</button></div>)}
      <p className="live-channel-footnote">切换平台会保留已选账号。同一店铺的业绩合并填报；一场直播的计时工资只计算一次，各平台提成分别计算。关联关系在自媒体账号档案中维护。</p>
    </fieldset>
  );
}

export function snapshotChannels(
  options: Options | null,
  inputs: LiveChannelInput[],
): LiveChannel[] {
  return inputs.map((c) => {
    const a = options?.douyinAccounts.find((a) => a.id === c.accountId);
    return {
      ...c,
      platform: a?.platform ?? "",
      accountName: a?.name ?? "",
      stores: c.storeIds.map((id) => ({
        id,
        name: options?.stores.find((s) => s.id === id)?.name ?? "",
        jstShopId: options?.stores.find((s) => s.id === id)?.hasJstShop
          ? "bound"
          : "",
      })),
    };
  });
}

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
  const [platform, setPlatform] = useState("douyin");
  const accounts = options.douyinAccounts.filter(
    (a) => a.platform === platform,
  );
  return (
    <fieldset className="wide live-channel-picker">
      <legend>直播平台、账号与店铺（可多选）</legend>
      <p className="muted">
        只显示有直播权限的账号。店铺在自媒体账号档案中关联；同店铺业绩合并填报。场次计时工资只计算一次，各平台提成分别计算。
      </p>
      <label className="live-field">
        平台
        <select
          aria-label="直播平台"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
        >
          {Object.entries(LIVE_PLATFORMS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {!accounts.length && (
        <p className="muted">
          该平台暂无有直播权限的账号，请先在自媒体账号档案中开启直播权限。
        </p>
      )}
      <div className="live-chips">
        {accounts.map((a) => (
          <label key={a.id}>
            <input
              type="checkbox"
              checked={value.some((c) => c.accountId === a.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, { accountId: a.id, storeIds: [] }]
                    : value.filter((c) => c.accountId !== a.id),
                )
              }
            />
            {a.name}
          </label>
        ))}
      </div>
      {value.map((c) => {
        const account = options.douyinAccounts.find(
          (a) => a.id === c.accountId,
        );
        const stores = options.stores.filter(
          (s) =>
            account?.storeIds?.includes(s.id) &&
            s.platform === account.platform,
        );
        return (
          <div key={c.accountId} className="live-channel-row">
            <strong>
              {LIVE_PLATFORMS[account?.platform ?? ""] ?? "历史账号"} ·{" "}
              {account?.name ?? `账号 #${c.accountId}`}
            </strong>
            <button
              type="button"
              className="link-button"
              onClick={() =>
                onChange(value.filter((v) => v.accountId !== c.accountId))
              }
            >
              移除
            </button>
            <div className="live-chips">
              {stores.map((s) => (
                <label key={s.id}>
                  <input
                    type="checkbox"
                    aria-label={`${account?.name}关联${s.name}`}
                    checked={c.storeIds.includes(s.id)}
                    onChange={(e) =>
                      onChange(
                        value.map((v) =>
                          v.accountId === c.accountId
                            ? {
                                ...v,
                                storeIds: e.target.checked
                                  ? [...v.storeIds, s.id]
                                  : v.storeIds.filter((id) => id !== s.id),
                              }
                            : v,
                        ),
                      )
                    }
                  />
                  {s.name}
                  {s.hasJstShop ? "" : "（未绑定聚水潭，可人工核定）"}
                </label>
              ))}
            </div>
            {!stores.length && (
              <p className="notice warn">
                此账号暂无同平台关联店铺，请先补全自媒体账号档案中的关联店铺。
              </p>
            )}
          </div>
        );
      })}
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

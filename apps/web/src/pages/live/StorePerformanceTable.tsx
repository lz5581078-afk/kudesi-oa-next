import './liveWorkspace.css';
import { useState } from "react";
import {
  LIVE_PLATFORMS,
  type LiveChannel,
  type LiveStoreLine,
} from "@kudesi/shared";
import { liveApi, type Candidates } from "./liveApi";
import { errText, money, yuanCents } from "./liveFormat";

export interface StoreDraft {
  storeId: number;
  platform: string;
  sales: string;
  ad: string;
  orders: string[];
  reason: string;
}
export function storeDrafts(
  channels: LiveChannel[],
  existing: LiveStoreLine[] = [],
): StoreDraft[] {
  const stores = new Map(
    channels.flatMap((c) =>
      c.stores.map((s) => [s.id, { ...s, platform: c.platform }] as const),
    ),
  );
  return [...stores.values()].map((s) => {
    const l = existing.find((l) => l.storeId === s.id);
    return {
      storeId: s.id,
      platform: s.platform,
      sales: l ? String(l.salesCents / 100) : "",
      ad: l ? String(l.adSpendCents / 100) : "0",
      orders: l?.orderIds ?? [],
      reason: l?.reason ?? "",
    };
  });
}
export function storePayload(rows: StoreDraft[]): LiveStoreLine[] {
  return rows.map((r) => {
    const sales = yuanCents(r.sales),
      ad = yuanCents(r.ad);
    if (!Number.isSafeInteger(sales) || !Number.isSafeInteger(ad))
      throw Error("请逐店填写有效营业额和投流费用");
    return {
      storeId: r.storeId,
      platform: r.platform,
      salesCents: sales!,
      adSpendCents: ad!,
      orderIds: r.orders,
      reason: r.reason,
    };
  });
}
export function StorePerformanceTable({
  channels,
  rows,
  onChange,
  sessionId,
  endAt,
  showAd = true,
  readOnly = false,
}: {
  channels: LiveChannel[];
  rows: StoreDraft[];
  onChange: (r: StoreDraft[]) => void;
  sessionId?: number;
  endAt?: string;
  showAd?: boolean;
  readOnly?: boolean;
}) {
  const [candidates, setCandidates] = useState<Record<number, Candidates>>({}),
    [error, setError] = useState(""),
    [loading, setLoading] = useState<number | null>(null);
  const patch = (id: number, p: Partial<StoreDraft>) =>
    onChange(rows.map((r) => (r.storeId === id ? { ...r, ...p } : r)));
  const store = (id: number) =>
    channels.flatMap((c) => c.stores).find((s) => s.id === id);
  async function load(id: number) {
    setLoading(id);
    setError("");
    try {
      const c = await liveApi.candidates(sessionId!, {
        storeId: id,
        endAt,
        refresh: true,
      });
      setCandidates((v) => ({ ...v, [id]: c }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(null);
    }
  }
  return (
    <div className="wide live-store-editor">
      <p className="muted live-table-hint">逐店填写营业额；订单与人工核定原因在同一张表中核对。</p>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <div className="live-scroll">
        <table
          className="data-table live-store-performance live-responsive-table"
          aria-label="按店铺填报业绩"
        >
          <thead>
            <tr>
              <th>平台 / 店铺 / 直播号</th>
              <th>营业额（元）</th>
              {showAd && <th>投流费用（元）</th>}
              <th>订单核对 / 人工核定原因</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length && <tr><td colSpan={showAd ? 4 : 3} className="live-empty">先选择直播账号及店铺，再填写各店业绩。</td></tr>}
            {rows.map((r) => {
              const c = candidates[r.storeId];
              return (
                <tr key={r.storeId}>
                  <td data-label="平台 / 店铺 / 直播号">
                    {LIVE_PLATFORMS[r.platform]} · {store(r.storeId)?.name}
                    <small className="muted">
                      {channels
                        .filter((c) => c.storeIds.includes(r.storeId))
                        .map((c) => c.accountName)
                        .join("、")}
                    </small>
                  </td>
                  <td data-label="营业额（元）">
                    <input
                      aria-label={`${store(r.storeId)?.name}营业额`}
                      inputMode="decimal"
                      value={r.sales}
                      disabled={readOnly}
                      onChange={(e) =>
                        patch(r.storeId, { sales: e.target.value })
                      }
                    />
                  </td>
                  {showAd && (
                    <td data-label="投流费用（元）">
                      <input
                        aria-label={`${store(r.storeId)?.name}投流费用`}
                        inputMode="decimal"
                        value={r.ad}
                        disabled={readOnly}
                        onChange={(e) =>
                          patch(r.storeId, { ad: e.target.value })
                        }
                      />
                    </td>
                  )}
                  <td data-label="订单核对 / 人工核定原因">
                    {!!r.orders.length&&!c&&<small>已载入 {r.orders.length} 个原订单</small>}
                    {sessionId && !readOnly && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={loading === r.storeId}
                        onClick={() => void load(r.storeId)}
                      >
                        {loading === r.storeId ? "读取中…" : "读取本店订单"}
                      </button>
                    )}
                    {c && !c.available && (
                      <p className="notice warn">{c.reason}</p>
                    )}
                    {c?.truncated && (
                      <p className="notice warn">
                        订单读取不完整，请填写人工核定原因。
                      </p>
                    )}
                    {c?.available && !c.truncated && (
                      <details>
                        <summary>
                          勾选本场订单（已选 {r.orders.length} 单）
                        </summary>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            patch(r.storeId, {
                              orders: c.orders
                                .filter((o) => o.paid && !o.cancelled)
                                .map((o) => o.orderId),
                              sales: String(
                                c.orders
                                  .filter((o) => o.paid && !o.cancelled)
                                  .reduce((n, o) => n + o.amountCents, 0) / 100,
                              ),
                            })
                          }
                        >
                          选择全部有效订单并带入营业额
                        </button>
                        <div className="live-store-order-list">{c.orders.map((o) => (
                          <label className="live-order-option" key={o.orderId}>
                            <input
                              type="checkbox"
                              disabled={!o.paid || o.cancelled}
                              checked={r.orders.includes(o.orderId)}
                              onChange={(e) =>
                                patch(r.storeId, {
                                  orders: e.target.checked
                                    ? [...r.orders, o.orderId]
                                    : r.orders.filter((id) => id !== o.orderId),
                                })
                              }
                            />
                            {o.orderId} · {money(o.amountCents)}
                          </label>
                        ))}</div>
                      </details>
                    )}
                    <textarea
                      rows={2}
                      aria-label={`${store(r.storeId)?.name}人工核定原因`}
                      placeholder="未核对订单时填写原因"
                      maxLength={500}
                      value={r.reason}
                      disabled={readOnly}
                      onChange={(e) =>
                        patch(r.storeId, { reason: e.target.value })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th data-label="平台 / 店铺 / 直播号">本场合计</th>
              <td data-label="营业额合计">
                {money(rows.reduce((n, r) => n + (yuanCents(r.sales) || 0), 0))}
              </td>
              {showAd && (
                <td data-label="投流合计">
                  {money(rows.reduce((n, r) => n + (yuanCents(r.ad) || 0), 0))}
                </td>
              )}
              <td data-label="计薪规则">各平台营业额分别计算提成；场次工资按时间计算一次。</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

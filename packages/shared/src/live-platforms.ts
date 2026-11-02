import { liveComputeCommission, type LiveRules } from "./live";

export const LIVE_PLATFORMS: Record<string, string> = {
  douyin: "抖音",
  kuaishou: "快手",
  channels: "视频号",
  xhs: "小红书",
  other: "其他",
};
export interface LiveChannelInput {
  accountId: number;
  storeIds: number[];
}
export interface LiveChannel extends LiveChannelInput {
  platform: string;
  accountName: string;
  stores: Array<{ id: number; name: string; jstShopId: string }>;
}
export interface LiveStoreLine {
  storeId: number;
  platform: string;
  salesCents: number;
  adSpendCents: number;
  orderIds?: string[];
  reason?: string;
  ordersTotalCents?: number;
  orderCount?: number;
  verified?: boolean;
}
export function liveJsonArray<T>(value: unknown): T[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}
/** Platform totals are rounded and tiered independently. Never tier a combined session total. */
export function livePlatformCommissions(
  rules: LiveRules,
  lines: ReadonlyArray<{
    platform: string;
    salesCents: number;
    adSpendCents: number | null;
  }>,
) {
  const totals = new Map<
    string,
    { platform: string; salesCents: number; adSpendCents: number | null }
  >();
  for (const line of lines) {
    const t = totals.get(line.platform) ?? {
      platform: line.platform,
      salesCents: 0,
      adSpendCents: 0,
    };
    t.salesCents += line.salesCents;
    t.adSpendCents =
      t.adSpendCents === null || line.adSpendCents === null
        ? null
        : t.adSpendCents + line.adSpendCents;
    totals.set(line.platform, t);
  }
  return [...totals.values()].map((t) => ({
    platform: t.platform,
    ...liveComputeCommission({
      rules,
      finalSalesCents: t.salesCents,
      adSpendCents: t.adSpendCents,
    }),
  }));
}

import { describe, expect, it } from "vitest";
import {
  LIVE_DEFAULT_RULES,
  liveBuildSettlement,
  liveComputeCommission,
  liveComputeWage,
  liveRefundKey,
} from "./live";
import { livePlatformCommissions } from "./live-platforms";

describe("多平台直播核算", () => {
  it("同平台多店合并营业额，各平台独立分档和计算ROI，三平台共用一次计时工资", () => {
    const lines = [
      { platform: "douyin", salesCents: 60000, adSpendCents: 10000 },
      { platform: "douyin", salesCents: 40000, adSpendCents: 10000 },
      { platform: "kuaishou", salesCents: 1000000, adSpendCents: 1000000 },
      { platform: "channels", salesCents: 200000, adSpendCents: 0 },
    ];
    const results = livePlatformCommissions(LIVE_DEFAULT_RULES, lines);
    expect(results).toHaveLength(3);
    for (const r of results) {
      const selected = lines.filter((l) => l.platform === r.platform);
      expect(r).toEqual({
        platform: r.platform,
        ...liveComputeCommission({
          rules: LIVE_DEFAULT_RULES,
          finalSalesCents: selected.reduce((n, l) => n + l.salesCents, 0),
          adSpendCents: selected.reduce((n, l) => n + l.adSpendCents, 0),
        }),
      });
    }
    expect(results.find((r) => r.platform === "douyin")?.finalSalesCents).toBe(
      100000,
    );
    expect(results.find((r) => r.platform === "kuaishou")?.belowRoi).toBe(true);
    const wage = liveComputeWage({
      startAt: "2026-09-28 20:00:00",
      endAt: "2026-09-28 23:00:00",
      hourlyRateCents: 5000,
    });
    expect(wage).toMatchObject({ minutes: 180, amountCents: 15000 });
  });
  it("退款只扣对应平台，跨店同号订单按店铺识别；退款合计不重复计算角色", () => {
    const records = [
      {
        id: 1,
        sessionId: 1,
        platform: "douyin",
        role: "anchor",
        amountCents: 1000,
        rateUnits: 100,
      },
      {
        id: 2,
        sessionId: 1,
        platform: "douyin",
        role: "control",
        amountCents: 500,
        rateUnits: 50,
      },
      {
        id: 3,
        sessionId: 1,
        platform: "kuaishou",
        role: "anchor",
        amountCents: 4000,
        rateUnits: 400,
      },
    ];
    const orders = new Map([
      [
        1,
        [
          {
            shopId: "D",
            orderId: "SAME",
            platform: "douyin",
            amountCents: 100000,
          },
          {
            shopId: "K",
            orderId: "SAME",
            platform: "kuaishou",
            amountCents: 100000,
          },
        ],
      ],
    ]);
    const built = liveBuildSettlement(
      records,
      orders,
      new Map([
        [liveRefundKey("D", "SAME"), { cents: 20000 }],
        [liveRefundKey("K", "SAME"), { cents: 10000 }],
      ]),
    );
    expect(built.lines.map((l) => [l.refundCents, l.deductionCents])).toEqual([
      [20000, 200],
      [20000, 100],
      [10000, 400],
    ]);
    expect(built.totals.refundCents).toBe(30000);
    expect(built.totals.deductionCents).toBe(700);
  });
});

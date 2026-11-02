import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelPicker } from "./ChannelPicker";
import {
  StorePerformanceTable,
  storeDrafts,
  storePayload,
} from "./StorePerformanceTable";
import { PayrollTab } from "./PayrollTab";
import { liveApi, type Options } from "./liveApi";
import type { LiveChannel } from "@kudesi/shared";
import { useState } from "react";

vi.mock("./liveApi", () => ({
  liveApi: { candidates: vi.fn(), commissions: vi.fn(), wages: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const options = {
  rooms: [],
  anchors: [],
  controls: [],
  operators: [],
  douyinAccounts: [
    {
      id: 1,
      name: "抖音直播号",
      detail: "",
      platform: "douyin",
      storeIds: [10],
    },
    {
      id: 2,
      name: "快手直播号",
      detail: "",
      platform: "kuaishou",
      storeIds: [20],
    },
  ],
  stores: [
    {
      id: 10,
      name: "抖音店",
      detail: "",
      platform: "douyin",
      hasJstShop: true,
    },
    {
      id: 20,
      name: "快手店",
      detail: "",
      platform: "kuaishou",
      hasJstShop: false,
    },
  ],
} as Options;
const channels: LiveChannel[] = [
  {
    accountId: 1,
    accountName: "抖音直播号",
    platform: "douyin",
    storeIds: [10],
    stores: [{ id: 10, name: "抖音店", jstShopId: "D" }],
  },
  {
    accountId: 2,
    accountName: "快手直播号",
    platform: "kuaishou",
    storeIds: [20],
    stores: [{ id: 20, name: "快手店", jstShopId: "" }],
  },
];

describe("多平台直播表单与工资", () => {
  it("切换平台保留已选账号；店铺按账号关联过滤", () => {
    const change = vi.fn();
    render(
      <ChannelPicker
        options={options}
        value={[{ accountId: 1, storeIds: [10] }]}
        onChange={change}
      />,
    );
    expect(screen.getByLabelText("抖音直播号关联抖音店")).toBeTruthy();
    expect(screen.queryByLabelText("抖音直播号关联快手店")).toBeNull();
    fireEvent.change(screen.getByLabelText("直播平台"), {
      target: { value: "kuaishou" },
    });
    fireEvent.click(screen.getByLabelText("快手直播号"));
    expect(change).toHaveBeenCalledWith([
      { accountId: 1, storeIds: [10] },
      { accountId: 2, storeIds: [] },
    ]);
    expect(screen.getByText(/抖音 · 抖音直播号/)).toBeTruthy();
  });
  it("逐店填写金额和原因，合并同店账号；空营业额不能变成0提交", () => {
    const all = [
      ...channels,
      { ...channels[0], accountId: 3, accountName: "抖音副号" },
    ];
    expect(storeDrafts(all)).toHaveLength(2);
    expect(() => storePayload(storeDrafts(all))).toThrow(/逐店/);
    function Form() {
      const [rows, setRows] = useState(storeDrafts(all));
      return (
        <StorePerformanceTable channels={all} rows={rows} onChange={setRows} />
      );
    }
    render(<Form />);
    const table = screen.getByRole("table", { name: "按店铺填报业绩" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    fireEvent.change(screen.getByLabelText("抖音店营业额"), {
      target: { value: "100.25" },
    });
    fireEvent.change(screen.getByLabelText("快手店营业额"), {
      target: { value: "99.75" },
    });
    expect(within(table).getByText("¥200.00")).toBeTruthy();
    expect(screen.getByText("抖音直播号、抖音副号")).toBeTruthy();
  });
  it("两个平台提成分别显示，单场工资与时长只合计一次", async () => {
    const base = {
      sessionId: 7,
      userId: 3,
      userName: "主播甲",
      role: "anchor",
      roleLabel: "主播",
      date: "2026-09-28",
      roomName: "直播间甲",
      startAt: "",
      douyinName: "",
      adSpendCents: 0,
      roiScaled: null,
      belowRoi: false,
      rateUnits: 100,
      ruleVersionId: 1,
    };
    vi.mocked(liveApi.commissions).mockResolvedValue({
      month: "2026-09",
      scope: "all",
      summary: [],
      totalCents: 3000,
      rows: [
        {
          ...base,
          id: 1,
          platform: "douyin",
          finalSalesCents: 100000,
          amountCents: 1000,
        },
        {
          ...base,
          id: 2,
          platform: "kuaishou",
          finalSalesCents: 200000,
          amountCents: 2000,
        },
      ],
    });
    vi.mocked(liveApi.wages).mockResolvedValue({
      month: "2026-09",
      scope: "all",
      summary: [],
      totalCents: 15000,
      rows: [
        {
          id: 1,
          sessionId: 7,
          userId: 3,
          userName: "主播甲",
          role: "anchor",
          date: "2026-09-28",
          roomName: "直播间甲",
          startAt: "",
          endAt: "",
          minutes: 180,
          hourlyRateCents: 5000,
          rateSource: "archive",
          amountCents: 15000,
          note: "",
        },
      ],
    });
    render(<PayrollTab role="anchor" onOpen={() => {}} />);
    await waitFor(() =>
      expect(
        screen.getByRole("table", { name: "工资提成明细" }).textContent,
      ).toContain("快手"),
    );
    const summary = screen.getByRole("table", { name: "工资汇总" });
    expect(summary.textContent).toContain("180.00");
    const row = within(summary).getAllByRole("row")[1];
    expect(within(row).getAllByRole("cell")[1].textContent).toBe("1");
    expect(within(row).getAllByRole("cell")[3].textContent).toBe("¥150.00");
  });
});

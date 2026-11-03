import { EntityManager } from "typeorm";
import {
  LIVE_PLATFORMS,
  liveJsonArray,
  liveToText,
  type LiveChannel,
  type LiveChannelInput,
  type LiveStoreLine,
} from "@kudesi/shared";
import { liveDouyinAccounts, liveDouyinStores } from "./live-access";
import { liveClock, liveFail, type Row } from "./live-core";
import { LiveOrderSource, type LiveOrder } from "./live-order-source";

export const channelsOf = (row: Row) =>
  liveJsonArray<LiveChannel>(row.channels_json);
export const linesOf = (row: Row) =>
  liveJsonArray<LiveStoreLine>(row.store_lines_json);
export function channelStores(channels: LiveChannel[]) {
  const stores = new Map<
    number,
    { id: number; name: string; jstShopId: string; platform: string }
  >();
  for (const c of channels)
    for (const s of c.stores) stores.set(s.id, { ...s, platform: c.platform });
  return [...stores.values()];
}
export async function validateChannels(
  em: EntityManager,
  companyId: number,
  input: LiveChannelInput[],
  onUnlinkedStore?: (message: string) => void,
): Promise<LiveChannel[]> {
  if (!Array.isArray(input) || !input.length || input.length > 20)
    liveFail("请选择 1 到 20 个有直播权限的账号", 400);
  const accounts = await liveDouyinAccounts(em, companyId),
    stores = await liveDouyinStores(em, companyId);
  const seen = new Set<number>(),
    shops = new Map<string, number>();
  return input.map((c) => {
    const a = accounts.find((a) => a.id === c.accountId);
    if (!a || !a.platform || !LIVE_PLATFORMS[a.platform])
      liveFail("直播账号不存在、已停用或没有直播权限", 400);
    if (seen.has(c.accountId)) liveFail("同一个直播账号不能重复选择", 400);
    seen.add(c.accountId);
    if (
      !Array.isArray(c.storeIds) ||
      !c.storeIds.length ||
      c.storeIds.length > 20 ||
      new Set(c.storeIds).size !== c.storeIds.length
    )
      liveFail("每个直播账号请选择关联店铺，不能重复", 400);
    const selected = c.storeIds.map((id) => {
      const s = stores.find((s) => s.id === id);
      if (!s || s.platform !== a!.platform)
        liveFail("店铺必须属于当前公司、同一平台且已关联该直播账号", 400);
      if (!a!.storeIds?.includes(id)) {
        if (!onUnlinkedStore) liveFail("店铺必须属于当前公司、同一平台且已关联该直播账号", 400);
        onUnlinkedStore(`直播账号「${a!.name}」当前未关联店铺「${s!.name}」`);
      }
      if (
        s!.jstShopId &&
        stores.some(
          (other) => other.id !== id && other.jstShopId === s!.jstShopId,
        )
      )
        liveFail("聚水潭店铺编号重复，请先修正店铺绑定", 400);
      const previous = shops.get(s!.jstShopId || `local:${id}`);
      if (previous && previous !== id) liveFail("聚水潭店铺编号重复", 400);
      shops.set(s!.jstShopId || `local:${id}`, id);
      return { id, name: s!.name, jstShopId: s!.jstShopId || "" };
    });
    return {
      accountId: c.accountId,
      accountName: a!.name,
      platform: a!.platform!,
      storeIds: c.storeIds,
      stores: selected,
    };
  });
}
export async function assertAccountTime(
  em: EntityManager,
  companyId: number,
  channels: LiveChannel[],
  startAt: string,
  endAt: string | null,
  excludeSession?: number,
  excludeSchedule?: number,
  purpose: "actual" | "schedule" = "actual",
) {
  const now = liveToText(liveClock.now())!;
  const futureSchedule = purpose === "schedule" && startAt > now;
  for (const table of ["live_sessions", "live_schedules"]) {
    const session = table === "live_sessions";
    const exclude = session ? excludeSession : excludeSchedule;
    // Planning projects an unfinished session to its scheduled end. Actual starts and
    // historical corrections retain the open-ended occupation until a real checkout.
    const projected = session && futureSchedule;
    const source = projected ? "live_sessions s LEFT JOIN live_schedules p ON p.company_id=s.company_id AND p.id=s.schedule_id" : `${table} s`;
    const occupiedUntil = projected ? "COALESCE(s.end_at,p.end_at,?)" : "COALESCE(s.end_at,'9999-12-31')";
    const rows: Row[] = await em.query(
      `SELECT s.* FROM ${source} WHERE s.company_id=? AND s.status IN (${session ? "'live','pending_report','submitted','returned','approved'" : "'scheduled','live'"}) AND s.start_at${endAt ? "<" : "<="}? AND ${occupiedUntil}>?${exclude ? " AND s.id<>?" : ""}`,
      [companyId, endAt ?? startAt, ...(projected ? [now] : []), startAt, ...(exclude ? [exclude] : [])],
    );
    for (const row of rows) {
      if (
        session &&
        excludeSchedule &&
        Number(row.schedule_id) === excludeSchedule
      )
        continue;
      if (
        !session &&
        excludeSession &&
        Number(row.session_id) === excludeSession
      )
        continue;
      const ids = channelsOf(row).map((c) => c.accountId);
      if (!ids.length) ids.push(Number(row.douyin_account_id));
      if (channels.some((c) => ids.includes(c.accountId)))
        liveFail("所选直播账号在该时间段已有场次或排场", 400);
    }
  }
}

export interface CheckedStoreLines {
  lines: LiveStoreLine[];
  picked: Array<LiveOrder & { shopId: string; platform: string }>;
  sales: number;
  ad: number;
}
/** Check every shop against the immutable session snapshot; unavailable queries require a reason. */
export async function checkStoreLines(
  source: LiveOrderSource,
  companyId: number,
  session: Row,
  input: LiveStoreLine[],
  endAt: string,
  manual = false,
): Promise<CheckedStoreLines> {
  const stores = channelStores(channelsOf(session));
  if (
    !stores.length ||
    !Array.isArray(input) ||
    input.length !== stores.length ||
    new Set(input.map((l) => l.storeId)).size !== stores.length
  )
    liveFail("请逐店填写本场全部店铺的业绩，不能漏报或重复", 400);
  const picked: CheckedStoreLines["picked"] = [],
    lines: LiveStoreLine[] = [];
  for (const s of stores) {
    const line = input.find((l) => l.storeId === s.id);
    if (!line || line.platform !== s.platform)
      liveFail("填报店铺或平台与本场不符", 400);
    for (const value of [line!.salesCents, line!.adSpendCents])
      if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000_000)
        liveFail("店铺金额必须为有效的非负金额", 400);
    const ids = line!.orderIds ?? [];
    if (ids.length > 500 || new Set(ids).size !== ids.length)
      liveFail("店铺订单不能重复，最多500条", 400);
    const reason = String(line!.reason || "").trim();
    let found = s.jstShopId
      ? await source.candidates(
          companyId,
          {
            id: Number(session.id || 0),
            shopId: s.jstShopId,
            startAt: session.start_text,
            endAt,
          },
          { refresh: true },
        )
      : null;
    const verified = !!found?.available && !found.truncated;
    if (!verified && (!reason || reason.length > 500))
      liveFail(
        `${s.name}：${found?.reason || "未绑定聚水潭或订单查询不完整"}，请填写人工核定原因`,
        400,
      );
    if (!verified && ids.length)
      liveFail(`${s.name}：未读到完整订单，不能使用订单号`, 400);
    if (
      verified &&
      !manual &&
      found!.orders.some((o) => o.paid && !o.cancelled) &&
      !ids.length
    )
      liveFail(`${s.name}：请勾选本场订单`, 400);
    const selected = ids.map((id) => {
      const o = found?.orders.find((o) => o.orderId === id);
      if (!o) liveFail(`${s.name}：订单 ${id} 不在本场的聚水潭订单范围内`, 400);
      if (!o!.paid || o!.cancelled)
        liveFail(`${s.name}：订单 ${id} 未付款或已取消，不能勾选`, 400);
      return { ...o!, shopId: s.jstShopId, platform: s.platform };
    });
    picked.push(...selected);
    lines.push({
      storeId: s.id,
      platform: s.platform,
      salesCents: line!.salesCents,
      adSpendCents: line!.adSpendCents,
      orderIds: ids,
      reason,
      verified: verified && (selected.length > 0 || line!.salesCents === 0),
      ordersTotalCents: selected.reduce((n, o) => n + o.amountCents, 0),
      orderCount: selected.length,
    });
  }
  const sales = lines.reduce((n, l) => n + l.salesCents, 0),
    ad = lines.reduce((n, l) => n + l.adSpendCents, 0);
  if (sales > 10_000_000_000 || ad > 10_000_000_000)
    liveFail("单场合计金额超出范围", 400);
  return { lines, picked, sales, ad };
}
export async function persistStoreLines(
  em: EntityManager,
  companyId: number,
  sessionId: number,
  reportId: number,
  checked: CheckedStoreLines,
) {
  for (const o of checked.picked) {
    const [duplicate] = await em.query(
      "SELECT id FROM live_session_orders WHERE company_id=? AND shop_id=? AND order_id=? AND session_id<>? LIMIT 1",
      [companyId, o.shopId, o.orderId, sessionId],
    );
    if (duplicate) liveFail("订单已计入其他场次，不能重复计算业绩", 400);
  }
  await em.query(
    "DELETE FROM live_session_orders WHERE company_id=? AND report_id=?",
    [companyId, reportId],
  );
  for (const o of checked.picked)
    await em.query(
      "INSERT INTO live_session_orders(company_id,session_id,report_id,order_id,inner_order_id,amount_cents,pay_time,order_status,shop_id,platform) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        companyId,
        sessionId,
        reportId,
        o.orderId,
        o.innerId || null,
        o.amountCents,
        o.payTime,
        o.status,
        o.shopId,
        o.platform,
      ],
    );
  await em.query(
    "UPDATE live_session_reports SET store_lines_json=?,order_count=?,orders_total_cents=? WHERE company_id=? AND id=?",
    [
      JSON.stringify(checked.lines),
      checked.picked.length,
      checked.picked.reduce((n, o) => n + o.amountCents, 0),
      companyId,
      reportId,
    ],
  );
}

# 直播管理对齐旧站（feat/live-parity）

旧站 oa.kudesi.com「直播管理」按功能、规则、口径迁到新系统；不复用旧代码和旧界面。旧仓库（bdf4f6d）只读，旧库副本 `legacy_full`（到 10-24）只读。
本文是审计结论、补齐内容、字段与权限对照、迁移与上线说明。

## 1. 结论总览

按 §2 的 29 条功能统计：已一致 19 条；部分一致 2 条（#4 排场通知、#8 订单读取）；缺失、本次已补 5 条（#9、#10、#11、#21、#23）；新增 1 条（#29 历史数据迁入）；缺失、未做 1 条（#27）；故意不同 1 条（#1）。另有跨条目的故意不同见 §5。

提成公式、工资、月结行、退款判定、规则版本选取用**旧代码跑出的黄金用例**对拍：495 个提成组合（三套规则 × 边界/投产/小数销售额）加工资、结算、退款、版本选取，全部与旧结果逐项一致。测试：`packages/shared/src/live-legacy-parity.test.ts`，夹具 `packages/shared/src/fixtures/live-legacy-golden.json`。

## 2. 旧功能清单与对照（旧来源 → 新实现 → 结论）

| # | 旧功能 | 旧来源（/home/claude/kudesi-oa） | 新实现 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 角色判定：主播/中控/运营/管理（旧按部门、岗位名） | server/modules/live/access.js | `live-access.ts`，按 `positions.workspace_type`（live_anchor/live_control/operations）；管理看 `live.manage` | 故意不同（规则 8） |
| 2 | 直播间列表、南北走廊分组、直播中/过时未上播状态 | rooms.js、src/live/LiveOverview.jsx | 全览页（`LiveOverview` 同名功能，`OverviewTab`），直播间来自「位置」资料 | 已一致 |
| 3 | 排场新增/修改/取消，同房间不重叠、同主播不同时两间、首尾相接可以、最长 16 小时 | routes.js、LiveSchedules.jsx | `live-schedule.service.ts` + 排场页 | 已一致 |
| 4 | 排场通知相关人（新排班/调整/移除/取消/开播提醒），带版本号 | schedule-notifications.js | 站内通知 + 飞书出站队列；`notification_version`/`reminder_version` 保留 | 部分一致（§3-1） |
| 5 | 上播：开始前 2 小时起、可临时加场、必须选店铺和产品、店铺要绑聚水潭 | routes.js、LiveRunDialog.jsx | `LiveSessionService.start`、`StartDialog` | 已一致 |
| 6 | 同房间/同主播只能一场直播中 | live_sessions 的 live_room_lock / live_anchor_lock | `live_room_key`/`live_anchor_key` 生成列唯一键 | 已一致 |
| 7 | 报下播：只能本人填报，主播填销售额，中控填销售额+投流 | routes.js | `LiveSessionService.report` | 已一致 |
| 8 | 从聚水潭勾选本场订单，金额与付款时间以服务端重查为准 | jushuitan-orders.js | `LiveOrderSource`（`JushuitanOrderSource` 只读） | 部分一致（§3-2）、故意不同（§5-1） |
| 9 | 本场聚水潭查到没订单时可以不勾 | report-state.mjs | 本次补齐（空订单放行，没授权/截断不放行） | 缺失→已补 |
| 10 | 报下播时实时预估提成（只显示本人角色） | LiveRunDialog.jsx、preview-privacy.js | `POST /live/sessions/:id/commission-preview` + 报下播弹窗 | 缺失→已补 |
| 11 | 销售额随勾选订单合计自动带出；一键勾选全部已付款/清空 | LiveRunDialog.jsx | 报下播弹窗 | 缺失→已补 |
| 12 | 提交审核：主播/中控任一人提交，需两人都已报；被退回后可改再提交 | review.js | `submit` + 流程模板 `live-session-review` | 已一致（引擎承载，§5-2） |
| 13 | 审核：最终销售额来源（主播/中控/订单合计/手填+原因）、运营指定（不能是主播）、工资时间/时薪调整 | review.js、LiveReviewDialog.jsx | `reviewPreview` + 流程步骤表单 | 已一致 |
| 14 | 审核通过写提成记录 + 主播工资 + 规则快照 | review.js、commission.js、wage.js | `live-review.ts` | 已一致（对拍） |
| 15 | 提成公式：档位、边界含下限/上限、投产不足扣点、运营固定点数 | commission.js | `packages/shared/src/live.ts` `liveComputeCommission` | 已一致（495 例） |
| 16 | 主播工资：分钟×时薪，时薪取兼职档案/审核手填 | wage.js | `liveComputeWage` | 已一致 |
| 17 | 提成规则版本只追加、按场次日期取版本、编辑器试算 | commission.js、routes.js | `live-ledger.service.ts` 规则页 | 已一致 |
| 18 | 提成记录、主播工资记录：全员权限看全部，其他人只看本人 | routes.js | `live.commissions.view` | 已一致 |
| 19 | 月底结算：只读核对退款（订单取消=整单退；已完成售后累计；不含换货补发）、按原比例扣减、提交后锁月 | settlement.js、jushuitan-refunds.js | `live-settlement.service.ts`、`liveRefundForOrder` | 已一致（对拍） |
| 20 | 结算单审批 | workflows/live-*-adapter.js | 流程模板 `live-settlement` | 已一致（引擎承载） |
| 21 | 聚水潭没授权/没配置/过期时的提示 | （旧：直接报错） | `GET /live/integration-status`，页面顶部与弹窗内提示；月结在未就绪时拒绝生成 | 缺失→已补 |
| 22 | 我的直播：本月提成/工资、本周排场、进行中、最近 20 场 | LiveWorkspace.jsx | `LiveDeskPage` | 已一致 |
| 23 | 我的直播：下一场直播卡、本月提成明细、本月工资明细 | LiveWorkspace.jsx | 本次补齐（工作台接口返回 `commissionRows`/`wageRows`） | 缺失→已补 |
| 24 | 我的场次历史：按月/区间/全部，汇总（全部/本月/上月） | workbench-history.js、LiveHistory.jsx | `history` + `HistoryPanel` | 已一致 |
| 25 | 提成预览隐私：非本人角色不返回 | preview-privacy.js | `liveFilterPreview` | 已一致 |
| 26 | 总控台卡片：待审核、过时未上播；运营今日排场；主播本月提成 | OperationsLiveSummary.jsx | `live-workspace.ts` | 已一致 |
| 27 | 运营“被退回/待提交”提醒卡 | OperationsLiveSummary.jsx | 未做 | 缺失（待决） |
| 28 | 兼职档案附件 | employee_workforce_attachments | 已有 `workforce` 资料迁移（五类附件） | 已一致 |
| 29 | 历史数据迁入 | （无） | `apps/api/src/migration/live-import.ts` | 新增，见 §7 |

## 3. 部分一致

1. **排场通知**：旧系统发送前会再核对一次“这条通知是否还适用”。新系统改排场/取消时把还没发出的旧通知直接置为已取消（`cancelPending`，移除通知除外），效果相同，但已经发出的不能撤回。
2. **聚水潭订单读取**：旧系统按 7 天分段、遇限流重试、30 分钟缓存。新系统走统一的只读接入（`JushuitanClient`），单次窗口最长 48 小时，没有分段/缓存；订单太多时返回“已截断”，报下播直接拦住并提示联系管理员，不放行残缺订单。
3. **旧通知历史**：不迁已发送的站内通知（一次性提醒），只迁排场上的 `notification_version`。

## 4. 本次补齐（缺失→已补）

- 报下播：本场没订单可不勾；没授权/没配置/过期/订单被截断时明确拒绝并写原因（`409`）。
- 预估提成：保存前即可试算，只显示本人能看到的角色，销售额格式不对返回 400。
- 勾选订单：一键勾选全部已付款、清空；销售额跟随订单合计（本人手改后不再覆盖）。
- 聚水潭授权状态：顶部提示条（直播管理、我的直播、报下播弹窗），月结在没就绪时拒绝生成并给出管理员要做的事。
- 排场通知同步飞书（出站队列，公司级开关，默认关）；改排场作废旧的未发通知。
- 工作台：下一场卡、本月提成明细、本月工资明细。
- 报下播订单列表样式（原来每行竖排，现为一行一单）。
- 旧直播数据迁入（§7）。

## 5. 故意不同（及原因）

1. **未付款/已取消订单不能勾选**：旧系统候选里都能勾；新系统规定结算按已付款订单，且服务端重查校验，避免把无效订单算进销售额。（需要用户确认，见 §8-1）
2. **审批走统一流程引擎**：旧系统每个业务单独写适配器与固定审批人；新系统用 `live-session-review` / `live-settlement` 模板，审批人由管理员在流程配置里发布。
3. **角色按 `positions.workspace_type`**，不按岗位名称正则。
4. **聚水潭店铺 ID 放在店铺资料字段**，不再用旧的 `integration_store_mappings`。
5. **金额整数分、点数 ×100、投产 ×10000**，旧库是 DECIMAL；迁移时精确换算，不能精确表示的整行不迁。
6. **没有任何聚水潭写入**：只读；飞书通知走出站队列且有总开关。

## 6. 字段与权限对照

### 6.1 旧表 → 新表字段

| 旧表.列 | 新表.列 | 换算 |
| --- | --- | --- |
| live_schedules.room_location_id / douyin_account_id / store_id | live_schedules.room_id / douyin_account_id / store_id（均为资料记录） | 通过迁入账本映射；名称快照取资料标题 |
| *_employee_id | *_user_id | 员工 → 用户 |
| status、notification_version | status、notification_version | 原值 |
| live_sessions.final_sales / approved_by | final_sales_cents / approved_by | 元→分 |
| live_sessions.workflow_run_id/workflow_instance_id | flow_run_id | **不迁**（旧审批实例） |
| live_sessions.live_room_lock/live_anchor_lock | live_room_key/live_anchor_key（生成列） | 新库自动生成 |
| live_session_reports.sales_amount/ad_spend/orders_total | sales_cents/ad_spend_cents/orders_total_cents | 元→分 |
| live_session_reports.reporter_role / reporter_employee_id | role / reporter_user_id | |
| live_session_orders.amount | amount_cents | 元→分 |
| live_commission_records.final_sales/ad_spend/amount | *_cents | 元→分 |
| live_commission_records.roi（4 位小数） | roi_scaled | ×10000 |
| live_commission_records.rate（百分数） | rate_units | ×100 |
| live_commission_records.rule_snapshot | rule_snapshot | `{versionId,effectiveFrom,rules,belowRoi,legacySnapshot}`，旧快照原样放 legacySnapshot |
| live_wage_records.hourly_rate/amount | hourly_rate_cents/amount_cents | 元→分 |
| live_commission_rule_versions.rules_json | rules_json | 走 `liveRulesFromInput`（档位元→分、点数→units、运营点数缺省） |
| live_settlements.*_total | *_total_cents | 元→分 |
| live_settlement_lines.rate / commission_amount / refund_amount… | rate_units / commission_cents / refund_cents… | |
| live_settlement_refunds.order_amount/refund_amount | order_amount_cents/refund_cents | |

### 6.2 权限键

| 旧（旧站页面/岗位权限） | 新键（只在 `navigation.ts` 定义） | 用途 |
| --- | --- | --- |
| 直播管理页入口 | `features.live.view` | 看直播管理全览、排场、场次、规则 |
| 直播管理员操作 | `live.manage` | 排场增删改、生成/提交月结 |
| 看全部人提成/工资 | `live.commissions.view` | 否则只看本人 |
| 我的直播入口（主播/中控/运营） | `features.live-desk.view` | 报上播/下播、提交 |
| 审核/月结审批 | 流程引擎步骤审批人 | 在流程配置里发布 `live-session-review`、`live-settlement` |

没有新增权限键，没有新迁移（现有 `1749000000000` 的表足够；迁入只写数据）。

## 7. 数据迁移

### 7.1 映射

- 适配器 `scripts/migration/legacy-adapter.cjs` 只读十一张旧表（全部带 company_id），原样交出 `live`；金额保持十进制字符串。
- 导入器 `apps/api/src/migration/live-import.ts`：规则版本 → 排场 → 场次 → 上播产品 → 下播报告 → 勾选订单 → 提成记录 → 工资 → 月结单 → 明细 → 退款。
- 引用映射：员工用 `user`，直播间用 `locations`，抖音号用 `self-media`，店铺用 `stores`，基础编码用 `finance-base-codes`；缺映射的行失败并写原因，不造数据。
- 状态规则：旧“待审核”的场次迁成“待提交审核”；旧“审批中”的月结单迁成“已退回”（原因：旧系统审批中，迁入后需重新提交）；其余原样。
- 幂等：沿用 `legacy_import_links` 账本和源数据指纹；源数据变化时拒绝静默复用；每行一个保存点，坏行只影响自己。
- 试跑（默认）整个事务回滚，报告列出 created / reused / failed / excluded（`live_*` 类型）。
- 测试：`live-import.db.spec.ts`（真实 MySQL）、`legacy-adapter-live.spec.ts`。

### 7.2 对 legacy_full 的试跑结果（只读，目标是一次性本机新库，已回滚）

旧库直播业务数据为空，只有 2 条规则版本（公司 1、公司 3，均 2026-01-01 起，3 档，投产阈值 10）。

- 公司 3：`live_rule_version` 创建 1，其余直播类型 0；`live_*` 失败 0、排除 0。
- 公司 1：`live_rule_version` 创建 1；`live_*` 失败 0。
- 其余失败项（商品、组合明细等）是此前资料迁移的存量问题，与直播无关，沿用原报告。
- 试跑后目标库直播表行数为 0（回滚确认）。

其余类型只能用合成数据验证：`live-import.db.spec.ts` 覆盖金额分换算、点数/投产换算、状态改写、引用缺失行失败、试跑回滚、复跑幂等、源数据变化拦截。

### 7.3 生产迁入流程（由有服务器权限的人执行）

1. 备份：目标库（含附件目录）完整备份并记录备份名。
2. 试跑：`import-legacy.ts` 不带 `--apply`，指定 `--source-company/--company/--actor/--expected-name/--adapter/--report`；检查报告里 `live_*` 的 failed 与 excluded。
3. 用户确认：把报告给业务负责人核对（尤其“待审核→待提交审核”“审批中结算单→已退回”的清单）。
4. 正式导入：加 `--apply --expected-report <已核对报告> --confirm <库名:目标公司:来源公司>`。
5. 核对：对比旧库月度提成/工资合计与新库；重新提交被改状态的场次和结算单。
6. 注意：先迁位置/自媒体/店铺/基础编码资料和员工，再迁直播数据；这一步放在同一批次里已按此顺序。

## 8. 待用户决定的点

1. 未付款/已取消订单是否允许勾选（新系统不允许，旧系统允许）。
2. 运营“被退回/待提交”提醒卡是否需要补。
3. 聚水潭窗口 48 小时上限与“订单过多不放行”是否可接受，还是需要补旧的 7 天分段和缓存。

## 9. 上线后管理员要做的事

- 勾权限：给相关岗位勾 `features.live.view`、`live.manage`、`live.commissions.view`、`features.live-desk.view`（现有公司不会自动获得）。
- 流程配置：发布 `live-session-review`（场次审核）与 `live-settlement`（月结审批）并指定审批人，否则不能提交。
- 聚水潭授权：在“接口接入”完成本公司授权；未授权时报下播与月结会被拦并提示。店铺资料里填聚水潭店铺 ID。
- 飞书：配置通知渠道 `live`，在公司开关里打开飞书通知（默认关）；绑定员工飞书身份。
- 直播规则：确认当前生效的提成规则版本（迁入的旧规则 2026-01-01 起）。
- 数据迁入：按 §7.3 执行，迁入后处理被改状态的场次与结算单。

## 10. 验证

- shared：`packages/shared` 对拍与单测通过；web：直播页测试 12 条通过；API：`src/live`（真实 MySQL，串行）10 条通过，`src/migration/live-import.db.spec.ts` 4 条通过，适配器 1 条通过。
- 截图：`docs/协作/审计/截图-直播管理对齐/`，`before-*` 是 integration 的旧版，`after-*` 是本分支；`d` 为 1440 宽，`m` 为 390 宽；页面：我的直播工作台、报下播弹窗、直播管理全览、提成规则。截图中的接口数据是为演示构造的夹具，登录使用真实本地 API。

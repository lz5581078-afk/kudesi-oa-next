# UI 对照：售后、订单申诉与兜底监督（u8）

分支 feat/new-aftersales，迁移 1748000000000。旧系统对应 `src/after-sales/`、订单申诉页、监督中心及其后端路由；新系统按统一流程引擎重写，不复用旧代码。

## 1. 旧功能清单与新实现方案

| 旧功能 | 新实现 |
|---|---|
| 售后表格：客服工单登记、状态流转、时限、退款退货处理 | `after_sales_cases` 业务表 + 流程模板 `after-sales`（登记 → 处理 → 主管复核 → 结束）。登记走 `POST /api/after-sales`，内部调用 flow.start（模板带 `entry`，只能从业务页发起）。 |
| 售后截图/附件 | `CaseSupport` 复用 files 服务：上传、拖拽、Ctrl+V 粘贴、删除、取链接。 |
| 粘贴客服文字自动识别 | 前端 `parseAfterSalesText()`（shared）预填订单号/买家/金额，确认后提交。旧的假 OCR 截图识别占位**不做**。 |
| 订单申诉：9 类入口、5 类记录页签、倒计时、举证、复议（每月 3 次提示） | `order_appeals` + 流程模板 `order-appeal`（登记 → 复核举证 → 提交平台 → 登记结果）。复议为 `parent_id` 关联新申诉，仅被平台驳回且未复议过的可发起。 |
| 申诉自动同步（爬取） | **不做**：没有真实数据源，只提供手工登记；外部订单同步如需要只能走只读/出站队列，默认关。 |
| 兜底监督：逾期任务、客服未完结、升级到主管/老板、关闭要写原因 | `supervision_exceptions` + `supervision_rules`，每 5 分钟扫描（`SupervisionScheduler`，测试中关闭），L1/L2/L3 按逾期分钟升级，关闭必须写原因（可配），源头办结自动解除。 |
| 无人负责提醒、员工待办排行 | `overview` 的 `assignmentAlerts`、`people`。 |

流程定义需要管理员在“流程配置”里发布并指定处理人后才能登记，未启用时页面提示“还没有启用”并给出配置入口。

## 2. 售后表格（/after-sales/table）

| 旧功能 | 状态 | 说明 |
|---|---|---|
| 状态/时限筛选、关键字多词搜索、只看我的 | ✓ | 筛选记忆在本机 |
| 汇总（在办/逾期/将到期/金额） | ✓ | 服务端统计，金额为整数分 |
| 登记工单（店铺、订单号、买家、类型、金额、原因、期限） | ✓ | 手工录入；重复在办订单提示/拒绝 |
| 文字粘贴预填 | ✓ | 同旧口径 |
| 截图识别（OCR） | ✗ | 旧系统是假占位，放弃；截图作为附件保存 |
| 处理/复核/退款结果 | ≠ | 改走统一流程待办（RunDetail 弹窗），不在页面写死审批人 |
| 催办、跟进记录 | ✓ | 催办会给当前处理人发通知 |
| 复制工单信息 | ✓ | |

## 3. 订单申诉（/after-sales/appeals）

| 旧功能 | 状态 | 说明 |
|---|---|---|
| 经营中店铺列表 → 店铺工作台 | ✓ | 含在办/超时数；另可看全部店铺 |
| 概况（含本月复议 n/3） | ✓ | |
| 9 个申诉入口卡片 | ✓ | 点击预设类型打开登记框 |
| 5 个申诉记录页签 + 全部 | ✓ | 页签记忆 |
| 订单号（多个）与状态筛选 | ✓ | |
| 表格：订单编号/信息/申诉项/倒计时/处理人/状态 | ✓ | |
| 举证上传、复议 | ✓ | 无凭证不能复核、不能提交平台 |
| 自动同步申诉单 | ✗ | 无数据源，手工登记 |

## 4. 兜底监督（/supervision/center）

| 旧功能 | 状态 | 说明 |
|---|---|---|
| 汇总卡片 | ✓ | |
| 异常列表、级别、关闭原因、跟进 | ✓ | |
| 手工登记异常 | ✓ | |
| 立即扫描 | ✓ | 需 `supervision.manage` |
| 规则编辑 | ✓ | 需 `supervision.manage` |
| 员工排行、无人负责提醒、已关闭列表 | ✓ | |

## 5. 给 u7（老板总控台/首页）的汇总接口

- 服务层：`SupervisionService.summary(companyId): Promise<ServiceSummary>`（`apps/api/src/service/supervision.service.ts`）。
- HTTP：`GET /api/supervision/summary`，需 `supervision.center.view`。
- 形状（`packages/shared/src/service-cases.ts` 的 `ServiceSummary`）：`asOf`；`afterSales{open,overdue,dueSoon,openAmountCents,overdueAmountCents}`；`appeals{open,overdue,dueSoon,toSubmit,openAmountCents}`；`tasks{pending,overdue,completed,total}`；`flows{running,overdue}`；`exceptions{open,urgent,escalated}`。
- 金额为整数分；公司取自登录令牌。

- 工作台接入：`ServiceWorkspaceProvider`（`apps/api/src/service/service-workspace.provider.ts`）已向 u7 的 `WorkspaceModuleRegistry` 注册 `supervision`（异常列表/人员异常数/卡片）和 `after-sales`（售后待处理、订单申诉在办卡片，按各自页面查看权限出数）。接入测试在 `service-cases.db.spec.ts` 最后一个用例。

## 6. 验证矩阵

| 页面 | 功能区布局是否与旧一致 | 功能是否齐 |
|---|---|---|
| 售后表格 | 一致（概况卡、筛选条、表格、登记面板） | 齐，除假 OCR（放弃） |
| 订单申诉 | 一致（店铺列表 → 概况 → 入口卡 → 记录页签与表格） | 齐，除自动同步（无数据源） |
| 兜底监督 | 一致（卡片、异常、排行、规则、已关闭） | 齐 |

## 7. 测试

- shared：service-cases、navigation 测试；API：`service-cases.db.spec.ts`（14 个库测试）、`service.controller.spec.ts`（权限声明）；web：`servicePages.test.tsx`。
- 因新增“售后/监督”分区，手机底栏“更多”首项由“系统”变为“售后”，已同步更新 `navigation.test.ts`、`app.test.tsx`。

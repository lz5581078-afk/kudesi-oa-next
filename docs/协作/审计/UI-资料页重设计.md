# UI·资料页重设计

分支 feat/res-redesign。范围：资料列表、详情、新增/编辑表单的通用外壳（所有资料共用，没有为单个资料另写页面）。不改后端接口语义，无迁移。

## 1. 为什么改

用户反馈：资料页排版里多余的东西太多，应该显示东西的地方占最大面积，详情页设计不好，要整体重设计。

原来的问题（以营业执照列表截图为准）：
- 顶栏小面包屑“资料 / 营业执照”和下面的大标题“营业执照 + 一句说明”重复，位置信息出现两次。
- 页签、筛选下拉、搜索、批量按钮占了大块高度，表格被挤到半屏以下，首屏看不到分页。
- 详情抽屉：面包屑、字段、关联、操作记录堆在一页，头部操作按钮一排挤满。

## 2. 设计要点

一套设计语言，只用现有主题变量（--accent / --accent-soft / --accent-ink / --border / --border-strong / --muted / --ink / --bg / --surface / --radius），新增 --rd-w、--head-bg、--hover-bg 三个变量；没有使用未定义变量。

列表：
- 顶栏只留页面标题；一句话说明变成标题旁的 ⓘ（PageHint，经顶栏插槽 AppbarSlot 放入）。位置信息只出现一次。
- 工具条一行（分类很多的资料如商品档案，页签单独占一行，工具条仍一行）：页签、搜索、筛选（弹层，带数量角标）、显示列、行高、表格编辑、导入、导出、新增。已选条件变成可单独清除的标签（chips）。
- 表格占满剩余高度：表头固定、表体内部滚动、分页固定在底部；第一列冻结；列宽可拖并记住；行高紧凑/舒适可切换并记住；空态和加载态只留一句话。
- 手机：卡片列表；一行工具条（搜索、筛选、新增、更多）；排序并入筛选面板（底部抽屉）。

详情（右侧抽屉，可展开全宽，手机全屏）：
- 固定头部：名称（可复制）、状态、编码（可复制）、上一条/下一条与位置（n/total）、主要操作，其余收进“更多”，展开全宽、关闭。
- 要点（KeyFacts）在头部下面。
- 页签：详情 / 关联（带数量）/ 操作记录 / 各资料自己的页签（原有的都保留）。
- 字段为 2/3 列紧凑网格，值可复制，空值可隐藏（记住选择），分区锚点；逐区就地编辑沿用。
- 快捷键：Esc 关闭；上下方向键切换上一条/下一条；有弹窗、菜单、行内表单或正在输入时让它们先处理。

新增/编辑表单：
- 分组成区（rf-sec），有分区锚点；必填有星号并有一句提示；点保存后顶部汇总错误并可定位，错误提示显示在字段下面。

## 3. 去掉了什么 / 挪到了哪

| 原来 | 现在 |
|---|---|
| 顶栏面包屑“资料 / xxx” | 去掉（Shell 在“精简模式”下不显示小标题，见第 6 节） |
| 页面大标题 + 说明段落 | 去掉大标题；说明成为顶栏标题旁的 ⓘ |
| 状态/各筛选下拉常驻 | 收进“筛选”弹层；已选条件显示为标签 |
| 手机排序下拉常驻 | 进手机筛选面板；电脑点表头排序 |
| 详情内面包屑“位置” | 去掉（头部已有资料类型名） |
| 详情里操作记录与字段同页 | 独立“操作记录”页签 |
| 详情头部一排按钮 | 主要操作 + “更多”菜单 |
| 总览页大标题与说明 | 去掉，说明用 ⓘ |
| 表格 cards-narrow 窄屏卡片 | 手机专用卡片列表（useIsMobile） |

## 4. 功能保留对照

批量操作（停用/启用/导出所选/按配置的批量动作含原因）、快捷页签与数量、分类页签、派生列与排序、复制按钮、关联与关联弹窗、导入导出（含按列导出）、表格编辑入口及未保存时锁定、左侧分类树、KeyFacts、归档/恢复、到期角标、相似检查、草稿、继续新建、零值确认、逐区就地编辑、敏感信息查看权限与审计、成本/价格服务端脱敏、每页条数/状态/筛选记忆、显示列菜单（全部显示/恢复默认）：全部保留，原有测试断言没有删除，只改了入口位置（例如状态下拉要先打开“筛选”）。

## 5. 验证

| 项 | 结果 |
|---|---|
| packages/shared tsc | 通过 |
| apps/web tsc --noEmit | 通过 |
| apps/web vitest 全量 | 80 个文件 403 个测试全部通过 |
| apps/api tsc --noEmit | 本窗口环境里 api 解析到主目录 /home/claude/kudesi-oa-next 的旧 shared 构建产物，报 grid-edit 导出缺失；本分支没有改 api 和 shared，与本次改动无关 |
| 后端 jest | 未跑（没有改后端） |
| 新增测试 | ResourcePage.layout（6）、RecordDetail.layout（5）、RecordForm 分组布局（1） |
| Playwright 截图 | 1440、1920、手机 390；营业执照、合作人、手机号、商品档案的列表/详情/新增表单，用全新种子库 |

### 数据区占屏幕高度（表格可见高度 / 视口高度）与首屏可见行数

| 页面 | 视口 | 改前占比 | 改后占比 | 改前行数 | 改后行数 | 首屏看到分页 |
|---|---|---|---|---|---|---|
| 营业执照 | 1440×900 | 0.669 | 0.810 | 11 | 20 | 否 → 是 |
| 合作人 | 1440×900 | 0.697 | 0.771 | 12 | 19 | 否 → 是 |
| 手机号 | 1440×900 | 0.646 | 0.771 | 11 | 19 | 否 → 是 |
| 商品档案 | 1440×900 | 0.680 | 0.714 | 11 | 18 | 否 → 是 |
| 营业执照 | 1920×1080 | 0.767 | 0.842 | 16 | 20 | 否 → 是 |
| 合作人 | 1920×1080 | 0.747 | 0.809 | 15 | 20 | 否 → 是 |
| 手机号 | 1920×1080 | 0.747 | 0.809 | 15 | 20 | 否 → 是 |
| 商品档案 | 1920×1080 | 0.733 | 0.762 | 15 | 20 | 否 → 是 |
| 营业执照 | 390×844 | 0.525 | 0.694 | 1 | 4 | 否 → 是 |
| 合作人 | 390×844 | 0.480 | 0.694 | 1 | 4 | 否 → 是 |
| 手机号 | 390×844 | 0.480 | 0.694 | 1 | 4 | 否 → 是 |
| 商品档案 | 390×844 | 0.338 | 0.507 | 0 | 3 | 否 → 是 |

改前数据来自 integration 的截图，改后来自本分支最终代码。

截图（本机，未入库）：/tmp/claude-0/-home-claude/5f0340df-d2db-5d53-aea9-3dc621c50d0f/scratchpad/shots/before-*.png、/tmp/claude-0/-home-claude/5f0340df-d2db-5d53-aea9-3dc621c50d0f/scratchpad/shots/after-*.png（命名 {before|after}-{licenses|partners|phones|products}-{list|detail|form}-{1440|1920|m390}.png）；指标：/tmp/claude-0/-home-claude/5f0340df-d2db-5d53-aea9-3dc621c50d0f/scratchpad/shots/before-metrics.json、/tmp/claude-0/-home-claude/5f0340df-d2db-5d53-aea9-3dc621c50d0f/scratchpad/shots/after-metrics.json。

## 6. 对共用文件的改动（说明）

- layout/Shell.tsx（最小改动）：增加 AppbarContext 与 .appbar-slot，让页面把 ⓘ 放进顶栏标题旁；资料页进入“精简模式”（useAppbarBare）时顶栏不再显示分区小标题。其他页面行为不变。
- styles.css：旧的资料页规则删除，新规则（res-*、rd-*、rf-*）追加在末尾；.drawer* 保留给 DocDetail/ShopInline。有两处全局微调：.content 下含 .res-page 的容器改为撑满高度的弹性布局（用 :has）；手机 .modal-backdrop 的 z-index 提到 50，避免表单底部按钮被底栏盖住。
- ExpressPricesPage：给通用资料页传 embedded，去掉嵌入时重复的标题。

## 7. 其他页面“顶栏位置 + 页面标题”重复清单（只记录，没有改）

下面这些页面在顶栏标题之外又自带 h1，同样存在重复，建议后续统一用 PageHint 的做法处理：
- pages/ChangePasswordPage.tsx
- pages/StatusPages.tsx
- pages/finance/CashBankPage.tsx
- pages/finance/CostTablePage.tsx
- pages/finance/DataToolPages.tsx
- pages/finance/DocumentsPage.tsx
- pages/finance/FinanceOverviewPage.tsx
- pages/finance/InventoryPage.tsx
- pages/finance/MaintenancePage.tsx
- pages/finance/MasterImportPage.tsx
- pages/finance/PricingDebugPage.tsx
- pages/finance/SettlementPages.tsx
- pages/finance/StoreWithdrawalPage.tsx
- pages/finance/VoucherPage.tsx
- pages/finance/express/ExpressPricesPage.tsx
- pages/finance/express/FreightEstimatePage.tsx
- pages/finance/express/ZoneRunsPage.tsx
- pages/finance/jst/BaseCodesPage.tsx
- pages/finance/jst/BundlesPage.tsx
- pages/finance/jst/JstUploadPage.tsx
- pages/finance/labor/LaborCostPage.tsx
- pages/flow/ApplyPage.tsx
- pages/flow/FlowDesigner.tsx
- pages/flow/NodeCenterPage.tsx
- pages/flow/RunsPage.tsx
- pages/flow/TasksPage.tsx
- pages/flow/TemplatesPage.tsx
- pages/flow/TimeoutsPage.tsx
- pages/flow/TodosPage.tsx
- pages/live/LiveDeskPage.tsx
- pages/live/LiveManagePage.tsx
- pages/org/PositionProfilesPage.tsx
- pages/org/StaffPage.tsx
- pages/org/StructurePage.tsx
- pages/platform/ApplicationsPage.tsx
- pages/platform/CompaniesPage.tsx
- pages/platform/IntegrationAppsPage.tsx
- pages/service/AfterSalesPage.tsx
- pages/service/AppealsPage.tsx
- pages/service/SupervisionPage.tsx
- pages/system/AiApiPage.tsx
- pages/system/AuditPage.tsx
- pages/system/BankFundPage.tsx
- pages/system/FeeSettingsPage.tsx
- pages/system/IntegrationsPage.tsx
- pages/system/OcrSettingsPage.tsx
- pages/workspace/BossPage.tsx
- pages/workspace/HomePage.tsx
- pages/workspace/RoleDesk.tsx

## 8. 约定（给后续开发）

- 资料页外壳的样式类统一 res-（列表）、rd-（详情）、rf-（表单）；新工具放 ListTools / ToolPop，不另起一套。
- 页面说明用 PageHint + AppbarSlot；页面如果自己带了标题，用 useAppbarBare() 去掉顶栏小标题。
- 本地偏好键：kudesi.list.<type>、kudesi.cols.<type>、kudesi.colw.<type>、kudesi.list.density、kudesi.detail.hideEmpty。

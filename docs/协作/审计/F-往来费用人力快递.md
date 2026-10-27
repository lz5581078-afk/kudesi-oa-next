# F 组审计：往来、费用、人力、快递、包装（只读审计，未改任何代码）

- 资料数量：10 组（供应商及分类、客户及分类、费用档案及费用类别、人力成本表、快递价格与运费、包装方案、财务单据与过账、财务总览、主数据导入；外加快递子资料），共约 25 个新系统资源。
- 缺口总数：约 46 项（高 2、中 16、低 21、其余为有意变更）。
- 最严重 1：费用档案页没有分类目录（fee-items 未配置 filterBy），378 个费用项分布在 140 个类别中无法按类别浏览。
- 最严重 2：费用种子导入时，默认挂账节点“仓库”（37 项）和“公户”（7 项）不在 FEE_BOOKING_NODE_MAP 内，43 项被改成“不固定/无需”，其中 41 项在种子中本为“是”（必须关联）。
- 最严重 3：快递手工价格表 CSV 导入导出、加收原始凭据图片、分区建议 CSV 导出列（7 列对 14 列）缺失；人力成本“复制版本”缺失；供应商/客户无相似/重复检测与批量移动。

## 1. 供应商档案与供应商分类（finance-suppliers / finance-supplier-categories）

旧：server/modules/finance/shared-archives.js（整份 JSON 存 finance_shared_archives）、src/finance/finance-archive-state.jsx、src/finance/FinanceArchivePage.jsx、contact-category-move.mjs、archive-similarity-utils.mjs。
新：packages/shared/src/finance-resources.ts、apps/api/src/resources/finance-rules.ts（beforeParty、beforePartyCategory）。

已对齐字段：名称、简称、简码、编码、分类（多选）、联系人、电话、地址、结算方式、开户名、开户行、银行账号（加密）、付款码（files，最多 2）、税号、备注，共约 14 个。新系统额外有 settlement、address、taxNo。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 分类 categoryCode（用于编码生成与唯一建议） | finance-archive-state.jsx 分类配置；FinanceArchivePage.jsx 编码生成 | 无（分类仅 name/parentId/subtitle/sort） | 缺失 | 中 | 若沿用旧编码规则则需补字段 |
| 编码规则 `GYS-<主类码>-<类码>-<名称首字母>` | FinanceArchivePage.jsx | finance-rules.ts beforeParty：顺序号 GYS-001 | 变更 | 中 | 旧编码含分类信息，历史编码迁移需确认 |
| 新建时必须选叶子分类且至少 1 个分类 | FinanceArchivePage.jsx 校验 | categoryIds 非必填 | 部分 | 中 | 建议补必填校验 |
| 相似/重复检测：名称相同或相似度>=55%、电话相同、简称相同给提示；编码相同或全字段相同则阻止 | archive-similarity-utils.mjs；FinanceArchivePage.jsx | 未找到（已 grep，无相似检测） | 缺失 | 中 | 往来档案最易重复，建议补 |
| 批量移动分类 / 批量启停 / 批量删除 | FinanceArchivePage.jsx；contact-category-move.mjs | suppliers/customers 未配置 `batch`（仅 finance-products 有） | 缺失 | 中 | 在 ResourceDef 上补 batch: ['status','categoryIds'] |
| 分类强调色 accent 与顶级分类卡片入口页（topCategoryCards） | finance-archive-state.jsx | 无卡片页，仅分类树 | 缺失 | 低 | |
| 分类拖拽排序、复制全部/单项银行信息、保存草稿、保存后继续新增 | FinanceArchivePage.jsx | 未找到 | 缺失 | 低 | 银行信息复制可用于对账付款 |
| 默认分类（7 个顶级）自动带出 | finance-archive-state.jsx | 仅 PARTY_SEED_CATEGORIES 导入按钮 | 变更 | 低 | 旧系统首次进入自动初始化 |
| 分类跨顶级移动 | contact-category-move.mjs 限制同顶级 | 允许任意移动，最多 4 级 | 变更 | 低 | 放宽，需确认是否有意 |
| 银行账号明文 JSON | 旧：data_json 明文 | 新：加密 sensitive | 变更（改进） | — | 符合 CLAUDE.md 第 5 条 |

## 2. 客户档案与客户分类（finance-customers / finance-customer-categories）

已对齐字段：名称、简称、简码、编码、分类、联系人、电话、地址、备注，共约 9 个。新系统额外有 kind、storeId、creditLimit。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 默认 4 个顶级分类与 categoryCode | finance-archive-state.jsx | 仅种子按钮，无 categoryCode | 缺失 | 中 | 同供应商 |
| 编码 `KH-<主类码>-<类码>-<首字母>` | FinanceArchivePage.jsx | KH-001 顺序号 | 变更 | 中 | 同供应商 |
| 相似/重复检测、批量移动/启停/删除、必选分类 | 同供应商 | 未找到 | 缺失/部分 | 中 | 同供应商 |
| 停用原因、草稿、拖拽排序 | FinanceArchivePage.jsx | 未找到停用原因字段 | 缺失 | 低 | |

## 3. 费用档案与费用类别（finance-fee-items / finance-fee-categories）

旧：finance-archive-state.jsx（15 个顶级类别及子类、约 224 条字面费用项、itemPatches、deprecated 列表、EXPENSE_BOOKING_NODE_OPTIONS、getDefaultExpenseRelationRequirement）；FinanceArchivePage.jsx。
新：finance-resources.ts、fee-archive.ts（FEE_BOOKING_NODES 24、FEE_SEED_CATEGORIES 140、FEE_SEED_ITEMS 378）、finance-rules.ts beforeFeeItem、fee-archive.service.ts。

已对齐字段：编码、名称、收支方向（4 值）、会计科目 accountingSubject、平台选项 platform、isCommon、requiredObject、needFlow、relationRequirement、备注、defaultObject（挂账节点，多选）、所属类别，共 12 个。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 默认挂账节点“仓库”（37 项）与“公户”（7 项）（如 FY-016 公户年费、FY-042..048 仓库项） | finance-archive-state.jsx 默认项 | fee-archive.ts seed() 过滤不在 FEE_BOOKING_NODE_MAP 的节点，43 项变成 defaultObject=不固定、requiredObject=no（其中 41 项种子原为“是”） | 部分（数据丢失） | 高 | 增加“仓库”节点（可对应 finance-warehouses），“公户”映射到“公司公户”；见问题 8 |
| 费用档案按分类浏览（左侧类别树） | FinanceArchivePage.jsx | finance-fee-items 未设 filterBy，页面无 CategoryTree | 缺失 | 高 | 378 项/140 类别，必须有树；在 def 上补 filterBy 指向 fee-categories |
| 费用档案存档表（整份档案命名快照、查看、恢复、恢复前自动备份） | shared-archives.js snapshots | 未找到 | 缺失 | 中 | 见问题 3 |
| 批量移动/启停/删除 | FinanceArchivePage.jsx | fee-items 无 batch | 缺失 | 中 | |
| 个人拖拽排序偏好 `/api/user-preferences/finance-expense-sort-v1` | FinanceArchivePage.jsx | 未找到 | 缺失 | 低 | |
| 表单草稿保存；导入在编码为空时按名称匹配 | FinanceArchivePage.jsx | 未找到 | 缺失 | 低 | |
| 默认费用项仅对“山东优冠种业”租户生效 | finance-archive-state.jsx | 新种子对所有公司可用 | 变更 | 低 | 见问题 2 |
| 旧 sanitizeFinanceArchiveItem 因 storageKey 不匹配等于空操作，存储里 requiredObject 仍为“是” | shared-archives.js | 新系统已显式校验节点 | 变更 | — | 旧显示端丢弃该节点，存储未变 |

## 4. 人力成本表（finance-labor-*）

旧：server/modules/finance/labor-costs.js、labor-cost-propagation.js、src/finance/FinanceLaborCostTablePage.jsx，表 finance_labor_*。
新：labor-rules.ts、apps/web/src/pages/finance/labor/*。

已对齐字段：版本/分类/工作分类/计价单位/人力成本项的字段、3 级分类上限、引用保护、价格变更向商品成本传播（已有测试）、操作日志，共约 40 个。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 复制版本（复制分类树与成本项到新版本） | labor-costs.js | 未找到 | 缺失 | 中 | |
| 启用新版本时自动设为默认并清除其他默认 | labor-costs.js | 需手工“设为默认” | 变更 | 中 | |
| 启用要求至少 1 条有效项 | labor-costs.js | 未找到 | 缺失 | 低 | |
| `/current?businessDate` 按日期解析生效版本 | labor-costs.js | 未找到 | 缺失 | 低 | 见问题 6 |
| 工作编码版本段：去掉 RL- 前缀并取拼音首字母 | labor-costs.js | labor-rules.ts cleanCode，产生 RL-RL20261026-...，中文版本码被丢弃 | 部分 | 中 | |
| 重复判断：同版本+名称+工作分类+计价单位 | labor-costs.js | 同归档分类+工作分类+名称 | 部分 | 低 | |
| 分类/工作分类拖拽排序、保存并继续新增、三栏分类管理 UI | FinanceLaborCostTablePage.jsx | 未找到 | 缺失 | 低 | |
| 版本信息仅草稿可改/删；零成本确认绑定上下文 JSON | labor-costs.js | 改为 zeroReason 文本 | 变更 | 低 | |

## 5. 快递价格与运费（finance-express-*）

旧：express-catalog.js、express-cost-estimates.js、express-ai-config.js、shared/express-routing.mjs、express-shipping-weight.mjs、ExpressPriceTablePage.jsx（2942 行）、express-price-rules.mjs、express-ai-models.mjs、server/index.js 约 1500-1700 行识别提示词。
新：express-rules.ts、express.controller.ts/service.ts、packages/shared/src/express-engine.ts、freight.ts、apps/web/src/pages/finance/express/*。

已对齐字段：快递公司/网点/版本/价格行/规则字段、聚水潭名称、发货重量上限、合作状态、价格来源 ai/manual、识别记录、批次、运费覆盖、成本估算算法（15% 多数窗口、+10%、>=6kg 上截尾回退）、34 个省份、按单包拆分，共约 60 个。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 手工价格表 CSV 模板/导出/导入 | ExpressPriceTablePage.jsx | 未找到（仅 PriceMatrixEditor 与通用导入） | 缺失 | 中 | |
| 加收原始凭据图片（evidence_data_url 预览） | express-catalog.js | 仅 fileName | 缺失 | 中 | |
| 分区建议 CSV 导出 14 列（含上下界运算符、价格版本、命中规则、聚水潭录入核对说明、缺聚水潭名称占位） | ExpressPriceTablePage.jsx | ZoneRunsPage 7 列 CSV | 部分 | 中 | |
| 手工加收按多省份选择并展开成多行 | ExpressPriceTablePage.jsx | 单省份文本 | 部分 | 低 | |
| 加收识别预览 CSV 导出 | ExpressPriceTablePage.jsx | 未找到 | 缺失 | 低 | |
| AI 模型按供应商选择、异步任务轮询、图片压缩 | express-ai-config.js、express-ai-models.mjs | 单一公司视觉模型（ocr.service.ts），上限 8MB | 变更 | 低 | |
| 新建网点自动建“创始版本”；切换当前版本会翻转版本状态 | express-catalog.js | 不自动建；切换不改状态 | 变更 | 低 | |
| 标准重量列含 3.2kg 与“通用” | express-price-rules.mjs standardColumns | 未找到 | 缺失 | 低 | |
| 百分比加收 | express-catalog.js | 新增独立 percent 字段 | 变更（改进） | — | |

## 6. 包装方案（finance-packaging-*）

旧：packaging-schemes.js、packaging-scheme-excel.js，表 finance_packaging_scheme_*。
新：packaging.ts、data-tools.service.ts（packaging-match）。

已对齐：匹配逻辑（packagingRuleMatches、match-preview）、离散重量、优先级、分类/品牌/场景引用，共约 20 个字段。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 三工作表 Excel 导入导出（说明、预检、确认码 `IMPORT-PACKAGING-xxxx`） | packaging-scheme-excel.js | 通用单资源导入 | 部分 | 中 | 方案+行+规则需一起导入 |
| 目标类型 product_archive（旧有 base_code、bundle_code、product_archive、general） | packaging-schemes.js | 缺 product_archive | 缺失 | 低 | |
| 方案 source_type/source_ref；行 unit_name、sort_order、source_row_ref | finance_packaging_scheme_* | 未找到 | 缺失 | 低 | |
| cost_bucket 为自由文本；行 role 选项 | packaging-schemes.js | 新为 2 个选项 | 变更 | 低 | |
| 方案+行+规则一次事务保存 | packaging-schemes.js | 按资源分别保存 | 变更 | 低 | 存在中间态风险 |

## 7. 财务单据与过账（只判断资料层字段与入口；单据流程另案）

旧：document-types.js、document-schema.js、document-posting.js、posting-routes.js、document-configs.js、FinanceDocumentPages.jsx。
新：finance-documents.ts、DocForm.tsx、DocumentsPage.tsx、CashBankPage.tsx、InventoryPage.tsx。

旧 12 类单据：ordinary_sales XS、online_sales WDXS、sales_return XSTH、customer_prepay YS、receipt SK、payment FK、transfer ZK、expense FYD、supplier_prepay YF、purchase_inbound CGRK、purchase_return CGTH、other_income QTSR。新 13 类（多 withdrawal TX，费用前缀改为 FY）。

已对齐：草稿中心、经营历程、资金银行查询（含重点账户）、库存、期初预收预付对话框、多账户转账、银行流水号去重、按单据/按商品结算。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 员工作为往来对象（付款、费用、其他收入） | document-types.js | 未找到 | 缺失 | 中 | 见问题 4 |
| 销售退货从原销售单导入明细 | FinanceDocumentPages.jsx | 未找到 | 缺失 | 中 | |
| 网店销售按平台预估佣金并自动匹配店铺账户 | document-posting.js | 未找到 | 缺失 | 低 | |
| 费用凭证独立表 finance_expense_vouchers | old-schema.sql | 合并进统一单据 | 变更 | 中 | 历史数据迁移见问题 7 |

## 8. 财务总览（FinanceOverviewPages / FinanceDesk）

旧：FinanceDesk.jsx（统计期间、日期快捷项 今天/近7天/本月/上月/全部、持久化期间、汇总卡片点击带筛选跳转经营历程、公户/店铺户余额、余额更新新鲜度着色、店铺利润累计口径）。
新：FinanceOverviewPage.tsx（趋势、店铺利润、账本），未深入逐项核对。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 日期快捷项与期间记忆 | FinanceDesk.jsx / finance-ux.jsx DATE_RANGE_PRESETS | 未找到 | 缺失 | 低 | |
| 汇总卡片点击带筛选跳转经营历程（localStorage 筛选） | FinanceDesk.jsx openJourney | 未找到 | 缺失 | 低 | |
| 余额更新时间新鲜度着色（24h/48h/72h/7天/15天/30天） | FinanceOverviewPages.jsx | 未找到 | 缺失 | 低 | |

## 9. 主数据导入

旧：master-data-imports.js、master-data-import-utils.js、FinanceMasterDataImportPage.jsx。覆盖 7 类商品侧数据（archive_categories、dictionaries、archive_units、platforms、product_archives、base_codes、bundle_codes），主要属于商品组范围。
新：MasterImportPage.tsx，通用导入，8 步，含供应商/客户。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 多工作表 xlsx 模板（带示例） | master-data-imports.js | 通用单表模板 | 部分 | 低 | |
| 导入历史（含文件哈希） | master-data-imports.js | 未找到 | 缺失 | 中 | |
| 生成已审阅工作簿（generate-files） | master-data-imports.js | 未找到 | 缺失 | 低 | |

## 需要用户确认的问题

1. 旧供应商/客户是否实际使用长编码格式（GYS-主类-类-首字母）？迁移后是否保留旧编码、新建是否仍按旧规则？
2. 旧默认费用项只对山东优冠种业生效，新种子对所有公司开放，是否有意？
3. 费用档案“存档表”（命名快照）是否仍需要？
4. 员工作为往来对象（付款、费用、其他收入）是否仍要支持？
5. 人力成本工作编码的版本段是否仍沿用“去 RL- 前缀 + 拼音首字母”？
6. `/labor-costs/current?businessDate` 是否有新模块要消费？
7. 旧 finance_expense_vouchers 历史是否要迁移到统一单据？
8. 费用项默认挂账节点“仓库”“公户”如何映射（建议新增“仓库”节点，“公户”映射“公司公户”）？
9. 分类跨顶级移动在新系统放开，是否有意？

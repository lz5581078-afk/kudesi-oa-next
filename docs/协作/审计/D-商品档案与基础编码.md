# 审计 D：商品档案与基础编码（旧系统 vs 新系统）
资料数量：14 组（finance-products 七类合并为 1 个资源按类别区分；供货来源、BOM、商品基础编码、分类字典、品牌、销售平台、单位、仓库、商品专属领取、商品数据验证/快照、零值原因、发货物料重量、照片/成本/相似度/质量确认）。缺口总数约 50 项（高 14 / 中 22 / 低 14，见各节）。
最严重 3 点：(1) 基础编码由“多构成”变为“单 productId”，且丢失“档案保存自动同步基础编码”联动；(2) 商品专属领取（product_exclusive_grants/members/slots + 申请-审批-授权流程）新系统完全没有，档案级生效日期成本记录与运费/价格历史也缺失；(3) 赠品简称/赠品编码简称（含跨赠品档案排重表 finance_product_gift_aliases）、materialCode（原料/物料生产编码）、basicInfoFullName 缺失。
说明：本文件依据对旧源码（dump/source）与新仓库（/home/claude/kudesi-oa-next）的阅读整理；未逐行复核处标“待确认”。旧系统实际使用 product-base-codes-v3.js（server/index.js:13489 挂载）与 FinanceProductBaseCodePageV5.jsx，v1/v2 已废弃。

## 1. 商品档案 finance-products（七类）
旧：src/finance/FinanceProductArchivePage.jsx（约 5600 行）、finance-archive-state.jsx（productArchiveFields/Tabs）、server/modules/finance/product-archives.js；表 finance_products（列 + payload_json）。
新：packages/shared/src/finance-resources.ts（22–135 行）、apps/api/src/resources/finance-rules.ts（beforeProduct/productCode/recomputeProduct）。

| 旧字段/功能 | 旧位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 赠品简称 giftShortName / 赠品编码简称 giftCodeShortName，跨赠品档案排重 | product-archives.js:1239；gift-alias-maintenance.js；finance_product_gift_aliases(name_key,code_key 唯一) | 无 | 缺失 | 高 | 旧保存时规范化(gift-aliases.mjs)并跨档案排重，提示“赠品简称已被其他商品使用”；套餐命名规则(bundle-naming-rules.mjs renderGift)依赖。需补字段+唯一校验 |
| materialCode 原料/物料生产编码 | 档案 payload | 无 | 缺失 | 高 | 与生产编码/导入匹配相关 |
| basicInfoFullName 基础信息全称（ProductBasicRemark.jsx） | ProductBasicRemark.jsx | 无 | 缺失 | 中 | |
| 档案级成本记录（6 桶 purchase/transfer/pre_ship_package/production/shipping_package/express，11 种来源类型，生效日期） | finance_product_archive_costs / cost_snapshots；finance-cost-types.js；product-archive-cost-source-types.js；archive-purchase-cost.js；archive-total-cost.mjs | 新：finance-rules recomputeProduct 单价 scale 4；cost-maintain.service.ts、data-tools cost-history | 部分 | 高 | 新系统有成本历史工具，但无“按生效日期的分桶成本记录+来源类型”模型；需确认是否由 cost 资源替代 |
| 派生成本刷新 refreshDerivedArchiveCosts（BOM 所属档案） | product-archive-derived-costs.js | recomputeProduct / refreshFromSources | 部分 | 中 | 对照公式与桶是否一致 |
| 运费历史 finance_product_freight_history | old-schema.sql | 无 | 缺失 | 中 | |
| 档案操作日志 finance_product_archive_logs | old-schema.sql | 通用资料审计（待确认粒度） | 部分 | 中 | |
| 相似度检查（archive-similarity-utils.mjs） | FinanceProductArchivePage.jsx | 无 | 缺失 | 中 | 新增时提示相似档案 |
| 质量确认弹窗 ArchiveQualityConfirmation.jsx / archive-quality.mjs | 同左 | 无 | 缺失 | 中 | |
| 草稿保存 | FinanceProductArchivePage.jsx | 无 | 缺失 | 低 | |
| 零值原因库 finance_zero_value_reasons | zero-value-reasons.js；ZeroValueReasons.jsx | ReasonLibraryDialog.tsx | 部分 | 低 | 对照预置原因与适用字段 |
| 照片（QR 手机扫码上传 finance_product_photo_upload_sessions） | product-archive-photos.js；ProductArchivePhotos.jsx | FilesField.tsx（普通附件） | 部分 | 中 | 缺手机扫码上传会话 |
| 仓库角色模式 WarehouseProductArchives.jsx | product-archives/ | 无 | 缺失 | 中 | 仓库视图只读/精简列 |
| 档案访问范围 product-archive-access.js | 同左 | 权限键 product.cost.view / product.price.view | 变更 | 低 | 新为服务端脱敏，合规 |
| 工作区保存 PUT /product-archives/workspace + expectedRevision | product-archives.js | 通用 /api/resources | 变更 | 低 | 乐观锁是否保留待确认 |
| 商品编码生成 buildProductCode / resolveCategoryCode / generateProductCode | product-code-utils.mjs；code-category-name.js | finance-rules productCode | 变更 | 中 | 格式/长度不同（新 48 vs 旧 160），迁移需映射 |
| 重量单位 kg | weight-utils.js；raw-measurement.js | systemWeightG（克） | 变更 | 中 | 导入导出需换算 |
| CSV 导入导出模板列 | FinanceProductArchivePage.jsx CSV headers | ImportDialog.tsx + 通用模板 | 部分 | 中 | 需逐列对照旧表头 |
| 规格/维度单位/包装分类管理 | FinanceProductArchivePage.jsx | 无（见单位节） | 缺失 | 中 | |
已对齐字段：约 40 个（名称、类别、品牌、单位、规格、条码、状态、备注、重量、各价格/成本主字段等，按 finance-resources.ts 对照）。

## 2. 供货来源（finance_raw_material_sources）
| 旧字段/功能 | 旧位置 | 新系统对应 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|---|
| 来源到档案的成本回写 | product-archive-linkage.js | finance-rules beforeSource/refreshFromSources | 完整/变更 | 低 | 待复核币种/税率字段 |
| 来源类型枚举、生效日期历史 | product-archive-cost-source-types.js | 部分 | 部分 | 中 | 新为当前来源，历史缺 |
已对齐字段：约 10 个。

## 3. 构成 BOM
| 旧字段/功能 | 旧位置 | 新系统对应 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|---|
| bom 头/行/人工行 finance_product_archive_{boms,bom_lines,labor_lines} | old-schema.sql | beforeBom | 部分 | 中 | 人工行(labor_lines)对应缺失待确认 |
| 生产物料 production materials 辅助 | FinanceProductArchivePage.jsx | 无 | 缺失 | 中 | |
已对齐字段：约 8 个。

## 4. 商品基础编码（V3 / PageV5）
| 旧字段/功能 | 旧位置 | 新系统对应 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|---|
| 多构成（一个基础编码含多商品+数量） | product-base-codes-v3.js；finance_product_base_codes / code_links | 单一 productId + 别名(“马甲”，YL-<sha256前20位>) | 变更 | 高 | scripts/migration/mapping-rules.json 已注明“旧聚合多商品需专项处理”，会丢构成语义 |
| 档案保存自动同步基础编码 | product-base-codes-v3.js、product-archive-linkage.js | finance-rules syncAliases/recheckBaseCodes（仅别名） | 缺失 | 高 | |
| 基础编码被引用锁定 | product-base-code-references.js | 引用校验较弱 | 部分 | 高 | |
| 删除引用检查与删除作业 | base-code-deletion.js | base-code-tools 删除预览/执行/deletion-jobs | 部分 | 中 | 检查项范围需对照 |
| 唯一性（分类/品牌编码） | product-category-validation.js | 部分 | 部分 | 中 | |
| 聚水潭同步 | V5 页面 | outbox + 管理员 | 变更 | 低 | 符合新约定 |
| rawFinishedNames 原始成品名 | raw-finished-names.js | 用于生成别名 | 变更 | 低 | |
已对齐字段：约 12 个。

## 5. 商品分类字典 / 品牌 / 销售平台 / 单位 / 仓库
| 项 | 旧位置 | 新系统对应 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|---|
| 分类字典 finance_product_code_dictionary + 预置种子 | product-code-dictionary-seeds.js | finance-resources.ts 790–863 + CategoryTree | 部分 | 中 | 种子/编码唯一规则需对照 |
| 单位 finance_product_units / packaging_units / shipping_material_units 管理界面 | FinanceProductArchivePage.jsx；unit-code-utils.js | 无独立管理 | 缺失 | 中 | 三类单位+规格+包装分类+维度单位 |
| 品牌 | 同上 | 品牌资源 | 部分 | 低 | 编码唯一待补 |
| 销售平台 finance_sales_platforms（product-bundles.js CRUD） | product-bundles.js | 平台资源 | 完整/待确认 | 低 | |
| 仓库（旧系统仅文本，无独立主数据） | shared-archives.js 仅 suppliers/customers/expenses | 新增仓库资源 | 变更（新增） | 低 | 新系统的增项，无缺口 |
| 发货物料重量 | ShippingMaterialWeight.jsx | 无专页，字段化 | 部分 | 低 | |

## 6. 商品专属领取 product_exclusive_*
| 旧功能 | 旧位置 | 新系统对应 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|---|
| familyKey=sha256(分类,品牌,品种/商品名)；members/slots/grants；申请→审批→授权，1–3650 天 | server/modules/workflows/product-exclusivity.js；migrations/0171；ExclusiveProductApplication.jsx | 无 | 缺失 | 高 | 需走统一流程引擎重建，或确认是否废弃 |

## 7. 商品数据验证 / 验证快照
| 旧功能 | 旧位置 | 新系统对应 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|---|
| 快照+签名、状态 pending/verified/reverify/disabled/deleted | product-data-verification.js；verification-snapshot.js | base-code-support buildSnapshot/diffSnapshots；markReverify | 完整/变更 | 低 | 快照中 giftShortName 被剔除，随赠品字段缺失而无影响 |
| 验证事件历史 finance_product_data_verification_events | old-schema.sql | 未找到等价事件表 | 部分 | 中 | |
| 批量验证/批量删除 | 同上 | base-code-tools verify/删除 | 完整 | 低 | |

## 需要用户确认的问题
1. 基础编码是否确认放弃“多构成”？旧聚合编码迁移是拆成多个单商品编码，还是保留聚合能力？
2. 商品专属领取功能是否仍在使用？若是需按流程引擎重做；若已废弃请确认。
3. 赠品简称/赠品编码简称与套餐命名规则是否仍需要（旧套餐生成依赖）？
4. 档案级“按生效日期的分桶成本记录”是否由新的 cost 类资源取代？
5. 草稿、相似度检查、质量确认弹窗、QR 手机传图是否需要恢复？
6. 重量单位由 kg 改为克、编码长度 160→48，迁移时是否接受换算与截断规则？
7. 单位/规格/包装分类/维度单位的独立管理界面是否需要恢复？

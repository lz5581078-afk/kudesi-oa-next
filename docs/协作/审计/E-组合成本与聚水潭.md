E 组审计摘要：覆盖 13 个资源/功能块（组合编码主体、构成与BOM、命名规则、赠品别名、销售平台、销售场景、验证、构成修订、删除与归档、成本表与成本历史/分类利润率、旧成本版本引擎、定价调试、聚水潭对接含外部API与SKU申请）
缺口合计：82 项（状态为缺失或部分；变更（已有替代）不计入），其中高严重度 23 项、中 31 项、低 28 项
最严重 1：聚水潭出站只是占位——没有真实发送器（UnconfiguredSender），组合装上传内容只有 code/name/lines，缺款式编码、规格值、组合基本售价(compose_sale_price)、真实子商品编码结构，也没有回查确认、目标账号校验、子商品先同步的依赖检查；旧的“最低售价自动同步到聚水潭”(bundle-price-sync) 与“分类同步”整块没有对应
最严重 2：组合构成模型被压扁——旧 BOM 版本/定义/明细（单位、损耗率、必需、是否进聚水潭组合、成本归集、生效期、可挂包装/贴纸等档案型组件）只剩“基础编码+数量”；赠品别名(gift-aliases)整块缺失，命名算法不再按单位合并规格、不处理品牌/品种
最严重 3：归档与修订的并发保护变弱——旧版归档会建 archive_jobs 并可复查聚水潭禁用结果，归档/发布修订前会拦截“待同步、待验证修订、未完成SKU申请”；新版只入队禁用，无任务追踪、无这些拦截；组合品牌/品种/分类(bundle_category 独立字典)/规格值/基础单位等定义级字段缺失

说明：本文件只做审计，没改任何代码。旧系统位置均相对 `.../scratchpad/dump/source`（后端 server/modules/finance、server/modules/integrations/jushuitan，前端 src/finance），新系统位置相对 `/home/claude/kudesi-oa-next`。“未核实”表示读过相关文件但没有读到能下结论的代码；“未找到”表示搜索过没有。

---

## 1. 组合编码主体（旧 finance_product_bundle_codes + finance_product_bundle_definitions；新 finance-bundles）

旧系统位置：server/modules/finance/product-bundles.js、product-bundle-utils.js、bundle-extras.js；前端 FinanceProductBundleCodePageV2.jsx、BundleCreateDialog.jsx（实际使用版本；其余 CreateDialog 变体是 `{false&&...}` 死代码）。
新系统位置：packages/shared/src/finance-resources.ts(finance-bundles, 约650-800行)、apps/api/src/resources/finance-rules.ts(beforeBundle/refreshBundle)、bundle-tools.service.ts、apps/web/src/pages/finance/jst/BundlesPage.tsx、BundleDialogs.tsx。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 规格值 properties_value（≤255，验证必填，聚水潭“颜色及规格”） | codes.properties_value / definitions.properties_value；verification 必填检查 | 未找到字段；新出站载荷 `{code,name,lines}` 不含它 | 缺失 | 高 | 聚水潭组合装上传需要 properties_value；旧版由 composeBundle 把“5斤×2”合成“10斤”生成。建议在 finance-bundles 加该字段并进入出站载荷 |
| 品牌 brand_dictionary_id、品种(马甲品名) variety_dictionary_id | definitions；命名规则字段 brand/variety；BundleCreateDialog 品牌自由输入并自动记入品牌字典 | 未找到字段；命名规则 codeFields 默认 `platform,baseCode,scenario`，没有 brand/variety 字段 | 缺失 | 中 | SKU申请流程旧版要求选品牌（resolveApplicationBrand），新版未找到。原料/发货物料类别旧版可不带品牌 |
| 组合分类（独立字典 bundle_category，必须选叶子；新建只能在叶子分类下） | definitions.product_category_dictionary_id；product-bundles.js 校验；ProductCodeCategoryDirectory | 分类取自“第一个主商品基础编码的分类”（finance-categories），无独立组合分类树 | 变更 | 中 | 旧版组合有自己的分类树并对外暴露（verified-feed /categories、catalog /bundle-categories）。新版成本表分类树靠主商品推导。见“需要用户确认的问题”1 |
| 基础单位 base_unit（≤60，必填） | definitions.base_unit；验证必填 | 未找到 | 缺失 | 低 | 旧版组合装上传聚水潭的载荷里其实不带单位，只用于验证必填与展示，可确认是否保留 |
| 称重重量 weighing_weight(decimal 18,6)、weight_mode auto/manual | definitions；product-bundles.js 校验≥0；修订时 0<w≤1,000,000 | weightMode(auto/manual)、manualWeightG（克） | 变更 | 低 | 单位由 kg 改为 g；规则（手工必须填、>0）已有。已对齐 |
| 编码 final_code / generated_code / manual_override / override_reason | codes；pattern `^[A-Z0-9+*]+(-[A-Z0-9+*]+)*$`，≤48，>32 警告 | code / manualCode / manualReason；checkCode，≤120 | 变更 | 中 | 长度上限 48→120，旧版 48 来自聚水潭商品编码限制。需确认 120 是否真能上传聚水潭；字符集校验是否保留未核实（checkCode 在 finance-rules.ts） |
| 款式编码 final_style_code / main_style_code / style_manual_override / style_override_reason | codes | styleCode / manualStyleCode / manualReason | 部分 | 低 | main_style_code（`+ZP-` 之前的部分）没有独立存储；旧版款式编码的平台前缀加在 SKU 编码上而非款式编码，新版 stylePrefix 逻辑不同（见第3节） |
| 名称 product_name(≤255) / 简称 short_name(≤160)，各带“手工”标记与“恢复自动” | codes；BundleCreateDialog 长度计数 48/48/255/160 | name / shortName(只读自动) / manualName / manualShortName | 变更 | 中 | 新版自动简称=第一个主商品简称截 30 字+“+赠”，旧版 160 字且可手工改。确认简称 30 字是否有意（聚水潭限制？） |
| 销售平台 platform_id、销售场景 sales_scenario、配置编码 configuration_code(默认 V01，varchar 16) | codes；唯一维度=平台×场景×配置 | platformId/platformCode、scenarioId、configNo(默认 '01'，≠01 才写进编码) | 变更 | 低 | 默认值 V01→01；唯一性由 preview 的重复检查（本地组合/基础编码/聚水潭普通/组合）保证，未见数据库级唯一约束（未核实） |
| 状态 status active/inactive/deleted | codes.status | pending/verified/reverify/archived | 变更 | 中 | 旧版“停用(inactive)但保留”在新版没有；archived 对应 deleted。若业务需要停用，需补 |
| record_origin（system_generated 等）、source_import_id | codes | 未找到 | 缺失 | 低 | 导入来源追溯。新版有导入但不记录来源批次 |
| sync_status(默认 not_ready)、sync_message | codes | jstStatus(not_synced/pending/synced/failed)；失败信息在 outbox_jobs.last_error | 部分 | 低 | 状态值对齐，但同步消息不在组合记录上，列表里看不到原因 |
| jst_category_id（必须是 jst_product_categories 叶子） | codes；jst_product_categories 镜像表 | 未找到 | 缺失 | 低 | 旧组合装上传接口不传分类（bundle-sync-service 注释“分类同步到分类库，组合装接口不…”被截断，未能全文核实），影响小 |
| 列表列：成本价/销售价/重量/组成数/包装数/包装摘要 | `/codes` 列表 API；V2 页表格 | BundlesPage 列只有 编码/名称/平台/场景/jstStatus/状态/待修订标记 | 部分 | 中 | 旧版列表一眼能看成本、售价、重量、是否缺包装。建议补列（成本列需 product.cost.view 脱敏） |
| 分类目录树筛选 + 关键字（编码/款式/主款式/名称/简称/定义名）+ 状态筛选 + 页大小 10/20/30/50 + 列排序 | V2 页、`/codes` | 5 个 Tab（全部/待验证/需重新验证/已验证/失效归档）带计数；通用列表搜索 | 部分 | 中 | 缺分类树筛选、各分类计数（旧 category counts）、列排序。关键字搜索范围与旧版是否一致未核实 |
| 验证 Tab：待验证/已验证/二次验证 + 计数 | V2 页 | Tab 对应且有计数 | 完整 | - | 已对齐 |
| 详情弹窗：按角色分组，成本/售价/重量小计，显示成本来源 | `/codes/:id/detail` | 右侧 RecordDetail 显示构成行 | 部分 | 中 | 无分组小计与成本来源列 |
| 修改基础信息（只能改名称/简称/状态，禁止改平台/场景/配置/定义/BOM） | `/codes/:id/basic-info`、PUT `/codes/:id` 限制 | 通用编辑表单，manual* 字段 | 变更 | 低 | 已有替代；但新版是否禁止已验证组合改 platformId/scenarioId/configNo 未核实 |
| 跨平台复用（把已有定义/BOM 用到新平台） | `/codes/:id/reuse`；bundle-reuse.js(component_signature sha256+sameLines+劳务比较) | 批量生成 preview：同平台+场景+configNo 下按 role:baseCodeId:qty 签名判重复；多平台勾选一次生成 | 变更 | 低 | 新版每个组合独立成行，不共享 BOM；“复用”变成“再生成一条”。可接受，但失去“改一处影响多平台”的能力（旧版也禁止共享 BOM 被占用时原地修改，影响有限） |
| 新建向导：多平台 × 单场景，分块（主商品/包装/标签说明书贴纸/打包材料/人工/赠品），每行 规格/数量/单价/成本小计/重量小计/“同步组成”勾选 | BundleCreateDialog.jsx | GenerateDialog：CodePick 选已验证基础编码，角色 main/gift/package/label/instruction/other；多平台勾选 + 一个场景；preview→generate；上限 30 个目标、50 行 | 部分 | 中 | 缺：创建时的人工(labor)行、各平台编码/款式/名称/简称内联可改并带“恢复自动”、总重量确认/恢复计算、总成本(含运费搬运人工)展示、错误点击定位、场景在向导内新增/删除。人工行在 SKU 申请流程里有，在这里没有 |
| 新建时校验：主商品至少1行、重复行(组件+角色+单位)、数量>0 | product-bundles.js complete-preview | beforeBundleLine/beforeBundle：主赠品数量整数、至少一个主商品（验证时）、报告里 issues | 变更 | 低 | 旧版允许小数数量(decimal 18,6)，新版主/赠必须整数（与聚水潭 childList 整数要求一致，反而更严格，合理） |
| 批量验证 ≤50 | V2 页 | ≤200 | 变更 | 低 | 上限变大，可接受 |
| 平台管理抽屉、场景管理、“组合品编码配置中心”“SKU批量申请”入口、“聚水潭同步维护”按钮+同步摘要 | V2 页顶部 | 命名中心按钮、导入/导出；同步维护是单独菜单“资料维护/同步队列”；SKU 申请在流程中心 | 变更 | 低 | 入口分散到别的菜单，功能在；列表上不显示每行同步状态角标（旧版 ProductSyncSummary） |
| 访问控制：finance-product-bundles.view/manage；运营工作台与仓库档案被拒绝 | bundle-code-access.js | 资源权限键由 resources 配置派生；运营/仓库是否被拒绝未核实 | 部分 | 中 | 见问题 4 |
| 导入/导出 | 旧版有 source_import_id 暗示导入；具体导入入口未单独读 | BundlesPage 有导入/导出按钮（通用资料导入导出） | 完整 | - | 仅按“有此功能”记录，列映射未逐列核对 |

已对齐字段：编码/款式编码/名称/平台/场景/手工覆盖与原因/重量模式/验证状态与时间 共 9 个。

---

## 2. 组合构成与 BOM（旧 definitions→boms→bom_lines + labor_lines；新 finance-bundle-lines）

旧系统位置：product-bundles.js(boms)、bundle-composition.mjs、bundle-line-unit.mjs、bundle-source-fields.mjs；新系统位置：finance-resources.ts(finance-bundle-lines)、finance-rules.ts(beforeBundleLine/refreshBundle)。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| BOM 版本 version_no（默认 V01）、生效起止、状态 active/inactive、同日期区间不能重叠 | finance_product_bundle_boms | 无 BOM 层；一个组合=一行+若干 lines；变更靠“构成修订” | 变更 | 中 | 已有替代（修订记录保留历史）。旧“有效期区间”能力丢失，确认是否需要按日期切换构成 |
| BOM 锁定：active BOM 不能原地改，只能 `copyFromBomId` 复制新版；被编码占用的 BOM 不能原地改 | product-bundles.js | 已验证组合改构成必须走修订（beforeBundleRevision） | 完整 | - | 已对齐（语义等价） |
| 组件类型 component_type：base_code 或 archive（包装、OEM 包装、发货物料等档案可直接做组件） | bom_lines.component_type | 只支持 baseCodeId（基础编码）或 laborId | 变更 | 中 | 新版要求档案先变成基础编码。若业务上包装档案不会生成基础编码，会缺少可选项，需确认 |
| 角色 role：main/auxiliary/package/label/instruction/gift/other | bom_lines.role | main/gift/package/label/instruction/other/labor | 部分 | 低 | 缺 auxiliary（辅料）；多了 labor（把人工并入同一张表） |
| 数量 quantity decimal(18,6) | bom_lines | qty，主/赠必须整数，其余未核实 | 部分 | 低 | 包装类小数数量（如 0.5 卷）新版是否允许未核实；SKU 申请仓库物料允许 3 位小数（packages/shared/src/sku-apply.ts） |
| 单位 unit_dictionary_id（与档案计费单位一致性校验） | bom_lines；verification“单位与档案计费单位一致” | 未找到 | 缺失 | 中 | 影响规格合并（“斤/公斤/克”可加总）、成本换算、重量计算 |
| 损耗率 loss_rate | bom_lines | 未找到 | 缺失 | 中 | 旧版成本/重量是否乘损耗需查 bundle-cost-linkage（读过但无逐行记录）；若有生产损耗核算，会丢 |
| 是否必需 is_required、是否进聚水潭组合 include_in_jst_bundle | bom_lines；聚水潭 childList 只取 includeInJstBundle 的行 | 未找到；出站 lines 把所有行都带上（含 role） | 缺失 | 高 | 旧版只有 main/gift 进入聚水潭组合装，包装贴纸不进。新版载荷不区分，上线真实发送前必须明确哪些行进 childList |
| 成本归集 cost_bucket、成本处理 cost_treatment(include/included_in_parent/reference_only) | bom_lines | 未找到 | 缺失 | 中 | “仅参考不计入成本”“已含在父级”的行在新版会直接计入，可能成本偏高。需确认是否仍有这类行 |
| 排序 sort_order、行备注 remark、组件快照 component_snapshot、source_scheme_id/source_scheme_line_id（来自方案） | bom_lines | note（行备注）；无排序、无快照、无方案来源 | 部分 | 低 | 验证快照(snapshot)在 bundle 层有，行层快照没有 |
| 行有效期 effective_from/to | bom_lines | 未找到 | 缺失 | 低 | 同上，确认是否需要 |
| 人工行 finance_bundle_labor_lines（labor_item_id、quantity、source_snapshot，最多100；成本为 0 需确认零值原因） | 表 finance_bundle_labor_lines | role=labor + laborId；零值确认原因未找到 | 部分 | 中 | 人工成本变化会触发组合刷新（finance-rules 已实现）。零成本需写原因的规则未找到 |
| 同身份行合并、仅可加单位求和（斤/公斤/克/kg…）；“5斤×2”→“10斤”；规格段=qtyCode(总量)+单位码，否则 `SPEC×qty` | bundle-composition.mjs（composeBundle） | bundle-naming.ts 只有 `code*qty`、`×qty`；totalSpec=重量kg | 缺失 | 高 | 见第3节。影响名称、编码、规格值三处 |
| 单位码表：毫克MG 克G 千克KG 斤J 吨T 毫升ML 升LTR 粒L 棵K 包B 袋D 盒BOX 箱CTN 瓶BTL 罐CAN 件PCS 个EA | bundle-composition.mjs | 未找到 | 缺失 | 中 | 同上，随单位字段一起缺 |
| 成本/重量实时取源（refreshCurrentBundleValues → source_values_update 事件） | bundle-current-values.js、bundle-cost-linkage.js | 基础编码变化→markBundlesOfBaseCode 标记组合为“需重新验证”；劳务成本变化→刷新 | 变更 | 低 | 已有替代，行为更严格（会打回重新验证） |

已对齐字段：基础编码引用、角色(main/gift/package/label/instruction/other)、数量、行备注、BOM锁定规则 共 5 个。

---

## 3. 组合命名规则与命名中心（旧 finance_bundle_naming_rules + bundle-naming-rules.mjs；新 finance-bundle-naming-rules + bundle-naming.ts）

旧系统位置：server/modules/finance/bundle-naming-rules.mjs、bundle-naming-config.js、bundle-composition.mjs；新系统位置：apps/api/src/resources/bundle-naming.ts、finance-rules.ts(beforeNamingRule)、BundleDialogs.tsx(NamingCenterDialog)。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 规则按商品分类(product_category 字典)存 JSON，沿分类树向上继承；没有规则时主商品所在分类报错 | finance_bundle_naming_rules | scopeKey/categoryId，键为 finance-categories；有“继承”动作 | 变更 | 低 | 分类来源由 product_category 字典变为 finance-categories。无规则时是否报错未核实 |
| 默认规则：`{prefix:'ZH-', namePrefix:'组合-', stylePrefix:true(布尔), codeFields:[brand,variety,totalSpec], nameFields:[category,brand,variety,totalSpec]}` | bundle-naming-rules.mjs | 默认 codeFields 'platform,baseCode,scenario'；nameFields 'name'；stylePrefix 为字符串 | 变更 | 中 | 默认值不同：新版默认不含品牌/品种/总规格。同一商品在新旧系统生成的编码不同。上线迁移时需决定编码是否沿用旧值（见问题 2） |
| 可用字段：category、platform、scenario、brand、variety、packageType、supplyMode、name、shortName、style、baseCode、spec、quantity、totalSpec、custom | 同上 | 新版字段集合：platform、baseCode、scenario、name、quantity、totalSpec、custom 等（具体枚举未逐个核对） | 部分 | 中 | 缺 category/brand/variety/packageType/supplyMode/spec/style 中的若干项（未逐项核实，至少 brand/variety 无来源字段） |
| 校验：prefix `^[A-Z0-9]{1,12}-$`；customCode ≤20；customName ≤80；namePrefix ≤20；单字段覆盖 code ≤48 大写、name ≤80 | 同上 | 仅管理员可维护；customCode 1–12 字符 | 变更 | 低 | 长度限制不同，覆盖项在新版是文本而非 JSON 结构（codeOverrides/nameOverrides） |
| 平台 GENERAL 不进编码；平台前缀加在 SKU 编码而不是款式编码 | bundle-naming-rules.mjs | GENERAL 不进编码（资源帮助文字说明）；款式编码= stylePrefix||prefix + 主商品款式 + 平台 + 场景 | 变更 | 中 | 款式编码里带平台与场景，与旧版“平台只加在 SKU 编码”不同。需确认聚水潭款式编码是否允许/需要带平台 |
| 多个主商品前缀不一致报错；原料/发货物料类别品牌可省略 | bundle-naming-rules.mjs | 未找到 | 缺失 | 低 | 随品牌字段一起缺 |
| 赠品渲染：名称 `${赠品简称}×qty`，编码 `${赠品编码简称}*qty`，接在主体后 `+赠:`/`+ZP-` | bundle-composition.mjs | 名称 `组合-main×qty+...+赠:gift`；编码 `ZH-[平台-]main1+main2+ZP-gift...`，编码段是 `code` 或 `code*qty`，小数用 D | 变更 | 高 | 新版直接用基础编码/名称当赠品段，没有“赠品别名”，长度会爆（旧版别名 ≤40 字、编码简称 ≤20 位正是为了控长）。见第4节 |
| 命名中心页：每个分类一条规则、可视化预览 | BundleCreateDialog 旁的配置中心 | NamingCenterDialog（仅管理员、按分类、继承） | 完整 | - | 功能在；预览效果是否一致未核实 |

已对齐字段：规则按分类存放、继承、前缀、名称前缀、自定义编码/名称 共 5 个。

---

## 4. 赠品别名（旧 finance_product_gift_aliases）

旧系统位置：server/modules/finance/gift-aliases.mjs、gift-alias-maintenance.js；新系统：未找到（packages/shared、apps/api、apps/web 全文搜索 alias 只命中基础编码的“马甲标识 aliasKey”，那是另一回事）。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 赠品名称简称 giftShortName（≤40，不能含 `+ × *`） | gift-aliases.mjs | 未找到 | 缺失 | 高 | 命名里赠品段用它 |
| 赠品编码简称 giftCodeShortName（`^[A-Z0-9]{1,20}$`） | 同上 | 未找到 | 缺失 | 高 | 同上 |
| 全公司唯一（name_key、code_key 在所有赠品档案间唯一） | gift-alias-maintenance.js | 未找到 | 缺失 | 高 | 避免两个赠品生成相同编码段 |
| 允许的档案类型：raw、purchased、shipping_material | 同上 | 未找到 | 缺失 | 中 | |
| 没有别名的商品不能作为赠品加入（SKU 申请与新建都校验 giftAliasIssue） | bundle-application.js、product-bundles.js | 未找到 | 缺失 | 高 | |
| 别名维护入口（档案页或独立维护） | gift-alias-maintenance.js | 未找到 | 缺失 | 中 | |

已对齐字段：0 个。

---

## 5. 销售平台（旧 finance_sales_platforms；新 finance-platforms）

旧位置：product-bundles.js(platforms 路由)；新位置：finance-resources.ts 约 821-832 行。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| platform_name ≤80 | 表+路由校验 | name（必填，列表+搜索，未限长） | 完整 | - | |
| platform_code 大写字母数字 ≤16；GENERAL 为保留通用平台 | 同上 | code，maxLength 12，帮助文字说明 GENERAL | 变更 | 低 | 16→12，确认现有平台码都 ≤12 |
| 平台码被引用后不能改/删（统计基础编码、组合、旧款式引用数） | 路由 | 未核实通用引擎是否有引用保护 | 部分 | 中 | 组合编码里已嵌入平台码，改码会让编码与平台不一致。需验证 |
| 状态 active/deleted、恢复已删除平台 | 路由 | 状态 active/stopped（停用） | 变更 | 低 | 删除→停用，已有替代 |
| 排序 sort_order | 表 | 未找到 | 缺失 | 低 | 平台下拉顺序 |
| 管理入口：组合编码页的“平台管理抽屉” | V2 页 | 资料维护菜单下的“销售平台”页 | 变更 | 低 | |

已对齐字段：平台名称、平台码、状态 共 3 个。

---

## 6. 销售场景（旧 bundle-extras.js 的 sales scenarios；新 finance-scenarios）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 内置场景：standard“公司自销”(编码段空)、supply_chain“供应链产品”(段 GYL)，不可删/停用 | bundle-extras.js | 资源 finance-scenarios：code(≤20)、name、segment(≤8)；内置保护未核实 | 部分 | 中 | 需确认是否已种子 standard/supply_chain 且不可删 |
| 自定义场景：key `^[a-zA-Z0-9_]{1,32}$`、name ≤80、code `^[A-Z0-9]{1,16}$`、active/inactive | 同上 | code ≤20（相当于旧 key）、segment ≤8（相当于旧 code，未限大写） | 变更 | 低 | 字段拆分方式不同，已有替代 |
| 被使用后不能删除；有引用后编码段不能改 | 同上 | 未核实 | 部分 | 中 | 同平台 |
| 仅管理员可维护 | 同上 | 资源权限 | 变更 | 低 | |
| 新建向导内直接新增/删除场景 | BundleCreateDialog | 未找到 | 缺失 | 低 | 入口差异，功能在资料维护页 |

已对齐字段：场景名称、场景码、编码段 共 3 个。

---

## 7. 组合验证（旧 bundle-verification.js + finance_bundle_data_verifications/_events；新 bundle-tools.service verify/report）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 验证快照签名，状态 待验证/已验证/二次验证（签名比对） | verifications.composition_signature、snapshot_json | signature、snapshot、verifiedAt，状态 pending/verified/reverify | 完整 | - | 已对齐 |
| 验证事件流水 finance_bundle_data_verification_events（每次验证一条，次数用于“验证次数”） | events 表；verified-feed 的 verification.count | 资源变更日志；未见独立事件表 | 变更 | 低 | 对外接口里的“验证次数”无对应 |
| 验证问题清单：分类存在且启用；编码/定义/平台启用；必填文本(final_code、final_style_code、product_name、short_name、properties_value、base_unit)；逐行 数量>0、单位存在、来源存在、来源报告问题、基础编码已验证、成本有效、单位与计费单位一致；聚水潭行必须是基础编码且数量整数；人工有效；至少1个主商品且至少1个进聚水潭行；重量>0 | bundle-verification.js | 报告 issues 只有“无主商品/基础编码未验证/基础编码已删除”三类 | 部分 | 高 | 缺：重量>0、必填文本、成本有效、聚水潭整数数量等校验（部分被字段必填覆盖）。验证是进聚水潭前最后一道闸，建议补全 |
| 验证要求 confirmed=true、syncToJst=true、uploadSignature；同事务写验证+事件+发布成本+入队聚水潭 | POST `/verification/:id` | verify：≤200，confirmed + syncToJst，syncToJst 仅管理员，校验 signature 与 uploadSignature，入队，registerCost | 完整 | - | 已对齐；仅管理员能勾“同步”是新增约束（旧版需 finance-product-bundles.sync 权限） |
| 报告含 changes 差异、出站预览、修订上下文；可在待发布的构成修订上验证并发布(switchRevision) | `/verification/:id` | report：components、总重量/总成本(需 product.cost.view)、changes、outbound 预览(sku_id,i_id,name,short_name,weight,cost_price)、replacing；publishRevision 在验证时替换 lines | 完整 | - | 出站预览含 short_name/weight/cost_price，但实际入队载荷不含（见第13节） |
| 权限：finance-product-bundles.view/manage，运营工作台/仓库档案被拒 | bundle-code-access.js | 资源动作权限 | 部分 | 中 | 同第1节 |

已对齐字段：签名、快照、状态流转、确认、二次验证差异 共 5 个。

---

## 8. 构成修订（旧 bundle-composition-revisions.js + finance_bundle_composition_revisions；新 finance-bundle-revisions）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 新建修订=复制新定义+BOM（版本号 R时间戳）+劳务行 | bundle-composition-revisions.js | 修订记录存 payload（lines），验证时 publishRevision 替换 lines | 变更 | 低 | 已有替代 |
| 赠品行锁定（assertIdentity），改赠品走 SKU 申请 | 同上 | 赠品不能改（beforeBundleRevision） | 完整 | - | |
| 乐观锁 source_token(sha256)；理由 ≤500；重量手工/自动 0<w≤1,000,000 | 同上 | sourceToken；理由 2–500 字；payload 1–50 行；主赠品数量整数 | 完整 | - | 重量在修订里能否改未核实 |
| 无变化的修订被拒；每个编码只能有一个待发布修订 | 同上 | 一个组合一个待发布修订 | 完整 | - | 无变化修订是否被拒未核实 |
| 发布前拦截：有待同步聚水潭任务(assertNoPendingSync)、有未完成的 SKU 流程批次项 | 同上 | 未找到 | 缺失 | 高 | 防止修订在同步中途切换构成。建议在 publishRevision 前检查 outbox_jobs pending/sending 与 SKU 申请 |
| 历史列表最近30条、列出共用同一BOM的兄弟编码 | 同上 | 抽屉里看修订记录；兄弟编码不适用（无共享BOM） | 变更 | 低 | |
| 取消修订必须填理由 | 同上 | `/:id/revisions/cancel` | 完整 | - | 理由是否必填未核实 |
| 3步编辑器：目录选择器、人工、重量确认、历史面板 | BundleCompositionEditor.jsx | RevisionDialog：改行（赠品锁定）+理由 | 部分 | 中 | 缺人工行编辑与重量确认 |
| 待验证修订标记 pending_composition_revision_id 显示在列表 | `/codes` | pendingRevisionId + 列表标签 | 完整 | - | |

已对齐字段：赠品锁定、乐观锁、理由、单一待发布修订、取消 共 5 个。

---

## 9. 删除、归档与归档任务（旧 bundle-code-deletion.js、bundle-code-archive.js、bundle-disable-service.js、finance_bundle_archive_jobs）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 删除仅限从未验证、从未同步过的本地编码；检查13张引用表；需 token+confirmCode+理由；写日志 | bundle-code-deletion.js；BundleCodeDelete.jsx | `/:id/deletion` GET/POST：未验证/未同步且无成本快照；token+confirmCode+理由 | 完整 | - | 引用检查范围（13表 vs 新版）未逐表核对 |
| 归档（已验证/二次验证）：status=deleted，建 archive_jobs，经 bundleDisableService 去聚水潭停用组合装；需同步权限+token+confirmCode | bundle-code-archive.js | `/:id/archive`：理由；管理员；有 jstUploadedCode 时 enqueueDisable | 部分 | 高 | 缺 archive_jobs 任务表与状态跟踪 |
| 归档前拦截：待同步/调价任务、待发布修订、未完成SKU申请 | bundle-code-archive.js | 未找到 | 缺失 | 高 | 同第8节 |
| 归档任务列表与复查：`/archive-jobs`、`/archive-jobs/:id/recheck`（页面5秒轮询） | 路由；BundleArchiveHistory.jsx“归档与聚水潭禁用记录” | 未找到（禁用结果只是 outbox_jobs 里的 bundle_disable 行） | 缺失 | 中 | 无法确认聚水潭是否真的停用成功，也没有“复查”动作 |
| 聚水潭禁用服务：读回确认组合装已停用 | bundle-disable-service.js(142行) | 发送器未接入，无回查 | 缺失 | 高 | 随第13节一起补 |

已对齐字段：删除条件与确认、归档原因 共 3 个。

---

## 10. 成本表（SKU成本表）、成本历史、成本拆解、分类利润率（旧 bundle-cost-register.js 等；新 cost.service/cost-maintain/data-tools、CostTablePage）

旧位置：bundle-cost-register.js、bundle-cost-linkage.js、bundle-cost-history.js、bundle-cost-breakdown.js、bundle-cost-rules.js；前端 FinanceCostTablePageV3.jsx(只渲染 BundleCostRegister 与 BundleCostHistory 两个页签)、BundleCostRegister.jsx、BundleCostHistory.jsx。
新位置：apps/api/src/resources/cost.controller.ts、cost.service.ts、cost-maintain.service.ts、data-tools.service.ts(registerCost/costHistory)；apps/web/src/pages/finance/jst/CostTablePage.tsx、CostDialogs.tsx、CostCategoryTree.tsx。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 成本登记表 finance_bundle_cost_entries：sku_code、sku_name、product_cost、pre_ship_cost（发布时两者写同一值）、billing_weight、category_dictionary_id、source_signature、revision | register / publishBundleCosts | 不存表；cost.service 实时计算（preShipCostCents、weightG、categoryId 取自主商品），签名/revision 为哈希 | 变更 | 中 | 设计差异：旧版是“验证时发布的快照”，新版是“实时算”。需确认是否接受“成本表即时变化、不必二次验证”。product_cost 与 pre_ship_cost 合一，已有替代 |
| 成本表列表范围：只含已验证（已发布成本登记）的 SKU | register | 列出所有未归档组合（含待验证），多“N项待补/完整”状态列 | 变更 | 中 | 见问题 3。定价调试表只取 verified/reverify（见第12节） |
| 列：SKU组合编码/SKU名称/成本/预发货成本/重量(kg)/使用快递/预估运费/含快递成本/利润率/最低售价/操作 | BundleCostRegister.jsx | 对应列齐全；重量显示 g | 变更 | 低 | 单位 kg→g |
| 每个 SKU 的快递 carrier_name(≤80) 与利润率覆盖 profit_rate，需理由(≤300)、revision 乐观锁 | register 的编辑接口 | 组合记录上的 carrierName、marginOverridePercent、overrideReason；savePricing：carrier ≤80、percentToMicro、理由 ≤300、revision 冲突检查，写入后 registerCost | 完整 | - | 已对齐 |
| freight 字段（已废弃） | entries.freight | 无 | 变更 | 低 | 旧版已废弃，不需要 |
| 运费估算：按重量段表 finance_express_cost_estimates | bundle-cost-rules.js、loadPricingContext | cost.controller `freight-estimate`；快递成本资源由其他组审计 | 变更 | 低 | 见“往来费用人力快递类”那一组 |
| 最低售价 ceil((成本+运费)/(1-利润率)*100)/100 | minimumSellingPrice | 整数分：ceil((cost+freight)/(1-margin))，利润率用百万分比 | 完整 | - | 已对齐（精度方式不同，结果等价） |
| 利润率范围 0≤r<1，最多6位百分比小数；存 decimal(12,8) | bundle-cost-rules.js | percentToMicro，<100，6 位 | 完整 | - | |
| 分类利润率：树上覆盖+继承+“全部默认”(category 0)，revision，理由 ≤300，事件表 finance_bundle_cost_margin_events | bundle-cost-rules.js、finance_bundle_cost_margins | saveCategoryMargin(categoryId 0=全部默认)，finance-margins 记录，marginHistory | 完整 | - | |
| 成本历史页：类型 成本变更记录 / 分类利润率记录 / 旧版成本档案(只读，来自 /costs/versions) | BundleCostHistory.jsx；bundle-cost-history.js | 成本历史 + 分类利润率 两个页签；pricingHistory/marginHistory；costHistory 与前一份快照做差异 | 部分 | 低 | 缺“旧版成本档案(只读)”，依赖旧成本版本引擎，见第11节 |
| 事件类型 workflow_publish / source_values_update / category_margin / pricing_update | bundle-cost-history.js | 快照只在验证、保存定价、手动登记成本时产生；基础资料变动不产生记录 | 部分 | 中 | “来源值变化联动”(source_values_update) 的记录没有。若基础编码成本变了，成本历史里看不到是什么时候变的（成本是实时的，但没有留痕）。建议在 markBundlesOfBaseCode 时也 registerCost |
| 补齐已验证SKU（backfill-preview + backfill） | register | 不需要（实时计算） | 变更 | 低 | 已有替代 |
| 成本拆解 `/bundle-register/:id/breakdown`：成本与重量分行拆解，含对账差额 | bundle-cost-breakdown.js | BreakdownDialog | 部分 | 低 | 对账差额是否展示未核实 |
| 编辑权限：财务岗位/部门才能改(mayEdit)；读取需 canReadBatchCosts | register.mayEdit | product.cost.edit / product.cost.view | 变更 | 低 | 旧版按岗位判断，新版按权限键，符合 CLAUDE.md |
| 成本/价格服务端脱敏 | 旧版靠 canReadBatchCosts | cost.service 无 product.cost.view 不返回成本字段 | 完整 | - | |
| 页面每15秒自动刷新 | BundleCostRegister.jsx | 未找到 | 缺失 | 低 | 体验项 |
| 分类目录树显示利润率+编辑笔 | BundleCostRegister.jsx | CostCategoryTree.tsx：计数+利润率 | 完整 | - | |
| 成本相关 Excel 导出 | 旧成本表 | 未找到成本表导出；仅 pricing-debug/export | 缺失 | 低 | 成本表本身是否需要导出，请确认 |

已对齐字段：SKU编码/名称、预发货成本、重量、使用快递、预估运费、含快递成本、利润率、最低售价、覆盖理由、分类利润率 共 10 个。

---

## 11. 旧成本版本引擎（旧 costs.js 613行、sku-cost-engine*.js、cost-calculator.js、cost-excel-utils.js、cost-data-reset.js、cost-data-package-utils.js、finance_sku_costs、finance_cost_versions）

旧界面已是死代码（LegacyFinanceCostTablePageV3 未被渲染），但后端路由仍在。新系统没有任何对应。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 成本版本 CRUD、复制、状态、有效期、默认版本 | costs.js `/versions` | 未找到 | 缺失 | 低 | 界面已不用；若无需历史版本可视为有意删除，需用户确认 |
| SKU 成本 sku-costs、sku-overrides、sku-settings | costs.js | 未找到 | 缺失 | 低 | 同上 |
| 辅助成本类型/成本/分配 auxiliary-types/costs/assignments | costs.js | 未找到 | 缺失 | 低 | |
| 生产费率 production-rates | costs.js | 未找到 | 缺失 | 低 | |
| 成本桶 purchase/transfer/pre_ship_package/production/shipping_package/express 核算 | sku-cost-engine、cost-calculator | 新版成本来自商品 totalCost（其他组审计商品档案成本） | 变更 | 中 | 如果生产/包材/快递这几类成本需要分桶展示或核算，新版没有；成本拆解里能看到的粒度需确认 |
| Excel 导入/导出成本 | cost-excel-utils.js | 未找到 | 缺失 | 低 | |
| 计算预览/执行、覆盖率 coverage、resolve | costs.js | 未找到 | 缺失 | 低 | |
| 成本数据重置/快照 cost-data-reset | cost-data-reset.js | data-tools.service 的 master reset（范围不同） | 变更 | 低 | |
| 成本日志 logs | costs.js | 资源日志 | 变更 | 低 | |

已对齐字段：0 个。本块缺口按“界面已死”降为低，是否有意丢弃需用户确认（问题 5）。

---

## 12. 定价调试表（旧 pricing-debug.js 243行、PricingDebugPage.jsx 194行；新 pricing-debug.service.ts、cost.controller pricing-debug*）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 组件筛选目录（分类树+基础编码）选商品 `/pricing-debug/components` | pricing-debug.js | `pricing-debug/components` | 完整 | - | |
| 联动试算：投产→售价(roiToPrice)、售价→投产(priceToRoi)，投产需 >1 且 ≤1000 | roiQuote | shared roiQuote、cost.controller `quote` | 完整 | - | 公式在 packages/shared；对账未逐项跑 |
| 滑块价（预留利润档位）`slider-price`，导出模式 sliderPrice | sliderPrice | `slider-price`、sliderQuote | 完整 | - | |
| 自定义利润 profit {id,amount}（有权限者精确到分，其他人整元） | markupForStep/privileged | customProfitQuote、costViewer 分级显示 | 完整 | - | |
| 导出 Excel（商品名称、SKU编码、组合分类、预留利润、滑块价、售价、投产、最低价…）最多 10000 行 | pricingExportWorkbook | `pricing-debug/export`（xlsx-lite），ArrayMaxSize 10000 | 完整 | - | 列顺序未逐列核对 |
| 列表范围：已发布成本登记的 SKU | pricing-debug.js | 仅 verified/reverify 组合（PRICEABLE） | 完整 | - | |
| 多选/全选到右侧、复制、移动端底栏 | PricingDebugPage.jsx | PricingDebugPage.tsx 未读 | 部分 | 低 | 页面交互细节未核实，按“未读”记录 |

已对齐字段：试算、滑块、自定义利润、导出、范围 共 5 个。

---

## 13. 聚水潭对接（旧 server/modules/integrations/jushuitan/*、verified-bundle-api-keys.js、verified-bundle-feed.js、company-catalog-api.js、bundle-application.js；新 outbox、jst-maintenance、data-tools、catalog-api、flow/sku-apply）

新系统位置：apps/api/src/outbox/outbox.service.ts(279行)、outbox.controller.ts、apps/api/src/resources/jst-maintenance.service.ts(100行)、data-tools.service.ts、catalog-api.service.ts、apps/api/src/flow/sku-apply.service.ts、packages/shared/src/sku-apply.ts；前端 JstSyncItems.tsx、JstUploadPage.tsx。

### 13.1 组合装上传出站（bundle-sync-service + product-sync-service）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 真实发送器：调用聚水潭开放接口（组合装 `/open/item/combinesku/upload`、回查 `/open/combine/sku/query`） | bundle-sync-service.js、product-sync-service.js | OUTBOX_SENDER 无任何提供者，默认 UnconfiguredSender(configured=false)，worker 一条都不发 | 缺失 | 高 | CLAUDE.md 要求外部写入默认禁止，所以可能是有意暂缓；但上线前这是最大空缺。同时也没有 getRuntime(授权账号、coid、appKey) 的读取 |
| 上传载荷：sku_id、i_id(款式编码)、name、properties_value、childList[{src_sku_id,qty}]、compose_sale_price | bundle-sync-service.prepare | `{code,name,lines:[{role,baseCode,qty}]}` | 缺失 | 高 | 缺 i_id、properties_value、compose_sale_price；childList 应只含进聚水潭的 main/gift 行并合并同编码数量 |
| 写入后回查确认（读回比对 same(remote,item)；写成功但回查不一致→保留待人工核对）；状态 confirming | product-sync-service、bundle-price-sync.confirm | 无回查；发送成功就标 done/synced；JstSyncItems 的“confirming”实际对应 job 状态 sending | 缺失 | 高 | 重复上传风险：旧版“结果不明不重复发送” |
| 目标账号校验 target_key(hash(账号,coid,appKey,baseUrl))，账号变化则停止 | category-sync-service.targetKey | 未找到 | 缺失 | 高 | 防止写错聚水潭企业 |
| 依赖检查：组成基础商品必须已同步成功且与聚水潭实际一致，才能上传组合装 | bundle-sync-service.assertDependencies | 未找到 | 缺失 | 高 | 否则会上传引用不存在子商品的组合装 |
| 上传前 prepare 的 issues 阻断（status=blocked，“资料待补齐”）：必填文本、整数子数量、运费/利润率/最低售价缺失等 | prepare | items 状态 incomplete 仅用于基础编码（weight/cost/c_name/unit），组合无 | 部分 | 中 | 组合的“待补齐”阻断缺失 |
| 并发/幂等：desired_signature、confirmation_attempts、next_check_at、pending_json | jst_bundle_outbound_states | idempotency_key=类型:id:updatedAt:载荷指纹(前8位) 的 INSERT IGNORE；attempts≤5，2^n 分钟退避 | 变更 | 低 | 已有替代，机制更简单；缺“待确认”阶段 |
| 状态集 unsynced/pending/confirming/success/failed/blocked | list | not_synced/queued/confirming/synced/failed/incomplete | 变更 | 低 | 对应关系已有 |
| 同步日志 jst_bundle_outbound_logs（含差异证据 evidence_json，页面“查看回查差异”）`/:id/logs` 分页30 | product-sync-routes.js | items 里每条带最近 10 个 job 记录（kind/status/attempts/lastError）；与上次上传内容的 diff | 部分 | 中 | 无证据快照、无分页历史 |
| 批量入队：confirmed=true，1–50 条，每条带 signature（防止核对后内容变化） | product-sync-routes.js | enqueue(type, ids) 无条数上限，无逐条 signature | 部分 | 中 | 验证流程里有 uploadSignature，但同步维护页入队没有 |
| 同步权限：独立权限键 finance-product-bundles.sync，个人 deny 优先 | bundle-sync-permissions.js | 仅公司管理员 | 变更 | 中 | 财务非管理员无法同步。确认是否有意 |
| 换码（编码变化→禁用旧码+新建；仅基础编码，组合装不允许） | product-code-replacement.js；`!adapter` 限制 | base_code_replace、bundle_replace，需 replaceConfirmed | 变更 | 低 | 新版对组合装也允许换码，更宽松；旧码处理仍靠人工确认 |
| 自动同步规则开关：workflow_external_sync_rules(action_key，enabled，target_key，authorized_by) | category-sync/product-sync | outbox_switches 全局总开关（默认关，可一键停） | 变更 | 低 | 符合 CLAUDE.md 要求，已有替代 |

### 13.2 组合基本售价同步（旧 bundle-price-sync.js，159行；表 jst_bundle_price_states、jst_bundle_price_logs）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 成本表最低售价（含运费、利润率）自动同步为聚水潭组合装 compose_sale_price，每15秒轮询，每次最多25条 | bundle-price-sync.drain/start | 未找到（grep compose_sale_price/combinesku 在 apps/api 无命中） | 缺失 | 高 | 旧业务规则：成本或利润率变化后，聚水潭组合基本售价自动跟着变 |
| 只在“纯数值变化”(numericOnly)时调价；身份或组成变化要先二次验证；保留子项应占售价与启用状态 | planPrice、preservedRemote | 未找到 | 缺失 | 高 | |
| 阻断原因：缺运费预估、缺利润率、缺最低售价、成本未联动、正在同步、目标账号不一致 | planPrice | 未找到 | 缺失 | 高 | |
| 售价日志 jst_bundle_price_logs / 状态 blocked/confirming/success/failed | save | 未找到 | 缺失 | 中 | |
| 独立授权开关 action `jushuitan_bundle_price_sync` | ACTION | 未找到 | 缺失 | 中 | |

### 13.3 聚水潭商品分类同步（旧 category-sync-*，表 jst_category_sync_links/_runs、jst_category_outbound_runs、jst_product_categories）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 把 OA 商品分类/组合分类单向同步到聚水潭（差异预览→确认→执行；动作 新增/修改/关联已有/停用/收尾/冲突） | category-sync-plan.js(98行)、category-sync-service.js(247行)、category-sync-routes.js；前端 JushuitanCategorySync.jsx | 未找到 | 缺失 | 中 | 新版基础编码上传的分类取本地叶子分类名（jst-maintenance options），不会去聚水潭建分类。如果聚水潭里没有同名分类，上传会失败 |
| 规则：最多4级；启用分类不能挂在停用父级；同名冲突不自动认领；外部被改动要人工核对；删除=停用 | category-sync-plan.js | 未找到 | 缺失 | 低 | 随上一条 |
| 自动同步开关、失败重试、同步记录（分页20） | routes | 未找到 | 缺失 | 低 | |
| 聚水潭分类镜像 jst_product_categories（remote_category_id、category_path、category_level、is_leaf），用于选叶子分类 | 表 | 未找到；用本地 finance-categories 叶子代替 | 变更 | 低 | |

### 13.4 聚水潭商品镜像与手工上传（旧 routes.js 1019行；jst_skus、jst_sku_sync_logs；新 finance-jst-skus、finance-jst-uploads、jst-maintenance）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 镜像表 jst_skus：goods_type、sku_id、name、properties_value、category_name、unit、cost_price、sale_price、enabled、remote_modified_at、last_pulled_at、last_pushed_at、local_modified_at、sync_status、sync_message、raw_json | 表 | finance-jst-skus：skuId、goodsType、styleId、name | 部分 | 中 | 只保留了判重复需要的 4 个字段；价格/分类/启用状态没有。如果只用来查重，可接受，请确认 |
| 从聚水潭拉取（全量/最新页、异步任务进度、单条重拉 pull_one） | routes.js `/sync`、`/products/:id/pull`、`/sync-jobs/:id` | 无拉取；镜像靠“商品数据导入”页导入聚水潭导出文件 | 缺失 | 中 | 与“聚水潭默认只读”原则不冲突，但没有自动刷新 |
| 本地编辑镜像并单条推送 `/products/:id` PUT、`/push` | routes.js | 未找到 | 缺失 | 低 | 旧页 JushuitanGoodsPage 只定义未引用（疑似死代码），见问题 6 |
| 普通商品上传：重复检查(本地基础/本地组合/聚水潭普通/聚水潭组合 四层)、必填项、分类/品牌选项、上传日志 | routes.js normal-products/* | jst-maintenance：check-duplicate(高风险=编码重复，款式/名称重复=提醒)、options、upload（管理员、必填：编码/款式/名称/简称/规格/分类/品牌/成本/采购价/重量/单位）、logs（不返回成本价） | 完整 | - | 字段是否与旧上传表单逐项一致未逐项核对（新增了大量可选字段 JST_UPLOAD_TEXT/NUMBER） |
| 上传结果回写、失败信息 | routes.js | outbox 回写 finance-jst-uploads 状态 success/failed、message | 完整 | - | 但发送器未接入，实际不会上传 |

### 13.5 对外只读 API 与密钥（旧 verified-bundle-api-keys.js、verified-bundle-feed.js、company-catalog-api.js；表 verified_bundle_api_keys）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 密钥格式 `kdoa1.<uuid>.<43位base64url>`，SHA-256 存哈希，timing-safe 比较，只显示一次，Cache-Control no-store，仅 GET，仅公司管理员管理 | verified-bundle-api-keys.js | data-tools.service 同格式、同哈希方式、仅管理员、只显示一次 | 完整 | - | 已对齐 |
| 密钥范围 scope：verified_bundle_read、company_catalog_read；用途名称 ≤100；撤销记录 revoked_by/revoked_at；列表含创建人/撤销人 | 同上 | scope 两个同名；撤销与列表字段未核实 | 部分 | 低 | |
| 已验证组合只读接口 `/verified-feed`：`/`（afterId 游标，limit 1–100，返回 nextCursor、total）、`/all`、`/categories`（分类平铺+树）、`/:code`（≤160） | verified-bundle-feed.js | `/external/v1/verified-bundles` | 部分 | 高 | 旧返回含分类路径、主商品列表、验证信息(count/verifiedAt/signature)、details{profile,components}；新返回 bundleId、code、name、categoryName、weightG、preShipCostCents、freightCents、marginPercent、minPriceCents。字段和语义不同，且没有 /all、/categories、/:code。已有外部系统对接时必须逐项对照 |
| 公司目录接口 `/company-catalog`：bundle-categories、cost-categories（含生效利润率、自身利润率、defaultMargin）、sku-costs（afterId/limit/code）、bundle-codes（含 issues、components）；统一信封 `{apiVersion:'1',companyId,generatedAt}` | company-catalog-api.js | `/external/catalog/v1`：bundle-categories、cost-categories、sku-costs、bundle-codes（afterId，limit 1–100，金额为分） | 变更 | 中 | 路径前缀与金额单位（元→分）变化；信封字段是否保留未核实；bundle-codes 是否带 components/issues 未核实。对外契约变化必须通知调用方 |

### 13.6 SKU 批量申请（旧 bundle-application.js 110行；新 flow/sku-apply.service.ts 107行 + shared/sku-apply.ts 112行）

流程引擎部分由流程组审计，这里只记录与组合编码相关的规则。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 规格清单：规格名 ≤100、主商品≥1、组成项≤100、同商品数量合并 | editPayload/inspect | normalizeSpecs：规格≤100、每规格行≤20、规格名唯一、数量正整数 | 变更 | 低 | 每规格行数上限 100→20 |
| 来源档案范围校验：主商品只能来自 供应商OEM成品/原料档案/原装采购成品；赠品再加 发货物料档案；包装只能 产品包装档案；标签/说明书/其他只能 发货物料档案 | inspect.scopes | 未找到（SkuOptionKind 选项接口是否按档案过滤未核实） | 部分 | 中 | |
| 赠品必须有别名 | giftAliasIssue | 未找到 | 缺失 | 高 | 随第4节 |
| 品牌：优先主商品品牌，否则必须手选启用品牌 | resolveApplicationBrand | 未找到 | 缺失 | 中 | 随品牌字段缺失 |
| 仓库节点：包装/标签说明书/打包材料/人工四类，每类要么配置要么写“不需要”原因(≤200) | inspect(warehouse) | normalizeWarehouse：四类同规则，数量最多3位小数 | 完整 | - | |
| 复用标记 reuseInfo；销售节点修改会清空仓库确认 | editPayload | reuseReason（相同构成已存在时必须写申请理由，≤500） | 变更 | 低 | 已有替代 |
| 销售平台 ≤20 个 | inspect | platformIdsOf（上限未核实） | 部分 | 低 | |
| 财务审核通过：仅财务可更新成本表；同事务生成组合→写验证+事件→发布成本→入队聚水潭；校验最终成本与审核成本一致 | finalize | flow-adapters 通过 BundleToolsService 生成；是否在同事务内验证、registerCost、入队、成本一致性比对未核实 | 部分 | 高 | 需要对 flow-adapters.ts 做一次专项核对 |
| 销售场景：标准/供应链等，以及平台选择 | salesKeys | 一张申请单一个场景 + 多平台 | 完整 | - | |

已对齐字段：仓库四类确认、规格名称与数量规则、API密钥机制、普通商品上传查重 共 4 个。

---

## 需要用户确认的问题

1. 组合分类：旧版组合有独立的 bundle_category 分类树（新建只能选叶子，并对外提供 bundle-categories）。新版改成“取第一个主商品的分类”。是有意合并吗？如果主商品分类和销售看到的组合分类本来就不是一套（例如 “礼盒/组合装” 类），成本表分类利润率会按错的树汇总。
2. 编码长度与规则：旧编码 ≤48 位且“编码规则默认含品牌/品种/总规格”；新版允许 120 位且默认规则是 平台+基础编码+场景。上线后旧编码是沿用旧值（保持聚水潭已上传的 SKU 不变），还是按新规则重新生成？如果沿用，需要迁移时把旧 final_code 写入 manualCode。
3. 成本表范围：旧版只显示“已验证并发布成本”的 SKU，新版显示全部未归档组合（含待验证）。运营/财务是否希望待验证的也出现在成本表里？
4. 权限：旧版组合编码禁止“运营工作台”和“仓库档案”岗位访问。新版是否需要保留这条限制？
5. 旧成本版本引擎（成本版本、辅助成本、生产费率、成本 Excel 导入导出、成本数据重置）：界面已不用，后端路由还在。是有意丢弃，还是业务上仍需要“生产成本/包材成本分桶核算”？
6. 聚水潭商品镜像：旧版有拉取、本地编辑、单条推送的页面（JushuitanGoodsPage，菜单是否引用无法确认，疑似死代码）。新版只保留导入。要不要做“只读拉取聚水潭商品”（符合只读原则）来替代人工导入？
7. 聚水潭写入：旧版组合基本售价自动同步（最低售价→compose_sale_price）和分类同步是线上在跑的功能。新版没有，属于“暂缓”还是“取消”？如果上线，请给明确授权范围与开关策略（CLAUDE.md：任何真实写入需要明确授权）。
8. 同步权限：旧版有独立的“组合装同步维护”权限（finance-product-bundles.sync），非管理员财务可以操作。新版只有公司管理员。是否需要放开给财务角色？
9. 赠品别名：这是旧命名的核心（控制编码长度并保证唯一）。新版是要补回别名，还是改用其他方式（例如直接使用基础编码简称）？
10. 对外只读 API：旧调用方依赖的字段（details.profile、components、分类路径、验证信息、/all、/categories、/:code）新版没有，路径前缀和金额单位（元→分）也变了。是否有外部系统在用？是否需要保留旧路径和旧字段作为兼容版本？
11. 构成模型：旧版有 BOM 版本和有效期、行级单位/损耗率/是否进聚水潭/成本处理方式。新版只有基础编码+数量。这些在实际业务里还在用吗？（特别是“仅参考不计入成本”“不进聚水潭的行”“损耗率”。）
12. 简称长度：旧版简称 ≤160，新版自动简称截取 30 字。聚水潭对简称有没有 30 字限制？

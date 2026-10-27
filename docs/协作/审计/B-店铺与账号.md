# B 组审计：店铺与账号类资料（旧系统 vs kudesi-oa-next）

- 范围：店铺档案(含 7 个子资料：领退店、经营数据、推广、评分、资金、店铺异常原因库、登录助手字段)、手机号(含通信费用、手机号异常原因库)、自媒体、微信号、宽带、软件账号、账号与服务备忘，共 7 大类 / 14 个资料配置。
- 缺口合计约 50 项（高 3、中约 26、低约 21），其中跨资料的通用缺口 14 项。依据为代码阅读，未运行系统。
- 最严重 3 点：(1) 删除变硬删除，旧的归档/恢复/已归档页签全部没有；(2) 引用选择器只取前 200 条且无搜索，旧数据规模为 528 店铺、328 手机号，老记录选不到（通信费用页同样只载前 200 手机号）；(3) 店铺缺批量指派运营/收回、筛选页签、一店多手机、授权商标关联，且手机号档案选择器 `phoneId` 疑似被规则清空（见店铺节），通信费用页退化为单条表单。

说明：旧系统以 `src/resource-center/schemas/*.jsx` + `ResourcesDesk.jsx` 为实际使用版本；`src/resource-pages/StoreResourcePage.jsx`、`PhoneNumberPage.jsx` 未被任何地方 import（死代码，仅旧测试引用），已忽略。新系统为配置驱动的通用资料引擎（`packages/shared/src/resources.ts`、`apps/api/src/resources/resource-rules.ts`、`resources.service.ts`、`apps/web/src/resources/*`）。

---

## 0. 跨资料通用缺口（适用于本组全部资料）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 归档/恢复代替删除（archived_at/by/reason/from_status）、关联清单、“已归档”页签 | server/modules/resources/archive-service.js；server/index.js 通用 DELETE/restore | resources.service.ts `remove()` 为硬删除（带原因，被引用时拦截）；无恢复 | 缺失 | 高 | 业务数据丢失风险。建议恢复归档（软删除）+ 已归档页签 |
| 引用选择器只取 pageSize:200（id 倒序）的 `<select>`，无搜索 | apps/web/src/resources/RecordForm（loadRefOptions）；旧库约 528 店铺/328 手机号 | 同左 | 缺失 | 高 | 老记录无法被选中；`FeeSettingsPage` 也只载前 200 手机号。需改为带搜索的远程选择器 |
| 列表动态页签：即将到期/已过期/已归档/未指派等 | resource-center 各 schema 的 tabs；server/modules/resources/expiring.js | 仅概览 `alerts`，列表无此类页签 | 缺失 | 中 | |
| 复制为新 | ResourceWorkbench 行操作 | 仅 `def.batch` 资料有（只有 finance-products） | 缺失 | 中 | 本组所有资料都没有 |
| 列排序 | ResourceWorkbench | 无 | 缺失 | 中 | |
| 搜索覆盖聚合文本（运营人、证照名等） | 旧列表 searchText | `buildSearchText` 只索引 `search:true` 的自有字段 | 部分 | 中 | 运营、营业执照名等不可搜 |
| 手工关联带属性（用途；授权起止） | server/modules/resources/relation-registry.js；resource_links.purpose/valid_from/valid_to | 通用手工关联无属性 | 缺失 | 中 | 手机号→店铺/自媒体/微信用途、商标→店铺授权期限 |
| 派生只读关联（店铺→可用资质/税务资料）与“由字段维护”提示 | relation-registry.js、derived-facts.js | 无 | 缺失 | 中 | |
| 数据问题总览（店铺没绑营业执照、手机号无任何绑定、关联冲突） | server/modules/resources/data-issues.js | 无（只有 alerts） | 缺失 | 中 | 与概览组重叠 |
| 日志仅显示动作+备注 | 旧操作记录显示字段变化 | API 返回 before/after，UI 不展示字段差异 | 部分 | 低 | |
| 敏感字段查看自动隐藏 15 秒、无复制 | 旧 30 秒 + 复制 | 新 15 秒 | 变更 | 低 | |
| 导入：整文件回滚（旧为逐行，未匹配引用写入备注）、行数上限 2000、无手机号规范化（科学计数法/`="…"`）、引用只能按精确标题（旧可按信用代码、登录账号等） | ImportDialog；旧 resource-shared.jsx、`/api/resources/phones/import-match` | ImportDialog.tsx、resources.service.ts `importRows` | 变更 | 中 | |
| 无唯一键的资料重复导入必然新增重复行（stores/self-media/memos/software 无 uniqueField） | 旧：店铺按 storeNo+name、自媒体按 platform+accountName、备忘按 provider+account(+service)、软件按 name+account 匹配更新 | 无 | 缺失 | 中 | |
| 导入的停用/异常行不校验原因 | 旧 getDeactivationReason | 无 | 缺失 | 低 | |
| 状态改为“异常”不弹原因（旧 ReasonDialog 必填） | 旧 StatusControl | `requiresReason` 才要求原因 | 部分 | 中 | |
| 异常原因库权限独立，编辑人无库查看权就无法选原因 | 旧同店铺/手机号权限 | store-abnormal-reasons / phone-abnormal-reasons 独立权限键 | 变更 | 中 | |

---

## 1. 店铺档案 stores

已对齐字段：约 28 个（platform、name、storeNo、platformStoreId、licenseRef、openedAt、lastOrderAt、url、claimStatus 4 项、operator、推广释放日期、account、storePassword/withdrawPassword(加密)、聚水潭接入+到期、商标文本+到期、资质状态 6 项+说明、保证金/冻结/货款/推广余额/资金说明、remark、status 4 态）。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 手机号档案选择器 `phoneId` | stores POST server/index.js:7357；schemas/stores.jsx | resource-rules.ts：stores `matchPhone(strict)`，`phoneNumber` 为空时把 `phoneId` 置 null；前端 RecordForm 无 `phoneId` 特殊处理 | 部分/疑似缺陷 | 高 | 只选档案不填号码文本会被清空绑定；未建档号码直接报错。测试 resources.db.spec.ts L99-103 仅覆盖文本路径。wechat/self-media 非严格模式同类。基于代码阅读，未运行验证 |
| 筛选/页签：在运营、公共待领取、已注销、领用状态、运营人、营业执照已/未关联、聚水潭已接入/未接入/已过期、“未指派” | schemas/stores.jsx tabs/filters | stores 仅平台页签+状态筛选，无 `filterBy` | 缺失 | 中 | |
| 批量指派运营 / 收回为公共 / 批量改状态(带原因) | schemas/stores.jsx batch；store-operator-assignments.js | stores 无 `batch` | 缺失 | 高 | 业务高频操作 |
| 指派/收回流程：运营必填+原因；推广受限必填释放日期 | server/index.js claim-records L9580-9660；stores PUT L10576 | 字段均可选 | 缺失 | 中 | |
| 一店多手机号（每平台每手机一个） | store 与 phone 多对多关联 | `phoneId` 单值 + 文本 `phoneNumber` | 变更 | 中 | 见确认问题 |
| 授权商标关联商标档案并展示授权清单+到期 | derived-facts.js 派生商标授权 | `trademark` 为纯文本，无关联 | 缺失 | 高 | 与证照组协调；`trademarkExpireAt` 不在预警（旧有） |
| 聚水潭到期三级预警(30/15/已过期)及筛选 | expiring.js | 仅 30 天一档 alert | 部分 | 低 | |
| 历史负责人(owner_id/operator_name)、“未指派”页签 | old-schema stores | 未找到 | 缺失 | 低 | 见确认问题 |
| lastOrderAt 精度（旧日期时间） | old-schema | 仅日期 | 变更 | 低 | |
| 最新快照“经营数据”面板（评分按维度分页） | schemas/store-parts.jsx | 子资料仅列表 | 部分 | 低 | |
| 导入：按 storeNo+name 更新、licenseRef 按信用代码匹配 | 旧导入 | 无 | 缺失 | 中 | |
| 异常原因自由输入并自动记入库 | server/index.js L10762-10810 | 只能选已建的库条目 | 变更 | 低 | 见确认问题 |
| 领退店额度规则(主平台 3 个名额)、罚款 50 元、自动收回 | 旧仅文本，无执行 | 未实现 | 缺失(旧也无) | 低 | |
| 额外：在新系统里 stores.deposit 与 store-funds 两处资金口径 | — | 两个来源 | 变更 | 低 | 以谁为准需约定 |

### 1.1 领退店记录 store-claims
旧：record_type / source_method（手工 vs 流程记录）、创建人、日期时间。新：action(领/退)、userId、happenedAt、lastOrderAt、product、note，字段是超集；缺失“流程来源”标记。状态：变更，低。

### 1.2 店铺经营数据 store-daily-metrics
| 旧 | 新 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|
| product_views 商品浏览、product_reviews 评价数 | 无 | 缺失 | 中 | 新增了 refund/fee/cost/profit；每店每日唯一已对齐 |

### 1.3 店铺推广 store-promotions
| 旧 | 新 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|
| conversion_rate 转化率、item_url 链接、商品级状态；快照级+商品级两层 | 无；改为按计划合并一层，roi 为百分比 | 缺失/变更 | 中 | |

### 1.4 店铺评分 store-scores
旧快照指标（体验分、服务体验分、询单转化率、3 分钟回复率、排名）改为指标行；item_status 变为 benchmark。状态：变更，低。

### 1.5 店铺资金 store-funds
旧仅 stores 上的字段；新为快照表。数据只能手工/导入（接口同步按 ROADMAP 未做）。变更，低。

### 1.6 店铺异常原因库 store-abnormal-reasons
已对齐（名称、排序、启用）；差异见通用缺口（权限独立、不自动记忆）。

### 1.7 登录助手/session-manager 店铺字段
`SessionShop`：loginAccount、loginPasswordEnc、autoLogin、loginState、status 与旧 `session_managed_shops` 对齐；公司店铺维护的状态变更(异常选库原因、注销/停用必填原因)在 maintenance.service.ts 已实现。旧的“已归档店铺”检查因硬删除不再需要，但硬删店铺后会出现孤立会话店铺（显示“(店铺已删除)”）。状态：完整/变更，低。

---

## 2. 手机号 phones（含通信费用、异常原因库）

已对齐字段：约 22 个（number 唯一规范化、usageType 4 类、carrier、plan、certifiedName、parentPhoneId 且不可自指、asset/area/assetLocation、userId、externalUser、deviceType、forwardApp+名称、partnerId、keeper(员工或手填)、monthlyFee、feeCycle、lastRechargeAt、rechargeCycleDays、nextRechargeAt 自动、abnormalReason 库、status）。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 列表列/筛选：绑定店铺、店铺编号、主卡/副卡、店铺平台、运营商、“即将充值”页签 | schemas/phones.jsx、phone-shared.jsx | 无 | 缺失 | 中 | |
| 主副卡面板、“记录今天已充值”一键 | phone-shared.jsx | 无 | 缺失 | 低 | |
| 充值日 recharge_day（月日/每年月日选项） | server/index.js:2007、7446；helpers.jsx phoneRechargeDayOptions | 未找到对应字段（仅 rechargeCycleDays + nextRechargeAt） | 缺失 | 中 | 年度/月度固定充值日无法表达 |
| 导入：各平台店铺列、号码规范化 | `/api/resources/phones/import-match`、`import-upsert` | 无 | 缺失 | 中 | |
| 默认值：运营商中国移动、充值周期 30 天、套餐“基础套餐” | server/index.js import-upsert | 无默认 | 缺失 | 低 | |
| forwardAppName 仅在“有转发应用”时显示 | 旧表单 | 非条件 | 部分 | 低 | |
| 位置选择器区分区域与资产空间 | 旧 | 不过滤 | 部分 | 低 | |
| 停用必填停用原因 | import-upsert getDeactivationReason | 仅 requiresReason 状态 | 部分 | 低 | |

### 2.1 通信费用（旧 CommunicationFeesPage → 新 FeeSettingsPage）
| 旧 | 新 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|
| 三页签：手机套餐 / 主子卡费用 / 宽带费用；多选批量改；保存前预览差异；搜索、排序、分页；批量设主卡 | apps/web/src/pages/system/FeeSettingsPage.tsx：单条表单，无搜索/批量/预览，只载前 200 条，套餐名不可改 | 部分 | 高 | 328 个手机号会漏；效率大幅下降 |

### 2.2 手机号异常原因库 phone-abnormal-reasons
已对齐；差异见通用缺口。

---

## 3. 自媒体账号 self-media

已对齐字段：约 20 个（platform 5 类、name、accountNo、password(加密)、phone、homepage、followers、deposit、license、operator、certifier、promotionFeeBalance、各平台属性 douyinShopId/kuaishouShopId/wechatId/videoChannelId/subjectType/redBookId/contentCategory/adAccountId/brandCooperationNo/accountType/platformContact/extraInfo、status、异常原因）。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 一号多店（self_media_store 多对多，导入追加） | old-schema self_media_store | `storeId` 单值 | 变更 | 中 | 见确认问题 |
| 运营部门列/筛选、运营人员筛选、异常页签 | schemas/self-media-accounts.jsx | 无 | 缺失 | 低 | |
| 平台属性 JSON(platformProperties) 导入、bindPhone 键 | 旧导入 | 无 | 缺失 | 低 | |
| 手机号绑定 `phoneId` 非严格匹配同样可能被清空 | 见店铺 | 同 | 部分 | 中 | |

---

## 4. 微信号档案 wechat

已对齐：全部主要字段。

| 旧 | 新 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|
| 名称与微信号均必填 | 微信号非必填 | 变更 | 低 | |
| 微信号仅导入时匹配 | `wechatNo` 唯一 | 变更 | 低 | |
| 使用人/手机号档案“已关联/未关联”筛选 | 无 | 缺失 | 低 | |
| store_wechat 关联无属性 | 同 | 缺失 | 低 | 通用缺口 |

---

## 5. 宽带账号 broadband

| 旧 | 新 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|
| broadband_location 位置说明（自由文本） | 无 | 缺失 | 中 | |
| 位置/手机号筛选 | 无 | 缺失 | 低 | |
| 停用/暂停必填原因 | 不强制 | 部分 | 低 | |
| 新增：expiresAt + 30 天预警、account 唯一 | — | 变更(新增) | — | |

---

## 6. 软件账号 software

| 旧 | 新 | 状态 | 严重度 | 备注 |
|---|---|---|---|---|
| name、accountNo 必填；(name+account) 去重 | account 可选；无唯一 | 部分 | 低 | |
| 位置：账号与服务页的“软件订阅”页签 | 作为 memos 的伴生页签(RESOURCE_COMPANIONS) | 变更 | 低 | |
| 新增 password 加密字段 | — | 变更(新增) | — | |

---

## 7. 账号与服务备忘 memos

旧模型：provider_name(必填)、account_name(必填)、service_name(服务类必填)、login_account、password、account_no、homepage、owner、parent_account、service_type、started_at、expires_at、renewal_cycle(4 项)、renewal_amount。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| account_name + service_name 两字段 | schemas/account-services.jsx | 合并为 `title` | 变更 | 低 | |
| provider_name 必填 | 同 | provider 非必填 | 部分 | 低 | |
| 状态：normal/expiring/expired/abnormal/renewing/needs_recharge/paused/inactive；到期/过期按日期动态计算 | 同；expiring.js | normal/abnormal/expiring/expired/inactive，到期/过期改为手动；缺 renewing、needs_recharge、paused | 部分 | 中 | |
| 页签：域名、即将到期、已过期；筛选：服务商、归属部门、负责人 | 同 | 无 | 缺失 | 中 | |
| 与软件混合台账视图 | 同 | 仅伴生页签 | 变更 | 低 | |
| 与证照/店铺/手机号手工关联带属性 | relation-registry | 通用手工关联，无属性 | 部分 | 低 | |

---

## 需要用户确认的问题

1. 旧 stores 的历史负责人（owner_id/operator_name）与“未指派”页签是否还需要？
2. 备忘的 needs_recharge / paused 状态、以及备忘的“续费中”是否仍在使用？
3. 一个店铺是否真的要绑定多个手机号（旧：每平台每手机一个），还是新系统“一店一号”即可？
4. 异常原因保持“只能选库”，还是恢复“自由输入并自动记入库”？
5. 是否恢复归档/恢复，取代当前硬删除？
6. 店铺“授权商标”是否要关联商标档案并带授权起止日期？
7. `src/resource-pages/*`（死代码）是否确认忽略？
8. 自媒体与店铺的多对多关系是否仍需要？
9. 店铺领用额度规则（主平台 3 个名额、50 元罚款、自动收回）是否要在新系统实现？
10. 手机号固定充值日（recharge_day）是否仍需要，还是用“周期天数”足够？
11. 疑似缺陷：选择“手机号档案”而不填号码文本会被清空绑定，请确认是否需要立刻修复（本审计只读，未运行验证）。

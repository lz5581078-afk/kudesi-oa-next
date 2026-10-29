# UI·页签分类管理（资料列表页签“管理分类”）

分支 feat/tab-manage。范围：资料列表上方的分类页签（`ResourceDef.tabsBy` 对应 select 字段的选项）原来是 `packages/shared/src/resources.ts` 里写死的，页面上不能增删改名。现在开放通用的“管理分类”，不为任何单个资料另写页面或接口，全部在通用壳里做。迁移 1752000000000（新增一张表，向后兼容）。

## 1. 设计说明

### 1.1 入口与权限
- 页签栏最右侧一个小齿轮（`aria-label="管理分类"`），有权限的人才显示。
- 权限键：**统一一个 `resource.categories.manage`**（定义在 `packages/shared/src/navigation.ts` 的 `SPECIAL_PERMISSIONS.resourceCategoriesManage`，权限清单在“资料 · 页签分类”组里自动出现）。选统一键而不是每个资料一个键的原因：分类管理是一类能力，不是某个资料的业务动作；岗位只勾一次就能管全部资料，勾选页不会多出 10 个键；同时服务端还强制要求该资料的 `resource.<类型>.view`，所以能管哪些资料仍由查看权限限定。
- 公司管理员默认有（管理员权限是全集）；现有岗位需要管理员在“岗位档案/员工与权限”里勾选“资料 · 页签分类”。
- 接口默认拒绝：`@RequirePermission(resource.categories.manage)`；公司和操作人只取自令牌；DTO 白名单 + 多余字段拒绝（`name` 最长 60，实际校验 20 个字；`hidden` 布尔；排序传完整值数组；URL 里的分类值只允许 `[A-Za-z0-9_]{1,64}`）。

### 1.2 规则
| 操作 | 系统分类（代码里写死的选项） | 公司自建分类 |
|---|---|---|
| 改名（只改显示名，记录里存的是值，不受影响） | 可以 | 可以 |
| 上下移动排序 | 可以（与自建分类混排） | 可以 |
| 隐藏/显示 | **不可以** | 可以 |
| 删除 | **不可以** | 仅“零记录在用”；有记录在用只能隐藏，并提示数量 |
| 值（内部 key） | 代码里的值，只读 | 自动生成 `c_` + 8 位小写字母数字，生成后永不改变，不和代码选项/已有行冲突 |

- 系统分类一律只允许改名和排序：业务规则（`resource-rules.ts`、`entity-rules.ts`、关联、迁入器映射、页面专属面板）可能依赖它们的值，所以不开放隐藏/删除。确认没被引用的系统分类也按同一条处理，保持规则简单（见第 3 节被引用清单）。
- 名称：1~20 个字、不含控制字符、不能叫“全部”（页签保留名）、同一资料内不重名（忽略全半角和大小写，含已隐藏的）。每个资料最多 50 个自建分类。
- “在用记录数”统计该公司该资料的全部记录（含停用、归档），这样“零记录在用才能删”是真的零。
- 隐藏的自建分类：不在页签、新建/编辑下拉、导入识别里；已有记录的值仍正确显示，列表/详情/表格里带“（已隐藏）”，编辑别的字段时下拉里保留该值。
- 当前页签被隐藏/删除后自动回到“全部”。
- `tabSplit` 拆分页签和 `q:` 快捷页签保持原样：只管理 tabsBy 的 select 选项（有 `tabSplit` 的资料本身就不在开放范围内，见 2）。

### 1.3 存储（迁移 1752000000000，只改结构，无种子）
表 `resource_category_options`：`company_id, resource_type, field_key, value, label, sort_order, hidden, custom, created_by/at, updated_by/at`，唯一键 `(company_id, resource_type, field_key, value)`。
- 没有行 = 完全沿用代码选项，所以老数据、迁入器、没人用这个功能的公司零影响（向后兼容；回滚只需删表）。
- 系统分类只在第一次被改名/排序时才“落成行”（排序基数 10、20、30…，自建排在后面）。之后代码里新增的系统选项即使没有行也会出现（按代码顺序补在系统分类位置）。
- 有效选项 = `mergeCategoryOptions(代码选项, 公司的行)`（`packages/shared/src/category-options.ts`，前后端同一份）。

### 1.4 并发
- 所有改动（新增、改名、排序、隐藏、删除）在事务里先 `SELECT … FOR UPDATE` 锁公司行，同一公司串行；排序必须提交“当前全部分类的一个排列”，别人同时改过就返回 409“分类已经变化，请刷新”。
- 删除：先对分类行加排他锁，再数在用记录，再删除；保存记录时如果提交的是自建分类，会在事务里对该分类行加共享锁并重读有效选项，所以“数完是 0 → 同时有人选了它 → 删掉”不会发生。
- 每个改动写一条 `audit_logs`（action = `resource.category.create|rename|reorder|hide|show|delete`，resourceType = 资料类型，resourceId = 分类值，detail 带名称变化/顺序）。系统审计页可查。

### 1.5 全链路生效位置
| 位置 | 实现 |
|---|---|
| 列表页签、数量 | 页签用有效选项（可见的），数量仍按值统计（`tabCounts` 不变） |
| 新建/编辑表单下拉 | `FieldInput` 用 `selectChoices`：可见分类 + 记录当前值 |
| 服务端字段校验 | `saveRecord`：`categoryAllowedForSave` → `dynamicOptions`（代码选项 + 本公司未隐藏的自建分类）；别的公司的自建值被拒；记录原值不动仍合法 |
| 筛选 / 列筛选 facets | facets 返回值与数量，前端用本公司名称显示；筛选标签条同理；`colFilters` 不校验选项值，按值筛 |
| 表格编辑（grid-edit） | 编辑器与粘贴解析用有效选项；保存走 `saveRecord` 同一套校验 |
| 导入 | 认本公司名称、值、改名前的代码原名；自建分类名也能导入；已隐藏的给出“已隐藏，不能再选用”；别的公司的名称认不出；导入说明/示例行用本公司名称 |
| 导出 | CSV 显示本公司名称 |
| 详情、操作记录差异 | `displayValue` / `LogChanges` 用本公司名称，已隐藏带提示 |
| 关联摘要（服务端） | `relationSummary` 用本公司名称 |
| 手机号“绑定店铺/自媒体账号”派生文字、店铺提现平台名 | 用本公司的平台名称（`categoryLabelMap`） |
| 手机/移动端 | 同一套组件；管理弹窗在手机上是卡片列表，弹窗盖住底部导航 |
| 批量操作 | 没有批量动作直接修改分类字段；批量走 `saveRecord`，校验同上 |
| 迁入器 | 不受影响：不读配置表，系统值照旧通过静态选项校验 |
| 前端缓存 | `GET /api/resources/category-options`（登录即可，只返回有查看权限的资料的配置）；管理弹窗每次改动后强制刷新，页签和表单立即变化；登录/退出清空缓存 |

## 2. 各资料 tabsBy 清单与开放情况

共 15 个资料带 tabsBy（`resources.ts` 11 个、`finance-resources.ts` 4 个）。**开放 10 个，不开放 5 个。**

| 资料 | tabsBy 字段 | 系统分类（值：名称） | 开放 |
|---|---|---|---|
| licenses 营业执照 | category | operation 经营执照、ecommerce 电商执照 | 开放 |
| stores 店铺档案 | platform | pdd 拼多多、taobao 淘宝、tmall 天猫、douyin 抖音、jd 京东、kuaishou 快手、xhs 小红书、other 其他 | 开放（另有 `q:` 快捷页签，保持原样） |
| store-scores 店铺评分 | dimension | growth/experience/navigator/aftersales/reviews/service/consumer 共 7 个维度 | 开放（嵌在店铺详情里，列表页签只在自己的列表出现） |
| phones 手机号 | usageType | company_kept/personal_used/external_used/partner_used | 开放 |
| tax-profiles 税务资料 | taxCategory | operation 经营税务、ecommerce 电商税务 | 开放 |
| partners 合作人档案 | partnerType | partner 合作人、legal 法人、business 合作商、other 其他 | 开放 |
| bank-accounts 银行账户 | kind | company_public/company_card/cashier_account/store_public/store_personal_card | 开放 |
| qualifications 资质证照 | type | seed_business_filing/brand_authorization/platform_operation/general | 开放 |
| self-media 自媒体账号 | platform | douyin/kuaishou/channels/xhs/other | 开放（另有 `q:` 快捷页签） |
| memos 账号与服务备忘 | kind | account 账号、service 服务 | 开放（另有 `q:` 快捷页签） |
| locations 房间与档案位置 | scope | area 区域位置、asset_space 固定资产储物空间 | **不开放**：页面是专用看板（区域位置/储物空间两个视图），没有分类页签 |
| finance-products 商品档案 | archiveType | 6 个档案类型，且有 `tabSplit` | **不开放**：已有自己的“管理档案类型”（单位与规格里的自定义类型），类型参与商品编码规则 |
| finance-categories 商品分类 | archiveType | 8 个 | **不开放**：同上，分类树按档案类型分开并参与编码 |
| finance-fee-items 费用档案 | direction | expense/income/offset/current | **不开放**：收支方向决定记账口径 |
| finance-product-units 单位与规格 | kind | 7 个种类 | **不开放**：种类是代码里的结构 |

开放的判定在 `categoryFieldOf(def)`：有 tabsBy、该字段是单选 select、没有 `optionsFrom`、没有 `tabSplit`、不在不开放清单（`UNMANAGED`，附原因）里。以后新增带 tabsBy 的资料默认就开放；不该开放的往 `UNMANAGED` 加一行并写原因。

## 3. 被业务规则引用的系统分类（一律只读：只能改名、排序，不能隐藏、不能删除）

按 grep 各取值在 api/web/shared/agent（排除测试和迁入脚本）里的使用统计。**所有系统分类都按这一条处理**，下表只是说明为什么这条规则不能放松：

| 资料 | 被引用的取值 | 引用位置（代表） |
|---|---|---|
| licenses | operation、ecommerce | resource-rules（由执照类别推导税务/银行卡/店铺公户）、entity-rules（税务类别默认值）、TaxPendingDialog |
| tax-profiles | operation、ecommerce | entity-rules、resource-rules（和执照类别对应）、TaxPendingDialog |
| partners | partner（默认）、legal | entity-rules（默认合作人类型）、resource-rules（自动建法人合作人）、RecordDetail（“法人主体与银行卡”页签只对合作人档案） |
| bank-accounts | 5 个全部 | entity-rules（公户/卡规则）、resource-rules（按执照类别建账户）、bank-balance（公户余额）、data-issues、audit.controller、CashBankPage/BankFundPage/BankMini、fee-archive |
| qualifications | general | entity-rules（类型缺省为 general） |
| phones | external_used | resource-rules / resources.service（外部使用人建手机号）、CertPanels；其余三个取值通过 showWhen 决定表单里出现“使用人/资产/合作人”等字段 |
| stores | pdd、taobao、tmall、douyin、jd、kuaishou、xhs、other | session（提现平台顺序）、fee-archive、agent platforms 白名单映射、account-views（手机号绑定店铺列）、live-access（douyin）；平台字段还参与 uniqueTogether（平台+手机号） |
| self-media | douyin、kuaishou、channels、xhs | showWhen（各平台专属字段）、groupTitleBy（“平台专属属性”）、live-access（douyin） |
| memos | account、service | account-views（域名视图）、showWhen（服务类专属字段） |
| store-scores | 7 个维度 | StoreMetricsPanel、店铺评分各维度字段 |

**自建分类的行为**：自建分类是“普通分类”：记录可以归到它、页签/筛选/导入导出都认它，但依赖具体系统值的联动字段（showWhen 条件字段、上表的规则）对它不生效，只出现基础字段。例如手机号自建一个“测试机”使用类型，不会出现“使用人”“资产”等条件字段。这是预期行为，管理弹窗的说明里也写明了“系统自带的分类参与业务规则，只能改名和排序”。

## 4. 验证

### 4.1 自动化测试
| 范围 | 内容 | 结果 |
|---|---|---|
| shared（`category-options.test.ts`，11 项） | 有效选项合并、改名保留原名、排序、系统分类不被隐藏、隐藏分类的可选集合与“已隐藏”标注、系统分类保护（隐藏/删除）、自建分类在用数量保护、名称校验、key 生成不冲突、开放/不开放清单、权限键进可授予清单、动态选项通过校验 | shared 全量 265 项通过 |
| API db.spec（`resource-categories.db.spec.ts`，真实 MySQL，11 项） | 新增/改名/排序/隐藏/删除规则；有记录在用不可删；系统分类不可删隐；公司隔离（别的公司看不到、不能用）；权限（只有查看权限、只有管理权限、不开放的资料）；新分类值通过记录保存校验；隐藏后不能新选但原记录能继续改；列表页签数量、筛选、列筛选 facets；导出用本公司名称；导入认名称/值/原名/隐藏的不认/别的公司不认；表格保存；排序并发；审计日志 | 通过 |
| API HTTP（`resource-categories.http.spec.ts`，12 项） | 默认拒绝（未登录/仅查看）、DTO 白名单与非法值、身份只来自令牌 | 通过 |
| web vitest（`CategoryManage.test.tsx`，10 项） | 管理弹窗各操作（新增、改名、上下移动、隐藏、删除确认、有记录在用不可删并提示数量、服务端拒绝提示）；无权限不显示齿轮；新分类与新名称出现在表单下拉和页签；隐藏的不出现在页签/下拉，已有值带“已隐藏”；无配置时页签为代码选项 | web 全量 526 项通过（含合并 integration 后） |
| 三端 tsc | shared / api / web `tsc --noEmit` | 通过 |
| API 至少 resources/common/org/migration | `RESOURCE_DB_TEST=1 jest --runInBand src/resources src/common src/org src/migration` | 通过（含新增 23 项） |

### 4.2 Playwright（全新种子库，本地 vite + API，截图在本机）
1440×900 与手机 390×844；资质证照：默认页签与齿轮、打开管理弹窗、新增“行业协会证书”（值自动生成）、系统分类“品牌授权”改名“品牌授权书”、页签出现新分类并显示新名称、新建表单下拉含新分类和新名称、用新分类建一条记录并在新页签下看到、有记录在用的自建分类不能删并提示、隐藏后页签消失且记录仍显示。全部断言通过。

截图（本机，未入库）：`/tmp/claude-0/-home-claude/5f0340df-d2db-5d53-aea9-3dc621c50d0f/scratchpad/tabm-shots/`，命名 `{01-tabs-gear|02-manage-dialog|03-manage-after-add-rename|04-tabs-after|05-form-new-category|06-record-in-new-tab|07-in-use-cannot-delete|08-hidden}-{d1440|m390}.png`，断言结果 `result.txt`。

测试中发现并修掉的问题：`@Param()` 整体做 DTO 会因 `type` 路径参数被 `forbidNonWhitelisted` 拒绝（改名/隐藏/删除全部 400），改成 `@Param('value', 管道)`，并补了 HTTP 层测试；详情抽屉（z-index 24）盖住管理弹窗，弹窗单独提到 30（手机 50，盖住底栏）。

## 5. 对共用文件的改动（说明，均为最小追加）
- `packages/shared/src/navigation.ts`：`SPECIAL_PERMISSIONS` 追加一个权限键；`permission-catalog.ts`：追加一组；`index.ts`：导出新模块；`resources.ts`：`resourceTabOptions` 加一个可选参数。
- `apps/api`：`entities/index.ts` 追加实体、`data-source.ts` 注册迁移、`app.module.ts` 注册控制器（必须排在 `ResourcesController` 前，否则 `resources/category-options`、`resources/:type/categories` 会被 `:type`/`:type/:id` 抢走）和服务；`resources.service.ts` 四处（保存校验、导出、导入、关联摘要）；`relation-summary.ts`、`account-views.ts`、`finance-documents.service.ts` 各一处取本公司名称。
- `apps/web`：`ResourcePage`（页签 + 齿轮 + 弹窗）、`RecordForm`（下拉）、`ResourceGrid`（编辑器/列筛选）、`format.ts`、`DetailLogs`、`ImportDialog`、`StoresPop`、`AuthContext`（登录/退出清缓存）、`ResIcons`（齿轮）、`styles.css` 末尾追加。

## 6. 上线后管理员要做的事
1. 跑迁移（新增一张表，无数据变更）。
2. 在“岗位档案 / 员工与权限”里给需要的岗位勾选“资料 · 页签分类：管理分类”（公司管理员默认就有）。
3. 要改名/新增分类的人，到对应资料列表页，点页签栏右侧的齿轮。
4. 没有人动之前，所有页面和现在完全一样。

# A 组审计：证照与主体类（营业执照 / 资质证照 / 商标资料 / 合作人档案 / 税务资料 / 银行账户 / U 盾 / 银行概览）

**范围**：9 个资料对象（营业执照、借用记录、使用记录、资质证照、商标资料、合作人档案、税务资料、银行账户、U 盾）+ 银行概览（资金概况）与 `bank-views` 五个入口，另列“通用资料页缺口”与“迁移适配器影响”两节。
**缺口总数**：124 行（缺失 60 / 部分 38 / 变更 26，含跨节重复；去重后约 70 项），详见文末“统计”。
**最严重 3 点**：
1. **提醒预警大面积断了**：营业执照“年审月日”、银行/执照“对账提醒日”只存字段、没有任何预警（新系统 `alerts` 只支持完整日期且执照/银行没配）；商标“授权店铺 + 授权到期”整条关联（`trademark_store_authorization`，含 valid_from/valid_to，回写店铺授权商标）没有；旧“即将到期”统一清单（`server/modules/resources/expiring.js`）没有等价物。
2. **删除变硬删除，且字段/历史有丢失**：旧系统是“归档（可恢复，保留关联）”，新系统是带原因的**永久删除**；旧 U 盾“编号 shield_no”、合作人“合作范围/开始/结束时间/预留手机号姓名/预留手机号档案”、执照“照片缺失标记”、使用记录“关联对象”在新系统无对应字段；借用/使用历史按迁移规则被整体排除（`policy: review-history`）。
3. **旧流程性功能缺**：借用“登记归还”、借出状态显示在存放位置、逾期；税务资料“一张执照可有经营+电商两份”被新规则（`uniqueTogether: ['licenseId']`）改成只能一份；列表筛选（年审月份/资料缺项/到期、银行/店铺/预留手机号/U盾）、复制新建、批量、排序、“资质/税务适用店铺”派生面板在本组资料上全部没有。

> 说明：新系统有意合并/改名的标“变更”；“完整”项只汇总数量。引用格式：旧系统 `文件:行`（相对旧源码根 `.../dump/source`），新系统 `文件/字段`（相对 `/home/claude/kudesi-oa-next`）。“旧库列”引自 `audit/old-schema.sql`。

---

## 1. 营业执照 `licenses`

**已对齐字段：48 个**（旧表 `business_licenses` 实际使用的列 53 个，对不上的见下表；含 4 枚印章 × 状态/种类/位置共 12 项、正副本照片/实物状态/位置、公户 3 项、法人卡 4 项、对账 2 项、KT 板 3 项、基础信息 12 项）。新系统另外多了 `legalPhone`（法人预留手机）、`note`。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 营业期限起 `business_term_start`、营业期限到期 `expires_at` | business_licenses.business_term_start / expires_at；`expiring.js:12`（“营业期限到期”）；`business-licenses.jsx:393` 注释“营业期限已从执照资料中去掉” | 无 | 缺失 | 低 | 旧 UI 已不维护，但 `expiring.js` 仍把 expires_at 纳入到期清单，旧库可能有数据。见“需确认”Q1 |
| 旧完整日期年审 `annual_review_at` | business_licenses.annual_review_at | `annualAuditDay`（MM-DD） | 变更（已有替代） | 低 | 旧代码已全部改用 `annual_review_month_day`，迁移别名已映射 |
| 正本/副本“照片缺失”标记 `original_photo_missing` / `duplicate_photo_missing` | business-licenses.jsx 字段 `originalPhotoMissing/duplicatePhotoMissing`（“只表示没有照片，不代表实物缺失”）；导入列 `originalPhotoMissing` | 无（只有 `originalState/copyState` 实物状态和照片文件） | 缺失 | 中 | 旧“资料缺项：正本或副本照片未上传/缺失”筛选、`data-issues.js` 的“营业执照缺少照片”都依赖它；建议加 bool 字段或明确合并到实物状态 |
| 年审到期预警（30 天，按每年 MM-DD 滚动）+ 列表“年审”徽标 + 到期筛选（30/90 天/未设置）+ 年审月份筛选 | business-licenses.jsx:394（expiry）、:396-428（filters: reviewMonth/due）；`expiring.js:13`（kind: annual，`nextAnnualOccurrence`） | `resources.ts` licenses 无 `alerts`；`monthday` 类型 `OverviewPage` 的 alerts 只处理完整日期字符串（`resources.service.ts:975-985` `typeof v==='string'` + `daysUntil`） | 缺失 | **高** | 年审是执照最核心的业务提醒。需要：滚动到下一个 MM-DD 的预警规则、总览“需要关注”、列表徽标 |
| 对账提醒（周期+提醒日）→ 到期清单 | `expiring.js:35`（bank-accounts 的 reconciliation）；licenses 同名两列 | `reconcileCycle/reconcileDay` 仅存储 + `checkReconcileDay` 校验（`resource-rules.ts:66`） | 部分 | **高** | 字段有、提醒没有。执照与银行账户两处都是死数据 |
| 列表筛选：分类、状态、年审月份、到期、资料缺项（照片/无存放位置/印章遗失/无公户） | business-licenses.jsx:396-428 | `tabsBy: category` + 通用状态筛选 + 关键词；无 `filterBy` | 部分 | 中 | “印章遗失”“没有公户”“没有存放位置”是日常盘点用的 |
| 列表默认列/可选列：编号、主体、分类、法人、状态、年审（带徽标）、公户有无、执照存放（含借出显示）、印章齐全/遗失、正/副本照片状态、店铺数、本月营业额、最后修改 | business-licenses.jsx:430-460；工作区 SQL `server/index.js:4181-4286`（has_public_account/store_count/month_sales/last_changed_at） | `list:true` 字段：category、licenseNo、companyName、creditCode、legalPerson、annualAuditDay、locationId、publicAccountName（可选列=全部字段，无计算列） | 部分 | 中 | 缺“公户有无、印章摘要、照片状态、店铺数、本月营业额、最后修改”等派生列 |
| 排序选择、每页条数可选 | ResourceWorkbench.jsx:84,382 | 固定每页 20、按新建先后（`sortField` 未设） | 缺失 | 低 | 通用页能力，见第 8 节 |
| 复制新建（`copyOmit`: licenseNo/subjectName/creditCode/正副本照片） | business-licenses.jsx:606 | `RecordDetail.tsx` 只有 `def.batch` 存在才给 onCopy；licenses 无 `batch` → 无复制按钮 | 缺失 | 低 | 见第 8 节 |
| 导入：模板 51 列、按统一信用代码或执照编号匹配更新、空白不覆盖、“仅覆盖印章/KT 板/公户”模式、位置按完整路径或末级名匹配、状态/类别中英文识别、停用必须填原因、导入前自动备份最近 5 次可恢复 | business-licenses.jsx:123-130,183-260,625-660；`server/index.js:9889`（importBackupConfigs 含 tax/partner/bank/phone） | 通用导入：按字段中文名；`uniqueField: creditCode` 有则更新；备份最近 5 份（`resources.service.ts:1088-1160`） | 部分 | 中 | 缺：按执照编号匹配、“仅覆盖印章/KT/公户”清空模式、位置按路径解析（新系统 ref 按**标题**全等匹配）、备份只覆盖本类型（旧备份连同自动建出的税务/合作人/银行/手机号），恢复后自动建出的关联档案不会回退 |
| 导出：51 列 + “公户情况”（有公户/未开通）；银行账号写成 `="…"` 防科学计数 | business-licenses.jsx:132,262-310 | 通用导出（除 secret 外全部字段，公式注入转义） | 部分 | 低 | 缺“公户情况”只读列；“导出所选”（旧 ResourceWorkbench.jsx:431）新系统没有，只能整类导出 |
| 状态与流转：正常/异常/注销/停用；每次流转（标记异常/恢复正常/标记注销/停用/启用）都要“原因/说明”，异常原因自动写入 `abnormalReason` | business-licenses.jsx:598-604 | statuses：normal/abnormal/cancelled/inactive；仅 cancelled/inactive `requiresReason`；`abnormalReason` 为可选编辑字段，仅异常状态可见（showWhen），状态下拉直接切换 | 部分 | 低 | 标记异常/恢复正常不再强制说明，异常原因要另外去编辑里填 |
| 停用/注销的列表隐藏 + “停用注销列表”面板 | 旧三块面板（经营/电商/停用注销） | `hidden:true` + “显示停用/注销”勾选 | 变更（已有替代） | — | |
| 归档/恢复（保留关联、可恢复；归档前展示仍存在的关联） | `server/modules/resources/archive-service.js`；Dossier.jsx:104-110,756-775；列表“已归档”页签 | 只有删除（`resources.service.ts:810-840` 硬删除；被引用时拒绝）；无归档页签 | 缺失 | **高** | 新系统删除不可恢复；旧系统所有本组资料（含 U 盾）都走归档。见“需确认”Q2 |
| 新增时自动联动：法人手机号档案、法人合作人、税务资料、公户/法人银行卡（含已存在则复用并补关联） | `server/index.js:2710 autoCreateLicenseRelatedRecords`、:2489 税务、:2532 合作人、:2625 银行、:2453 手机 | `resource-rules.ts:230-300 afterCreateRule` | 部分 | 中 | 差异：①旧用“法人银行卡预留手机号”(`legalPersonBankReservedPhone`)建/找手机号并建 `phone_license` 关联，新用独立字段 `legalPhone`，只填了 `legalCardPhone` 的不会建手机号；②同名法人合作人已存在时，旧版补 `license_id` 并回填银行卡信息，新版什么都不做（代码注释写“补上执照关联”但未实现）；③新建合作人不带法人银行卡 `cardHolder/cardBank/cardNo/cardPhone`；④已存在同账号银行账户时，旧版把无归属的账户挂到本执照，新版直接跳过；⑤税务资料旧版按“识别号+类别”找已有的复用并挂执照，新版总是新建；⑥旧版税务资料带上公户开户行/账号 |
| 执照 ⇄ 银行账户双向同步：银行账户为准，保存银行账户后把公户/法人卡写回执照 `public_*`/`legal_person_bank_*`；详情里“公户与法人银行卡”显示关联账户列表、冲突提示（属于别的执照/没建账户）+ 一键新增公户/银行卡 | `derived-facts.js:439-566`（writeBackLicenseBankColumns/loadLicenseBankFact）；business-licenses.jsx:20-60,497-513；`server/index.js:10706-10716` | 执照上的 `publicAccount*`/`legalCard*` 与 bank-accounts 记录各存一份，创建后互不同步 | 缺失 | 中 | 会出现两处账号不一致；也没有“未建银行账户”的数据问题清单（`data-issues.js:licenseBankUnlinked`） |
| 照片识别：新增时上传/粘贴剪贴板/屏幕截图识别；已有执照“用照片识别并核对”逐项勾选更新；可选识别模型（企业默认）；本机 OCR 文本解析、OCR 状态接口 | license-sections.jsx:40-270（useAiModel/LicenseCreatePanel/RecognizeFromPhotos/RecognitionCompareDialog）；`server/index.js:6999-7055` | `LicenseRecognize.tsx`（新增/编辑表单里选图→确认填入）+ `integrations/ocr.service.ts` | 部分 | 低 | 缺：对已有记录的“核对并逐项更新”对比框、剪贴板/截图入口、模型选择；识别字段 10 项一致 |
| 营收面板（今日/本周/本月/自定义；营业额/退款/经营利润合计 + 分店铺） | license-sections.jsx:490-553；`server/index.js:7056-7108`（sales_snapshots） | `RevenuePanel.tsx` + `revenue.service.ts`（store-daily-metrics，列更多：推广费/平台费/采购成本/其他成本/订单数） | 变更（已有替代） | — | 数据源由 sales_snapshots 改为“店铺经营数据”（手工/导入），属有意变更 |
| 关联关系：新增店铺（带执照）、关联已有店铺（含转移）、新增公户/银行卡（按电商/经营自动选类型）、新增资质、新增税务（只列缺失类别）；手动关联运营人员/合作人/手机号 | license-sections.jsx:290-483（LicenseRelationActions）；relations targets `['employee','partner_profile','phone_number']`（business-licenses.jsx:587）；relation-registry `license_operator`、`phone_license` | `related` 页签（stores/bank-accounts/qualifications/tax-profiles/partners/archives）+ ChildPanel“＋新增”（执照字段锁定）；通用手动关联 | 部分 | 中 | 缺：①“关联运营”(员工)——通用手动关联不含员工（`addManualLink` 对 `user` 报“资料类型不存在”）；②关联已有店铺/转移；③新增公户时按执照类别自动选 kind；④`related` 没有 trademarks（旧有 `license_trademark`） |
| 存放位置显示：总位置 + 固定资产内格位路径 + 该位置固定资产名称；正/副本/印章“同资料总位置”回退文字；借出中显示“xx借走，预计…归还” | business-licenses.jsx:57-95,586；license-common.jsx:108-150,150-170（activeBorrow/borrowText） | 位置是普通 ref（`locations` 标题）；借用不影响显示 | 缺失 | 中 | “借出显示在位置上”依赖借用记录流程（见 1.1） |
| 位置联动：总位置变更→跟随的正/副本位置；印章总位置→各章位置；创建时空位置继承总位置 | license-common.jsx:187-215 normalizeCustody | `resource-rules.ts:syncLocations`（locationId→original/copy；sealLocationId→四枚章，缺失的章不动） | 完整 | — | |
| 印章联动：缺失→种类/位置清空；普通保存⇔自刻章；防伪章切回“正常保存”；非缺失印章种类默认防伪章 | license-common.jsx:216-232；`server/index.js:9859` | `resource-rules.ts:applySealRules` | 部分 | 低 | ①`ordinary_kept` 分支排在前，“种类改回防伪章→回到在位”分支永远走不到，无法只改种类取消普通章；②非缺失且种类为空不补 `anti_fake`；③正本/副本“缺失”、KT 板“无”时不清空对应位置（旧 normalizeCustody 清空） |
| 权限/敏感：公户号、法人卡号 | 旧：明文存 + 页面 MaskedNumber 点按显示/复制 | `sensitive` 加密存储、有权限者明文显示（CLAUDE.md 规定不脱敏） | 变更（已有替代） | — | 旧的“点击显示 / 一键复制”不再有，属有意变更 |
| 数据问题清单：营业执照缺照片 / 执照登记公户未建账户 | `data-issues.js:158,276` | 无（本组范围外的总览页，见组外） | 缺失 | 低 | 仅提示依赖：照片缺失标记 |

### 1.1 借用记录 `license-borrows`

**已对齐字段：8 个**（licenseId、purpose、borrowedAt、expectedReturnAt、returnedAt、status 三值 borrowed/returned/overdue、note、item 六类）。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 借用人 = 员工（`borrower_employee_id`） | license_borrow_records.borrower_employee_id；license-sections.jsx:591 | `borrower` 文本（必填） | 变更 | 中 | 新系统改成自由文本，无法按员工统计/联动；迁移别名把员工 id 直接映射到文本字段会得到数字（`mapping-rules.json` license-borrows.borrower） |
| 借用对象枚举 `license_original/license_duplicate/official_seal/finance_seal/legal_person_seal/invoice_seal` | license-common.jsx:130-137 | `item`：original/copy/official/finance/legal/invoice | 变更 | 低 | 值变了，历史数据需转换（迁移适配器无值转换，见第 9 节） |
| 登记归还（填归还日期/说明；状态置 returned；写操作日志；已归还不能重复） | `server/index.js:7235-7260`；license-sections.jsx:625-640 | 无专用动作，只能编辑 `returnedAt` + 手动改状态 | 缺失 | 中 | 建议在 ChildPanel 加“登记归还”，并自动写 returnedAt+状态 |
| 借出中状态在执照存放位置/印章位置上显示；`activeBorrow` 判定 borrowed/overdue | license-common.jsx:150-170；business-licenses.jsx:57-72 | 无 | 缺失 | 中 | |
| 逾期自动判断（`overdue`） | 旧代码只有枚举，无定时任务（`grep overdue` 仅工作流模块） | 同样无 | 完整（行为一致） | — | 旧系统也靠人工 |
| 校验：预计归还/归还日期不早于借用日期 | 旧无 | `resource-rules.ts:195-199` | 新增 | — | 新系统更严 |
| 借用用途必填、借用日期默认今天 | `server/index.js:7110-7160` | purpose、borrowedAt 必填 | 完整 | — | |
| 操作人只取登录用户（`actor_id`） | `server/index.js:7121` | 通用操作日志 | 完整 | — | |
| 历史数据迁移 | mapping-rules.json license-borrows `policy: review-history` | 迁移适配器会把整张表列入排除（`legacy-adapter.cjs` `if(rule.policy)…excluded`） | 缺失 | 中 | 未归还的借用记录“建议保留”，目前没有迁移路径 |

### 1.2 使用记录 `license-usages`

**已对齐字段：7 个**（licenseId、item、purpose、usedAt、status、note、使用人）。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 关联对象 `related_object`（如某店铺入驻、某合同） | license_usage_records.related_object；license-sections.jsx:613 | 无 | 缺失 | 中 | 数据丢失风险 |
| 使用类型 `usage_type`（自由文本，默认“业务办理”） | license_usage_records.usage_type | `usageType` 选择：bank/tax/platform/contract/other | 变更 | 低 | 历史自由文本无法对应 5 个枚举，迁移需映射 |
| 使用人（员工，可空） | used_by_employee_id | `userId` 必填 ref user | 变更 | 低 | 旧可空；必填后旧数据缺使用人的无法迁入 |
| 状态 completed/pending(处理中)/abnormal | license-sections.jsx:614 | done/pending(待处理)/abnormal | 变更 | 低 | 值名变化，需转换 |
| 使用对象 | LICENSE_ITEMS（6 类） | `item` 6 类 + other | 变更 | 低 | |
| 迁移 | mapping-rules.json license-usages `policy: review-history` | 整表排除 | 缺失 | 中 | 同上 |

---

## 2. 资质证照 `qualifications`

**已对齐字段：11 个**（所属执照、名称、类型、备案日期、备案产品、证书号、平台登录账号、平台登录密码、审核联系人、附件、到期日）。旧表另有 `store_id`、`scope_type`（新增时恒为 license/NULL，UI 已废弃，不算缺失）。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 状态“续期中 renewing”及“标记续期中”流转 | qualifications.jsx:15-17,90-100,168-176 | statuses：normal/abnormal/expired/inactive | 缺失 | 中 | 旧页签“续期中”、状态筛选“续期中”；旧库 status 可能含 renewing/valid/expiring（见第 9 节迁移） |
| 到期状态按到期日自动判断（即将到期/已过期），页签：即将到期/已过期/续期中/异常；到期筛选（已过期/30/90/无到期日）；列表到期徽标；默认按到期日升序 | qualifications.jsx:34-48,96-130,134-148；`expiring.js:21` | `alerts: expiresAt 30 天`（只进总览“需要关注”）；`expired` 是**手动状态**；无页签/筛选/徽标/默认排序 | 部分 | 中 | 到期了不会自动变“已过期”，也没有“已过期”筛选 |
| 所属执照筛选（含“未关联营业执照”） | qualifications.jsx:131-140 | 无 `filterBy` | 缺失 | 低 | |
| 适用店铺：按所属执照下的店铺实时派生、只读 | qualifications.jsx:171-176；relation-registry `store_qualification_derived`/`qualification_store_derived`；`server/index.js:loadDerivedResourceRelations` | 无（licenses 的 related 有 stores，但资质详情没有） | 缺失 | 中 | |
| 资质类型枚举名 | TYPE_OPTIONS：种子生产经营备案/品牌授权/平台经营资质/其他资质 | seed_business_filing(种子经营备案)/brand_authorization/platform_operation(平台运营资质)/general(通用) | 变更 | 低 | 值一致、标签改名；新系统 `type` 必填且无默认值（旧默认 general） |
| 导入：按“备案/证书编号”匹配，没有编号按“名称+类型+营业执照”匹配；执照可填主体名/信用代码/编号/ID；**可导入平台登录密码并加密**；导出不含密码；状态中文识别；停用必须填原因；自动备份 5 份 | qualifications.jsx:55-70,200-300 | 通用导入：`uniqueField: certNo` 有则更新；secret 字段**不走导入**；ref 仅按标题匹配；无编号时一律新建 | 部分 | 中 | 缺：平台密码导入、无编号时的名称+类型+执照匹配、执照多键匹配 |
| 复制新建（`copyOmit: certificateNo`） | qualifications.jsx 末段 | 无（无 batch） | 缺失 | 低 | |
| 状态流转需填说明（续期/异常/恢复/停用/启用） | qualifications.jsx 末段 statusActions | 仅 inactive 要原因；`abnormalReason` 可选字段 | 部分 | 低 | |
| 平台登录密码：加密，仅按权限查看，查看写审计 | SecretField.jsx、`/secret/:field` | `secret` 类型 + `resource.qualifications.secret` + reveal 日志 | 完整 | — | |
| 详情“证书附件/照片”单张 ≤8MB | qualifications.jsx:media | `attachments` 多文件（最多 9） | 变更（已有替代） | — | 更宽松 |
| 删除/归档 | archive-service | 硬删除 | 缺失 | 高 | 同 1 的归档项，不重复计 |

---

## 3. 商标资料 `trademarks`

**已对齐字段：17 个**（名称、类别、来源、申请人、所属执照、授权方/合作负责人、申请号、注册号、申请/受理/注册日期、到期日、商标图、受理通知书、证书、备注、状态）。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 合作商标所属方 `cooperation_owner_name`（授权方） | trademarks.jsx:“合作商标所属方” | `cooperativeContact`（标签“合作负责人”） | 变更 | 低 | 名称/语义变成“负责人”，旧语义是“商标所属方/授权方”，建议改标签或补字段 |
| **店铺授权**：商标 → 店铺多对多关联 `trademark_store_authorization`，带授权开始/授权到期（valid_from/valid_to）；详情“店铺授权”表（店铺、店铺登记的授权商标、授权到期、说明、绑定时间）；店铺的“授权商标/授权商标到期”由关联回写；商标改名后回写所有被授权店铺；到期清单优先取关联上的 valid_to | trademarks.jsx:40-70,customSections；`relation-registry.js:authorization`；`derived-facts.js:337-436`；`expiring.js:relationExpirySources` | stores 只有文本字段 `trademark`、`trademarkExpireAt`；通用手动关联无日期/用途属性；无回写 | 缺失 | **高** | 商标到期提醒的真实来源是“授权到期”。新系统：商标页看不到授权给了哪些店铺，店铺的授权商标是自由文本，商标改名/到期不会联动。建议做带属性的关联（valid_from/valid_to）并回写店铺 |
| 状态集合与流转：申请中→已受理→已注册（或驳回/部分通过(无效)）→过期→续展后恢复；每步“标记…”需填说明；registered 的 normal/active 兼容；新增时按日期推断状态（有注册日期=已注册、有受理日期=已受理） | trademarks.jsx:10-30,200-215（statusActions/create） | statuses 同 7 个值（含 partial_passed、accepted），状态下拉任意切换；新增默认 applying，无按日期推断 | 部分 | 低 | 缺：流转限制、说明必填（仅 inactive 要原因）、按日期推断初始状态 |
| 页签：申请中 / 已注册(自有) / 不可用(驳回·过期·部分通过) / 合作商标；类别（多类别逗号分隔）、来源、状态、到期（90 天/已过期/已注册无到期日）筛选；到期徽标只对已注册商标 | trademarks.jsx:110-150 | `tabsBy: source`（自有/合作）+ 状态筛选；`alerts: validUntil 90 天` 对**所有**状态生效（含驳回） | 部分 | 中 | 缺类别筛选、“不可用”分组、到期筛选；预警未限定“已注册” |
| 导入：按“注册号，无则申请号”匹配更新非空栏目；执照按名称/信用代码找，找不到只记申请人；来源/状态中文识别；不能导入停用；日期格式校验；自动备份 | trademarks.jsx:230-300 | 通用导入；商标**没有 `uniqueField`**，所以每次导入都是新建 → 重复导入会产生重复商标 | 缺失 | 中 | 建议注册号或申请号做 `uniqueField`/组合键 |
| 复制新建（`copyOmit`: 名称/申请号/注册号） | trademarks.jsx | 无 | 缺失 | 低 | |
| 商标改名 → 回写店铺授权商标文本 | `server/index.js:10683-10690` | 无 | 缺失 | 中 | 与授权关联同属一件事 |
| 附件：商标图、受理通知书、商标注册证；列表“附件”列（商标图/受理书/证书） | trademarks.jsx:media/columns | `image`(1)/`acceptNotice`(5)/`certificate`(5) | 完整 | — | 列表无附件摘要列，低 |
| 申请人：可从执照检索或手填；导入时执照命中自动带申请人名称 | trademarks.jsx importer | `applicant` 文本 + `licenseId` 引用 | 部分 | 低 | 选执照后不会自动带申请人名 |
| 归档/恢复 | archive-service | 硬删除 | 缺失 | 高 | 同 1，不重复计 |

---

## 4. 合作人档案 `partners`

**已对齐字段：17 个**（编号、姓名、联系电话、身份证号、身份证正/反面、所属执照、店铺、关系负责人姓名/电话/员工/说明、银行卡户名/开户行/卡号/预留手机、备注）。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 合作范围 `cooperation_scope` | partner_profiles.cooperation_scope；partner-profiles.jsx:“合作范围”；导入列 | 无 | 缺失 | **高** | 法人自动建档时写“营业执照法人”；旧页面可编辑 |
| 开始时间 `started_at` / 结束时间 `ended_at` | partner_profiles.started_at/ended_at；列“开始时间” | 无 | 缺失 | **高** | 合作期信息整体没有承接 |
| 银行预留手机号姓名 `bank_reserved_phone_owner_name` | partner-profiles.jsx:“预留手机号姓名”；`derived-facts.js phoneFactSpecs.partner_profile` | 无（只有 `cardPhone` 文本） | 缺失 | 中 | |
| 银行预留手机号 → 手机号档案关联 `bank_phone_number_id`（手机号为准、文字回写；“未建档手机号”一键建档；手机号变更同步依赖记录） | partner-profiles.jsx:phoneFactFields；`derived-facts.js:123-285`；`data-issues.js:unlinkedPhoneTexts` | `cardPhone` 纯文本，无关联 | 缺失 | 中 | bank-accounts 有 `phoneId`+自动匹配，合作人没有 |
| 类型枚举：法人 / 合作人 / 合作商 / 其他 | TYPE_OPTIONS | `partnerType`：partner(合作人)/legal(法人) | 部分 | 中 | “合作商、其他”缺失；旧库已存在的这些类型无法落地 |
| 状态：合作中 / 解除合作 / 异常 | STATUS_LABELS（active/inactive/abnormal） | active / terminated（解除合作） | 部分 | 中 | 无“异常”；值 `inactive`→`terminated` 需要转换 |
| 法人主体面板：列出以该人为法人的所有执照（绑定的 + 同名的），标注“与合作人名称不一致”，一键“关联为法人”；合作人 ⇄ 执照多对多（`partner_profile_license`） | partner-profiles.jsx:34-93；relation-registry `partner_profile_license` | 单值 `licenseId`；执照详情的“合作人”页签（反向） | 部分 | 中 | 一个法人名下多张执照时，合作人侧只能挂一张；同名未关联提示/一键关联没有 |
| 合作人 ⇄ 银行账户（`partner_bank`）；“把登记的银行卡建成银行账户并关联”/“新增银行卡并关联” | partner-profiles.jsx:95-160；relation-registry | 无专用动作；合作人页卡片字段与 bank-accounts 独立 | 缺失 | 中 | 通用手动关联可手工挂，但没有一键建账户 |
| 合作人 ⇄ 店铺多对多（`partner_profile_store`） | relation-registry | 单值 `storeId` | 部分 | 低 | |
| 页签：法人 / 其他合作人 / 解除合作；筛选：类型、状态、公司归属人员、是否登记银行卡 | partner-profiles.jsx:159-175 | `tabsBy: partnerType`、状态筛选 | 部分 | 低 | 缺归属人员/银行卡有无筛选 |
| 导入：按合作人编号匹配，无编号按“名称+联系方式”匹配；归属人员按姓名/账号；日期；解除必须填原因；备份 | partner-profiles.jsx:260-340 | 通用导入；**无 `uniqueField`** → 总是新建 | 缺失 | 中 | |
| 复制新建（`copyOmit`: 编号/姓名/身份证号/电话） | partner-profiles.jsx | 无 | 缺失 | 低 | |
| 身份证号、银行卡号：旧明文存；新加密存、有权限者明文 | 旧 docs 3.x | `sensitive` | 变更（已有替代） | — | 有意收紧 |
| 法人自动建档来源（新增执照时自动建，type=法人，合作范围“营业执照法人”，关系说明“营业执照法人自动关联”，联系人=法人） | `server/index.js:2532-2620` | `afterCreateRule`（type=legal，`contactNote:'法人'`） | 部分 | 低 | 同 1 的自动联动项 |
| 归档/恢复 | archive-service | 硬删除 | 缺失 | 高 | 同 1，不重复计 |

---

## 5. 税务资料 `tax-profiles`

**已对齐字段：15 个**（所属执照、类别、纳税人名称、识别号、税种类型、主管税务机关、发票类型、税盘号、开户行、银行账号、联系人、联系电话、最近申报日期、备注、状态）。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| **一张执照可同时有“经营税务”和“电商税务”两份**；重复校验按“执照+类别” | tax-profiles.jsx:140-143（duplicateProfile）、:196-203；relation-registry 注释“one license can carry two tax profiles” | `uniqueTogether: [['licenseId']]`，提示“这个营业执照已经有税务资料了” | 变更（收紧） | 中 | 新规则只允许每执照一份；若业务仍需两份应改为 `['licenseId','taxCategory']`。见“需确认”Q4 |
| 纳税人类型枚举：待确认 / 一般纳税人 / 小规模纳税人 / **普通纳税人** | TAX_TYPES | pending / general / small | 部分 | 低 | 缺“普通纳税人” |
| 纳税人名称/识别号必填，缺省取执照主体名称/信用代码 | tax-profiles.jsx:create；`server/index.js:7263` 校验 taxpayerName+taxpayerNo | `taxpayerName` 必填、`taxpayerNo` 不必填；表单不会按所选执照自动带入 | 部分 | 低 | 识别号旧库为 NOT NULL |
| “还没有税务资料的营业执照”横幅 + 逐张建立/全部建立 | tax-profiles.jsx:49-116 | `TaxPendingDialog.tsx` 按钮“待生成”（逐张生成，类别固定 operation，忽略执照类别） | 部分 | 低 | 旧版类别跟随执照（经营/电商），新版一律“经营税务”；无“一键全部” |
| 适用店铺面板（按执照派生：店铺、编号、当前运营、状态） | tax-profiles.jsx:118-148；`store_tax_profile_derived` | 无 | 缺失 | 中 | |
| 列：本月营业额（取执照）、店铺数 | tax-profiles.jsx:columns | 无 | 缺失 | 低 | |
| 页签：经营/电商/异常；筛选：纳税人类型、状态、执照情况（未绑定/执照已停用注销） | tax-profiles.jsx:174-195 | `tabsBy: taxCategory` + 状态 | 部分 | 低 | |
| 导入：按“执照+类别”找已有更新，没有则新增；类别空白跟随执照；执照按名称/信用代码 | tax-profiles.jsx:215-330 | 通用导入：无 `uniqueField`，且 `uniqueTogether(licenseId)` 会让对已有执照的导入**直接报重复** | 缺失 | 中 | 目前不可能通过导入更新已有税务资料 |
| 归档规则：对应营业执照仍存在时**禁止**归档/删除税务资料 | `archive-service.js:assertTaxProfileArchivable` | 无此限制（税务→执照是出向引用，可直接删除） | 缺失 | 中 | |
| 迁移：无执照但识别号唯一对应一张执照时自动补执照 | `legacy-adapter.cjs:133` | 已实现 | 完整 | — | |
| 复制新建 | tax-profiles.jsx `copyOmit` | 无 | 缺失 | 低 | |

---

## 6. 银行账户 `bank-accounts`（含 U 盾、银行概览）

**已对齐字段：20 个**（账户类型、户名、开户行、账号、所属人、所属执照、关联店铺、保管人、预留手机号、预留手机持有人、手机号档案、客户号、开户档案位置、开户附件×4（合并为 `attachments` 最多 4 个）、对账周期、状态、备注）。新系统多了 `ownerName` 与 `accountName` 分开、`abnormalReason`。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 范围 `account_scope`（company/store） | bank_accounts.account_scope；bank-views.js BANK_KINDS | 由 `kind` 推出，不存 | 变更（已有替代） | — | |
| 当前余额 `current_balance`：旧系统只读，**由过账（document-posting）累加**；迁移明确“不自动作为期初余额迁入” | bank-accounts.jsx:`currentBalance readOnly`；`server/modules/finance/document-posting.js:49`；`legacy-adapter.cjs`（`delete data.balance`） | `balance` 手工登记，被财务“现金银行”当作**期初余额**（`finance-documents.service.ts:796,857`）；资金概况直接把它当当前余额汇总 | 变更 | 中 | 含义不一致：资料页叫“当前余额”，财务页当期初。建议改名“期初余额”并让资金概况调用现金银行的实时余额 |
| 对账提醒日格式：每月 `1-31`；**每季度 `Q-END-dd`（季度末月的第 dd 天）**；每年 `MM-DD`；选项按周期联动，改周期要重选 | bank-accounts.jsx:ReminderDayInput/parseReminderDay；`helpers.jsx bankReminderOptions`；`expiring.js:nextQuarterEndDay` | 文本框；校验季/年一律 `MM-DD`（`resource-rules.ts:66-77`） | 变更 | 中 | 旧季度值 `Q-END-15` 不满足新校验，旧数据迁入/保存会报错；季度语义也不同。无提醒功能（见 1 的对账提醒项） |
| 账号格式校验：数字/空格/横线，6–40 位 | bank-accounts.jsx accountNo.validate | `sensitive` 最多 64 字符，无格式校验 | 缺失 | 低 | |
| 账号唯一（同公司） | 旧库无唯一约束；导入按账号去重 | `uniqueField: accountNo`（加密后仍可查重） | 变更（更严） | 低 | 旧库有重复账号的数据会被拒，迁移需要先清理 |
| 账户类型 tab：公司公户/公司银行卡/出纳账户/店铺公户/店铺个人银行卡，另有 5 个旧入口别名 | bank-views.js | `tabsBy: kind` + `RESOURCE_VIEWS` 五个菜单入口 | 完整 | — | |
| 关联店铺 **多对多**（`bank_store` 关联，带用途：店铺收款/提现/保证金/推广充值）；列表“关联店铺”“店铺：已关联/未关联”筛选；导入可填多个店铺（顿号分隔） | bank-accounts.jsx:linkStores/filters；relation-registry `bank_store` + `bankPurpose` | 单值 `storeId`；通用手动关联（无用途） | 部分 | 中 | 财务侧 `finance-documents.service.ts:779` 读取 bank-accounts⇄stores 关联，但资料页没有“用途”属性 |
| 列表筛选：状态、银行、店铺有无、预留手机号（已关联档案/有号码未关联/未填写）、U 盾有无；列：U 盾个数、对账摘要 | bank-accounts.jsx:527-570,columns | 无 `filterBy`；无 U 盾个数列 | 缺失 | 中 | |
| 预留手机号：手机号档案为准、文字回写；未建档手机号一键建档并绑定；手机号变更同步 | `derived-facts.js phoneFactSpecs.bank_account`；phone-fact.jsx | `reservedPhoneNumber` + `phoneId`，保存时按号码自动匹配（`resource-rules.ts:122-130`） | 部分 | 低 | 缺“未建档手机号一键建档”“手机号变更后文字同步” |
| 公户专属块：客户号、开户资料位置、公户附件 1–4（任意文件，打开/下载/替换/删除），仅公司公户/店铺公户显示 | bank-accounts.jsx:290-420,561-580 | `customerNo/openingArchiveLocationId/attachments` 三项 `showWhen kind in 公户` | 完整 | — | |
| 新增时可直接选关联店铺 | bank-accounts.jsx createStores 区块 | `storeId` 字段 | 完整 | — | |
| 导入：按账号匹配更新非空栏目；执照/店铺/保管人/手机号/位置按名称或编号匹配，匹配不到整行标红不导入；周期/对账日/状态中文识别；备份 | bank-accounts.jsx:430-520,600-700 | 通用导入：ref 仅标题全等；对账日 Q-END 不识别 | 部分 | 中 | |
| 导出含“U 盾数量”“当前余额” | bank-accounts.jsx exporter | 通用导出（无 U 盾数量） | 部分 | 低 | |
| 复制新建（`copyOmit`: 账号/手机号档案/预留手机/客户号） | bank-accounts.jsx | 无 | 缺失 | 低 | |
| 状态：正常/异常/停用，停用必填原因 | bank-accounts.jsx statusActions | 同；`abnormalReason` 新增 | 完整 | — | |
| 数据问题：银行账户没有归属（公司账户无执照/店铺账户无店铺） | `data-issues.js:bankAccountsWithoutOwner` | 无 | 缺失 | 低 | 总览组范围 |
| 归档/恢复 | archive-service | 硬删除 | 缺失 | 高 | 同 1，不重复计 |

### 6.1 U 盾 `u-shields`

**已对齐字段：8 个**（所属银行账户、名称、保管人、存放位置、状态、备注、登录密码、交易密码）。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| U 盾编号 `shield_no`（与名称 `shield_name` 分开） | bank_u_shields.shield_no；bank-accounts.jsx:ShieldForm | 无（`name` 标签“名称/编号”，迁移只映射 shield_name） | 缺失 | **高** | 实体设备编号，迁移会丢；建议加 `shieldNo` |
| 状态：正常 / **借出 borrowed** / **遗失 lost** / 已停用 | SHIELD_STATUS_LABELS | normal / abnormal / inactive | 部分 | 中 | “借出/遗失”区分没有；迁入旧状态会不合法 |
| 新增时保管人默认取银行账户保管人 | bank-accounts.jsx:emptyShield | 无默认 | 缺失 | 低 | |
| 密码查看：仅企业管理员/老板（角色硬编码）；30 秒自动隐藏；写审计；状态“已维护/未维护” | `server/index.js:7784-7810`；ShieldSecrets | `secret` + `resource.bank-accounts.secret` 权限（沿用父资源）；15 秒隐藏；reveal 日志 | 变更（已有替代） | — | 由角色改为权限，符合 CLAUDE.md |
| 密码留空=不修改 | `server/index.js:7880` | 通用 secret 逻辑 | 完整 | — | |
| 停用（必填原因）/启用；归档/恢复；“已归档的 U 盾”折叠列表 | bank-accounts.jsx:206-330；`server/index.js:7813-7830` | ChildPanel：编辑、状态下拉（停用要原因）、删除（硬删） | 部分 | 中 | 无归档/恢复，已删除的 U 盾找不回 |
| 银行账户列表 U 盾个数 / U 盾有无筛选 | 见上 | 无 | 缺失 | 低 | 已在银行账户节计 |

### 6.2 银行概览/资金概况（`bank-overview`，菜单 `bank-fund`）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 四个汇总指标：账户总余额 / 公司账户余额 / 店铺账户余额 / 异常账户数（不含停用、已归档） | BankOverviewPage.jsx:29-38 | `BankFundPage.tsx` + `audit.controller.ts BankFundController`（同四项） | 完整 | — | |
| 按账户类型表：账户数、**异常数、已停用数**、余额；整行点击进入该类型页（并可定位到记录） | BankOverviewPage.jsx:40-70 | 只有类型、账户数、余额，无点击跳转 | 部分 | 低 | |
| 最近登记 12 条（户名、类型、银行、账号、余额、状态；点击打开该账户） | BankOverviewPage.jsx:71-103 | 最近 20 条，无账号列、不可点击 | 部分 | 低 | |
| 余额口径 | 过账累计 `current_balance` | 手工登记余额（页底说明“按过账流水算的余额在财务的现金银行查询里”） | 变更 | 中 | 见银行账户“当前余额”一行；不单独计 |
| `bank-views.js`：旧页面 key 别名、`resolveBankAccountsView`、`normalizeBankTab`、`bankAccountsNavTarget`、跨页“打开某类型某条记录”的 intent | bank-views.js；intent.js；navigation-targets.js | `RESOURCE_VIEWS` 五入口；跨页深链到记录**没有**（总览预警链接只到列表页） | 部分 | 低 | 见第 8 节“深链” |

---

## 7. 本组资料间的联动/关系（跨资料）

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 统一关联表 `resource_links` 带属性（`valid_from/valid_to/purpose`），本组用到：`trademark_store_authorization`(授权期)、`bank_store`(用途)、`phone_store`(用途)、`partner_profile_license/store/bank`、`license_operator`、`phone_license` | `relation-registry.js` 全文 | `resource_links` 仅 `relation:'manual'`、无属性 | 部分 | 高 | 根因：通用手动关联没有属性、不含员工；已计入商标/银行/执照/合作人各节，本行不重复计数 |
| 数据对齐/关联冲突/未建档手机号等“数据问题”检查 | `data-issues.js`、`link-alignment*.js` | 无 | 缺失 | 低 | 总览组范围，仅提示 |
| 即将到期统一清单（执照年审/资质/商标/对账/店铺聚水潭·授权商标/手机充值/软件续费/账号服务） | `expiring.js` | 总览 alerts：仅 qualifications、trademarks、phones、stores 等配了 `alerts` 的完整日期字段 | 部分 | 高 | 本组缺：执照年审、银行对账日、商标授权到期；已计入各节，本行不重复计数 |

---

## 8. 通用资料页对本组的缺口（所有 7 类共用）

| 旧功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 批量操作：批量停用/启用（填原因）、导出所选 | ResourceWorkbench.jsx:279,427-431 | 仅 `def.batch` 的资料有；本组 7 类都没配 `batch` | 缺失 | 中 | |
| 复制新建 | 各 schema `copyOmit` | `ResourcePage.tsx` 只在 `def.batch` 时传 onCopy → 本组无 | 缺失 | 低 | |
| 下拉筛选（执照/银行/店铺/类别等） | 各 schema `filters` | `filterBy` 未给本组任何资料配置 | 缺失 | 中 | |
| 排序选择、每页条数选择、“即将到期/已停用/已归档”内置页签 | ResourceWorkbench.jsx:84,144-147,382 | 固定 20 条/页；无排序；无到期/归档页签 | 缺失 | 低 | |
| 到期徽标（行内 30/90 天徽标） | ui.jsx ExpiryBadge | 无 | 缺失 | 中 | |
| 卷宗“关键事实”条、分区编辑（原位编辑单个分区）、未保存提示、查看轨迹 | Dossier.jsx | 抽屉详情 + 整表单弹窗 | 变更（已有替代） | — | |
| 跨页深链：打开某资料的某条记录（`onOpenResource(view,{tab,record})`） | intent.js、navigation-targets.js、Dossier `openRecord` | 无记录级深链（路由只到 `/resource/:type`） | 缺失 | 低 | |
| 敏感号码一键复制/点按显示 | MaskedNumber.jsx | 明文显示（有权限者） | 变更（已有替代） | — | |
| 位置字段按“房间/固定资产/格位”路径显示与导入 | license-common.jsx:75-120 | `locations` 标题 | 部分 | 低 | 同 1 的导入/位置项，不重复计 |

---

## 9. 迁移适配器对本组的影响（`scripts/migration/legacy-adapter.cjs` + `mapping-rules.json`）

> 这是“新系统会不会丢数据”的补充视角：适配器对 select 字段是 `option? option.value : String(value)`，旧值不在新枚举里时**原样写入**（保存时会被新校验拒绝或写成非法值，需试迁验证）；`resource_links`、操作日志不迁；`policy: review-history` 的表整表排除。

| 项 | 旧值/来源 | 新系统 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 资质状态 `renewing / valid / expiring` | qualifications.jsx:15 | 无这些状态 | 缺失 | 中 | `valid` 本应=normal，适配器只特判 normal/active |
| 商标状态 `normal / active`（旧=已注册） | trademarks.jsx:trademarkStatus | 适配器遇 normal/active 时取 `def.statuses` 里的 `active`，商标无此状态 → 落成默认 `applying` | 变更（错转） | 中 | 已注册商标会被迁成“申请中” |
| 合作人状态 `inactive / abnormal` | partner-profiles.jsx:STATUS_LABELS | 新状态 active/terminated | 缺失 | 中 | `inactive` 无对应也不匹配 `disabled`，保持原值 |
| 合作人类型 `合作商 / 其他` | TYPE_OPTIONS | 无 | 缺失 | 中 | 同第 4 节 |
| U 盾状态 `borrowed / lost` | bank-accounts.jsx:SHIELD_STATUS_LABELS | 无 | 缺失 | 中 | |
| 银行对账日季度值 `Q-END-dd` | bank-accounts.jsx:parseReminderDay | 新校验要求 MM-DD | 缺失 | 中 | |
| 借用对象 / 使用对象 / 使用状态 / 使用类型 的旧值 | license-common.jsx:LICENSE_ITEMS 等 | 新值全部改名 | 变更 | 低 | 无值转换表 |
| 银行账户余额 | current_balance | 适配器删除（不迁） | 变更 | 中 | 需另行确认期初余额口径 |
| 多对多关联：`bank_store`、`partner_profile_license/store/bank`、`trademark_store_authorization`、`license_operator`、`phone_license/phone_store` | resource_links | 不迁 | 缺失 | 中 | 只有各表自带的单值列（store_id、license_id）会迁 |
| 借用/使用记录整表 | license_borrow_records / license_usage_records | 整表排除 | 缺失 | 中 | |
| 旧列无新字段：business_term_start、expires_at、original/duplicate_photo_missing、cooperation_scope、started_at、ended_at、bank_reserved_phone_owner_name、bank_phone_number_id、shield_no、related_object、qualifications.store_id/scope_type | 见前文 | 无 | 缺失 | 见各节 | 已在各资料节计入 |

---

## 需要用户确认的问题

1. **营业期限（`business_term_start` / `expires_at`）**：旧页面注释写“已从执照资料中去掉”，但 `expiring.js` 仍把它放进到期清单、旧库有这两列。是确认废弃（新系统不要），还是仍要“营业期限到期”提醒？
2. **删除 vs 归档**：旧系统本组资料全部是“归档（可恢复）”，新系统只有“永久删除（被引用则拒绝）”。是否接受？还是需要补“归档/恢复”（建议至少 U 盾、执照、银行账户补上）？
3. **年审与对账提醒**：是否按旧逻辑（每年 MM-DD 滚动、对账日每月/季度末/每年）补进“资料总览-需要关注”和列表徽标？对账“季度”是否仍按“季度末月的第 N 天”（旧 `Q-END-dd`）而非 MM-DD？
4. **税务资料每执照一份还是两份**：新规则 `uniqueTogether: ['licenseId']` 是有意收紧吗？旧系统注释明确“一张执照可以有经营、电商两份税务”。
5. **借用记录的借用人**：旧是员工（可统计），新是自由文本。是否要改回员工引用（并保留外部人员的文本）？“登记归还/借出显示在位置上”是否需要？
6. **商标授权店铺**：是否需要“商标→店铺授权关联 + 授权到期 + 回写店铺授权商标”整套？还是店铺里手写文本就够？
7. **合作人**：合作范围、开始/结束时间、预留手机号姓名、预留手机号档案关联、类型“合作商/其他”、状态“异常”——旧页面都在用，是否都要保留？一个法人对应多张执照时合作人是否要多对多？
8. **U 盾**：是否补“编号”“借出/遗失”状态和归档？
9. **银行余额**：资料里的“当前余额”在新系统是手工期初余额，资金概况汇总的是它——是否要改成现金银行的实时余额，或把字段改名？迁移是否需要把旧 `current_balance` 作为期初余额带入？
10. **借用/使用历史迁移**：未归还的借用记录建议保留（迁移规则标注 review-history），是否迁入？
11. **旧库枚举脏值**：`qualifications.status`（valid/expiring/renewing）、`trademarks.status`（normal/active）、`partner_profiles.status`（inactive/abnormal）等，是否同意按“valid→normal、normal/active→registered、inactive→terminated”等规则在适配器里显式转换？
12. **法人自动联动**：新增执照时，法人手机号是用“法人卡预留手机”还是新字段“法人预留手机”？同名法人合作人已存在时是否要补挂执照并回填银行卡（旧行为）？

---

## 统计（按各表“状态”列，不含“完整”“新增”）

合计 124 行非“完整”条目：缺失 60、部分 38、变更 26（其中“变更（已有替代）”属有意改动，不算缺陷）。
按节：1 营业执照（含借用/使用记录）34；2 资质 10；3 商标 9；4 合作人 15；5 税务 10；6 银行账户/U盾/概览 23；7 跨资料联动 3；8 通用页 9；9 迁移影响 11。
注意：归档/恢复、关联属性、到期提醒等同根问题在多节重复出现，去重后独立缺口约 70 项。

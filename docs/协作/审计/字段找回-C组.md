# 字段找回 · C 组（银行卡、资产、组织与人员）

分支 feat/fields-c。范围：bank-accounts 及五个视图与资金概况、u-shields、bank-store-links、fixed-assets、asset-categories、locations、archives、员工档案资料字段、岗位档案字段、duty-groups（含 items/members）、workforce。
固定资产/位置、组织岗位职责组、兼职与临时工三块近期已按 24 日版重做（见 UI-固定资产与档案位置.md、UI-组织岗位职责组重写.md、UI-兼职与临时工.md），本次不推翻，只逐字段核对。

## 0. 方法与结论

- 对照来源：10 月 24 日源码（主）、旧真实库副本 legacy_full（只读，本地副本）。逐表列出旧库列，与 mapping-rules.json 别名和字段配置对账：本组所有旧业务列都已有新字段；没有对上的只剩元数据列（company_id/id/status/created_at 由迁入器处理，archive_* 由迁入器的归档通道处理）。
- 结论：字段本身基本完整，缺口集中在“关联带出与汇总显示”和“迁入器没搬的两张旧表”：当前余额、公户详情、列表关联列、店铺页的账户面板、U 盾与合作人银行的详情、人员列表的职责组、职责组说明列；以及旧岗位条目（position_duties）和员工薪酬记录（employee_compensation_records）没有进迁入器。
- 读时现算优先：余额和公户详情在读取时由流水/档案现算，不存库，所以对已有记录立刻生效，没有回填动作，也没有迁移。

## 1. 逐项对照

| 资料 | 旧字段（旧键） | 旧显示位置 | 现状 | 处理 | 备注 |
|---|---|---|---|---|---|
| bank-accounts | 当前余额（current_balance） | 银行卡列表、详情头、资金概况 | 只有期初余额；当前余额不显示 | 补回：只读读时字段 currentBalance = 期初 + 现金银行流水（整数分），与资金概况、现金银行查询同一口径；列表列、详情头关键信息、导出都带 | apps/api/src/resources/bank-balance.ts；col-filter 登记为读时字段，不做列筛选 |
| bank-accounts | 公户详情已维护/未维护（旧列表“公户详情”） | 公户列表列、详情 | 无 | 补回：只读 publicInfoFlag，公户/店铺公户的客户号、开户档案位置、开户附件任一项有即“已维护”；其他类型不出现 | 读时现算；详情的“关联”分区可见，导出带 |
| bank-accounts | 关联店铺（store_id）、保管人（keeper） | 列表列 | 在详情里，列表没有 | 补回：storeId、keeperUserId 设 list:true | 店铺个人银行卡/店铺公户视图直接看到店铺 |
| bank-accounts | 所属执照/所属人/预留手机/手机档案/店铺关联状态/U 盾个数 | 详情“关联”区 | 已有（phoneFlag、storeFlag、U 盾个数由实体规则带出） | 核对无缺，不改 | 带出规则在 entity-rules.ts |
| bank-accounts | 详情页关键信息 | 详情头 | 无余额 | KeyFacts 增加当前余额、关联店铺 | |
| 资金概况 | 账户数、各类型余额合计、最近登记账号 | 资金概况页 | 已有；余额汇总只用期初 | BankFundController 改用同一个 bankMovements，汇总=列表余额之和 | 与列表不再出现两套数 |
| bank-accounts 导入导出 | 全部字段列 | 导入导出 | 导出已带新增两列；导入忽略只读列 | 核对无缺 | 读时字段提交会被忽略（resources.ts 只读规则） |
| u-shields | 所属银行账户、保管人、位置、使用状态等 | 银行账户详情的 U 盾页 | 字段齐；账户详情里的 U 盾面板只列名称 | ChildPanel 的每一项带字段名（如“存放位置 …”），显示密码类字段“已维护/未设置”（不返回明文）和备注；账户店铺、职责组成员同理 | RecordDetail.tsx 的 LABELED_CHILDREN/CHILD_COLS |
| bank-store-links | 账户⇄店铺关联、关联说明 | 银行账户详情“账户店铺”、店铺详情 | 银行账户一侧有；店铺详情看不到账户 | stores.related 增加 bank-accounts、bank-store-links（按 storeId 反查） | 店铺详情“关联”页签出现账户面板 |
| 合作人（属 A 组）⇄ 银行 | 合作人详情里的银行信息 | 合作人详情 | 只有文字行 | 新增 BankMini（户名/开户行/账号带复制/当前余额），PartnerSubjectPanel 复用 | 与 A 组主体面板只在此处接触，未改 A 组配置 |
| fixed-assets / asset-categories | 全部业务列 | 固定资产页 | 字段齐，已按 24 日版重做 | 核对无缺，不改 | asset_categories.category_key（26/26 有值）是旧版内部英文分类键，新系统以分类名与树结构为准，不迁入；已在本表与 mapping 报告说明 |
| locations / archives | 全部业务列 | 位置与档案页 | 字段齐，已按 24 日版重做 | 核对无缺，不改 | 旧 location_scope=archive 已映射为 asset_space；旧 archive_* 归档列走迁入器归档通道 |
| duty-groups | 说明（description） | 职责组列表 | 在详情，列表没有 | 补回：description 设 list:true | 条目/成员面板不变 |
| employees（人员档案） | 所属职责组 | 人员列表 | 只有岗位与部门 | StaffPage 增加“职责组”列（取自成员关系，已有筛选下拉的同一份数据） | 没有新接口 |
| employees 人员资料 | 薪资权限、计薪、交接 | 人员档案 | 已有（org.staff.salary 权限、交接记录） | 核对无缺 | 旧 handover_records 表本地为 0 条，新系统由流程引擎承接，不迁 |
| positions 岗位档案 | 岗位条目（position_duties，十类分类） | 岗位详情 | 页面已有；迁入器没搬旧条目 | 迁入器新增：旧分类不在十类里的归“岗位职责”，旧分类名追加到说明（“（旧分类：X）”），所属岗位不在迁入范围的列入排除 | runner.ts；本地副本里这 8 条属于公司 1，公司 3 为 0 条，所以对公司 3 试跑为 0 |
| positions | position_responsibilities | 旧岗位职责 | 本地副本公司 3 无数据 | 不迁，列入说明 | 新系统以 position_duties 的“岗位职责”类承接，避免两份 |
| employees 薪酬记录 | employee_compensation_records（调薪、工资、奖励、处罚） | 人员记录 | 页面已有；迁入器没搬 | 迁入器新增：金额走 yuanToPreciseCents（超过整数分精度的不舍入，列入排除）；员工不在迁入范围、类型未知也列入排除 | 公司 3 试跑 1 条 |
| departments | is_system | 部门 | 无对应 | 不迁：新系统部门没有“系统部门”概念，保护靠权限 | |
| workforce | 全部业务列 | 兼职与临时工 | 字段齐，已重做 | 核对无缺，不改 | 旧附件表本地 0 条 |

## 2. 刻意不恢复

- asset_categories.category_key：见上。
- 旧 current_balance 作为存量不迁入：旧余额由流水推出，新系统期初余额不自动取旧余额（迁入器原有规则“余额不自动作为期初余额迁入”，试跑列出 42 条），当前余额改为读时现算，避免重复计算。
- departments.is_system、handover_records、position_responsibilities：见上。

## 3. 迁入器与试跑对账（legacy_full，只读副本，源公司 3，目标 kudesi_fieldsc 的空公司，dry-run 全回滚，没有 apply）

- 创建（试跑内）：department 17、position 26、user 59、bank-accounts 26、u-shields 4、bank-store-links 1、fixed-assets 30、asset-categories 22、locations 30、workforce 8、comp_record 1、position_duty 0。
- 失败 2936 条，全部在财务商品类（finance-product-costs 1546、finance-bundle-lines 1266 等）和 licenses.locationId 5、tax-profiles 3，不在本组资源内；与改动前同口径（空库缺依赖）。
- 适配器改动：legacy-adapter.cjs 读入 position_duties 与 employee_compensation_records；岗位条目的公司归属按所属岗位所在部门判断（旧条目 company_id 全是 1，与岗位所在公司不一致）。

## 4. 截图（1440 宽，本地 vite + 全新种子库）

目录：/tmp/claude-0/-home-claude/5f0340df-d2db-5d53-aea9-3dc621c50d0f/scratchpad/fc/shots/（未入库）
- 之前：before-_resource_bank-fund-*、before-_resource_company-public-accounts-*、before-_resource_store-public-accounts-*（list 与 detail）。
- 之后：after-_resource_bank-fund、company-public-accounts、store-public-accounts、company-bank-cards、store-personal-cards、cashier-accounts、u-shields、stores、fixed-assets、duty-groups、workforce、employees（各 list 与 detail）。
- 未改动的资料（固定资产、位置、档案、兼职）只拍“之后”。

## 5. 测试

shared 236、web 486、API db.spec（resources、common、org、migration）全部通过；新增 bank-balance.db.spec（余额与公户详情）、runner-org-extras.db.spec（岗位条目与薪酬迁入、排除、重跑不重复）。三端 tsc 通过。

## 6. 上线后管理员要做的

无迁移、无回填：余额和公户详情读时现算，上线即对已有记录生效。若要把旧系统的岗位条目和薪酬记录带入，需在迁入时对对应公司重新试跑并核对报告后再 apply（本任务没有 apply）。

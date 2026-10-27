# 审计 C：资产、组织与资料中心通用能力

- 本组资料 8 类（fixed-assets、asset-categories、locations、archives、duty-groups(含 items/members)、员工档案、岗位档案、组织树）+ 资料中心通用能力 1 块；共 9 节。
- 缺口总数：约 78 项（高 21 / 中 37 / 低 20），"变更"另计。旧系统无"折旧"功能（未找到），不算缺口。
- 最严重 1：固定资产没有状态流转（领用/转交/归还/送修/修好/丢失/找回/报废）、没有资产流转记录、没有盘点；新系统只有 4 个通用状态切换。
- 最严重 2：通用能力缺软归档/恢复（含关联预览）、"即将到期/已归档"页签、跨页打开记录、关联属性（起止日期/用途）与可点击关联、导出范围、排序/每页条数；档案关联类型从 8 种缩到 2 种。
- 最严重 3：人事侧缺计薪方式/时薪/用工类型、员工"人员记录"（调薪/工资/奖惩/任务/流程/交接）、员工导入导出、岗位 5 类职责分类与 position_key/默认角色；部门删除不转移固定资产；职责组成员缺来源/起止日期，且新系统目前无任何代码使用职责组。

约定：旧 = `$OLD` = `/tmp/claude-0/-home-claude/5f0340df-d2db-5d53-aea9-3dc621c50d0f/scratchpad/dump/source`；新 = `/home/claude/kudesi-oa-next`。新系统资料定义在 `packages/shared/src/resources.ts`，规则在 `apps/api/src/resources/resource-rules.ts`（其中没有固定资产、位置、档案、职责组的任何规则）。

---

## 1. 固定资产 fixed-assets

旧：`$OLD/src/resource-center/schemas/fixed-assets.jsx`（841 行）、`$OLD/server/index.js` 约 8200-8620（transition / inventory / asset-details）。新：`resources.ts` 的 `fixed-assets`（约 815 行）。
旧库 `fixed_assets` 列：asset_no, category_id, name, brand, model, configuration(json), serial_no, purchase_date, purchase_amount(14,2), supplier, warranty_until, user_employee_id, keeper_employee_id, department_id, location_id, status, remark, custom_asset_no, archived_*。

已对齐字段：assetNo(唯一)、customAssetNo、name、categoryId、brand、model、serialNo、purchasedAt、purchasePrice、supplier、warrantyUntil、userId、keeperUserId、departmentId、locationId、note、status 的 idle/in_use/repairing，共 17 个。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 状态流转 checkout 领用(idle→in_use，必填使用人，可带位置) | fixed-assets.jsx ACTIONS_BY_STATE；index.js assetTransitions | 无（仅通用状态下拉） | 缺失 | 高 | 新系统改状态不会同步使用人/位置 |
| transfer 转交(in_use→in_use，必填新使用人) | 同上 | 无 | 缺失 | 高 | |
| return 归还(in_use→idle，清空使用人，可带位置) | 同上 | 无 | 缺失 | 高 | |
| repair 送修(idle/in_use→repairing，必填原因) | 同上 | 通用状态 repairing，不要求原因 | 部分 | 高 | 旧要求原因 |
| repaired 修好(repairing→in_use；无使用人则 idle) | 同上 | 无 | 缺失 | 中 | |
| lost 标记丢失(必填原因) / found 找回(lost→idle，清使用人) | 同上 | lost 改名"遗失"，requiresReason，hidden | 变更 | 中 | 找回动作与清使用人缺失 |
| retire 报废(idle/in_use/repairing/lost→retired，必填原因+二次确认，清使用人) | 同上 | retired requiresReason，hidden；无二次确认、不清使用人 | 部分 | 中 | |
| 状态机约束(retired 终态；已归档资产返回 409) | index.js assetTransitions | 无状态机，任意状态可互切 | 缺失 | 高 | 应写入 resource-rules |
| 资产操作日志 asset_operation_logs(created/updated/status_changed/department_transferred/checkout/transfer/return/repair/repaired/retire/lost/found/inventory_*/archived/restored) | fixed-assets.jsx 日志标签；index.js | 通用日志仅 create/update/status/delete/reveal | 缺失 | 高 | 无"谁领用/何时归还"流转史 |
| 资产详情"流转记录"与 asset-details 接口 | GET /fixed-assets/:id/asset-details | 无 | 缺失 | 高 | |
| 盘点对话框(在位/位置变动/未找到，未找到→状态改丢失，搜索，全部标在位) | fixed-assets.jsx；POST /fixed-assets/inventory | 无 | 缺失 | 高 | 跳过已归档 |
| 纸质盘点表 CSV 导出 | fixed-assets.jsx | 无 | 缺失 | 中 | |
| 折旧 | 全库搜索 | 未找到（旧系统无） | 不适用 | - | 见确认问题 |
| 保修到期提醒 warranty_until 30 天 + "即将到期"页签 | fixed-assets.jsx expiring | `fixed-assets` 无 `alerts` | 缺失 | 中 | 概览页也不提示 |
| 状态页签(全部/闲置/使用中/维修中/已报废/丢失) | schema tabs | 无 tabsBy，仅状态下拉筛选 | 部分 | 低 | |
| 筛选：使用人(含"未分配使用人")、部门、位置(有/无) | schema filters | 仅 filterBy=categoryId | 缺失 | 中 | |
| 创建：填初始使用人则直接 in_use | schema create | 无 | 缺失 | 中 | |
| 自动编号 ASSET-xxxxxx | server/schema | assetNo 唯一，需手填？（未确认是否自动） | 部分 | 中 | 未找到自动生成规则 |
| 复制为新资产(copyOmit：assetNo、customAssetNo、serialNo、initialUserId) | schema copyOmit | 复制仅在 def.batch 时可用，fixed-assets 无 batch | 缺失 | 中 | |
| 默认/可选列(保管人、部门、序列号、购置日期、金额、保修、备注) | schema columns | 通用列选择 | 完整 | - | |
| 导入模板：表头 assetNo, customAssetNo, name, categoryRef, brand, model, serialNo, purchaseDate, purchaseAmount, supplier, warrantyUntil, userRef, keeperRef, departmentRef, locationRef, status, remark；别名映射、导入说明、警告 | schema importer | 通用导入(中文表头、dryRun、整批回滚) | 变更 | 中 | 无别名、无 categoryRef 路径解析、出错整批失败而非逐行警告 |
| 导入前备份保留 5 份并可恢复 | ImportExport | import-backups 保留 5 份+restore | 完整 | - | |
| 规格配置 configuration JSON(按分类 custom_fields，保留额外键) | fixed_assets.configuration | `attrs`(attrsFrom categoryId) + `config` 文本 | 变更 | 低 | 旧额外键保留逻辑需核对 |
| 照片 | 旧无专门字段(备注) | photos(files,image,max 6) | 新增 | - | |
| 采购金额 decimal(14,2) | purchase_amount | purchasePrice 整数分 | 变更 | 低 | 符合 CLAUDE.md |
| "规格参数"区、"储物空间"区(资产自身的存放空间及其中档案) | fixed-assets.jsx sections | 无；locations.fixedAssetId 只能反查 | 缺失 | 中 | |
| 软归档/恢复(archived_at/by/reason/from_status) | archive-service.js | 无 | 缺失 | 中 | 只有状态 retired + 删除 |
| 归档预览关联(使用人、保管人、位置、资产流转记录数) | loadResourceAssociations | 无 | 缺失 | 低 | |
| 部门删除时资产 department_id 转移并写日志 | index.js ~5994 | org 删除部门只转子部门/岗位/员工；`syncLinks` 跳过 department | 缺失 | 高 | 资产会挂在已删部门上 |
| 关联：asset_user / asset_keeper / asset_location | relation-registry | userId/keeperUserId/locationId 为 ref 字段，有关联页 | 完整 | - | |
| 操作权限(领用、盘点等细分) | 旧权限 | 通用 view/create/edit/disable/delete/import/export | 部分 | 低 | |

## 2. 资产分类 asset-categories

旧：`asset_categories`(parent_id, category_key, name, custom_fields json, status, sort_order)；index.js POST/reorder/DELETE；fixed-assets.jsx 分类树管理。新：`resources.ts` asset-categories（nav 隐藏，作为 fixed-assets 的伴随页签）。

已对齐字段：name、parentId、sort、status(NORMAL/INACTIVE)、note，共 5 个。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| custom_fields JSON 列表(每项 key/label/类型等) | asset_categories.custom_fields；"参数"对话框 | `customFields` 单个逗号分隔文本 | 变更 | 中 | 类型/必填/选项丢失，需核对 attrs 是否能表达 |
| category_key | asset_categories.category_key | 无 | 缺失 | 低 | |
| 树内新增/重命名/删除 | fixed-assets.jsx 分类管理 | CategoryTree.tsx 只读筛选；在伴随页签用通用表单管理 | 部分 | 中 | |
| 上移/下移排序(仅同级) | POST reorder | 只有 sort 数字手填 | 缺失 | 低 | |
| 新增自动 sort_order +10 | index.js | 无 | 缺失 | 低 | |
| 删除守卫(有资产或子类则禁止) | index.js DELETE | 通用"被引用则不可删" | 部分 | 低 | 子类校验需核对 |
| 停用 | status | 有 | 完整 | - | |

## 3. 房间与档案位置 locations

旧：`company_locations`(parent_id, name, location_type, code, description, status, location_scope, fixed_asset_id, sort_order)；schemas/locations-archives.jsx；index.js locations 接口。新：`resources.ts` locations（作为 archives 的伴随页签）。

已对齐字段：name、parentId、locationType(7 类：building/floor/room/asset_slot/shelf/drawer/box)、code、description、sort、fixedAssetId、scope(area/asset_space)，共 8 个。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 位置详情"存放内容"：子位置、档案、固定资产、U盾、证照(九个槽位：营业执照/正本/副本/印章/公章/财务章/法人章/发票章/牌匾)、手机号、银行开户档案、宽带 | GET /api/resources/locations/:id | 无 `related`；通用"关联"页签只列字段引用 | 缺失 | 高 | 用户"这个房间里有什么"无法回答 |
| 左侧位置树(区域 + 资产储物空间两组，含后代计数、显示停用) | locations-archives.jsx aside | 无 filterBy，档案页无位置树 | 缺失 | 中 | |
| 删除位置：必填原因，把子位置、档案、资产、U盾、九个证照槽位的引用置空并写日志 | index.js DELETE locations | 通用删除：被非手动关联引用则拒绝 | 变更 | 中 | 行为相反(旧级联清空，新阻止)，需确认 |
| 位置只有为空才可删("位置管理"区) | schema | 无 | 缺失 | 低 | |
| 停用位置必填原因 | PUT status | StatusControl 取决于状态定义 requiresReason | 待核对 | 低 | |
| 位置列表 CSV 导出(路径、范围、资产、类型、编码、状态、档案数、资产数、说明) | locations-archives.jsx | 通用导出，无路径/计数列 | 部分 | 低 | |
| 拖拽/上下移排序 | POST reorder | sort 手填 | 缺失 | 低 | |
| 类型层级校验(shelf/drawer/box 须挂在某类下) | 旧 UI 限定 | 新系统未发现校验 | 未确认 | 低 | |
| location_scope 取值(库中默认 area，UI 另用 archive 表示储物空间) | company_locations.location_scope | scope: area / asset_space | 变更 | 低 | 迁移需映射 archive→asset_space |
| 位置被证照/手机/宽带/U盾引用(各自的位置字段) | relation-registry projection | 取决于对应资料有无位置字段 | 待核对 | 中 | 属其他组 |

## 4. 档案项 archives

旧：`archive_items`；locations-archives.jsx。新：`resources.ts` archives。

已对齐字段：archiveNo(唯一)、name、archiveType、locationId、keeperUserId、note、photos(新增)，共 6 个。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 关联资料类型 related_type：business_license、store、bank_account、fixed_asset、partner_profile、trademark、qualification、tax_profile（8 种）+ related_id | schema RELATED_TYPES；archive-service.js archiveRelatedTypeValues | relatedType 仅 license / store，字段 licenseId/storeId | 部分 | 高 | 银行开户档案、资产合同、合作人协议、商标、资质、税务档案无法挂接 |
| 档案状态：stored 在库、borrowed 借出、missing 遗失、archived 已归档 | schema | stored 已存放、borrowed 借出、missing 缺失、archived 已归档 | 变更 | 低 | 名称改动 |
| 借出/归还/标遗失/找回都必填原因 | statusActions | 均不要求原因 | 缺失 | 低 | |
| 借出人/借出时间/应还时间 | 旧未见专门字段（用原因文本） | 无 | 不适用 | - | |
| 自动编号 ARCH-xxxxxx | schema | archiveNo 唯一，自动生成未确认 | 部分 | 中 | |
| 筛选：档案类型、保管人、存放位置(有/无) | schema filters | 仅状态/默认筛选 | 缺失 | 中 | |
| 左侧位置树筛选 | aside | 无 | 缺失 | 中 | 见 locations |
| 软归档/恢复、归档关联预览 | archive-service.js | 无 | 缺失 | 中 | |
| 关联：archive_location / archive_keeper / archive_related_resource | relation-registry | 部分字段化 | 部分 | 中 | related 只剩 2 类 |
| 导入表头(档案编号、名称、类型、位置、保管人、关联资料等) | schema importer | 通用导入 | 变更 | 低 | |

## 5. 职责组 duty-groups / duty-group-items / duty-group-members

旧：`responsibility_groups`(group_key, name, description, scope company/department, status)、`responsibility_group_items`(title, description, related_module, frequency, sort_order, status)、`employee_responsibility_groups`(employee_id, group_id, source, status, started_at, ended_at)；schemas/responsibility-groups.jsx；index.js 6329-6560。新：三个资料。

已对齐字段：groupKey、name、scope、description；item 的 title、description、module、frequency、sortOrder；member 的 groupId、userId，共 11 个。新增：group.leaderUserId、member.role。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 成员 source(来源：手动/岗位自动等)、started_at、ended_at、status | employee_responsibility_groups | 无；移除成员=删除记录 | 缺失 | 低 | 历史成员不可追溯 |
| 移出成员写日志(member_removed，含原因) | index.js ~6424 | 通用删除日志 | 部分 | 低 | |
| 明细 status(启用/停用，停用需原因) | items.status | 新 items 无状态 | 缺失 | 低 | |
| group_key 创建后不可改、公司内唯一 | schema | groupKey 有；不可改未确认 | 部分 | 低 | |
| 页签"没有成员" | schema | 无 | 缺失 | 低 | |
| 职责组停用必填原因 | schema | 取决于状态定义 | 待核对 | 低 | |
| 员工页职责组区块(加入/退出)与"职责组"筛选 | employees.jsx | StaffPage 无 | 缺失 | 中 | |
| 员工 CSV 导入列"职责组" | employees.jsx 导入 | 无 | 缺失 | 低 | |
| 流程/派单按职责组取人 | 旧 index.js 仅列表与组织数据使用，未发现派单引用 | 新 api 全仓 grep 无引用职责组 | 同旧（未使用） | 中 | 见确认问题 |
| 迁移 | runner.ts | 职责组、成员未迁移 | 缺失 | 中 | |

## 6. 员工档案（旧 EmployeesPage → 新 org/StaffPage）

旧：schemas/employees.jsx（605 行）；`employees` 列含 employment_type, pay_type, hourly_rate, base_salary, manager_id, role_key, title, last_login_at。新：`apps/api/src/org/org-admin.*`、`apps/web/src/pages/org/StaffPage.tsx`。

已对齐字段：account、name、departmentId、positionId、managerId、title、baseSalary(需 org.staff.salary 权限)、状态、最近登录、重置密码、停用交接预览，共 11 个；新增 extraPositionIds、权限覆盖 allow/deny、isCompanyAdmin。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| pay_type 计薪方式(monthly/hourly) | employees.pay_type | 无 | 缺失 | 高 | |
| hourly_rate 时薪 | employees.hourly_rate | 无 | 缺失 | 高 | 兼职/小时工无法计薪（需与财务/人力组核对） |
| employment_type 用工类型 | employees.employment_type | 无 | 缺失 | 中 | 兼职另页，不在本组 |
| role_key / 角色 | employees.role_key；schema roleId | 以岗位+权限覆盖+isCompanyAdmin 取代 | 变更 | 中 | 无"角色"筛选 |
| 初始密码默认 123456 | schema | 有意取消(无默认密码) | 变更 | - | 符合 CLAUDE.md |
| 页签：在职 / 没有登录账号 / 没有岗位 | schema tabs | 无 | 缺失 | 低 | |
| 筛选：部门、角色、职责组 | schema filters | 以部门树筛选为主 | 部分 | 中 | |
| "人员记录"区：hrLogs、salaryChanges、payrollRecords、rewardRecords、penaltyRecords、tasks、flows、handovers | employees.jsx sections | 无员工详情页；仅交接预览 | 缺失 | 高 | 薪资历史、奖惩记录不可见 |
| 人员变动交接(预览+手动交接) | schema | handover preview 有 | 部分 | 中 | 手动交接需核对 |
| 停用必填原因并自动交接 | schema | status+handover 有 | 完整 | - | |
| CSV 导入导出(姓名、登录账号、初始密码、部门、岗位名称、直属上级、计薪方式、月薪、时薪、状态、停用原因、角色、职责组)+导入备份 | employees.jsx | 无员工导入/导出 | 缺失 | 中 | 迁移由 runner.ts 完成但日常批量录入没有 |
| 员工薪酬记录 employee_compensation_records | 旧库表 | 未迁移，无对应 | 缺失 | 高 | |
| 位置/资产随人员联动(其名下资产) | 旧资产 user_employee_id | 停用员工时是否提示名下资产 | 未确认 | 中 | |

## 7. 岗位档案（旧 PositionProfilesPage → 新 org/PositionProfilesPage）

已对齐字段：name、level、workspaceType（9 值：boss/general/operations/finance/cashier/warehouse/purchasing/support/blank）、supervisorPositionId、status+原因、description、在岗人员、岗位权限、日志，共 9 个。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 职责分类 10 类（主 5：岗位职责/入职培训/绩效考核/监督规则/流程节点说明；另 5：日常工作/周期工作/审批职责/资料维护/其他） | position-profiles.jsx | `DUTY_CATEGORIES` 仅 5 类 | 部分 | 高 | 需核对新 5 类是否等于旧主 5 类，另 5 类丢失 |
| 职责字段 title, description, frequency, related_module, completion_standard, is_key_duty, status(停用原因) | position_duties | 需核对；未见 completion_standard / is_key_duty | 部分 | 中 | |
| position_key(部门内唯一) | positions.position_key | 无 | 缺失 | 中 | |
| 默认角色 | positions.default_role | 无（由权限矩阵取代） | 变更 | 低 | |
| workspace_template_key 29 套模板 | positions | workspaceType 9 值 | 变更 | 中 | 29→9，需确认模板映射(CLAUDE.md 要求显式字段，方向对) |
| 页签：无人在岗 / 没有职责 | schema tabs | 无 | 缺失 | 低 | |
| 筛选：部门、层级 | schema | 部分 | 部分 | 低 | |
| 列：条目数、默认角色 | schema | 无 | 缺失 | 低 | |
| 批量删除岗位；有人或有职责时禁止删除 | schema | deletePosition 单个 | 部分 | 低 | |
| 迁移 | runner.ts | 只迁 name, level, workspaceType, description, status；职责、position_key、默认角色未迁 | 缺失 | 高 | |

## 8. 组织树（旧 OrgTreePage → 新 org/StructurePage）

旧：pages/OrgTreePage.jsx（764 行）。

已对齐字段：部门 name、parentId、sortOrder、停用原因、删除时转移子部门/岗位/员工，共 6 个。

| 旧字段/功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 部门档案页：人数、部门主管、岗位表、人员表(角色/上级/职责组)、子部门 | OrgTreePage | 无部门档案 | 缺失 | 中 | |
| 部门主管识别(按层级或名称正则) | 旧 | 无；且 CLAUDE.md 禁止名称正则 | 变更 | 低 | 建议显式字段 |
| "管理架构"多列拖拽(排序、移动 PUT /organization/departments/reorder) | OrgTreePage | 仅改 parentId/sortOrder | 缺失 | 中 | |
| 搜索(部门+人员)、全部展开/收起 | OrgTreePage | 无 | 缺失 | 低 | |
| 多公司树 | OrgTreePage | 单公司 | 变更 | 低 | 租户隔离方向 |
| 删除部门转移：岗位、员工、固定资产 | OrgTreePage；index.js ~5994 | 缺固定资产 | 部分 | 高 | |
| 离职员工系统部门(隐藏) | index.js | 无 | 缺失 | 中 | 停用员工的归属 |
| 停用/启用部门必填原因 | OrgTreePage | 有 | 完整 | - | |
| 部门内直接新增岗位 | OrgTreePage | 无 | 缺失 | 低 | |
| "派单兜底"说明 | OrgTreePage | 无 | 缺失 | 低 | 取决于派单是否保留 |

## 9. 资料中心通用能力

旧：`$OLD/src/resource-center/*`、`$OLD/server/modules/resources/*`。新：`apps/api/src/resources/*`、`apps/web/src/resources/*`。

已对齐能力：字段类型渲染(含 attrs)、搜索、页签、列选择(localStorage)、批量启停、导入 dryRun+备份保留 5 份+恢复、导出 CSV、加密字段查看（需专门权限+审计，15 秒自动隐藏）、操作日志、关联列表（含手动关联）、状态原因必填、删除原因、分类树筛选、伴随页签，共 14 项。

| 旧功能 | 旧系统位置 | 新系统对应 | 状态 | 严重度 | 备注/建议 |
|---|---|---|---|---|---|
| 软归档/恢复(archived_at/by/reason/from_status，状态映射 archivedStatus，恢复到 archived_from_status) | archive-service.js；resource-catalog.js archivableResources（16 类） | 无；只有删除 | 缺失 | 高 | 违背旧"归档不删除"原则，历史关联丢失 |
| 归档前关联预览(分组计数+业务记录：售后、销售快照、登录态、流程、领退店等) | loadResourceAssociations；Dossier ArchivePreview | 无 | 缺失 | 中 | |
| "已归档""已停用""即将到期"内置页签 | ResourceWorkbench builtInTabs | 无 expiring/archived；停用靠"显示隐藏" | 缺失 | 高 | |
| 即将到期统一列表 `/api/resources/expiring`(营业期限、年报 MM-DD 年周期、资质、商标、软件续费、账号服务、手机充值、聚水潭授权、授权商标、银行对账日；INACTIVE 排除) | expiring.js | 仅概览 `alerts`（resources.ts 约 8 处，固定资产/档案无） | 部分 | 高 | 无年度循环日期(annual)、无对账日 reconciliation 规则 |
| 单资料"到期徽标"(KeyFacts) | Dossier | 无 | 缺失 | 低 | |
| 数据问题检查(资料总览)：关联与字段不一致 13 类原因、手机号未建档、店铺商标、执照银行等 | data-issues.js | 无 | 缺失 | 中 | |
| 数据对齐 link-alignment(plan→token→apply) | link-alignment*.js | 无 | 缺失 | 中 | 重写后以单一事实源，需求弱，建议确认 |
| derived-facts：由关联派生文本事实(手机号、店铺商标、执照银行) | derived-facts.js | 无 | 缺失 | 中 | |
| 关联分三种：link(中间表)/projection(字段)/derived(只读派生)，31 条 projectionSpecs，54 个关系标签 | relation-registry.js；resource-catalog.js | 关联页平铺，无存储类型区分，无派生 | 部分 | 中 | |
| 关联属性 valid_from / valid_to / purpose | relation-registry LINK_ATTRIBUTE_COLUMNS；RelationsPanel | 手动关联无属性 | 缺失 | 中 | |
| 关联可点击跳转目标资料；跨页打开记录 intent / navigation-targets | intent.js、navigation-targets.js、RelationsPanel | 关联行不可点击 | 缺失 | 中 | |
| 详情栈与面包屑(最多 5 层)，未保存离开守卫，宽屏模式 | ResourceWorkbench/Dossier | 无 | 缺失 | 低 | |
| 分区编辑(每个区块单独编辑保存) | Dossier | 整体表单 | 变更 | 低 | |
| 多字段排序、手机排序 | ResourceWorkbench | 无排序 | 缺失 | 中 | |
| 每页条数 20/50/100 | ResourceWorkbench | 固定 20 | 缺失 | 低 | |
| 筛选条件按用户持久化 | ResourceWorkbench | 仅列选择持久化 | 部分 | 低 | |
| 搜索覆盖全部文本字段 | ResourceWorkbench | 需核对 | 待核对 | 低 | |
| 导出范围：当前筛选/所选/全部；"导出所选" | ResourceWorkbench Export dialog | 全量 CSV | 缺失 | 中 | |
| 导入：别名映射、导入说明、逐行警告、局部成功 | ImportExport.jsx | 全或无 | 部分 | 中 | |
| 导入/导出不含 attrs、文件、加密字段 | - | 导入不支持 attrs/files/secret | 部分 | 中 | |
| 复制为新记录 copyOmit | Dossier | 仅 def.batch | 部分 | 中 | |
| SecretField：查看后 30 秒自动隐藏、复制按钮、错误友好提示 | SecretField.jsx | 15 秒自动隐藏，无复制按钮 | 部分 | 低 | |
| MaskedNumber：卡号尾号脱敏+点击显示+一键复制 | MaskedNumber.jsx | 无（CLAUDE.md 规定资料页不脱敏） | 变更 | 低 | 有意 |
| MediaSection：证件图单张上传/更换/删除/预览，MAX_BYTES | MediaSection.jsx | files 字段 | 变更 | 低 | 核对大小上限 |
| LogList：中文动作 20 种(含 relation_linked/unlinked/updated、derived_synced、fact_aligned、imported、import_restored、secret_viewed、archived、restored)，分页 15 条 | LogList.jsx | 动作 create/update/status/delete/reveal | 部分 | 中 | 关联变更是否写日志需核对 |
| 日志 company_id、before/after JSON | change-log.js | 通用日志 | 完整 | - | |
| LedgerTable 台账表：分组、合计 | LedgerTable.jsx | 通用列表 | 待核对 | 低 | 未逐行比较 |
| lookups：下拉引用远程检索 | lookups.js | RecordForm ref 字段 | 完整 | - | |
| 领退店分配 store-operator-assignments | store-operator-assignments.js | 属店铺组 | 不在本组 | - | |

---

## 需要用户确认的问题

1. 旧系统固定资产没有"折旧"功能（全库未找到），是否需要新增？还是只指领用/维修/报废？
2. 固定资产状态流转（领用/转交/归还/送修/修好/丢失/找回/报废）和盘点，是否要原样恢复？新流程引擎是否要承接"领用审批"？
3. "丢失"改为"遗失"、档案"遗失/缺失"、"在库/已存放"等改名是有意的吗？迁移需要状态映射。
4. 位置删除：旧系统是"原因+把引用置空"，新系统是"被引用则拒绝"。保留哪种？
5. 档案关联资料类型是否恢复全部 8 种，还是只保留证照/店铺（现状）？
6. 职责组：旧系统里职责组只做展示和组织数据，没有发现派单引用；新系统也没有任何代码使用。是仍要保留为纯展示，还是接入流程引擎的"按职责组取人"？
7. 软归档（archived_at、原因、恢复）是否需要恢复？新系统目前只有删除，会丢失关联历史。
8. 即将到期：营业执照年报(MM-DD 年度循环)、银行对账日、聚水潭授权、固定资产保修，是否都需要在概览中提示？
9. 员工的计薪方式、时薪、用工类型、薪酬记录，是由人力/财务组的新资料承接，还是在员工档案里恢复？
10. 岗位职责分类 10→5，另 5 类（日常工作/周期工作/审批职责/资料维护/其他）是否合并而不是丢弃？workspace 模板 29→9 的映射是否已确认？
11. 部门主管：旧系统按层级或名称正则识别，新系统是否要增加显式"部门主管"字段？
12. 部门删除时固定资产的 department_id 应如何处理（跟随转移）？
13. 数据问题检查、数据对齐、派生事实这三项旧"治理"功能，在新系统"单一事实源"后是否已无必要？
14. 当前新系统是否有自动编号 ASSET-/ARCH-？本次只在资源定义里未找到生成规则，需开发确认。

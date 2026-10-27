import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import {
  FLOW_TEMPLATES, ASSIGNEE_RUNTIME_ONLY, RELATED_OWNER_KINDS, POSITION_TYPE_LABEL, createChecker, evalCondition, validateCustomTemplate, validateResourceInput, validateSteps,
  type CustomSchema, type FlowAction, type FlowTemplate, type StepDef,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Department, FlowCc, FlowDefinition, FlowEvent, FlowRun, FlowStep, FlowTemplateRow, Notification, Position, ResourceRecord, User, WorkItem } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { ResourcesService } from '../resources/resources.service';
import { OutboxService } from '../outbox/outbox.service';
import { FeishuNoticeService } from '../outbox/feishu-notice.service';
import { StepContext, postDeclared } from './flow-adapters';
import { adapterFor, customFrom, loadTemplate } from './flow-templates';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

type Def = { steps: StepDef[]; escalateUserIds: number[] };

/** 把模板的字段包成一个“资料定义”，复用资料的字段校验（必填、日期、金额整数分、选项……） */
const pseudoDef = (key: string, fields: FlowTemplate['fields']) =>
  ({ key: `flow:${key}`, label: key, titleField: fields[0]?.key ?? 'id', statuses: [], defaultStatus: '', fields }) as never;

/**
 * 统一流程引擎。
 * 规则（沿用旧系统，已确认保留）：
 *  - 办理人在“进入步骤”时按当时的配置解析：员工/岗位必须恰好 1 名在职员工，部门共享，不兜底给管理员或发起人
 *  - 办理资格 = 这一步有你的未完成待办；管理员身份不自动等于办理人（防止代办）
 *  - 所有写操作锁住流程行、核对版本号和当前步骤，业务动作和流转在同一个事务里
 *  - 解析不到下一步办理人时，当前步骤的办理失败、什么都不改，提示去流程配置修好
 */
@Injectable()
export class FlowService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly resources: ResourcesService,
    private readonly docs: FinanceDocumentsService,
    @Optional() private readonly bundles?: BundleToolsService,
    @Optional() private readonly outbox?: OutboxService,
    @Optional() private readonly feishu?: FeishuNoticeService,
  ) {}
  private readonly log = new Logger('Flow');

  private can(user: AuthUser, key: string) { return createChecker(user.permissions)(key); }
  private need(user: AuthUser, key: string, msg: string) { if (!this.can(user, key)) throw new ForbiddenException(msg); }
  /** 解析模板（内置或自建）；在办流程传 run 以使用启动时的版本 */
  private tpl(em: EntityManager, companyId: number, key: string, definitionId?: number | null) { return loadTemplate(em, companyId, key, definitionId); }
  private runTpl(em: EntityManager, run: FlowRun) { return loadTemplate(em, run.companyId, run.templateKey, run.definitionId); }
  private svc() { return { resources: this.resources, docs: this.docs, bundles: this.bundles, outbox: this.outbox }; }

  // ================= 流程定义 =================

  private toDef(row: FlowDefinition) {
    return { id: row.id, version: row.version, status: row.status, steps: row.steps as StepDef[], escalateUserIds: row.escalateUserIds, publishedAt: row.publishedAt, createdAt: row.createdAt };
  }

  /** 模板列表：每个模板当前启用的版本和是否能发起 */
  async templates(user: AuthUser) {
    const em = this.dataSource.manager;
    const defs = await em.find(FlowDefinition, { where: { companyId: user.companyId, status: 'active' } });
    const builtin = FLOW_TEMPLATES.map((t) => {
      const active = defs.find((d) => d.templateKey === t.key);
      return { key: t.key, label: t.label, description: t.description, entry: t.entry ?? null, fields: t.fields, stepFields: t.stepFields, active: Boolean(active), version: active?.version ?? null, custom: false, steps: ((active?.steps ?? t.steps) as StepDef[]).map((s) => ({ name: s.name, type: s.type })) };
    });
    // 自建模板：只有启用中的才出现在申请中心
    const rows = await em.find(FlowTemplateRow, { where: { companyId: user.companyId }, order: { id: 'ASC' } });
    const custom = rows.flatMap((r) => {
      const active = defs.find((d) => d.templateKey === r.templateKey);
      if (!active) return [];
      const t = customFrom(r, active);
      return [{ key: t.key, label: t.label, description: t.description, entry: null, fields: t.fields, stepFields: t.stepFields, active: true, version: active.version, custom: true, steps: (active.steps as StepDef[]).map((x) => ({ name: x.name, type: x.type })) }];
    });
    return [...builtin, ...custom];
  }

  async definition(user: AuthUser, key: string) {
    const row = FLOW_TEMPLATES.some((x) => x.key === key) ? null : await this.dataSource.manager.findOne(FlowTemplateRow, { where: { companyId: user.companyId, templateKey: key } });
    const t = await this.tpl(this.dataSource.manager, user.companyId, key);
    const rows = await this.dataSource.manager.find(FlowDefinition, { where: { companyId: user.companyId, templateKey: key }, order: { version: 'DESC' } });
    const active = rows.find((r) => r.status === 'active');
    const draft = rows.find((r) => r.status === 'draft');
    const names = await this.userNames(this.dataSource.manager, user.companyId, [...(draft ?? active)?.steps.flatMap((s) => (s as StepDef).ccUserIds ?? []) ?? [], ...(draft ?? active)?.escalateUserIds ?? []]);
    const base = draft ?? active ?? rows[0] ?? null;
    const schemaOf = (d: FlowDefinition | null) => (t.custom ? { fields: ((d?.schemaJson as Partial<CustomSchema> | null)?.fields ?? t.fields), stepFields: (d?.schemaJson as Partial<CustomSchema> | null)?.stepFields ?? t.stepFields, posting: (d?.schemaJson as Partial<CustomSchema> | null)?.posting ?? null } : null);
    return {
      template: { key: t.key, label: t.label, description: t.description, steps: t.custom ? [] : t.steps, custom: !!t.custom, departmentId: row?.departmentId ?? null, fields: t.fields, stepFields: t.stepFields, posting: t.posting ?? null },
      active: active ? { ...this.toDef(active), schema: schemaOf(active) } : null,
      // 没有草稿时给一份“默认草稿”（不入库），保存后才成为真正的草稿
      draft: draft ? { ...this.toDef(draft), schema: schemaOf(draft) } : { id: null, version: (rows[0]?.version ?? 0) + 1, status: 'draft' as const, steps: (active?.steps as StepDef[]) ?? (t.custom ? ((base?.steps as StepDef[]) ?? []) : [...t.steps]), escalateUserIds: active?.escalateUserIds ?? [], publishedAt: null, createdAt: null, schema: schemaOf(active ?? base) },
      history: rows.map((r) => ({ version: r.version, status: r.status, publishedAt: r.publishedAt, stepCount: (r.steps as StepDef[]).length })),
      names: Object.fromEntries(names),
    };
  }

  /** 把管理员提交的步骤整理成要保存的样子（只留认识的字段） */
  private cleanSteps(t: FlowTemplate, steps: StepDef[]): StepDef[] {
    return steps.map((s) => {
      const out: StepDef = { key: s.key, name: s.name.trim(), type: s.type, assignee: s.assignee, dueMinutes: s.dueMinutes ?? null, ccUserIds: s.ccUserIds ?? [] };
      if (!t.custom && t.steps.some((x) => x.key === s.key && x.locked)) out.locked = true;
      if (s.when) out.when = { field: s.when.field, op: s.when.op, ...(s.when.value !== undefined ? { value: s.when.value } : {}) };
      if (s.returnToKey) out.returnToKey = s.returnToKey;
      if (s.mode === 'all') out.mode = 'all';
      if (s.remind && (s.remind.beforeMinutes.length > 0 || s.remind.overdueEveryMinutes)) out.remind = { beforeMinutes: [...s.remind.beforeMinutes].sort((x, y) => y - x), overdueEveryMinutes: s.remind.overdueEveryMinutes ?? null };
      if (s.hiddenFields?.length) out.hiddenFields = [...new Set(s.hiddenFields)];
      if (s.nodeTemplateKey) out.nodeTemplateKey = s.nodeTemplateKey;
      if (s.parallel) out.parallel = s.parallel;
      if (s.exceptionToKey) out.exceptionToKey = s.exceptionToKey;
      if (s.onlyOnException) out.onlyOnException = true;
      if (out.assignee) out.assignee = { source: out.assignee.source, ...(out.assignee.id !== undefined ? { id: out.assignee.id } : {}), ...(out.assignee.key ? { key: out.assignee.key } : {}), ...(out.assignee.field ? { field: out.assignee.field } : {}) };
      return out;
    });
  }

  async saveDraft(user: AuthUser, key: string, steps: StepDef[], escalateUserIds: number[], schema?: CustomSchema | null) {
    this.need(user, 'flow.templates.manage', '没有配置流程的权限');
    const em0 = this.dataSource.manager;
    const t = await this.tpl(em0, user.companyId, key);
    const check = t.custom ? { ...t, fields: schema?.fields ?? t.fields, stepFields: schema?.stepFields ?? t.stepFields, posting: schema ? (schema.posting ?? undefined) : t.posting } : t;
    const errors = t.custom ? validateCustomTemplate(check, steps, escalateUserIds) : validateSteps(t, steps, escalateUserIds);
    if (errors.length) throw new BadRequestException(errors.join('；'));
    await this.checkUsersExist(em0, user.companyId, [...steps.flatMap((s) => s.ccUserIds ?? []), ...escalateUserIds, ...steps.flatMap((s) => (s.assignee?.source === 'employee' && s.assignee.id ? [s.assignee.id] : []))]);
    const clean = this.cleanSteps(t, steps);
    const schemaJson = t.custom && schema ? { fields: schema.fields, stepFields: schema.stepFields, posting: schema.posting ?? null } : undefined;
    return this.dataSource.transaction(async (em) => {
      const rows = await em.find(FlowDefinition, { where: { companyId: user.companyId, templateKey: key }, order: { version: 'DESC' }, lock: { mode: 'pessimistic_write' } });
      const draft = rows.find((r) => r.status === 'draft');
      if (draft) {
        draft.steps = clean;
        draft.escalateUserIds = escalateUserIds;
        if (schemaJson) draft.schemaJson = schemaJson;
        await em.save(FlowDefinition, draft);
      } else {
        const inherit = rows.find((r) => r.status === 'active') ?? rows[0];
        await em.insert(FlowDefinition, { companyId: user.companyId, templateKey: key, version: (rows[0]?.version ?? 0) + 1, status: 'draft', steps: clean, escalateUserIds, createdBy: user.id, schemaJson: (schemaJson ?? (t.custom ? inherit?.schemaJson : null) ?? null) } as never);
      }
      return { ok: true };
    });
  }

  /** 发布：每一步的办理人现在都要能解析到人，否则不让发布（和旧系统一致） */
  async publish(user: AuthUser, key: string) {
    this.need(user, 'flow.templates.manage', '没有配置流程的权限');
    return this.dataSource.transaction(async (em) => {
      const rows = await em.find(FlowDefinition, { where: { companyId: user.companyId, templateKey: key }, order: { version: 'DESC' }, lock: { mode: 'pessimistic_write' } });
      const draft = rows.find((r) => r.status === 'draft');
      if (!draft) throw new BadRequestException('没有可发布的草稿，请先保存配置');
      const steps = draft.steps as StepDef[];
      const builtin = await this.tpl(em, user.companyId, key, draft.id);
      const t = builtin.custom ? customFrom((await em.findOne(FlowTemplateRow, { where: { companyId: user.companyId, templateKey: key } }))!, draft) : builtin;
      const errors = t.custom ? validateCustomTemplate(t, steps, draft.escalateUserIds) : validateSteps(t, steps, draft.escalateUserIds);
      if (errors.length) throw new BadRequestException(errors.join('；'));
      for (const s of steps.filter((x) => x.type !== 'submit' && x.type !== 'end' && !ASSIGNEE_RUNTIME_ONLY.includes(x.assignee?.source ?? 'employee'))) await this.resolveRecipients(em, user.companyId, s, user.id); // 失败会抛出带步骤名的提示
      for (const r of rows.filter((x) => x.status === 'active')) { r.status = 'retired'; await em.save(FlowDefinition, r); }
      draft.status = 'active';
      draft.publishedAt = new Date();
      await em.save(FlowDefinition, draft);
      return { ok: true, version: draft.version };
    });
  }

  private async checkUsersExist(em: EntityManager, companyId: number, ids: number[]) {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return;
    const found = await em.find(User, { where: { companyId, id: In(uniq), status: 'active' }, select: ['id'] });
    if (found.length !== uniq.length) throw new BadRequestException('抄送/升级/办理人里有人不存在或已停用');
  }

  // ================= 办理人解析 =================

  async resolveRecipients(em: EntityManager, companyId: number, step: StepDef, requesterId: number, previousHandlerId?: number | null, payload?: Record<string, unknown>): Promise<number[]> {
    const a = step.assignee;
    if (!a) throw new BadRequestException(`步骤「${step.name}」没有指定办理人，请管理员在流程配置里设置`);
    if (a.source === 'requester') {
      const u = await em.findOne(User, { where: { id: requesterId, companyId, status: 'active' } });
      if (!u) throw new BadRequestException('发起人已停用');
      return [u.id];
    }
    if (a.source === 'requester_manager') {
      const me = await em.findOne(User, { where: { id: requesterId, companyId } });
      let mid = me?.managerId ?? null;
      if (!mid && me?.departmentId) mid = (await em.findOne(Department, { where: { id: me.departmentId, companyId } }))?.managerId ?? null;
      if (mid === requesterId) mid = null;
      const m = mid ? await em.findOne(User, { where: { id: mid, companyId, status: 'active' } }) : null;
      if (!m) throw new BadRequestException(`步骤「${step.name}」要找发起人的上级，但发起人没有设置上级或部门主管（或已停用），请先到员工资料里设置`);
      return [m.id];
    }
    if (a.source === 'previous_handler') {
      const u = previousHandlerId ? await em.findOne(User, { where: { id: previousHandlerId, companyId, status: 'active' } }) : null;
      if (!u) throw new BadRequestException(`步骤「${step.name}」要找上一步办理人，但找不到在职的办理人`);
      return [u.id];
    }
    const exactlyOne = (users: number[], what: string) => {
      if (users.length !== 1) throw new BadRequestException(`步骤「${step.name}」${what}现在匹配到 ${users.length} 名在职员工，必须恰好 1 名；请管理员在流程配置里改成指定员工，或调整人员`);
      return users;
    };
    if (a.source === 'position_type') {
      const poss = (await em.find(Position, { where: { companyId, status: 'active' }, select: ['id', 'workspaceType'] })).filter((x) => x.workspaceType === a.key).map((x) => x.id);
      const users = (await em.find(User, { where: { companyId, status: 'active' }, select: ['id', 'positionId', 'extraPositionIds'] })).filter((x) => (x.positionId != null && poss.includes(x.positionId)) || (x.extraPositionIds ?? []).some((i) => poss.includes(i)));
      return exactlyOne(users.map((x) => x.id), `岗位类型“${POSITION_TYPE_LABEL[a.key ?? ''] ?? a.key}”`);
    }
    if (a.source === 'duty_group') {
      const group = a.id ? await em.findOne(ResourceRecord, { where: { id: a.id, companyId, type: 'duty-groups' } }) : null;
      if (!group || group.status === 'inactive') throw new BadRequestException(`步骤「${step.name}」指定的职责组不存在或已停用`);
      const rows = (await em.query("SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.userId')) AS uid FROM resource_records WHERE company_id = ? AND type = 'duty-group-members' AND status = 'normal' AND JSON_EXTRACT(data,'$.groupId') = ?", [companyId, group.id])) as Array<{ uid: string | null }>;
      const ids = [...new Set(rows.map((r) => Number(r.uid)).filter((n) => Number.isInteger(n) && n > 0))];
      const users = ids.length ? await em.find(User, { where: { companyId, status: 'active', id: In(ids) }, select: ['id'] }) : [];
      return exactlyOne(users.map((x) => x.id), `职责组“${group.title}”`);
    }
    if (a.source === 'related_owner') {
      const kind = a.key ? RELATED_OWNER_KINDS[a.key] : undefined;
      const rid = a.field ? payload?.[a.field] : undefined;
      if (!kind || typeof rid !== 'number') throw new BadRequestException(`步骤「${step.name}」要按关联资料找负责人，但申请里没有选择${kind?.label.replace('关联', '').replace('负责人', '') ?? '关联资料'}`);
      const rec = await em.findOne(ResourceRecord, { where: { id: rid, companyId, type: kind.type } });
      const uid = rec?.data?.[kind.userField];
      const u = typeof uid === 'number' ? await em.findOne(User, { where: { id: uid, companyId, status: 'active' } }) : null;
      if (!u) throw new BadRequestException(`步骤「${step.name}」要找${kind.label}，但“${rec?.title ?? '该资料'}”上没有设置在职的负责员工，请先到资料里设置`);
      return [u.id];
    }
    if (!a.id) throw new BadRequestException(`步骤「${step.name}」没有选择具体的办理人`);
    if (a.source === 'employee') {
      const u = await em.findOne(User, { where: { id: a.id, companyId, status: 'active' } });
      if (!u) throw new BadRequestException(`步骤「${step.name}」指定的员工已停用或不存在，请管理员在流程配置里改一下`);
      return [u.id];
    }
    if (a.source === 'position') {
      const users = (await em.find(User, { where: { companyId, status: 'active' }, select: ['id', 'positionId', 'extraPositionIds'] })).filter((x) => x.positionId === (a.id as number) || (x.extraPositionIds ?? []).includes(a.id as number));
      if (users.length !== 1) throw new BadRequestException(`步骤「${step.name}」指定的岗位现在有 ${users.length} 名在职员工，必须恰好 1 名；请管理员在流程配置里改成指定员工，或调整岗位人员`);
      return [users[0].id];
    }
    const users = await em.find(User, { where: { companyId, departmentId: a.id, status: 'active' }, select: ['id'] });
    if (users.length === 0) throw new BadRequestException(`步骤「${step.name}」指定的部门里没有在职员工`);
    return users.map((u) => u.id);
  }

  // ================= 通用小工具 =================

  private async userNames(em: EntityManager, companyId: number, ids: number[]) {
    const uniq = [...new Set(ids.filter((x) => Number.isInteger(x)))];
    if (!uniq.length) return new Map<number, string>();
    const rows = await em.find(User, { where: { companyId, id: In(uniq) }, select: ['id', 'name'] });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async notify(em: EntityManager, companyId: number, userIds: number[], n: { kind: string; title: string; body?: string; link?: string }, run?: FlowRun) {
    for (const uid of [...new Set(userIds)]) {
      await em.insert(Notification, { companyId, userId: uid, kind: n.kind, title: n.title.slice(0, 200), body: n.body?.slice(0, 500) ?? null, link: n.link ?? null });
      // 飞书通知（出站队列，独立开关默认关；只有 SKU 批量申请会发）：和站内通知同一个事务入队，幂等键带步骤编号
      if (run && this.feishu) await this.feishu.enqueue(em, companyId, run.templateKey, `${run.id}:${n.kind}:${run.currentStepKey ?? ''}:${run.revision}`, { userId: uid, title: n.title, body: n.body, link: n.link, runId: run.id });
    }
  }

  private async event(em: EntityManager, run: FlowRun, actorId: number, action: string, stepId: number | null, note?: string | null) {
    await em.insert(FlowEvent, { companyId: run.companyId, runId: run.id, stepId, actorId, action, note: note?.slice(0, 500) ?? null });
  }

  private async lockRun(em: EntityManager, user: AuthUser, id: number, revision?: number) {
    const run = await em.findOne(FlowRun, { where: { id, companyId: user.companyId }, lock: { mode: 'pessimistic_write' } });
    if (!run) throw new NotFoundException('流程不存在');
    if (revision !== undefined && run.revision !== revision) throw new ConflictException('这张单已经被别人处理过了，请刷新后再看');
    return run;
  }

  /** 进行中的步骤；并行分支时有多个，传 stepId 指定要办的那个 */
  private async activeStep(em: EntityManager, run: FlowRun, stepId?: number) {
    if (stepId !== undefined) {
      const one = await em.findOne(FlowStep, { where: { id: stepId, runId: run.id, status: 'active' } });
      if (!one) throw new ConflictException('这一步已经被处理过了，请刷新后再看');
      return one;
    }
    const step = await em.findOne(FlowStep, { where: { runId: run.id, status: 'active' }, order: { seq: 'DESC' } });
    if (!step) throw new ConflictException('这条流程已经没有进行中的步骤');
    return step;
  }

  /** 步骤所在的并行分支范围（没有并行返回 null） */
  private groupRange(steps: StepDef[], idx: number): { start: number; end: number } | null {
    const g = steps[idx]?.parallel;
    if (!g) return null;
    let start = idx, end = idx;
    while (start > 0 && steps[start - 1].parallel === g) start -= 1;
    while (end < steps.length - 1 && steps[end + 1].parallel === g) end += 1;
    return { start, end };
  }

  /** 并行分支里别的还在办的步骤一起作废（退回、结束时用） */
  private async cancelActive(em: EntityManager, run: FlowRun, exceptStepId?: number) {
    const rest = await em.find(FlowStep, { where: { runId: run.id, status: 'active' } });
    for (const x of rest.filter((r) => r.id !== exceptStepId)) {
      x.status = 'cancelled';
      x.comment = '流程已转向别处，这一步作废';
      x.finishedAt = new Date();
      await em.save(FlowStep, x);
      await em.update(WorkItem, { stepId: x.id, status: 'open' }, { status: 'cancelled', finishedAt: new Date() });
    }
  }

  private stepCtx(em: EntityManager, user: AuthUser, run: FlowRun, step: FlowStep, form: Record<string, unknown>): StepContext {
    return { em, user, run, payload: run.payload, stepKey: step.stepKey, form, ...this.svc() };
  }

  private async myOpenItem(em: EntityManager, user: AuthUser, step: FlowStep) {
    return em.findOne(WorkItem, { where: { companyId: user.companyId, stepId: step.id, assigneeId: user.id, status: 'open' } });
  }

  // ================= 发起 =================

  async start(user: AuthUser, templateKey: string, payloadIn: Record<string, unknown>, requestKey?: string, opts: { internal?: boolean } = {}) {
    if (!opts.internal) {
      // 有专门业务页面的流程（售后、申诉）：权限由业务模块自己判断，申请中心/接口不能绕过业务页面直接发起
      const t0 = await this.tpl(this.dataSource.manager, user.companyId, templateKey);
      if (t0.entry) throw new BadRequestException(`这条流程要${t0.entry.label}`);
      this.need(user, 'flow.apply.view', '没有发起流程的权限');
    }
    if (requestKey !== undefined && !/^[A-Za-z0-9_-]{12,80}$/.test(requestKey)) throw new BadRequestException('requestKey 要 12 到 80 位字母数字');
    return this.dataSource.transaction(async (em) => {
      if (requestKey) {
        const dup = await em.findOne(FlowRun, { where: { companyId: user.companyId, requestKey } });
        if (dup) return this.detailIn(em, user, dup.id);
      }
      const def = await em.findOne(FlowDefinition, { where: { companyId: user.companyId, templateKey: templateKey, status: 'active' } });
      if (!def) {
        await this.tpl(em, user.companyId, templateKey); // 不存在的流程给“没有这种流程”
        throw new BadRequestException('这条流程还没有启用，请管理员先在“流程配置”里配置办理人并发布');
      }
      const t = await this.tpl(em, user.companyId, templateKey, def.id);
      const adapter = adapterFor(t);
      const checked = validateResourceInput(pseudoDef(t.key, t.fields), payloadIn ?? {}, { status: '' });
      if (checked.errors.length) throw new BadRequestException(checked.errors.join('；'));
      const payload = Object.fromEntries(Object.entries(checked.values).filter(([, v]) => v !== null && v !== undefined));
      await adapter.validateStart?.({ em, user, payload, ...this.svc() });
      const title = await adapter.title(em, user.companyId, payload);
      const steps = def.steps as StepDef[];
      const ins = await em.insert(FlowRun, {
        companyId: user.companyId, definitionId: def.id, templateKey: t.key, title, status: 'running', requesterId: user.id,
        currentStepKey: steps[0].key, payload, stepsSnapshot: steps, escalateUserIds: def.escalateUserIds, requestKey: requestKey ?? null,
      } as never);
      const run = (await em.findOne(FlowRun, { where: { id: Number(ins.identifiers[0].id) } }))!;
      const first = await em.insert(FlowStep, {
        companyId: user.companyId, runId: run.id, seq: 1, stepKey: steps[0].key, stepName: steps[0].name, stepType: steps[0].type,
        status: 'done', recipients: [user.id], handledBy: user.id, action: 'submit', finishedAt: new Date(),
      });
      await this.event(em, run, user.id, 'submit', Number(first.identifiers[0].id));
      await adapter.onStart?.({ em, user, payload, run, ...this.svc() });
      await this.enter(em, user, run, steps, 1, 'normal');
      return this.detailIn(em, user, run.id);
    });
  }

  /** 进入第 idx 步：解析办理人、建步骤记录和待办、抄送、通知；end 步直接完成流程 */
  private async enter(em: EntityManager, actor: AuthUser, run: FlowRun, steps: StepDef[], idx0: number, via: 'normal' | 'return' | 'transfer' | 'exception', keepDue?: Date | null, recipientsOverride?: number[]) {
    let idx = idx0;
    if (via === 'normal') idx = await this.skipUnmet(em, run, steps, idx);
    const def = steps[idx];
    const t = await this.runTpl(em, run);
    if (def.type === 'end') {
      const last = await em.findOne(FlowStep, { where: { runId: run.id }, order: { seq: 'DESC' } });
      await em.insert(FlowStep, { companyId: run.companyId, runId: run.id, seq: (last?.seq ?? 0) + 1, stepKey: def.key, stepName: def.name, stepType: 'end', status: 'done', recipients: [], finishedAt: new Date() });
      await this.finish(em, actor, run, 'completed');
      return;
    }
    // 并行分支：一进入就同时开启分支里的所有步骤（转交只重开被转交的那一步）
    const g = via === 'transfer' ? null : this.groupRange(steps, idx);
    const members = g ? steps.slice(g.start, g.end + 1) : [def];
    const opened: Array<{ key: string; due: Date | null }> = [];
    let forms: Record<string, Record<string, unknown>> | null = null;
    for (const m of members) {
      if (g && m.when && via !== 'return') {
        forms ??= await this.stepForms(em, run.id);
        if (!evalCondition(m.when, { payload: run.payload, forms })) {
          const last = await em.findOne(FlowStep, { where: { runId: run.id }, order: { seq: 'DESC' } });
          await em.insert(FlowStep, { companyId: run.companyId, runId: run.id, seq: (last?.seq ?? 0) + 1, stepKey: m.key, stepName: m.name, stepType: m.type, status: 'skipped', recipients: [], finishedAt: new Date(), comment: '条件不满足，已跳过' });
          continue;
        }
      }
      opened.push({ key: m.key, due: await this.openStep(em, run, t, m, via, keepDue, recipientsOverride) });
    }
    if (g && opened.length === 0) { await this.enter(em, actor, run, steps, g.end + 1, 'normal'); return; }
    run.currentStepKey = opened[0].key;
    const dues = opened.map((o) => o.due).filter((d): d is Date => !!d).sort((x, y) => x.getTime() - y.getTime());
    run.dueAt = dues[0] ?? null;
    run.revision += 1;
    await em.save(FlowRun, run);
  }

  /** 开启一个办理步骤：找办理人、建待办、通知、抄送；返回它的到期时间 */
  private async openStep(em: EntityManager, run: FlowRun, t: FlowTemplate, def: StepDef, via: string, keepDue?: Date | null, recipientsOverride?: number[]): Promise<Date | null> {
    const adapter = adapterFor(t);
    const prev = def.assignee?.source === 'previous_handler' ? await em.findOne(FlowStep, { where: { runId: run.id, status: 'done', handledBy: Not(0) }, order: { seq: 'DESC' } }) : null;
    const recipients = recipientsOverride ?? await this.resolveRecipients(em, run.companyId, def, run.requesterId, prev?.handledBy, run.payload);
    const last = await em.findOne(FlowStep, { where: { runId: run.id }, order: { seq: 'DESC' } });
    const now = new Date();
    const bizDue = adapter.stepDueAt?.(def.key, run.payload) ?? null;
    const due = keepDue !== undefined ? keepDue : bizDue ?? (def.dueMinutes ? new Date(now.getTime() + def.dueMinutes * 60_000) : null);
    const ins = await em.insert(FlowStep, {
      companyId: run.companyId, runId: run.id, seq: (last?.seq ?? 0) + 1, stepKey: def.key, stepName: def.name, stepType: def.type,
      status: 'active', enteredVia: via, recipients, dueAt: due,
    });
    const stepId = Number(ins.identifiers[0].id);
    const label = via === 'return' ? `【被退回】${run.title}` : via === 'exception' ? `【异常】${run.title}` : run.title;
    for (const uid of recipients) {
      await em.insert(WorkItem, { companyId: run.companyId, kind: 'flow', runId: run.id, stepId, assigneeId: uid, title: `${def.name} · ${label}`.slice(0, 200), status: 'open', dueAt: due });
    }
    await this.notify(em, run.companyId, recipients, { kind: via === 'return' ? 'returned' : 'todo', title: via === 'return' ? `被退回：${run.title}` : via === 'exception' ? `异常待处理：${run.title}` : `新待办：${run.title}`, body: `步骤：${def.name}`, link: `/workbench/todos?run=${run.id}` }, run);
    for (const uid of def.ccUserIds ?? []) {
      const exists = await em.findOne(FlowCc, { where: { runId: run.id, userId: uid } });
      if (!exists && uid !== run.requesterId) {
        await em.insert(FlowCc, { companyId: run.companyId, runId: run.id, userId: uid, stepKey: def.key });
        await this.notify(em, run.companyId, [uid], { kind: 'cc', title: `抄送你：${run.title}`, body: `进入步骤：${def.name}`, link: `/workbench/cc?run=${run.id}` });
      }
    }
    return due;
  }

  private async finish(em: EntityManager, actor: AuthUser, run: FlowRun, status: 'completed' | 'cancelled' | 'rejected', step?: FlowStep) {
    run.status = status;
    run.currentStepKey = null;
    run.dueAt = null;
    run.finishedAt = new Date();
    run.revision += 1;
    await em.save(FlowRun, run);
    await em.update(WorkItem, { runId: run.id, status: 'open' }, { status: 'cancelled', finishedAt: new Date() });
    await this.cancelActive(em, run);
    const decl = await this.runTpl(em, run);
    const adapter = adapterFor(decl);
    const lastStep = step ?? (await em.findOne(FlowStep, { where: { runId: run.id }, order: { seq: 'DESC' } }));
    if (adapter.onFinish && lastStep) await adapter.onFinish(this.stepCtx(em, actor, run, lastStep, {}), status);
    if (status === 'completed' && decl?.posting?.at === 'complete' && lastStep) {
      await postDeclared(this.stepCtx(em, actor, run, lastStep, {}), decl);
      await em.update(FlowRun, { id: run.id }, { payload: run.payload } as never);
    }
    const word = status === 'completed' ? '已完成' : status === 'cancelled' ? '已废除' : '被拒绝';
    await this.notify(em, run.companyId, [run.requesterId], { kind: 'result', title: `${run.title} ${word}`, link: `/workbench/started?run=${run.id}` }, run);
  }

  // ================= 办理动作 =================

  private async closeStep(em: EntityManager, run: FlowRun, step: FlowStep, user: AuthUser, status: FlowStep['status'], action: FlowAction, comment?: string | null, form?: Record<string, unknown>) {
    step.status = status;
    step.action = action;
    step.handledBy = user.id;
    step.comment = comment?.slice(0, 500) ?? null;
    step.form = form ?? null;
    step.finishedAt = new Date();
    await em.save(FlowStep, step);
    await em.update(WorkItem, { stepId: step.id, assigneeId: user.id, status: 'open' }, { status: 'done', finishedAt: new Date() });
    await em.update(WorkItem, { stepId: step.id, status: 'open' }, { status: 'cancelled', finishedAt: new Date() });
    await this.event(em, run, user.id, action, step.id, comment);
  }

  async pass(user: AuthUser, runId: number, p: { revision: number; stepId: number; form?: Record<string, unknown>; comment?: string }) {
    let after: (() => Promise<void>) | null = null;
    const result = await this.dataSource.transaction(async (em) => {
      const run = await this.lockRun(em, user, runId, p.revision);
      if (run.status !== 'running') throw new ConflictException('这条流程已经结束了');
      const step = await this.activeStep(em, run, p.stepId);
      if (step.stepType === 'submit') throw new BadRequestException('这条流程被退回到发起人，请修改后“重新提交”');
      if (!(await this.myOpenItem(em, user, step))) throw new ForbiddenException('这一步不是你办理的');
      const t = await this.runTpl(em, run);
      const fields = t.stepFields[step.stepKey] ?? [];
      const checked = validateResourceInput(pseudoDef(`${t.key}.${step.stepKey}`, fields), p.form ?? {}, { status: '' });
      if (checked.errors.length) throw new BadRequestException(checked.errors.join('；'));
      const form = Object.fromEntries(Object.entries(checked.values).filter(([, v]) => v !== null && v !== undefined));
      const adapter = adapterFor(t);
      const stepDef = (run.stepsSnapshot as StepDef[]).find((x) => x.key === step.stepKey);
      if (stepDef?.mode === 'all') {
        // 全员会签：我办完了，但还有别人没办 → 只关我的待办，流程停在这一步
        const others = await em.count(WorkItem, { where: { stepId: step.id, status: 'open', assigneeId: Not(user.id) } });
        if (others > 0) {
          await em.update(WorkItem, { stepId: step.id, assigneeId: user.id, status: 'open' }, { status: 'done', finishedAt: new Date() });
          await this.event(em, run, user.id, 'pass', step.id, `会签通过${p.comment ? `：${p.comment}` : ''}`);
          return this.detailIn(em, user, run.id);
        }
      }
      const ctx = this.stepCtx(em, user, run, step, form);
      await adapter.beforePass?.(ctx);
      await adapter.onPass?.(ctx);
      if (t.posting && t.posting.at === step.stepKey) await postDeclared(ctx, t); // 模板声明的自动记账
      await em.update(FlowRun, { id: run.id }, { payload: run.payload } as never);
      await this.closeStep(em, run, step, user, 'done', 'pass', p.comment, form);
      const steps = run.stepsSnapshot as StepDef[];
      const idx = steps.findIndex((s) => s.key === step.stepKey);
      const g = this.groupRange(steps, idx);
      if (g) {
        // 并行分支：还有别的分支没办完，就先等着（汇合）；都办完才往下走
        const members = steps.slice(g.start, g.end + 1).map((m) => m.key);
        const rest = await em.find(FlowStep, { where: { runId: run.id, status: 'active', stepKey: In(members) }, order: { seq: 'ASC' } });
        if (rest.length > 0) {
          run.currentStepKey = rest[0].stepKey;
          run.dueAt = rest.map((r) => r.dueAt).filter((d): d is Date => !!d).sort((x, y) => x.getTime() - y.getTime())[0] ?? null;
          run.revision += 1;
          await em.save(FlowRun, run);
          return this.detailIn(em, user, run.id);
        }
      }
      await this.enter(em, user, run, steps, (g ? g.end : idx) + 1, 'normal');
      if (adapter.afterCommit) {
        const payload = JSON.parse(JSON.stringify(run.payload)) as Record<string, unknown>;
        after = () => adapter.afterCommit!({ user, runId: run.id, companyId: run.companyId, requesterId: run.requesterId, payload, db: this.dataSource.manager, ...this.svc() });
      }
      return this.detailIn(em, user, run.id);
    });
    // 事务已提交：做必须等数据落库才能做的事；它失败不能让已经办理成功的步骤看起来失败
    if (after) { try { await (after as () => Promise<void>)(); } catch (e) { this.log.error(`流程 #${runId} 提交后的处理失败：${(e as Error).message}`); } }
    return result;
  }

  async returnBack(user: AuthUser, runId: number, p: { revision: number; stepId: number; reason: string }) {
    if (!p.reason?.trim()) throw new BadRequestException('退回要写原因');
    return this.dataSource.transaction(async (em) => {
      const run = await this.lockRun(em, user, runId, p.revision);
      if (run.status !== 'running') throw new ConflictException('这条流程已经结束了');
      const step = await this.activeStep(em, run, p.stepId);
      if (step.stepType === 'submit') throw new BadRequestException('发起步骤不能退回');
      if (!(await this.myOpenItem(em, user, step))) throw new ForbiddenException('这一步不是你办理的');
      const steps = run.stepsSnapshot as StepDef[];
      const idx = steps.findIndex((s) => s.key === step.stepKey);
      const blocked = adapterFor(await this.runTpl(em, run)).returnBlocked?.(this.stepCtx(em, user, run, step, {}));
      if (blocked) throw new BadRequestException(blocked);
      const target = await this.returnTarget(em, run, steps, idx);
      await this.closeStep(em, run, step, user, 'returned', 'return', p.reason);
      await this.cancelActive(em, run);
      await this.enter(em, user, run, steps, target, 'return');
      return this.detailIn(em, user, run.id);
    });
  }

  /** 办理人废除/拒绝：流程以对应状态结束，原因必填 */
  async stop(user: AuthUser, runId: number, kind: 'cancel' | 'reject', p: { revision: number; stepId: number; reason: string }) {
    if (!p.reason?.trim()) throw new BadRequestException(`${kind === 'cancel' ? '废除' : '拒绝'}要写原因`);
    return this.dataSource.transaction(async (em) => {
      const run = await this.lockRun(em, user, runId, p.revision);
      if (run.status !== 'running') throw new ConflictException('这条流程已经结束了');
      const step = await this.activeStep(em, run, p.stepId);
      if (!(await this.myOpenItem(em, user, step))) throw new ForbiddenException('这一步不是你办理的');
      const blocked = adapterFor(await this.runTpl(em, run)).cancelBlocked?.(this.stepCtx(em, user, run, step, {}));
      if (blocked) throw new BadRequestException(blocked);
      await this.closeStep(em, run, step, user, kind === 'cancel' ? 'cancelled' : 'rejected', kind, p.reason);
      await this.finish(em, user, run, kind === 'cancel' ? 'cancelled' : 'rejected', step);
      return this.detailIn(em, user, run.id);
    });
  }

  /** 办理人上报异常：流程按步骤上的异常连线转到“仅异常”步骤处理 */
  async reportAbnormal(user: AuthUser, runId: number, p: { revision: number; stepId: number; reason: string }) {
    if (!p.reason?.trim()) throw new BadRequestException('上报异常要写原因');
    return this.dataSource.transaction(async (em) => {
      const run = await this.lockRun(em, user, runId, p.revision);
      if (run.status !== 'running') throw new ConflictException('这条流程已经结束了');
      const step = await this.activeStep(em, run, p.stepId);
      if (!(await this.myOpenItem(em, user, step))) throw new ForbiddenException('这一步不是你办理的');
      const steps = run.stepsSnapshot as StepDef[];
      const def = steps.find((x) => x.key === step.stepKey);
      const to = def?.exceptionToKey ? steps.findIndex((x) => x.key === def.exceptionToKey) : -1;
      if (to < 0) throw new BadRequestException('这一步没有设置异常处理路径，不能上报异常');
      await this.closeStep(em, run, step, user, 'done', 'abnormal', p.reason);
      await this.cancelActive(em, run);
      await this.enter(em, user, run, steps, to, 'exception');
      return this.detailIn(em, user, run.id);
    });
  }

  /** 发起人撤回：还没有人办理过（当前是第一个办理步骤），或被退回到自己手里时可以 */
  async withdraw(user: AuthUser, runId: number, p: { revision: number; reason?: string }) {
    return this.dataSource.transaction(async (em) => {
      const run = await this.lockRun(em, user, runId, p.revision);
      if (run.requesterId !== user.id) throw new ForbiddenException('只有发起人能撤回');
      if (run.status !== 'running') throw new ConflictException('这条流程已经结束了');
      const step = await this.activeStep(em, run);
      const handledBefore = await em.count(FlowStep, { where: { runId: run.id, action: 'pass' } });
      if (step.stepType !== 'submit' && handledBefore > 0) throw new BadRequestException('已经有人办理过了，不能撤回；请联系当前办理人退回或废除');
      const blocked = adapterFor(await this.runTpl(em, run)).cancelBlocked?.(this.stepCtx(em, user, run, step, {}));
      if (blocked) throw new BadRequestException(blocked);
      await this.closeStep(em, run, step, user, 'cancelled', 'withdraw', p.reason);
      await this.finish(em, user, run, 'cancelled', step);
      return this.detailIn(em, user, run.id);
    });
  }

  async resubmit(user: AuthUser, runId: number, p: { revision: number; payload: Record<string, unknown> }) {
    return this.dataSource.transaction(async (em) => {
      const run = await this.lockRun(em, user, runId, p.revision);
      if (run.requesterId !== user.id) throw new ForbiddenException('只有发起人能重新提交');
      if (run.status !== 'running') throw new ConflictException('这条流程已经结束了');
      const step = await this.activeStep(em, run);
      if (step.stepType !== 'submit') throw new BadRequestException('现在不在退回给你修改的状态');
      const t = await this.runTpl(em, run);
      const checked = validateResourceInput(pseudoDef(t.key, t.fields), p.payload ?? {}, { status: '' });
      if (checked.errors.length) throw new BadRequestException(checked.errors.join('；'));
      const payload = Object.fromEntries(Object.entries(checked.values).filter(([, v]) => v !== null && v !== undefined));
      const adapter = adapterFor(t);
      // 重新提交时，自己这条在办的流程不算“重复申请”：临时把它标成非 running 做检查
      await em.update(FlowRun, { id: run.id }, { status: 'cancelled' });
      try { await adapter.validateStart?.({ em, user, payload, ...this.svc() }); } finally { await em.update(FlowRun, { id: run.id }, { status: 'running' }); }
      run.payload = { ...payload };
      run.title = await adapter.title(em, run.companyId, payload);
      await em.save(FlowRun, run);
      await adapter.onResubmit?.({ em, user, payload, run, ...this.svc() });
      await this.closeStep(em, run, step, user, 'done', 'resubmit');
      const steps = run.stepsSnapshot as StepDef[];
      const idx = steps.findIndex((s) => s.key === step.stepKey);
      await this.enter(em, user, run, steps, idx + 1, 'normal');
      return this.detailIn(em, user, run.id);
    });
  }

  /** 转交：只有公司管理员能把当前步骤改派给别人（原办理人失去待办，截止时间不变） */
  async transfer(user: AuthUser, runId: number, p: { revision: number; toUserId: number; reason: string; stepId?: number }) {
    if (!user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员能转交');
    if (!p.reason?.trim()) throw new BadRequestException('转交要写原因');
    return this.dataSource.transaction(async (em) => {
      const run = await this.lockRun(em, user, runId, p.revision);
      if (run.status !== 'running') throw new ConflictException('这条流程已经结束了');
      const step = await this.activeStep(em, run, p.stepId);
      if (step.stepType === 'submit') throw new BadRequestException('发起步骤不能转交');
      await this.checkUsersExist(em, user.companyId, [p.toUserId]);
      step.status = 'transferred';
      step.action = 'transfer';
      step.handledBy = user.id;
      step.comment = p.reason.slice(0, 500);
      step.finishedAt = new Date();
      await em.save(FlowStep, step);
      await em.update(WorkItem, { stepId: step.id, status: 'open' }, { status: 'cancelled', finishedAt: new Date() });
      await this.event(em, run, user.id, 'transfer', step.id, p.reason);
      const steps = run.stepsSnapshot as StepDef[];
      await this.enter(em, user, run, steps, steps.findIndex((s) => s.key === step.stepKey), 'transfer', step.dueAt, [p.toUserId]);
      return this.detailIn(em, user, run.id);
    });
  }

  // ================= 条件分支 / 退回目标 =================

  private async stepForms(em: EntityManager, runId: number) {
    const rows = await em.find(FlowStep, { where: { runId }, order: { seq: 'ASC' } });
    const forms: Record<string, Record<string, unknown>> = {};
    for (const r of rows) if (r.form) forms[r.stepKey] = r.form;
    return forms;
  }

  /** 从第 idx 步开始，跳过条件不满足的步骤（每个跳过的步骤留一条“已跳过”记录）；结束步不会被跳过 */
  private async skipUnmet(em: EntityManager, run: FlowRun, steps: StepDef[], idx: number) {
    let i = idx;
    let forms: Record<string, Record<string, unknown>> | null = null;
    while (steps[i] && steps[i].type !== 'end' && (steps[i].onlyOnException || (steps[i].when && !steps[i].parallel))) {
      if (steps[i].onlyOnException) { i += 1; continue; } // 仅异常步骤：正常流转直接略过
      forms ??= await this.stepForms(em, run.id);
      if (evalCondition(steps[i].when!, { payload: run.payload, forms })) break;
      const last = await em.findOne(FlowStep, { where: { runId: run.id }, order: { seq: 'DESC' } });
      const d = steps[i];
      await em.insert(FlowStep, { companyId: run.companyId, runId: run.id, seq: (last?.seq ?? 0) + 1, stepKey: d.key, stepName: d.name, stepType: d.type, status: 'skipped', recipients: [], finishedAt: new Date(), comment: '条件不满足，已跳过' });
      i += 1;
    }
    return i;
  }

  /** 退回到哪一步：步骤声明了退回目标就用它，否则回到上一个实际会办理的步骤（跳过条件不满足的） */
  private async returnTarget(em: EntityManager, run: FlowRun, steps: StepDef[], idx: number) {
    const to = steps[idx].returnToKey ? steps.findIndex((x) => x.key === steps[idx].returnToKey) : -1;
    if (to >= 0 && to < idx) return to;
    let j = (this.groupRange(steps, idx)?.start ?? idx) - 1;
    let forms: Record<string, Record<string, unknown>> | null = null;
    while (j > 0 && (steps[j].onlyOnException || steps[j].when)) {
      if (!steps[j].onlyOnException) {
        forms ??= await this.stepForms(em, run.id);
        if (evalCondition(steps[j].when!, { payload: run.payload, forms })) break;
      }
      j -= 1;
    }
    return this.groupRange(steps, j)?.start ?? j;
  }

  /** 流程类型名：内置 + 本公司自建 */
  private async labelMap(companyId: number) {
    const map = new Map<string, string>(FLOW_TEMPLATES.map((t) => [t.key, t.label]));
    for (const r of await this.dataSource.manager.find(FlowTemplateRow, { where: { companyId }, select: ['templateKey', 'name'] })) map.set(r.templateKey, r.name);
    return map;
  }

  // ================= 查看 =================

  private async canSeeRun(em: EntityManager, user: AuthUser, run: FlowRun) {
    if (run.requesterId === user.id || this.can(user, 'flow.overview.view')) return true;
    const [row] = await em.query(
      `SELECT (SELECT COUNT(*) FROM flow_steps WHERE run_id = ? AND (JSON_CONTAINS(recipients, CAST(? AS JSON)) OR handled_by = ?)) +
              (SELECT COUNT(*) FROM flow_ccs WHERE run_id = ? AND user_id = ?) AS n`, [run.id, String(user.id), user.id, run.id, user.id]);
    return Number(row.n) > 0;
  }

  async detail(user: AuthUser, id: number) {
    return this.detailIn(this.dataSource.manager, user, id);
  }

  private async detailIn(em: EntityManager, user: AuthUser, id: number) {
    const run = await em.findOne(FlowRun, { where: { id, companyId: user.companyId } });
    if (!run) throw new NotFoundException('流程不存在');
    if (!(await this.canSeeRun(em, user, run))) throw new ForbiddenException('没有查看这条流程的权限');
    const t = await this.runTpl(em, run);
    const steps = await em.find(FlowStep, { where: { runId: id }, order: { seq: 'ASC' } });
    const events = await em.find(FlowEvent, { where: { runId: id }, order: { id: 'ASC' } });
    const ccs = await em.find(FlowCc, { where: { runId: id } });
    const activeAll = steps.filter((s) => s.status === 'active');
    const myOpen = activeAll.length > 1 ? await em.find(WorkItem, { where: { companyId: user.companyId, runId: id, assigneeId: user.id, status: 'open' }, select: ['stepId'] }) : [];
    const active = activeAll.find((s) => myOpen.some((w) => w.stepId === s.id)) ?? activeAll[0] ?? null;
    const names = await this.userNames(em, run.companyId, [run.requesterId, ...steps.flatMap((s) => [...s.recipients, ...(s.handledBy ? [s.handledBy] : [])]), ...events.map((e) => e.actorId), ...ccs.map((c) => c.userId)]);
    // 字段权限：这一步办理人看不到的发起字段（发起人、有总览权限的人、管理员不受限）
    const hidden = new Set<string>();
    if (!(run.requesterId === user.id || this.can(user, 'flow.overview.view') || user.permissions.isCompanyAdmin)) {
      for (const d of run.stepsSnapshot as StepDef[]) {
        if (d.hiddenFields?.length && steps.some((st) => st.stepKey === d.key && (st.recipients.includes(user.id) || st.handledBy === user.id))) d.hiddenFields.forEach((k) => hidden.add(k));
      }
    }
    const refLabels: Record<string, string> = {};
    for (const f of t.fields) {
      if (hidden.has(f.key)) continue;
      const v = run.payload[f.key];
      if (f.type === 'ref' && typeof v === 'number') {
        if (f.ref === 'user') refLabels[f.key] = (await this.userNames(em, run.companyId, [v])).get(v) ?? '';
        else refLabels[f.key] = (await this.resources.titleOf(em, run.companyId, f.ref!, v)) ?? '';
      }
    }
    const stepRefLabels: Record<number, Record<string, string>> = {};
    for (const s of steps) {
      for (const f of t.stepFields[s.stepKey] ?? []) {
        const v = s.form?.[f.key];
        if (f.type === 'ref' && typeof v === 'number' && f.ref) (stepRefLabels[s.id] ??= {})[f.key] = (await this.resources.titleOf(em, run.companyId, f.ref, v)) ?? '';
      }
    }
    const mine = active ? await this.myOpenItem(em, user, active) : null;
    const isRequester = run.requesterId === user.id;
    const running = run.status === 'running';
    const adapter = adapterFor(t);
    const ctx = active ? this.stepCtx(em, user, run, active, {}) : null;
    const handledBefore = steps.filter((s) => s.action === 'pass').length;
    return {
      id: run.id, templateKey: run.templateKey, templateLabel: t.label, title: run.title, status: run.status, revision: run.revision,
      requesterId: run.requesterId, requesterName: names.get(run.requesterId) ?? '', createdAt: run.createdAt, finishedAt: run.finishedAt, dueAt: run.dueAt,
      payload: Object.fromEntries(Object.entries(run.payload).filter(([k]) => !k.startsWith('_') && !hidden.has(k))), refLabels,
      fields: t.fields.filter((f) => !hidden.has(f.key)), stepFields: t.stepFields,
      activeSteps: activeAll.length > 1 ? activeAll.map((a) => ({ id: a.id, key: a.stepKey, name: a.stepName, recipients: a.recipients.map((u) => ({ id: u, name: names.get(u) ?? '' })), dueAt: a.dueAt })) : [],
      activeStep: active ? { id: active.id, key: active.stepKey, name: active.stepName, type: active.stepType, enteredVia: active.enteredVia, dueAt: active.dueAt, recipients: active.recipients.map((u) => ({ id: u, name: names.get(u) ?? '' })) } : null,
      steps: steps.map((s) => ({ id: s.id, seq: s.seq, key: s.stepKey, name: s.stepName, type: s.stepType, status: s.status, action: s.action, comment: s.comment, form: s.form, formRefLabels: stepRefLabels[s.id] ?? {}, enteredVia: s.enteredVia, enteredAt: s.enteredAt, finishedAt: s.finishedAt, dueAt: s.dueAt, handledByName: s.handledBy ? names.get(s.handledBy) ?? '' : null, recipients: s.recipients.map((u) => names.get(u) ?? '') })),
      events: events.map((e) => ({ id: e.id, action: e.action, note: e.note, actorName: names.get(e.actorId) ?? '', createdAt: e.createdAt })),
      ccs: ccs.map((c) => ({ userId: c.userId, name: names.get(c.userId) ?? '' })),
      links: { docId: typeof run.payload._docId === 'number' ? run.payload._docId : null, docNo: str(run.payload._docNo) || null, borrowRecordId: typeof run.payload._borrowRecordId === 'number' ? run.payload._borrowRecordId : null },
      me: {
        canPass: running && !!mine && active!.stepType !== 'submit',
        canReturn: running && !!mine && active!.stepType !== 'submit' && steps.filter((s) => s.status !== 'active').length > 1 && !adapter.returnBlocked?.(ctx!),
        canCancel: running && !!mine && !adapter.cancelBlocked?.(ctx!),
        canReject: running && !!mine && !adapter.cancelBlocked?.(ctx!),
        returnBlockedReason: running && !!mine && active ? adapter.returnBlocked?.(ctx!) ?? null : null,
        cancelBlockedReason: running && !!mine && active ? adapter.cancelBlocked?.(ctx!) ?? null : null,
        canResubmit: running && isRequester && active?.stepType === 'submit',
        canWithdraw: running && isRequester && !!active && (active.stepType === 'submit' || handledBefore === 0) && !adapter.cancelBlocked?.(ctx!),
        canAbnormal: running && !!mine && !!(run.stepsSnapshot as StepDef[]).find((d) => d.key === active?.stepKey)?.exceptionToKey,
        canTransfer: running && !!user.permissions.isCompanyAdmin && !!active && active.stepType !== 'submit',
        stepFields: active && mine ? t.stepFields[active.stepKey] ?? [] : [],
      },
    };
  }

  async listRuns(user: AuthUser, q: { view: 'started' | 'cc' | 'all'; status?: string; templateKey?: string; keyword?: string; overdue?: boolean; departmentId?: number; handler?: string; returned?: boolean; page: number; pageSize: number }) {
    if (q.view === 'all') this.need(user, 'flow.overview.view', '没有查看流程总览的权限');
    const where = ['r.company_id = ?'];
    const args: unknown[] = [user.companyId];
    let join = '';
    if (q.view === 'started') { where.push('r.requester_id = ?'); args.push(user.id); }
    if (q.view === 'cc') { join = 'JOIN flow_ccs c ON c.run_id = r.id AND c.user_id = ?'; args.unshift(user.id); }
    if (q.status) { where.push('r.status = ?'); args.push(q.status); }
    if (q.templateKey) { where.push('r.template_key = ?'); args.push(q.templateKey); }
    if (q.keyword?.trim()) { where.push('r.title LIKE ?'); args.push(`%${q.keyword.trim()}%`); }
    if (q.overdue) { where.push("r.status = 'running' AND r.due_at IS NOT NULL AND r.due_at < ?"); args.push(new Date()); }
    if (q.departmentId) {
      const depts: Array<{ id: number; parentId: number | null }> = await this.dataSource.query('SELECT id, parent_id AS parentId FROM departments WHERE company_id = ?', [user.companyId]);
      const ids = new Set<number>([q.departmentId]);
      for (let grew = true; grew;) { grew = false; for (const d of depts) if (d.parentId && ids.has(d.parentId) && !ids.has(d.id)) { ids.add(d.id); grew = true; } }
      where.push(`r.requester_id IN (SELECT id FROM users WHERE company_id = ? AND department_id IN (${[...ids].map(() => '?').join(',')}))`);
      args.push(user.companyId, ...ids);
    }
    if (q.handler?.trim()) {
      where.push("EXISTS (SELECT 1 FROM flow_steps hs JOIN users hu ON hu.company_id = r.company_id AND JSON_CONTAINS(hs.recipients, CAST(hu.id AS JSON)) WHERE hs.run_id = r.id AND hs.status = 'active' AND hu.name LIKE ?)");
      args.push(`%${q.handler.trim().replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (q.returned) where.push("r.status = 'running' AND EXISTS (SELECT 1 FROM flow_steps rs WHERE rs.run_id = r.id AND rs.status = 'active' AND rs.entered_via = 'return')");
    // 参数顺序：join 的参数在最前（unshift 处理），其余按 where 顺序
    const w = where.join(' AND ');
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n FROM flow_runs r ${join} WHERE ${w}`, args);
    const rows = await this.dataSource.query(
      `SELECT r.id, r.template_key AS templateKey, r.title, r.status, r.requester_id AS requesterId, u.name AS requesterName, r.current_step_key AS currentStepKey,
              r.due_at AS dueAt, r.created_at AS createdAt, r.finished_at AS finishedAt,
              (SELECT s.step_name FROM flow_steps s WHERE s.run_id = r.id AND s.status = 'active' ORDER BY s.seq DESC LIMIT 1) AS stepName,
              (SELECT s.recipients FROM flow_steps s WHERE s.run_id = r.id AND s.status = 'active' ORDER BY s.seq DESC LIMIT 1) AS recipients,
              (SELECT s.entered_at FROM flow_steps s WHERE s.run_id = r.id AND s.status = 'active' ORDER BY s.seq DESC LIMIT 1) AS stepEnteredAt
       FROM flow_runs r ${join} JOIN users u ON u.id = r.requester_id WHERE ${w} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const names = await this.userNames(this.dataSource.manager, user.companyId, rows.flatMap((r: { recipients: number[] | string | null }) => (typeof r.recipients === 'string' ? JSON.parse(r.recipients) : r.recipients ?? [])));
    const labels = await this.labelMap(user.companyId);
    return {
      total: Number(n), page: q.page, pageSize: q.pageSize,
      rows: rows.map((r: Record<string, unknown>) => {
        const rec: number[] = typeof r.recipients === 'string' ? JSON.parse(r.recipients) : (r.recipients as number[] | null) ?? [];
        return { ...r, templateLabel: labels.get(String(r.templateKey)) ?? r.templateKey, handlers: rec.map((u) => names.get(u) ?? ''), recipients: undefined, overdue: r.status === 'running' && r.dueAt ? new Date(String(r.dueAt)) < new Date() : false };
      }),
    };
  }

  /** 我的待办：待办（含逾期、被退回）和最近办完的 */
  async todos(user: AuthUser, q: { tab: 'pending' | 'overdue' | 'returned' | 'done'; keyword?: string; page: number; pageSize: number }) {
    const now = new Date();
    const base = 'w.company_id = ? AND w.assignee_id = ?';
    const args: unknown[] = [user.companyId, user.id];
    let cond = "w.status = 'open' AND (w.kind <> 'task' OR w.submitted_at IS NULL)"; // 已提交等复核的任务不再算负责人的待办
    if (q.tab === 'overdue') { cond += ' AND w.due_at IS NOT NULL AND w.due_at < ?'; args.push(now); }
    if (q.tab === 'returned') cond += " AND s.entered_via = 'return'";
    if (q.tab === 'done') { cond = "w.status = 'done'"; }
    const kw = q.keyword?.trim();
    if (kw) { cond += ' AND (w.title LIKE ? OR r.title LIKE ? OR w.description LIKE ?)'; const like = `%${kw.replace(/[\\%_]/g, '\\$&')}%`; args.push(like, like, like); }
    const from = `FROM work_items w LEFT JOIN flow_steps s ON s.id = w.step_id LEFT JOIN flow_runs r ON r.id = w.run_id LEFT JOIN users u ON u.id = r.requester_id LEFT JOIN users cu ON cu.id = w.created_by WHERE ${base} AND ${cond}`;
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n ${from}`, args);
    const rows = await this.dataSource.query(
      `SELECT w.id, w.kind, w.routine_id AS routineId, w.run_id AS runId, w.title, w.description, w.status, w.due_at AS dueAt, w.created_at AS createdAt, w.finished_at AS finishedAt,
              w.feedback_preset AS feedbackPreset, w.completion_standard AS completionStandard, w.requires_review AS requiresReview, w.review_note AS reviewNote, w.supervisor_id AS supervisorId, s.step_name AS stepName, s.entered_via AS enteredVia, r.template_key AS templateKey, COALESCE(r.title, w.title) AS runTitle, COALESCE(u.name, cu.name) AS requesterName
       ${from} ORDER BY ${q.tab === 'done' ? 'w.finished_at DESC' : 'w.due_at IS NULL, w.due_at ASC, w.id DESC'} LIMIT ? OFFSET ?`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const [counts] = await this.dataSource.query(
      `SELECT SUM(w.status = 'open' AND (w.kind <> 'task' OR w.submitted_at IS NULL)) AS pending, SUM(w.status = 'open' AND (w.kind <> 'task' OR w.submitted_at IS NULL) AND w.due_at IS NOT NULL AND w.due_at < ?) AS overdue,
              SUM(w.status = 'open' AND s.entered_via = 'return') AS returned
       FROM work_items w LEFT JOIN flow_steps s ON s.id = w.step_id WHERE w.company_id = ? AND w.assignee_id = ?`, [now, user.companyId, user.id]);
    const [cc] = await this.dataSource.query('SELECT COUNT(*) AS n FROM flow_ccs WHERE company_id = ? AND user_id = ?', [user.companyId, user.id]);
    const labels = await this.labelMap(user.companyId);
    const [rv] = await this.dataSource.query("SELECT COUNT(*) AS n FROM work_items WHERE company_id = ? AND kind = 'task' AND status = 'open' AND submitted_at IS NOT NULL AND COALESCE(supervisor_id, created_by) = ?", [user.companyId, user.id]);
    const [dl] = await this.dataSource.query("SELECT COUNT(*) AS n FROM task_delay_requests WHERE company_id = ? AND approver_id = ? AND status = 'pending'", [user.companyId, user.id]);
    return {
      total: Number(n), page: q.page, pageSize: q.pageSize,
      counts: { pending: Number(counts.pending ?? 0), overdue: Number(counts.overdue ?? 0), returned: Number(counts.returned ?? 0), cc: Number(cc.n), taskReview: Number(rv.n) + Number(dl.n) },
      rows: rows.map((r: Record<string, unknown>) => ({ ...r, templateLabel: r.kind === 'task' ? (r.routineId ? '周期任务' : '任务') : labels.get(String(r.templateKey)) ?? '', overdue: r.status === 'open' && r.dueAt ? new Date(String(r.dueAt)) < now : false })),
    };
  }

  // ================= 通知 =================

  async notifications(user: AuthUser, unreadOnly: boolean) {
    const rows = await this.dataSource.manager.find(Notification, { where: { companyId: user.companyId, userId: user.id, ...(unreadOnly ? { readAt: undefined } : {}) }, order: { id: 'DESC' }, take: 50 });
    const [{ n }] = await this.dataSource.query('SELECT COUNT(*) AS n FROM notifications WHERE company_id = ? AND user_id = ? AND read_at IS NULL', [user.companyId, user.id]);
    return { unread: Number(n), items: (unreadOnly ? rows.filter((r) => !r.readAt) : rows).map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, createdAt: r.createdAt, read: !!r.readAt })) };
  }

  async markRead(user: AuthUser, ids?: number[]) {
    if (ids?.length) await this.dataSource.query(`UPDATE notifications SET read_at = NOW() WHERE company_id = ? AND user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [user.companyId, user.id, ...ids]);
    else await this.dataSource.query('UPDATE notifications SET read_at = NOW() WHERE company_id = ? AND user_id = ? AND read_at IS NULL', [user.companyId, user.id]);
    return { ok: true };
  }

  /** 逾期扫描：待办过了截止时间，通知办理人和定义里配置的升级对象，每个待办只通知一次。定时器每分钟调一次。 */
  async scanOverdue(now = new Date()) {
    const items = await this.dataSource.manager.find(WorkItem, { where: { status: 'open', overdueNotifiedAt: undefined }, take: 500 });
    const due = items.filter((i) => i.dueAt && i.dueAt < now && !i.overdueNotifiedAt);
    let notified = 0;
    for (const it of due) {
      await this.dataSource.transaction(async (em) => {
        const fresh = await em.findOne(WorkItem, { where: { id: it.id }, lock: { mode: 'pessimistic_write' } });
        if (!fresh || fresh.status !== 'open' || fresh.overdueNotifiedAt) return;
        fresh.overdueNotifiedAt = now;
        await em.save(WorkItem, fresh);
        const run = fresh.runId ? await em.findOne(FlowRun, { where: { id: fresh.runId } }) : null;
        await this.notify(em, fresh.companyId, [fresh.assigneeId], { kind: 'overdue', title: `已逾期：${fresh.title}`, link: run ? `/workbench/todos?run=${run.id}` : undefined });
        const esc = (run?.escalateUserIds ?? []).filter((u) => u !== fresh.assigneeId);
        if (run && esc.length) {
          const names = await this.userNames(em, fresh.companyId, [fresh.assigneeId]);
          await this.notify(em, fresh.companyId, esc, { kind: 'escalate', title: `办理超时：${run.title}`, body: `${names.get(fresh.assigneeId) ?? ''} 办理的“${fresh.title.split(' · ')[0]}”已超过时限`, link: `/flow/overview?run=${run.id}` });
        }
        notified += 1;
      });
    }
    return notified;
  }
}

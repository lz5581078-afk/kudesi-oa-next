import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  FLOW_TEMPLATES, createChecker, getFlowTemplate, validateResourceInput, validateSteps,
  type FlowAction, type FlowTemplate, type StepDef,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FlowCc, FlowDefinition, FlowEvent, FlowRun, FlowStep, Notification, ResourceRecord, User, WorkItem } from '../entities';
import { FinanceDocumentsService } from '../resources/finance-documents.service';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { ResourcesService } from '../resources/resources.service';
import { OutboxService } from '../outbox/outbox.service';
import { FLOW_ADAPTERS, StepContext, postDeclared } from './flow-adapters';

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
  ) {}
  private readonly log = new Logger('Flow');

  private can(user: AuthUser, key: string) { return createChecker(user.permissions)(key); }
  private need(user: AuthUser, key: string, msg: string) { if (!this.can(user, key)) throw new ForbiddenException(msg); }
  private tpl(key: string) {
    const t = getFlowTemplate(key);
    if (!t) throw new NotFoundException('没有这种流程');
    return t;
  }
  private svc() { return { resources: this.resources, docs: this.docs, bundles: this.bundles, outbox: this.outbox }; }

  // ================= 流程定义 =================

  private toDef(row: FlowDefinition) {
    return { id: row.id, version: row.version, status: row.status, steps: row.steps as StepDef[], escalateUserIds: row.escalateUserIds, publishedAt: row.publishedAt, createdAt: row.createdAt };
  }

  /** 模板列表：每个模板当前启用的版本和是否能发起 */
  async templates(user: AuthUser) {
    const defs = await this.dataSource.manager.find(FlowDefinition, { where: { companyId: user.companyId, status: 'active' } });
    return FLOW_TEMPLATES.map((t) => {
      const active = defs.find((d) => d.templateKey === t.key);
      return { key: t.key, label: t.label, description: t.description, fields: t.fields, stepFields: t.stepFields, active: Boolean(active), version: active?.version ?? null, steps: ((active?.steps ?? t.steps) as StepDef[]).map((s) => ({ name: s.name, type: s.type })) };
    });
  }

  async definition(user: AuthUser, key: string) {
    const t = this.tpl(key);
    const rows = await this.dataSource.manager.find(FlowDefinition, { where: { companyId: user.companyId, templateKey: key }, order: { version: 'DESC' } });
    const active = rows.find((r) => r.status === 'active');
    const draft = rows.find((r) => r.status === 'draft');
    const names = await this.userNames(this.dataSource.manager, user.companyId, [...(draft ?? active)?.steps.flatMap((s) => (s as StepDef).ccUserIds ?? []) ?? [], ...(draft ?? active)?.escalateUserIds ?? []]);
    return {
      template: { key: t.key, label: t.label, description: t.description, steps: t.steps },
      active: active ? this.toDef(active) : null,
      // 没有草稿时给一份“默认草稿”（不入库），保存后才成为真正的草稿
      draft: draft ? this.toDef(draft) : { id: null, version: (rows[0]?.version ?? 0) + 1, status: 'draft' as const, steps: (active?.steps as StepDef[]) ?? [...t.steps], escalateUserIds: active?.escalateUserIds ?? [], publishedAt: null, createdAt: null },
      history: rows.map((r) => ({ version: r.version, status: r.status, publishedAt: r.publishedAt })),
      names: Object.fromEntries(names),
    };
  }

  async saveDraft(user: AuthUser, key: string, steps: StepDef[], escalateUserIds: number[]) {
    this.need(user, 'flow.templates.manage', '没有配置流程的权限');
    const t = this.tpl(key);
    const errors = validateSteps(t, steps, escalateUserIds);
    if (errors.length) throw new BadRequestException(errors.join('；'));
    await this.checkUsersExist(this.dataSource.manager, user.companyId, [...steps.flatMap((s) => s.ccUserIds ?? []), ...escalateUserIds, ...steps.flatMap((s) => (s.assignee?.source === 'employee' && s.assignee.id ? [s.assignee.id] : []))]);
    const clean = steps.map((s) => ({ key: s.key, name: s.name.trim(), type: s.type, assignee: s.assignee, dueMinutes: s.dueMinutes ?? null, ccUserIds: s.ccUserIds ?? [], locked: t.steps.some((x) => x.key === s.key && x.locked) || undefined }));
    return this.dataSource.transaction(async (em) => {
      const rows = await em.find(FlowDefinition, { where: { companyId: user.companyId, templateKey: key }, order: { version: 'DESC' }, lock: { mode: 'pessimistic_write' } });
      const draft = rows.find((r) => r.status === 'draft');
      if (draft) {
        draft.steps = clean;
        draft.escalateUserIds = escalateUserIds;
        await em.save(FlowDefinition, draft);
      } else {
        await em.insert(FlowDefinition, { companyId: user.companyId, templateKey: key, version: (rows[0]?.version ?? 0) + 1, status: 'draft', steps: clean, escalateUserIds, createdBy: user.id });
      }
      return { ok: true };
    });
  }

  /** 发布：每一步的办理人现在都要能解析到人，否则不让发布（和旧系统一致） */
  async publish(user: AuthUser, key: string) {
    this.need(user, 'flow.templates.manage', '没有配置流程的权限');
    const t = this.tpl(key);
    return this.dataSource.transaction(async (em) => {
      const rows = await em.find(FlowDefinition, { where: { companyId: user.companyId, templateKey: key }, order: { version: 'DESC' }, lock: { mode: 'pessimistic_write' } });
      const draft = rows.find((r) => r.status === 'draft');
      if (!draft) throw new BadRequestException('没有可发布的草稿，请先保存配置');
      const steps = draft.steps as StepDef[];
      const errors = validateSteps(t, steps, draft.escalateUserIds);
      if (errors.length) throw new BadRequestException(errors.join('；'));
      for (const s of steps.filter((x) => x.type !== 'submit' && x.type !== 'end')) await this.resolveRecipients(em, user.companyId, s, user.id); // 失败会抛出带步骤名的提示
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

  async resolveRecipients(em: EntityManager, companyId: number, step: StepDef, requesterId: number): Promise<number[]> {
    const a = step.assignee;
    if (!a) throw new BadRequestException(`步骤「${step.name}」没有指定办理人，请管理员在流程配置里设置`);
    if (a.source === 'requester') {
      const u = await em.findOne(User, { where: { id: requesterId, companyId, status: 'active' } });
      if (!u) throw new BadRequestException('发起人已停用');
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

  private async notify(em: EntityManager, companyId: number, userIds: number[], n: { kind: string; title: string; body?: string; link?: string }) {
    for (const uid of [...new Set(userIds)]) {
      await em.insert(Notification, { companyId, userId: uid, kind: n.kind, title: n.title.slice(0, 200), body: n.body?.slice(0, 500) ?? null, link: n.link ?? null });
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

  private async activeStep(em: EntityManager, run: FlowRun) {
    const step = await em.findOne(FlowStep, { where: { runId: run.id, status: 'active' }, order: { seq: 'DESC' } });
    if (!step) throw new ConflictException('这条流程已经没有进行中的步骤');
    return step;
  }

  private stepCtx(em: EntityManager, user: AuthUser, run: FlowRun, step: FlowStep, form: Record<string, unknown>): StepContext {
    return { em, user, run, payload: run.payload, stepKey: step.stepKey, form, ...this.svc() };
  }

  private async myOpenItem(em: EntityManager, user: AuthUser, step: FlowStep) {
    return em.findOne(WorkItem, { where: { companyId: user.companyId, stepId: step.id, assigneeId: user.id, status: 'open' } });
  }

  // ================= 发起 =================

  async start(user: AuthUser, templateKey: string, payloadIn: Record<string, unknown>, requestKey?: string) {
    this.need(user, 'flow.apply.view', '没有发起流程的权限');
    const t = this.tpl(templateKey);
    const adapter = FLOW_ADAPTERS[t.key];
    const checked = validateResourceInput(pseudoDef(t.key, t.fields), payloadIn ?? {}, { status: '' });
    if (checked.errors.length) throw new BadRequestException(checked.errors.join('；'));
    const payload = Object.fromEntries(Object.entries(checked.values).filter(([, v]) => v !== null && v !== undefined));
    if (requestKey !== undefined && !/^[A-Za-z0-9_-]{12,80}$/.test(requestKey)) throw new BadRequestException('requestKey 要 12 到 80 位字母数字');
    return this.dataSource.transaction(async (em) => {
      if (requestKey) {
        const dup = await em.findOne(FlowRun, { where: { companyId: user.companyId, requestKey } });
        if (dup) return this.detailIn(em, user, dup.id);
      }
      const def = await em.findOne(FlowDefinition, { where: { companyId: user.companyId, templateKey: t.key, status: 'active' } });
      if (!def) throw new BadRequestException('这条流程还没有启用，请管理员先在“流程配置”里配置办理人并发布');
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
      await this.enter(em, user, run, steps, 1, 'normal');
      return this.detailIn(em, user, run.id);
    });
  }

  /** 进入第 idx 步：解析办理人、建步骤记录和待办、抄送、通知；end 步直接完成流程 */
  private async enter(em: EntityManager, actor: AuthUser, run: FlowRun, steps: StepDef[], idx: number, via: 'normal' | 'return' | 'transfer', keepDue?: Date | null, recipientsOverride?: number[]) {
    const def = steps[idx];
    const t = this.tpl(run.templateKey);
    const adapter = FLOW_ADAPTERS[t.key];
    if (def.type === 'end') {
      const last = await em.findOne(FlowStep, { where: { runId: run.id }, order: { seq: 'DESC' } });
      await em.insert(FlowStep, { companyId: run.companyId, runId: run.id, seq: (last?.seq ?? 0) + 1, stepKey: def.key, stepName: def.name, stepType: 'end', status: 'done', recipients: [], finishedAt: new Date() });
      await this.finish(em, actor, run, 'completed');
      return;
    }
    const recipients = recipientsOverride ?? await this.resolveRecipients(em, run.companyId, def, run.requesterId);
    const last = await em.findOne(FlowStep, { where: { runId: run.id }, order: { seq: 'DESC' } });
    const now = new Date();
    const bizDue = adapter.stepDueAt?.(def.key, run.payload) ?? null;
    const due = keepDue !== undefined ? keepDue : bizDue ?? (def.dueMinutes ? new Date(now.getTime() + def.dueMinutes * 60_000) : null);
    const ins = await em.insert(FlowStep, {
      companyId: run.companyId, runId: run.id, seq: (last?.seq ?? 0) + 1, stepKey: def.key, stepName: def.name, stepType: def.type,
      status: 'active', enteredVia: via, recipients, dueAt: due,
    });
    const stepId = Number(ins.identifiers[0].id);
    const label = via === 'return' ? `【被退回】${run.title}` : run.title;
    for (const uid of recipients) {
      await em.insert(WorkItem, { companyId: run.companyId, kind: 'flow', runId: run.id, stepId, assigneeId: uid, title: `${def.name} · ${label}`.slice(0, 200), status: 'open', dueAt: due });
    }
    await this.notify(em, run.companyId, recipients, { kind: via === 'return' ? 'returned' : 'todo', title: via === 'return' ? `被退回：${run.title}` : `新待办：${run.title}`, body: `步骤：${def.name}`, link: `/workbench/todos?run=${run.id}` });
    for (const uid of def.ccUserIds ?? []) {
      const exists = await em.findOne(FlowCc, { where: { runId: run.id, userId: uid } });
      if (!exists && uid !== run.requesterId) {
        await em.insert(FlowCc, { companyId: run.companyId, runId: run.id, userId: uid, stepKey: def.key });
        await this.notify(em, run.companyId, [uid], { kind: 'cc', title: `抄送你：${run.title}`, body: `进入步骤：${def.name}`, link: `/workbench/cc?run=${run.id}` });
      }
    }
    run.currentStepKey = def.key;
    run.dueAt = due;
    run.revision += 1;
    await em.save(FlowRun, run);
  }

  private async finish(em: EntityManager, actor: AuthUser, run: FlowRun, status: 'completed' | 'cancelled' | 'rejected', step?: FlowStep) {
    run.status = status;
    run.currentStepKey = null;
    run.dueAt = null;
    run.finishedAt = new Date();
    run.revision += 1;
    await em.save(FlowRun, run);
    await em.update(WorkItem, { runId: run.id, status: 'open' }, { status: 'cancelled', finishedAt: new Date() });
    const adapter = FLOW_ADAPTERS[run.templateKey];
    const lastStep = step ?? (await em.findOne(FlowStep, { where: { runId: run.id }, order: { seq: 'DESC' } }));
    if (adapter.onFinish && lastStep) await adapter.onFinish(this.stepCtx(em, actor, run, lastStep, {}), status);
    const decl = getFlowTemplate(run.templateKey);
    if (status === 'completed' && decl?.posting?.at === 'complete' && lastStep) {
      await postDeclared(this.stepCtx(em, actor, run, lastStep, {}), decl);
      await em.update(FlowRun, { id: run.id }, { payload: run.payload } as never);
    }
    const word = status === 'completed' ? '已完成' : status === 'cancelled' ? '已废除' : '被拒绝';
    await this.notify(em, run.companyId, [run.requesterId], { kind: 'result', title: `${run.title} ${word}`, link: `/workbench/started?run=${run.id}` });
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
      const step = await this.activeStep(em, run);
      if (step.id !== p.stepId) throw new ConflictException('这一步已经被处理过了，请刷新后再看');
      if (step.stepType === 'submit') throw new BadRequestException('这条流程被退回到发起人，请修改后“重新提交”');
      if (!(await this.myOpenItem(em, user, step))) throw new ForbiddenException('这一步不是你办理的');
      const t = this.tpl(run.templateKey);
      const fields = t.stepFields[step.stepKey] ?? [];
      const checked = validateResourceInput(pseudoDef(`${t.key}.${step.stepKey}`, fields), p.form ?? {}, { status: '' });
      if (checked.errors.length) throw new BadRequestException(checked.errors.join('；'));
      const form = Object.fromEntries(Object.entries(checked.values).filter(([, v]) => v !== null && v !== undefined));
      const adapter = FLOW_ADAPTERS[t.key];
      const ctx = this.stepCtx(em, user, run, step, form);
      await adapter.beforePass?.(ctx);
      await adapter.onPass?.(ctx);
      if (t.posting && t.posting.at === step.stepKey) await postDeclared(ctx, t); // 模板声明的自动记账
      await em.update(FlowRun, { id: run.id }, { payload: run.payload } as never);
      await this.closeStep(em, run, step, user, 'done', 'pass', p.comment, form);
      const steps = run.stepsSnapshot as StepDef[];
      const idx = steps.findIndex((s) => s.key === step.stepKey);
      await this.enter(em, user, run, steps, idx + 1, 'normal');
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
      const step = await this.activeStep(em, run);
      if (step.id !== p.stepId) throw new ConflictException('这一步已经被处理过了，请刷新后再看');
      if (step.stepType === 'submit') throw new BadRequestException('发起步骤不能退回');
      if (!(await this.myOpenItem(em, user, step))) throw new ForbiddenException('这一步不是你办理的');
      const steps = run.stepsSnapshot as StepDef[];
      const idx = steps.findIndex((s) => s.key === step.stepKey);
      const blocked = FLOW_ADAPTERS[run.templateKey].returnBlocked?.(this.stepCtx(em, user, run, step, {}));
      if (blocked) throw new BadRequestException(blocked);
      await this.closeStep(em, run, step, user, 'returned', 'return', p.reason);
      await this.enter(em, user, run, steps, idx - 1, 'return');
      return this.detailIn(em, user, run.id);
    });
  }

  /** 办理人废除/拒绝：流程以对应状态结束，原因必填 */
  async stop(user: AuthUser, runId: number, kind: 'cancel' | 'reject', p: { revision: number; stepId: number; reason: string }) {
    if (!p.reason?.trim()) throw new BadRequestException(`${kind === 'cancel' ? '废除' : '拒绝'}要写原因`);
    return this.dataSource.transaction(async (em) => {
      const run = await this.lockRun(em, user, runId, p.revision);
      if (run.status !== 'running') throw new ConflictException('这条流程已经结束了');
      const step = await this.activeStep(em, run);
      if (step.id !== p.stepId) throw new ConflictException('这一步已经被处理过了，请刷新后再看');
      if (!(await this.myOpenItem(em, user, step))) throw new ForbiddenException('这一步不是你办理的');
      const blocked = FLOW_ADAPTERS[run.templateKey].cancelBlocked?.(this.stepCtx(em, user, run, step, {}));
      if (blocked) throw new BadRequestException(blocked);
      await this.closeStep(em, run, step, user, kind === 'cancel' ? 'cancelled' : 'rejected', kind, p.reason);
      await this.finish(em, user, run, kind === 'cancel' ? 'cancelled' : 'rejected', step);
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
      const blocked = FLOW_ADAPTERS[run.templateKey].cancelBlocked?.(this.stepCtx(em, user, run, step, {}));
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
      const t = this.tpl(run.templateKey);
      const checked = validateResourceInput(pseudoDef(t.key, t.fields), p.payload ?? {}, { status: '' });
      if (checked.errors.length) throw new BadRequestException(checked.errors.join('；'));
      const payload = Object.fromEntries(Object.entries(checked.values).filter(([, v]) => v !== null && v !== undefined));
      const adapter = FLOW_ADAPTERS[t.key];
      // 重新提交时，自己这条在办的流程不算“重复申请”：临时把它标成非 running 做检查
      await em.update(FlowRun, { id: run.id }, { status: 'cancelled' });
      try { await adapter.validateStart?.({ em, user, payload, ...this.svc() }); } finally { await em.update(FlowRun, { id: run.id }, { status: 'running' }); }
      run.payload = { ...payload };
      run.title = await adapter.title(em, run.companyId, payload);
      await em.save(FlowRun, run);
      await this.closeStep(em, run, step, user, 'done', 'resubmit');
      const steps = run.stepsSnapshot as StepDef[];
      const idx = steps.findIndex((s) => s.key === step.stepKey);
      await this.enter(em, user, run, steps, idx + 1, 'normal');
      return this.detailIn(em, user, run.id);
    });
  }

  /** 转交：只有公司管理员能把当前步骤改派给别人（原办理人失去待办，截止时间不变） */
  async transfer(user: AuthUser, runId: number, p: { revision: number; toUserId: number; reason: string }) {
    if (!user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员能转交');
    if (!p.reason?.trim()) throw new BadRequestException('转交要写原因');
    return this.dataSource.transaction(async (em) => {
      const run = await this.lockRun(em, user, runId, p.revision);
      if (run.status !== 'running') throw new ConflictException('这条流程已经结束了');
      const step = await this.activeStep(em, run);
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
    const t = this.tpl(run.templateKey);
    const steps = await em.find(FlowStep, { where: { runId: id }, order: { seq: 'ASC' } });
    const events = await em.find(FlowEvent, { where: { runId: id }, order: { id: 'ASC' } });
    const ccs = await em.find(FlowCc, { where: { runId: id } });
    const active = steps.find((s) => s.status === 'active') ?? null;
    const names = await this.userNames(em, run.companyId, [run.requesterId, ...steps.flatMap((s) => [...s.recipients, ...(s.handledBy ? [s.handledBy] : [])]), ...events.map((e) => e.actorId), ...ccs.map((c) => c.userId)]);
    const refLabels: Record<string, string> = {};
    for (const f of t.fields) {
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
    const adapter = FLOW_ADAPTERS[run.templateKey];
    const ctx = active ? this.stepCtx(em, user, run, active, {}) : null;
    const handledBefore = steps.filter((s) => s.action === 'pass').length;
    return {
      id: run.id, templateKey: run.templateKey, templateLabel: t.label, title: run.title, status: run.status, revision: run.revision,
      requesterId: run.requesterId, requesterName: names.get(run.requesterId) ?? '', createdAt: run.createdAt, finishedAt: run.finishedAt, dueAt: run.dueAt,
      payload: Object.fromEntries(Object.entries(run.payload).filter(([k]) => !k.startsWith('_'))), refLabels,
      fields: t.fields, stepFields: t.stepFields,
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
    return {
      total: Number(n), page: q.page, pageSize: q.pageSize,
      rows: rows.map((r: Record<string, unknown>) => {
        const rec: number[] = typeof r.recipients === 'string' ? JSON.parse(r.recipients) : (r.recipients as number[] | null) ?? [];
        return { ...r, templateLabel: getFlowTemplate(String(r.templateKey))?.label ?? r.templateKey, handlers: rec.map((u) => names.get(u) ?? ''), recipients: undefined, overdue: r.status === 'running' && r.dueAt ? new Date(String(r.dueAt)) < new Date() : false };
      }),
    };
  }

  /** 我的待办：待办（含逾期、被退回）和最近办完的 */
  async todos(user: AuthUser, q: { tab: 'pending' | 'overdue' | 'returned' | 'done'; keyword?: string; page: number; pageSize: number }) {
    const now = new Date();
    const base = 'w.company_id = ? AND w.assignee_id = ?';
    const args: unknown[] = [user.companyId, user.id];
    let cond = "w.status = 'open'";
    if (q.tab === 'overdue') { cond += ' AND w.due_at IS NOT NULL AND w.due_at < ?'; args.push(now); }
    if (q.tab === 'returned') cond += " AND s.entered_via = 'return'";
    if (q.tab === 'done') { cond = "w.status = 'done'"; }
    const kw = q.keyword?.trim();
    if (kw) { cond += ' AND (w.title LIKE ? OR r.title LIKE ? OR w.description LIKE ?)'; const like = `%${kw.replace(/[\\%_]/g, '\\$&')}%`; args.push(like, like, like); }
    const from = `FROM work_items w LEFT JOIN flow_steps s ON s.id = w.step_id LEFT JOIN flow_runs r ON r.id = w.run_id LEFT JOIN users u ON u.id = r.requester_id LEFT JOIN users cu ON cu.id = w.created_by WHERE ${base} AND ${cond}`;
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n ${from}`, args);
    const rows = await this.dataSource.query(
      `SELECT w.id, w.kind, w.routine_id AS routineId, w.run_id AS runId, w.title, w.description, w.status, w.due_at AS dueAt, w.created_at AS createdAt, w.finished_at AS finishedAt,
              s.step_name AS stepName, s.entered_via AS enteredVia, r.template_key AS templateKey, COALESCE(r.title, w.title) AS runTitle, COALESCE(u.name, cu.name) AS requesterName
       ${from} ORDER BY ${q.tab === 'done' ? 'w.finished_at DESC' : 'w.due_at IS NULL, w.due_at ASC, w.id DESC'} LIMIT ? OFFSET ?`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const [counts] = await this.dataSource.query(
      `SELECT SUM(w.status = 'open') AS pending, SUM(w.status = 'open' AND w.due_at IS NOT NULL AND w.due_at < ?) AS overdue,
              SUM(w.status = 'open' AND s.entered_via = 'return') AS returned
       FROM work_items w LEFT JOIN flow_steps s ON s.id = w.step_id WHERE w.company_id = ? AND w.assignee_id = ?`, [now, user.companyId, user.id]);
    const [cc] = await this.dataSource.query('SELECT COUNT(*) AS n FROM flow_ccs WHERE company_id = ? AND user_id = ?', [user.companyId, user.id]);
    return {
      total: Number(n), page: q.page, pageSize: q.pageSize,
      counts: { pending: Number(counts.pending ?? 0), overdue: Number(counts.overdue ?? 0), returned: Number(counts.returned ?? 0), cc: Number(cc.n) },
      rows: rows.map((r: Record<string, unknown>) => ({ ...r, templateLabel: r.kind === 'task' ? (r.routineId ? '周期任务' : '任务') : getFlowTemplate(String(r.templateKey))?.label ?? '', overdue: r.status === 'open' && r.dueAt ? new Date(String(r.dueAt)) < now : false })),
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

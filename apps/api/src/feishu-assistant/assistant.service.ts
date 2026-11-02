import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { IntegrationSetting, OutboxJob, OutboxSwitch, ResourceChangeLog } from '../entities';
import { FeishuClient } from '../integrations/feishu.client';
import { ASSISTANT_CHANNEL, ASSISTANT_KEY, AssistantConfig, beijingClock, morningDue, MORNING_TEXT, WELCOME_TEXT } from './greetings';

type JoinEvent = { app_id?: string; tenant_key?: string; create_time?: string; object?: { open_id?: string; status?: { is_resigned?: boolean; is_exited?: boolean } } };
export type AssistantInput = Omit<AssistantConfig, 'activatedAt' | 'appSecret'> & { appSecret?: string };
// SDK logs can include request details. Application logs deliberately contain no payloads/credentials.
const quietLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

@Injectable()
export class AssistantService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private connections = new Map<number, { fingerprint: string; client: WSClient }>();
  private readonly log = new Logger('OAAssistant');
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly crypto: CryptoService, private readonly feishu: FeishuClient) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.OUTBOX_WORKER === 'off') return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref();
    void this.tick();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.connections.values()) c.client.close({ force: true });
    this.connections.clear();
  }
  private decode(row: IntegrationSetting): AssistantConfig { return JSON.parse(this.crypto.decrypt(row.configEnc)); }
  private async config(companyId: number) {
    const row = await this.ds.manager.findOne(IntegrationSetting, { where: { companyId, settingKey: ASSISTANT_KEY } });
    return row ? this.decode(row) : null;
  }
  private admin(user: AuthUser) { if (!user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员可以配置OA助手'); }
  async overview(companyId: number) {
    const cfg = await this.config(companyId);
    const main = cfg ? null : await this.ds.manager.findOne(IntegrationSetting, { where: { companyId, settingKey: 'feishu' } });
    const jobs = await this.ds.query('SELECT id,kind,status,attempts,last_error AS lastError,created_at AS createdAt,done_at AS doneAt FROM outbox_jobs WHERE company_id=? AND channel=? ORDER BY id DESC LIMIT 15', [companyId, ASSISTANT_CHANNEL]);
    const sw = await this.ds.manager.findOne(OutboxSwitch, { where: { companyId, channel: ASSISTANT_CHANNEL } });
    return {
      appId: cfg?.appId ?? 'cli_aa62b26501785bcd', tenantKey: cfg?.tenantKey ?? (main ? this.decode(main).tenantKey : '') ?? '', secretConfigured: !!cfg?.appSecret,
      enabled: !!cfg?.enabled && !!sw?.enabled, morningEnabled: cfg?.morningEnabled ?? true, welcomeEnabled: cfg?.welcomeEnabled ?? true,
      morningText: cfg?.morningText ?? MORNING_TEXT, welcomeText: cfg?.welcomeText ?? WELCOME_TEXT,
      departmentIds: cfg?.departmentIds ?? ['0'], timezone: 'Asia/Shanghai', time: '08:00',
      eventConnection: this.connections.get(companyId)?.client.getConnectionStatus().state ?? 'not_started', jobs,
    };
  }
  async save(user: AuthUser, input: AssistantInput) {
    this.admin(user);
    const old = await this.config(user.companyId);
    const appSecret = input.appSecret?.trim() || (old?.appId === input.appId ? old.appSecret : '') || '';
    if (!/^cli_[a-zA-Z0-9]+$/.test(input.appId) || !input.tenantKey.trim() || !appSecret) throw new BadRequestException('请填写助手的App ID、App Secret和企业Tenant Key');
    if (!input.morningText.trim() || !input.welcomeText.trim()) throw new BadRequestException('问候语不能为空');
    if (!input.departmentIds.length || input.departmentIds.some(id => !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new BadRequestException('请选择有效的飞书部门范围');
    const cfg: AssistantConfig = {
      appId: input.appId, appSecret, tenantKey: input.tenantKey.trim(), enabled: input.enabled,
      morningEnabled: input.morningEnabled, welcomeEnabled: input.welcomeEnabled,
      morningText: input.morningText.trim(), welcomeText: input.welcomeText.trim(), departmentIds: [...new Set(input.departmentIds)],
      activatedAt: old?.enabled && old.appId === input.appId && old.tenantKey === input.tenantKey.trim() && !(input.welcomeEnabled && !old.welcomeEnabled) && !(input.morningEnabled && !old.morningEnabled) ? old.activatedAt : new Date().toISOString(),
    };
    await this.ds.transaction(async em => {
      // One Feishu app must never be attached to two OA companies.
      await em.query("SELECT id FROM companies WHERE id=? FOR UPDATE", [user.companyId]);
      const all = await em.find(IntegrationSetting, { where: { settingKey: ASSISTANT_KEY }, lock: { mode: 'pessimistic_write' } });
      if (all.some(r => r.companyId !== user.companyId && this.decode(r).appId === cfg.appId)) throw new BadRequestException('该助手已配置给其他公司');
      await em.query('INSERT INTO integration_settings(company_id,setting_key,config_enc,updated_by) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE config_enc=VALUES(config_enc),updated_by=VALUES(updated_by)', [user.companyId, ASSISTANT_KEY, this.crypto.encrypt(JSON.stringify(cfg)), user.id]);
      await em.query('INSERT INTO outbox_switches(company_id,channel,enabled,note,updated_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),updated_by=VALUES(updated_by)', [user.companyId, ASSISTANT_CHANNEL, cfg.enabled ? 1 : 0, '小白OA助手问候与欢迎消息总开关', user.id]);
      // Pausing must not build a backlog that surprises employees on re-enable.
      await em.query("UPDATE outbox_jobs SET status='cancelled' WHERE company_id=? AND channel=? AND status='pending'", [user.companyId, ASSISTANT_CHANNEL]);
      await em.insert(ResourceChangeLog, { companyId: user.companyId, resourceType: 'setting:feishu-assistant', resourceId: 0, action: 'update', actorId: user.id, note: '修改小白OA助手定时问候及入职欢迎配置' });
    });
    return this.overview(user.companyId);
  }
  async test(user: AuthUser) {
    this.admin(user);
    const cfg = await this.config(user.companyId);
    if (!cfg) throw new BadRequestException('请先保存助手配置');
    await this.feishu.checkBatchScope(cfg, cfg.departmentIds);
    return { ok: true, message: '应用鉴权及通讯录发送范围检查成功；此操作未向员工发送消息。' };
  }
  private async enabled(companyId: number, cfg: AssistantConfig) {
    const sw = await this.ds.manager.findOne(OutboxSwitch, { where: { companyId, channel: ASSISTANT_CHANNEL } });
    return cfg.enabled && !!sw?.enabled;
  }
  async enqueueWelcome(companyId: number, event: JoinEvent) {
    const cfg = await this.config(companyId);
    if (!cfg || !cfg.welcomeEnabled || !(await this.enabled(companyId, cfg))) return;
    if (event.app_id !== cfg.appId || event.tenant_key !== cfg.tenantKey) return;
    const id = event.object?.open_id;
    if (!id || !/^ou_[a-zA-Z0-9]+$/.test(id) || event.object?.status?.is_resigned || event.object?.status?.is_exited) return;
    // Never welcome existing employees by replaying an old subscription event.
    const created = Number(event.create_time);
    if (!Number.isFinite(created) || created < new Date(cfg.activatedAt).getTime() || created > Date.now() + 300_000) return;
    await this.enqueue(companyId, cfg, 'welcome', `welcome:${id}`, { openId: id, text: cfg.welcomeText, expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  }
  private async enqueue(companyId: number, cfg: AssistantConfig, kind: string, key: string, payload: Record<string, unknown>) {
    await this.ds.query('INSERT IGNORE INTO outbox_jobs(company_id,channel,kind,resource_type,resource_id,idempotency_key,payload_json,created_by) VALUES(?,?,?,?,?,?,?,NULL)', [companyId, ASSISTANT_CHANNEL, kind, ASSISTANT_KEY, 0, `oa:${companyId}:${cfg.appId}:${key}`, JSON.stringify({ ...payload, appId: cfg.appId, tenantKey: cfg.tenantKey })]);
  }
  async tick(now = new Date()) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const rows = await this.ds.manager.find(IntegrationSetting, { where: { settingKey: ASSISTANT_KEY } });
      const live = new Set<number>();
      for (const row of rows) {
        try {
          const cfg = this.decode(row);
          if (!(await this.enabled(row.companyId, cfg))) continue;
          if (cfg.welcomeEnabled) { live.add(row.companyId); this.connect(row.companyId, cfg); }
          if (cfg.morningEnabled && morningDue(now, cfg.activatedAt)) {
            await this.enqueue(row.companyId, cfg, 'morning', beijingClock(now).date, { text: cfg.morningText, departmentIds: cfg.departmentIds, expiresAt: new Date(`${beijingClock(now).date}T08:10:00+08:00`).toISOString() });
          }
          await this.process(row.companyId, now);
        } catch { this.log.error('OA助手任务处理失败，请检查配置与发送记录'); }
      }
      for (const [id, c] of this.connections) if (!live.has(id)) { c.client.close({ force: true }); this.connections.delete(id); }
    } finally { this.busy = false; }
  }
  private connect(companyId: number, cfg: AssistantConfig) {
    const fingerprint = createHash('sha256').update(`${cfg.appId}:${cfg.appSecret}:${cfg.tenantKey}`).digest('hex');
    const existing = this.connections.get(companyId);
    if (existing?.fingerprint === fingerprint && existing.client.getConnectionStatus().state !== 'failed') return;
    this.connections.get(companyId)?.client.close({ force: true });
    const client = new WSClient({ appId: cfg.appId, appSecret: cfg.appSecret, logger: quietLogger });
    this.connections.set(companyId, { fingerprint, client });
    void client.start({ eventDispatcher: new EventDispatcher({ logger: quietLogger }).register({
      'contact.user.created_v3': data => this.enqueueWelcome(companyId, data),
    }) }).catch(() => {
      if (this.connections.get(companyId)?.client === client) this.connections.delete(companyId);
      client.close({ force: true });
      this.log.error('OA助手飞书入职事件连接失败');
    });
  }
  async process(companyId: number, now: Date) {
    const jobs = await this.ds.manager.find(OutboxJob, { where: { companyId, channel: ASSISTANT_CHANNEL, status: 'pending' }, order: { id: 'ASC' }, take: 30 });
    for (const job of jobs) {
      const cfg = await this.config(companyId);
      if (!cfg || !(await this.enabled(companyId, cfg))) return;
      const p = job.payloadJson;
      if (p.appId !== cfg.appId || p.tenantKey !== cfg.tenantKey || new Date(String(p.expiresAt)).getTime() <= now.getTime() || (job.kind === 'morning' ? !cfg.morningEnabled : !cfg.welcomeEnabled)) {
        await this.ds.manager.update(OutboxJob, { id: job.id, companyId, status: 'pending' }, { status: 'cancelled' }); continue;
      }
      const claimed = await this.ds.manager.update(OutboxJob, { id: job.id, companyId, status: 'pending' }, { status: 'sending' });
      if (!claimed.affected) continue;
      try {
        if (job.kind === 'morning') await this.feishu.batchSend(cfg, p.departmentIds as string[], String(p.text));
        else if (job.kind === 'welcome') await this.feishu.send(cfg, String(p.openId), 'open_id', String(p.text), job.idempotencyKey);
        else throw new Error('不支持的助手任务类型');
        await this.ds.manager.update(OutboxJob, { id: job.id, companyId }, { status: 'done', doneAt: new Date(), attempts: 1 });
      } catch {
        // Batch API has no idempotency token. A timeout may have delivered the message.
        // Keep the unique daily key and never automatically repeat an uncertain send.
        await this.ds.manager.update(OutboxJob, { id: job.id, companyId }, { status: 'failed', attempts: 1, lastError: '发送未能确认，请在飞书核查；为避免重复问候，不自动重发' });
      }
    }
  }
}

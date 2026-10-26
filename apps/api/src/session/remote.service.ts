import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource, EntityManager, In, MoreThan } from 'typeorm';
import {
  createChecker, REMOTE_END_REASON_LABEL, REMOTE_LIMITS, REMOTE_MODES, REMOTE_MODE_LABEL, SPECIAL_PERMISSIONS, validateSignal,
  type RemoteMode,
} from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import {
  ResourceRecord, SessionAuditLog, SessionDevice, SessionRemoteDevice, SessionRemoteSession, SessionRemoteSignal, SessionShop, User,
} from '../entities';

const WORKSPACE = 'finance_withdrawal';
const ONLINE_MS = 90_000;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const MIN = 60_000;

export interface IceServer { urls: string[]; username?: string; credential?: string }

/** 管理员一键关闭：环境变量 KUDESI_REMOTE_ASSIST_DISABLED=1 时，不接受新申请，进行中的在下一次轮询被结束。 */
export const remoteGloballyDisabled = (env: NodeJS.ProcessEnv = process.env) => env.KUDESI_REMOTE_ASSIST_DISABLED === '1';

const urls = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8);

/**
 * 给网页和助手的 STUN/TURN 配置（环境变量 WEBRTC_STUN_URLS / WEBRTC_TURN_URLS / WEBRTC_TURN_SHARED_SECRET）。
 * TURN 用共享密钥生成带时限的账号（coturn 的 use-auth-secret 方式），账号里带会话号，过期自动失效。没配置就返回空（只能同一内网直连）。
 */
export function buildIceServers(sessionId: number, ttlSeconds: number, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): IceServer[] {
  const stun = urls(env.WEBRTC_STUN_URLS);
  const turn = urls(env.WEBRTC_TURN_URLS);
  const secret = env.WEBRTC_TURN_SHARED_SECRET ?? '';
  const out: IceServer[] = [];
  if (stun.length) out.push({ urls: stun });
  if (turn.length && secret.length >= 8) {
    const username = `${Math.floor(nowMs / 1000) + Math.max(60, ttlSeconds)}:remote-${sessionId}`;
    out.push({ urls: turn, username, credential: crypto.createHmac('sha1', secret).update(username).digest('base64') });
  }
  return out;
}

const fmtDuration = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec}秒`);

/**
 * 远程协助（店铺提现里看/协助授权电脑上的店铺窗口）。
 * 画面和操作走 WebRTC，在网页和助手之间点对点传输，不经过服务器；服务器只做：谁能申请、电脑是否同意、时限、信令信箱和完整记录。
 * 默认全部关闭：电脑要由有管理权限的人开启，助手那边还要由电脑主人在本机允许（助手配置里 remote.allow）。
 */
@Injectable()
export class RemoteAssistService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** 测试用：可以替换时钟 */
  clock: () => Date = () => new Date();
  private now() { return this.clock(); }

  private can(user: AuthUser, key: string) { return createChecker(user.permissions)(key); }
  private needRemote(user: AuthUser) { if (!this.can(user, SPECIAL_PERMISSIONS.financeSessionRemote)) throw new ForbiddenException('没有发起远程协助的权限'); }
  private needManage(user: AuthUser) { if (!this.can(user, SPECIAL_PERMISSIONS.financeSessionManage)) throw new ForbiddenException('没有管理店铺登录和授权电脑的权限'); }

  private async audit(em: EntityManager, companyId: number, eventType: string, summary: string, o: { actorId?: number | null; deviceId?: number | null; storeId?: number | null } = {}) {
    await em.insert(SessionAuditLog, { companyId, eventType, summary: summary.slice(0, 500), actorId: o.actorId ?? null, deviceId: o.deviceId ?? null, storeId: o.storeId ?? null });
  }

  private async nameMaps(em: EntityManager, companyId: number, rows: SessionRemoteSession[]) {
    const userIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.endedBy ?? 0]).filter((x) => x > 0))];
    const deviceIds = [...new Set(rows.map((r) => r.deviceId))];
    const storeIds = [...new Set(rows.map((r) => r.storeId))];
    const users = new Map((userIds.length ? await em.find(User, { where: { companyId, id: In(userIds) }, select: ['id', 'name'] }) : []).map((u) => [u.id, u.name]));
    const devices = new Map((deviceIds.length ? await em.find(SessionDevice, { where: { companyId, id: In(deviceIds) }, select: ['id', 'name'] }) : []).map((d) => [d.id, d.name]));
    const stores = new Map((storeIds.length ? await em.find(ResourceRecord, { where: { companyId, type: 'stores', id: In(storeIds) }, select: ['id', 'title'] }) : []).map((r) => [r.id, r.title]));
    return { user: (id: number | null) => (id ? users.get(id) ?? `#${id}` : ''), device: (id: number) => devices.get(id) ?? `#${id}`, store: (id: number) => stores.get(id) ?? `#${id}` };
  }

  private durationSec(s: Pick<SessionRemoteSession, 'acceptedAt' | 'endedAt'>, at?: Date) {
    if (!s.acceptedAt) return 0;
    return Math.max(0, Math.round(((s.endedAt ?? at ?? this.now()).getTime() - s.acceptedAt.getTime()) / 1000));
  }

  /** 结束一次协助（只会成功一次）：记录结束原因和时长，清空信令信箱，写操作日志。 */
  private async finish(em: EntityManager, s: SessionRemoteSession, reason: string, o: { note?: string | null; actorId?: number | null; inputs?: number } = {}): Promise<boolean> {
    const at = this.now();
    const r = await em.getRepository(SessionRemoteSession).createQueryBuilder()
      .update().set({ status: 'ended', endReason: reason, endNote: o.note?.slice(0, 300) ?? null, endedBy: o.actorId ?? null, endedAt: at, inputCount: () => `input_count + ${Math.max(0, Math.min(100000, Math.floor(o.inputs ?? 0)))}` })
      .where('id = :id AND status <> :ended', { id: s.id, ended: 'ended' }).execute();
    if (!r.affected) return false;
    await em.delete(SessionRemoteSignal, { sessionId: s.id });
    const n = await this.nameMaps(em, s.companyId, [s]);
    const sec = this.durationSec({ acceptedAt: s.acceptedAt, endedAt: at });
    const started = s.acceptedAt ? `时长 ${fmtDuration(sec)}` : '未开始';
    await this.audit(em, s.companyId, 'remote_ended', `远程协助结束：${n.user(s.requestedBy)} 在电脑「${n.device(s.deviceId)}」${REMOTE_MODE_LABEL[s.mode]}店铺「${n.store(s.storeId)}」，${started}，结果：${REMOTE_END_REASON_LABEL[reason] ?? reason}${o.note ? `（${o.note.slice(0, 80)}）` : ''}`, { actorId: o.actorId ?? s.requestedBy, deviceId: s.deviceId, storeId: s.storeId });
    return true;
  }

  /** 巡检：把该结束的协助结束掉（到时限、掉线、电脑被撤销/关闭、店铺被移除或改绑、全局关闭）。每次接口调用开头都会做。 */
  async sweep(companyId: number, em: EntityManager = this.dataSource.manager): Promise<void> {
    const live = await em.find(SessionRemoteSession, { where: { companyId, status: In(['requested', 'active']) } });
    if (!live.length) return;
    const now = this.now().getTime();
    const devices = new Map((await em.find(SessionDevice, { where: { companyId, id: In([...new Set(live.map((s) => s.deviceId))]) } })).map((d) => [d.id, d]));
    const cfgs = new Map((await em.find(SessionRemoteDevice, { where: { companyId, deviceId: In([...devices.keys(), 0]) } })).map((c) => [c.deviceId, c]));
    const shops = new Map((await em.find(SessionShop, { where: { companyId, id: In(live.map((s) => s.shopId)) } })).map((s) => [s.id, s]));
    const killed = remoteGloballyDisabled();
    for (const s of live) {
      const dev = devices.get(s.deviceId), cfg = cfgs.get(s.deviceId), shop = shops.get(s.shopId);
      let why: string | null = null;
      if (killed) why = 'killed';
      else if (!dev || dev.status !== 'active') why = 'device_revoked';
      else if (!cfg?.enabled || (s.mode === 'control' && !cfg.allowControl)) why = 'device_disabled';
      else if (!shop || shop.status !== 'active' || shop.deviceId !== s.deviceId) why = 'shop_changed';
      else if (s.status === 'requested' && s.deadlineAt.getTime() <= now) why = 'no_response';
      else if (s.status === 'active' && s.expiresAt && s.expiresAt.getTime() <= now) why = 'expired';
      else if (s.status === 'active' && s.agentSeenAt && now - s.agentSeenAt.getTime() > REMOTE_LIMITS.agentLostSeconds * 1000) why = 'agent_lost';
      else if (s.status === 'active' && s.viewerSeenAt && now - s.viewerSeenAt.getTime() > REMOTE_LIMITS.viewerLostSeconds * 1000) why = 'viewer_lost';
      if (why) await this.finish(em, s, why);
    }
  }

  private async load(em: EntityManager, companyId: number, id: number) {
    const s = await em.findOne(SessionRemoteSession, { where: { id, companyId } });
    if (!s) throw new NotFoundException('远程协助记录不存在');
    return s;
  }

  // ================= 网页端 =================

  /** 电脑的远程协助开关（授权电脑页用） */
  async devices(user: AuthUser) {
    const em = this.dataSource.manager;
    const devs = (await em.find(SessionDevice, { where: { companyId: user.companyId }, order: { id: 'ASC' } })).filter((d) => d.status !== 'deleted');
    const cfgs = new Map((await em.find(SessionRemoteDevice, { where: { companyId: user.companyId } })).map((c) => [c.deviceId, c]));
    return {
      globalDisabled: remoteGloballyDisabled(),
      iceConfigured: buildIceServers(0, 60).length > 0,
      canManage: this.can(user, SPECIAL_PERMISSIONS.financeSessionManage),
      canRemote: this.can(user, SPECIAL_PERMISSIONS.financeSessionRemote),
      limits: { minMinutes: REMOTE_LIMITS.minMinutes, hardCapMinutes: REMOTE_LIMITS.hardCapMinutes },
      devices: devs.map((d) => { const c = cfgs.get(d.id); return { deviceId: d.id, enabled: !!c?.enabled, allowControl: !!c?.enabled && !!c.allowControl, maxMinutes: c?.maxMinutes ?? REMOTE_LIMITS.defaultMinutes }; }),
    };
  }

  /** 开启/关闭一台电脑的远程协助。关闭会立即结束这台电脑上进行中的协助。 */
  async setDevice(user: AuthUser, deviceId: number, p: { enabled: boolean; allowControl?: boolean; maxMinutes?: number }) {
    this.needManage(user);
    const minutes = p.maxMinutes ?? REMOTE_LIMITS.defaultMinutes;
    if (!Number.isInteger(minutes) || minutes < REMOTE_LIMITS.minMinutes || minutes > REMOTE_LIMITS.hardCapMinutes) throw new BadRequestException(`单次时长要在 ${REMOTE_LIMITS.minMinutes} 到 ${REMOTE_LIMITS.hardCapMinutes} 分钟之间`);
    return this.dataSource.transaction(async (em) => {
      const d = await em.findOne(SessionDevice, { where: { id: deviceId, companyId: user.companyId }, lock: { mode: 'pessimistic_write' } });
      if (!d || d.status === 'deleted') throw new NotFoundException('电脑不存在');
      if (d.status !== 'active') throw new ConflictException('这台电脑已撤销');
      const allowControl = !!p.enabled && !!p.allowControl;
      const existing = await em.findOne(SessionRemoteDevice, { where: { deviceId, companyId: user.companyId } });
      const row = { deviceId, companyId: user.companyId, enabled: !!p.enabled, allowControl, maxMinutes: minutes, updatedBy: user.id, updatedAt: this.now() };
      if (existing) await em.update(SessionRemoteDevice, { deviceId }, row); else await em.insert(SessionRemoteDevice, row);
      await this.audit(em, user.companyId, p.enabled ? 'remote_device_enabled' : 'remote_device_disabled',
        p.enabled ? `开启电脑「${d.name}」的远程协助：${allowControl ? '可操作' : '只观看'}，单次最长 ${minutes} 分钟` : `关闭电脑「${d.name}」的远程协助`, { actorId: user.id, deviceId });
      if (!p.enabled || (existing?.allowControl && !allowControl)) await this.sweep(user.companyId, em);
      return { ok: true };
    });
  }

  /** 紧急停止：结束全公司进行中的协助，并关闭所有电脑的远程协助（要重新逐台开启）。 */
  async stopAll(user: AuthUser) {
    this.needManage(user);
    return this.dataSource.transaction(async (em) => {
      const live = await em.find(SessionRemoteSession, { where: { companyId: user.companyId, status: In(['requested', 'active']) } });
      let ended = 0;
      for (const s of live) if (await this.finish(em, s, 'killed', { actorId: user.id })) ended++;
      const r = await em.update(SessionRemoteDevice, { companyId: user.companyId, enabled: true }, { enabled: false, allowControl: false, updatedBy: user.id, updatedAt: this.now() });
      await this.audit(em, user.companyId, 'remote_stop_all', `紧急停止远程协助：结束 ${ended} 个进行中的协助，关闭 ${r.affected ?? 0} 台电脑的远程协助`, { actorId: user.id });
      return { ended, disabledDevices: r.affected ?? 0 };
    });
  }

  /** 店铺列表里“远程协助”按钮要用的状态 */
  async shopStates(user: AuthUser) {
    const em = this.dataSource.manager;
    await this.sweep(user.companyId);
    const shops = await em.find(SessionShop, { where: { companyId: user.companyId, workspace: WORKSPACE, status: 'active' } });
    const devIds = [...new Set(shops.map((s) => s.deviceId).filter((x): x is number => !!x))];
    const devs = new Map((devIds.length ? await em.find(SessionDevice, { where: { companyId: user.companyId, id: In(devIds) } }) : []).map((d) => [d.id, d]));
    const cfgs = new Map((devIds.length ? await em.find(SessionRemoteDevice, { where: { companyId: user.companyId, deviceId: In(devIds) } }) : []).map((c) => [c.deviceId, c]));
    const live = await em.find(SessionRemoteSession, { where: { companyId: user.companyId, status: In(['requested', 'active']) } });
    const n = await this.nameMaps(em, user.companyId, live);
    const liveByShop = new Map(live.map((s) => [s.shopId, s]));
    const killed = remoteGloballyDisabled();
    return {
      canRemote: this.can(user, SPECIAL_PERMISSIONS.financeSessionRemote),
      globalDisabled: killed,
      shops: shops.filter((s) => s.deviceId).map((s) => {
        const d = devs.get(s.deviceId!), c = cfgs.get(s.deviceId!), l = liveByShop.get(s.id);
        return {
          shopId: s.id,
          remoteEnabled: !killed && !!c?.enabled && d?.status === 'active',
          allowControl: !!c?.enabled && !!c.allowControl,
          maxMinutes: c?.maxMinutes ?? REMOTE_LIMITS.defaultMinutes,
          deviceOnline: !!d && d.status === 'active' && !!d.lastSeenAt && this.now().getTime() - d.lastSeenAt.getTime() < ONLINE_MS,
          live: l ? { id: l.id, status: l.status, mode: l.mode, mine: l.requestedBy === user.id, requestedByName: n.user(l.requestedBy) } : null,
        };
      }),
    };
  }

  async request(user: AuthUser, shopId: number, p: { mode: string; reason: string }) {
    this.needRemote(user);
    if (!(REMOTE_MODES as readonly string[]).includes(p.mode)) throw new BadRequestException('模式只能是“只观看”或“可操作”');
    const mode = p.mode as RemoteMode;
    const reason = (p.reason ?? '').trim();
    if (reason.length < REMOTE_LIMITS.reasonMin || reason.length > REMOTE_LIMITS.reasonMax) throw new BadRequestException(`请填写事由（${REMOTE_LIMITS.reasonMin} 到 ${REMOTE_LIMITS.reasonMax} 字），会记入操作日志`);
    if (remoteGloballyDisabled()) throw new ConflictException('管理员已关闭远程协助');
    return this.dataSource.transaction(async (em) => {
      const shop = await em.findOne(SessionShop, { where: { id: shopId, companyId: user.companyId, workspace: WORKSPACE, status: 'active' }, lock: { mode: 'pessimistic_write' } });
      if (!shop) throw new NotFoundException('店铺不在列表里');
      await this.sweep(user.companyId, em);
      if (!shop.deviceId) throw new BadRequestException('这家店铺还没有分配负责电脑');
      const dev = await em.findOne(SessionDevice, { where: { id: shop.deviceId, companyId: user.companyId } });
      if (!dev || dev.status !== 'active') throw new BadRequestException('负责电脑已撤销');
      const cfg = await em.findOne(SessionRemoteDevice, { where: { deviceId: dev.id, companyId: user.companyId } });
      if (!cfg?.enabled) throw new ForbiddenException(`电脑「${dev.name}」没有开启远程协助，请联系管理员在“授权电脑”里开启`);
      if (mode === 'control' && !cfg.allowControl) throw new ForbiddenException(`电脑「${dev.name}」只允许观看，不允许远程操作`);
      if (!dev.lastSeenAt || this.now().getTime() - dev.lastSeenAt.getTime() >= ONLINE_MS) throw new BadRequestException(`电脑「${dev.name}」的助手不在线`);
      const busy = await em.findOne(SessionRemoteSession, { where: [{ companyId: user.companyId, deviceId: dev.id, status: In(['requested', 'active']) }, { companyId: user.companyId, shopId: shop.id, status: In(['requested', 'active']) }] });
      if (busy) throw new ConflictException('这家店铺或这台电脑已经有一场远程协助在进行');
      const now = this.now();
      const ins = await em.insert(SessionRemoteSession, {
        companyId: user.companyId, shopId: shop.id, storeId: shop.storeId, deviceId: dev.id, requestedBy: user.id, mode, reason, status: 'requested',
        maxMinutes: cfg.maxMinutes, requestedAt: now, deadlineAt: new Date(now.getTime() + REMOTE_LIMITS.requestWaitSeconds * 1000),
      } as never);
      const id = Number(ins.identifiers[0].id);
      const store = (await em.findOne(ResourceRecord, { where: { id: shop.storeId, companyId: user.companyId, type: 'stores' }, select: ['id', 'title'] }))?.title ?? `#${shop.storeId}`;
      await this.audit(em, user.companyId, 'remote_requested', `申请远程协助：电脑「${dev.name}」上的店铺「${store}」，${REMOTE_MODE_LABEL[mode]}，事由：${reason}`, { actorId: user.id, deviceId: dev.id, storeId: shop.storeId });
      return { id, status: 'requested' as const, waitSeconds: REMOTE_LIMITS.requestWaitSeconds };
    });
  }

  private view(s: SessionRemoteSession, n: Awaited<ReturnType<RemoteAssistService['nameMaps']>>, user: AuthUser) {
    const now = this.now().getTime();
    const mine = s.requestedBy === user.id;
    return {
      id: s.id, status: s.status, mode: s.mode, reason: s.reason, mine,
      storeName: n.store(s.storeId), deviceName: n.device(s.deviceId), requestedByName: n.user(s.requestedBy),
      requestedAt: s.requestedAt, acceptedAt: s.acceptedAt, expiresAt: s.expiresAt, endedAt: s.endedAt,
      secondsLeft: s.status === 'active' && s.expiresAt ? Math.max(0, Math.round((s.expiresAt.getTime() - now) / 1000)) : 0,
      endReason: s.endReason, endReasonLabel: s.endReason ? REMOTE_END_REASON_LABEL[s.endReason] ?? s.endReason : null, endNote: s.endNote,
      canExtend: s.status === 'active' && !!s.acceptedAt && !!s.expiresAt && s.expiresAt.getTime() < s.acceptedAt.getTime() + REMOTE_LIMITS.hardCapMinutes * MIN,
      durationSeconds: this.durationSec(s),
    };
  }

  /** 查看一场协助：申请人或有管理权限的人可看；ICE 服务器只给申请人（含限时 TURN 账号） */
  async get(user: AuthUser, id: number) {
    this.needRemoteOrManage(user);
    await this.sweep(user.companyId);
    const s = await this.load(this.dataSource.manager, user.companyId, id);
    if (s.requestedBy !== user.id && !this.can(user, SPECIAL_PERMISSIONS.financeSessionManage)) throw new ForbiddenException('这不是你发起的远程协助');
    const n = await this.nameMaps(this.dataSource.manager, user.companyId, [s]);
    const base = this.view(s, n, user);
    const ice = base.mine && s.status === 'active' && s.expiresAt ? buildIceServers(s.id, Math.ceil((s.expiresAt.getTime() - this.now().getTime()) / 1000)) : undefined;
    return { ...base, ...(ice ? { iceServers: ice } : {}) };
  }

  private needRemoteOrManage(user: AuthUser) {
    if (!this.can(user, SPECIAL_PERMISSIONS.financeSessionRemote) && !this.can(user, SPECIAL_PERMISSIONS.financeSessionManage)) throw new ForbiddenException('没有远程协助的权限');
  }

  /** 申请人才能收发这场协助的信令 */
  private async mineOrThrow(em: EntityManager, user: AuthUser, id: number) {
    this.needRemote(user);
    const s = await this.load(em, user.companyId, id);
    if (s.requestedBy !== user.id) throw new ForbiddenException('这不是你发起的远程协助');
    return s;
  }

  /** 网页 → 助手 的信令（join / answer / ice / bye） */
  async signal(user: AuthUser, id: number, p: { kind: string; payload?: unknown }) {
    await this.sweep(user.companyId);
    const em = this.dataSource.manager;
    const s = await this.mineOrThrow(em, user, id);
    if (s.status !== 'active') throw new ConflictException(s.status === 'requested' ? '电脑还没有同意' : '这场远程协助已经结束');
    const bad = validateSignal('toAgent', p.kind, p.payload);
    if (bad) throw new BadRequestException(bad);
    const text = JSON.stringify(p.payload ?? {});
    if ((await em.count(SessionRemoteSignal, { where: { sessionId: id } })) >= REMOTE_LIMITS.maxSignalsPerSession) throw new ConflictException('信令过多，请重新发起');
    await em.insert(SessionRemoteSignal, { sessionId: id, toAgent: true, kind: p.kind, payload: text });
    await em.update(SessionRemoteSession, { id }, { viewerSeenAt: this.now() });
    return { ok: true };
  }

  /** 网页轮询：状态 + 助手发来的信令。轮询本身就是“网页还在”的心跳。 */
  async poll(user: AuthUser, id: number, after: number) {
    await this.sweep(user.companyId);
    const em = this.dataSource.manager;
    const s = await this.mineOrThrow(em, user, id);
    if (s.status === 'active') await em.update(SessionRemoteSession, { id }, { viewerSeenAt: this.now() });
    const n = await this.nameMaps(em, user.companyId, [s]);
    const rows = s.status === 'ended' ? [] : await em.find(SessionRemoteSignal, { where: { sessionId: id, toAgent: false, ...(after > 0 ? { id: MoreThan(after) } : {}) }, order: { id: 'ASC' }, take: 200 });
    return { ...this.view(s, n, user), signals: rows.map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload) as unknown })) };
  }

  async extend(user: AuthUser, id: number) {
    return this.dataSource.transaction(async (em) => {
      await this.sweep(user.companyId, em);
      this.needRemote(user);
      const s = await em.findOne(SessionRemoteSession, { where: { id, companyId: user.companyId }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw new NotFoundException('远程协助记录不存在');
      if (s.requestedBy !== user.id) throw new ForbiddenException('这不是你发起的远程协助');
      if (s.status !== 'active' || !s.acceptedAt || !s.expiresAt) throw new ConflictException('这场远程协助不在进行中');
      const cap = s.acceptedAt.getTime() + REMOTE_LIMITS.hardCapMinutes * MIN;
      if (s.expiresAt.getTime() >= cap) throw new ConflictException(`单场远程协助最长 ${REMOTE_LIMITS.hardCapMinutes} 分钟，已到上限`);
      s.expiresAt = new Date(Math.min(cap, s.expiresAt.getTime() + REMOTE_LIMITS.extendMinutes * MIN));
      s.extendCount += 1;
      await em.update(SessionRemoteSession, { id }, { expiresAt: s.expiresAt, extendCount: s.extendCount });
      const n = await this.nameMaps(em, user.companyId, [s]);
      await this.audit(em, user.companyId, 'remote_extended', `延长远程协助：${n.user(s.requestedBy)} 在电脑「${n.device(s.deviceId)}」协助店铺「${n.store(s.storeId)}」，延长 ${REMOTE_LIMITS.extendMinutes} 分钟`, { actorId: user.id, deviceId: s.deviceId, storeId: s.storeId });
      return this.view(s, n, user);
    });
  }

  /** 结束：申请人随时可以结束；有管理权限的人可以结束别人的协助 */
  async end(user: AuthUser, id: number) {
    return this.dataSource.transaction(async (em) => {
      this.needRemoteOrManage(user);
      const s = await em.findOne(SessionRemoteSession, { where: { id, companyId: user.companyId }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw new NotFoundException('远程协助记录不存在');
      const mine = s.requestedBy === user.id;
      if (!mine && !this.can(user, SPECIAL_PERMISSIONS.financeSessionManage)) throw new ForbiddenException('这不是你发起的远程协助');
      if (mine) this.needRemote(user);
      if (s.status !== 'ended') await this.finish(em, s, mine ? (s.status === 'requested' ? 'cancelled' : 'completed') : 'ended_by_admin', { actorId: user.id });
      return { ok: true };
    });
  }

  /** 远程协助记录：有管理权限的看全公司，其他人只看自己发起的 */
  async history(user: AuthUser) {
    this.needRemoteOrManage(user);
    await this.sweep(user.companyId);
    const all = this.can(user, SPECIAL_PERMISSIONS.financeSessionManage);
    const rows = await this.dataSource.manager.find(SessionRemoteSession, { where: { companyId: user.companyId, ...(all ? {} : { requestedBy: user.id }) }, order: { id: 'DESC' }, take: 100 });
    const n = await this.nameMaps(this.dataSource.manager, user.companyId, rows);
    return rows.map((s) => ({
      id: s.id, storeName: n.store(s.storeId), deviceName: n.device(s.deviceId), requestedByName: n.user(s.requestedBy), mode: s.mode, reason: s.reason, status: s.status,
      endReason: s.endReason, endReasonLabel: s.endReason ? REMOTE_END_REASON_LABEL[s.endReason] ?? s.endReason : null, endedByName: n.user(s.endedBy),
      requestedAt: s.requestedAt, acceptedAt: s.acceptedAt, endedAt: s.endedAt, durationSeconds: this.durationSec(s), inputCount: s.inputCount, extendCount: s.extendCount,
    }));
  }

  // ================= 助手端（设备令牌） =================

  private async deviceByToken(token: string | undefined) {
    if (!token || token.length < 32) throw new UnauthorizedException('设备未授权');
    const d = await this.dataSource.manager.findOne(SessionDevice, { where: { tokenHash: sha(token) } });
    if (!d || d.status !== 'active') throw new UnauthorizedException('设备未授权或已撤销');
    return d;
  }

  private async ownSession(em: EntityManager, d: SessionDevice, id: number) {
    const s = await em.findOne(SessionRemoteSession, { where: { id, deviceId: d.id, companyId: d.companyId } });
    if (!s) throw new NotFoundException('远程协助不存在');
    return s;
  }

  /** 助手领取：有没有人申请协助这台电脑。电脑没开启远程协助时永远是空。 */
  async agentClaim(token: string | undefined) {
    const d = await this.deviceByToken(token);
    await this.sweep(d.companyId);
    const em = this.dataSource.manager;
    const cfg = await em.findOne(SessionRemoteDevice, { where: { deviceId: d.id, companyId: d.companyId } });
    if (!cfg?.enabled || remoteGloballyDisabled()) return { enabled: false, session: null };
    const s = await em.findOne(SessionRemoteSession, { where: { deviceId: d.id, companyId: d.companyId, status: 'requested' }, order: { id: 'ASC' } });
    if (!s) return { enabled: true, session: null };
    const n = await this.nameMaps(em, d.companyId, [s]);
    const platform = String((await em.findOne(ResourceRecord, { where: { id: s.storeId, companyId: d.companyId, type: 'stores' } }))?.data.platform ?? '');
    return {
      enabled: true,
      session: { id: s.id, mode: s.mode, reason: s.reason, requestedByName: n.user(s.requestedBy), store: { id: s.storeId, name: n.store(s.storeId), platform }, maxMinutes: Math.min(cfg.maxMinutes, REMOTE_LIMITS.hardCapMinutes), waitSeconds: Math.max(0, Math.round((s.deadlineAt.getTime() - this.now().getTime()) / 1000)) },
    };
  }

  /** 助手同意（电脑主人在本机允许后调用）：开始计时，返回 ICE 配置 */
  async agentAccept(token: string | undefined, id: number) {
    const d = await this.deviceByToken(token);
    return this.dataSource.transaction(async (em) => {
      await this.sweep(d.companyId, em);
      const s = await em.findOne(SessionRemoteSession, { where: { id, deviceId: d.id, companyId: d.companyId }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw new NotFoundException('远程协助不存在');
      if (s.status !== 'requested') throw new ConflictException('这场远程协助已经开始或已结束');
      const cfg = await em.findOne(SessionRemoteDevice, { where: { deviceId: d.id, companyId: d.companyId } });
      if (!cfg?.enabled || remoteGloballyDisabled()) throw new ForbiddenException('这台电脑没有开启远程协助');
      const now = this.now();
      const expiresAt = new Date(now.getTime() + Math.min(cfg.maxMinutes, REMOTE_LIMITS.hardCapMinutes) * MIN);
      await em.update(SessionRemoteSession, { id }, { status: 'active', acceptedAt: now, expiresAt, viewerSeenAt: now, agentSeenAt: now });
      const n = await this.nameMaps(em, d.companyId, [s]);
      await this.audit(em, d.companyId, 'remote_started', `远程协助开始：${n.user(s.requestedBy)} ${REMOTE_MODE_LABEL[s.mode]}电脑「${d.name}」上的店铺「${n.store(s.storeId)}」，最长 ${Math.min(cfg.maxMinutes, REMOTE_LIMITS.hardCapMinutes)} 分钟，事由：${s.reason}`, { actorId: s.requestedBy, deviceId: d.id, storeId: s.storeId });
      return { id, mode: s.mode, expiresAt, iceServers: buildIceServers(id, Math.min(cfg.maxMinutes, REMOTE_LIMITS.hardCapMinutes) * 60) };
    });
  }

  async agentDecline(token: string | undefined, id: number, note?: string) {
    const d = await this.deviceByToken(token);
    return this.dataSource.transaction(async (em) => {
      const s = await this.ownSession(em, d, id);
      if (s.status === 'requested') await this.finish(em, s, 'declined', { note: note?.slice(0, 100) ?? null, actorId: null });
      return { ok: true };
    });
  }

  /** 助手一次往返：发出信令、领走网页发来的信令；同时是助手的“心跳”。会话已结束时返回 ended，助手据此收摊。 */
  async agentExchange(token: string | undefined, id: number, p: { send?: Array<{ kind: string; payload?: unknown }>; after?: number; inputs?: number }) {
    const d = await this.deviceByToken(token);
    await this.sweep(d.companyId);
    const em = this.dataSource.manager;
    const s = await this.ownSession(em, d, id);
    if (s.status !== 'active') return { status: s.status, endReason: s.endReason, mode: s.mode, expiresAt: s.expiresAt, signals: [] as Array<{ id: number; kind: string; payload: unknown }>, rejected: 0 };
    let rejected = 0;
    const send = Array.isArray(p.send) ? p.send.slice(0, 50) : [];
    for (const m of send) {
      if (validateSignal('toViewer', m?.kind, m?.payload)) { rejected++; continue; }
      await em.insert(SessionRemoteSignal, { sessionId: id, toAgent: false, kind: m.kind, payload: JSON.stringify(m.payload ?? {}) });
    }
    const inputs = Number.isInteger(p.inputs) ? Math.max(0, Math.min(5000, p.inputs!)) : 0;
    await em.getRepository(SessionRemoteSession).createQueryBuilder().update().set({ agentSeenAt: this.now(), inputCount: () => `input_count + ${inputs}` }).where('id = :id', { id }).execute();
    const rows = await em.find(SessionRemoteSignal, { where: { sessionId: id, toAgent: true, ...(p.after && p.after > 0 ? { id: MoreThan(p.after) } : {}) }, order: { id: 'ASC' }, take: 200 });
    return { status: 'active' as const, endReason: null, mode: s.mode, expiresAt: s.expiresAt, signals: rows.map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload) as unknown })), rejected };
  }

  /** 助手主动结束（本机关闭、出错等） */
  async agentEnd(token: string | undefined, id: number, p: { reason?: string; note?: string; inputs?: number }) {
    const d = await this.deviceByToken(token);
    return this.dataSource.transaction(async (em) => {
      const s = await this.ownSession(em, d, id);
      if (s.status !== 'ended') await this.finish(em, s, p.reason === 'error' ? 'error' : p.reason === 'declined' ? 'declined' : 'completed', { note: p.note, inputs: Number.isInteger(p.inputs) ? p.inputs : 0 });
      return { ok: true };
    });
  }
}

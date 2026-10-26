import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { createChecker, getResourceDef } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { FilesService, UploadedFile } from '../integrations/files.service';
import * as releases from './agent-release';
import { FinanceDocument, ResourceRecord, SessionAuditLog, SessionBindCode, SessionDevice, SessionOpenRequest, SessionShop, User } from '../entities';

const WORKSPACE = 'finance_withdrawal';
export const VOUCHER_TYPE = 'withdrawal-voucher';
const VOUCHER_FIELD = 'voucher';
const ONLINE_MS = 90_000;
const PENDING_TTL_MS = 5 * 60_000;
const PLATFORM_ORDER = ['pdd', 'taobao', 'tmall', 'douyin', 'kuaishou', 'jd', 'xhs', 'other'];
export interface OverviewQuery { storeId?: number; keyword?: string; loginState?: string; storeStatus?: string; deviceId?: string; sort?: string; page?: number; pageSize?: number }
const REQ_STEP: Record<string, { percent: number; label: string }> = {
  pending: { percent: 10, label: '等待助手领取' }, claimed: { percent: 60, label: '助手正在打开店铺' }, succeeded: { percent: 100, label: '已打开店铺' },
  failed: { percent: 100, label: '打开失败' }, cancelled: { percent: 100, label: '已取消' }, expired: { percent: 100, label: '超时未领取' },
};
/** 最近一次登录请求的进度（旧系统的进度条）：服务器只知道请求处在哪个阶段，所以按阶段给百分比 */
const progressOf = (r: { id: number; kind: string; status: string; errorText: string | null; createdAt: Date; finishedAt: Date | null }) => ({
  id: r.id, kind: r.kind, status: r.status, percent: REQ_STEP[r.status]?.percent ?? 0, step: REQ_STEP[r.status]?.label ?? r.status, errorText: r.errorText, at: r.finishedAt ?? r.createdAt,
});
/** 助手最新版本号：由部署配置 KUDESI_AGENT_LATEST_VERSION 给出（形如 1.2.0）；没配就是“暂未发布新版”，不能安排升级 */
export const latestAgentVersion = (): string | null => { const v = process.env.KUDESI_AGENT_LATEST_VERSION?.trim(); return v && /^\d+\.\d+\.\d+$/.test(v) ? v : null; };
export const compareVersions = (a: string | null | undefined, b: string | null | undefined): number => {
  const pa = String(a ?? '').split('.').map(Number), pb = String(b ?? '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y ? 1 : -1; }
  return 0;
};
/** 升级进行中的状态：心跳继续给助手下发目标版本（助手中途断电/重启后会接着升级）；failed / rolled_back / succeeded 是终态，要管理员重新安排 */
const UPDATE_IN_PROGRESS = ['queued', 'downloading', 'verifying', 'staged', 'applying', 'restarting'];
const UPDATE_REPORTABLE = ['downloading', 'verifying', 'staged', 'applying', 'restarting', 'failed', 'rolled_back'];
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混的 I O 0 1

/**
 * 店铺提现的“登录管理”：在授权电脑上的助手里登录店铺，再到平台后台提现；每提现一笔，在提现单里登记一笔。
 * 登录态（Cookie/Profile）只保存在授权电脑本机，服务器只保存：店铺登录账号密码（加密）、打开请求和结果、操作日志。
 * 助手（Windows 程序）通过 /agent/* 接口用设备令牌通信；远程协助（WebRTC）这一版没有做。
 */
@Injectable()
export class SessionService {
  constructor(@InjectDataSource() protected readonly dataSource: DataSource, protected readonly crypto: CryptoService, protected readonly files: FilesService) {}

  protected readonly ws: string = WORKSPACE;
  protected readonly manageKey: string = 'finance.session.manage';
  protected readonly addableStatuses: string[] = ['normal'];
  protected readonly manageDenied: string = '没有管理店铺登录的权限';
  private can(user: AuthUser, key: string) { return createChecker(user.permissions)(key); }
  protected needManage(user: AuthUser) { if (!this.can(user, this.manageKey)) throw new ForbiddenException(this.manageDenied); }
  protected async log(em: EntityManager, companyId: number, eventType: string, summary: string, o: { actorId?: number | null; deviceId?: number | null; storeId?: number | null } = {}) {
    await em.insert(SessionAuditLog, { companyId, eventType, summary: summary.slice(0, 500), actorId: o.actorId ?? null, deviceId: o.deviceId ?? null, storeId: o.storeId ?? null });
  }
  private online(d: { status: string; lastSeenAt: Date | null }) { return d.status === 'active' && !!d.lastSeenAt && Date.now() - d.lastSeenAt.getTime() < ONLINE_MS; }
  private async expireStale(em: EntityManager, companyId?: number) {
    await em.query("UPDATE session_open_requests SET status = 'expired', finished_at = NOW(), error_text = '助手未在有效时间内领取请求' WHERE status = 'pending' AND created_at < ?" + (companyId ? ' AND company_id = ?' : ''), companyId ? [new Date(Date.now() - PENDING_TTL_MS), companyId] : [new Date(Date.now() - PENDING_TTL_MS)]);
  }

  // ================= 店铺列表 =================

  /**
   * 店铺列表：支持搜索（平台、运营、店铺名、编码、平台店铺ID）、登录状态/负责电脑/店铺状态筛选、按平台或运营排序、分页。
   * 每家店铺带：平台店铺ID、当前运营、最近打开时间、最近一次登录请求的进度。
   */
  async overview(user: AuthUser, q: OverviewQuery = {}) {
    const em = this.dataSource.manager;
    await this.expireStale(em, user.companyId);
    const shops = await em.find(SessionShop, { where: { companyId: user.companyId, workspace: this.ws, status: 'active' }, order: { id: 'ASC' } });
    const stores = new Map((await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'stores', id: In([0, ...shops.map((s) => s.storeId)]) } })).map((r) => [r.id, r]));
    const reasonIds = [...new Set([...stores.values()].map((r) => Number(r.data.abnormalReason)).filter((n) => n > 0))];
    const reasons = new Map((reasonIds.length ? await em.find(ResourceRecord, { where: { companyId: user.companyId, id: In(reasonIds) } }) : []).map((r) => [r.id, r.title]));
    const opIds = [...new Set([...stores.values()].map((r) => Number(r.data.operatorUserId)).filter((n) => n > 0))];
    const operators = new Map<number, string>((opIds.length ? await em.find(User, { where: { companyId: user.companyId, id: In(opIds) }, select: ['id', 'name'] }) : []).map((u) => [u.id, u.name]));
    const devices = await em.find(SessionDevice, { where: { companyId: user.companyId } });
    const dmap = new Map(devices.map((d) => [d.id, d]));
    const ids = shops.map((s) => s.id);
    const latestRows: Array<{ shopId: number; id: number; kind: string; status: string; errorText: string | null; createdAt: Date; finishedAt: Date | null }> = ids.length ? await em.query(
      `SELECT r.shop_id AS shopId, r.id, r.kind, r.status, r.error_text AS errorText, r.created_at AS createdAt, r.finished_at AS finishedAt FROM session_open_requests r
       JOIN (SELECT MAX(id) AS mid FROM session_open_requests WHERE company_id = ? AND kind <> 'capture' AND shop_id IN (?) GROUP BY shop_id) m ON m.mid = r.id`, [user.companyId, ids]) : [];
    const latest = new Map(latestRows.map((r) => [r.shopId, r]));
    const openedRows: Array<{ shopId: number; at: Date }> = ids.length ? await em.query("SELECT shop_id AS shopId, MAX(finished_at) AS at FROM session_open_requests WHERE company_id = ? AND kind <> 'capture' AND status = 'succeeded' AND shop_id IN (?) GROUP BY shop_id", [user.companyId, ids]) : [];
    const opened = new Map(openedRows.map((r) => [r.shopId, r.at]));
    const reqs = ids.length ? await em.query("SELECT shop_id AS shopId, id, kind, status, created_at AS createdAt FROM session_open_requests WHERE company_id = ? AND status IN ('pending','claimed') AND shop_id IN (?)", [user.companyId, ids]) : [];
    const active = new Map<number, { id: number; kind: string; status: string }>(reqs.map((r: { shopId: number; id: number; kind: string; status: string }) => [r.shopId, r]));
    const platformOpts = new Map((getResourceDef('stores')?.fields.find((f) => f.key === 'platform')?.options ?? []).map((o) => [o.value, o.label]));
    let list = shops.map((s) => {
      const st = stores.get(s.storeId);
      const d = s.deviceId ? dmap.get(s.deviceId) : undefined;
      const platform = String(st?.data.platform ?? '');
      const lr = latest.get(s.id);
      return {
        id: s.id, storeId: s.storeId, storeName: st?.title ?? '(店铺已删除)', storeNo: String(st?.data.storeNo ?? ''), platformStoreId: String(st?.data.platformStoreId ?? ''),
        platform, platformLabel: platformOpts.get(platform) ?? (platform || '其他'), operatorName: operators.get(Number(st?.data.operatorUserId)) ?? '',
        storeStatus: st?.status ?? '', abnormalReason: reasons.get(Number(st?.data.abnormalReason)) ?? '', operatorUserId: st?.data.operatorUserId ?? null,
        deviceId: s.deviceId, deviceName: d?.name ?? '', deviceStatus: d ? (d.status === 'revoked' ? 'revoked' : this.online(d) ? 'online' : 'offline') : 'none',
        loginAccount: s.loginAccount ?? '', hasPassword: !!s.loginPasswordEnc, autoLogin: s.autoLogin, loginState: s.loginState, lastVerifiedAt: s.lastVerifiedAt,
        lastOpenedAt: opened.get(s.id) ?? null, activeRequest: active.get(s.id) ?? null,
        request: lr ? progressOf(lr) : null,
      };
    });
    if (q.storeId) list = list.filter((x) => x.storeId === q.storeId);
    const kw = q.keyword?.trim().toLowerCase();
    if (kw) list = list.filter((x) => [x.storeName, x.storeNo, x.platformStoreId, x.platformLabel, x.operatorName].some((v) => v.toLowerCase().includes(kw)));
    if (q.loginState) list = list.filter((x) => x.loginState === q.loginState);
    if (q.storeStatus) list = list.filter((x) => x.storeStatus === q.storeStatus);
    if (q.deviceId === 'none') list = list.filter((x) => !x.deviceId);
    else if (q.deviceId) list = list.filter((x) => x.deviceId === Number(q.deviceId));
    const pr = (p: string) => { const i = PLATFORM_ORDER.indexOf(p); return i < 0 ? 99 : i; };
    const zh = (a: string, b: string) => a.localeCompare(b, 'zh-CN');
    if (q.sort === 'platform_asc') list.sort((a, b) => pr(a.platform) - pr(b.platform) || zh(a.storeName, b.storeName));
    else if (q.sort === 'platform_desc') list.sort((a, b) => pr(b.platform) - pr(a.platform) || zh(a.storeName, b.storeName));
    else if (q.sort === 'operator_asc' || q.sort === 'operator_desc') {
      const dir = q.sort === 'operator_asc' ? 1 : -1; // 没有运营人的永远排最后
      list.sort((a, b) => (a.operatorName ? 0 : 1) - (b.operatorName ? 0 : 1) || (a.operatorName && b.operatorName ? dir * zh(a.operatorName, b.operatorName) : 0) || zh(a.storeName, b.storeName));
    } else if (q.sort === 'default') list.sort((a, b) => zh(a.storeName, b.storeName));
    const pageSize = Math.max(10, Math.min(200, q.pageSize ?? 50));
    const total = list.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.max(1, Math.min(pageCount, q.page ?? 1));
    return { canManage: this.can(user, this.manageKey), total, page, pageSize, pageCount, shops: list.slice((page - 1) * pageSize, page * pageSize) };
  }

  async availableStores(user: AuthUser, keyword?: string) {
    this.needManage(user);
    const taken = new Set((await this.dataSource.manager.find(SessionShop, { where: { companyId: user.companyId, workspace: this.ws, status: 'active' }, select: ['storeId'] })).map((s) => s.storeId));
    const rows = await this.dataSource.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: 'stores', status: In(this.addableStatuses) }, order: { id: 'DESC' }, take: 500 });
    const k = keyword?.trim();
    return rows.filter((r) => !taken.has(r.id) && (!k || r.title.includes(k))).slice(0, 100).map((r) => ({ id: r.id, name: r.title, platform: String(r.data.platform ?? '') }));
  }

  async addShops(user: AuthUser, p: { storeIds: number[]; deviceId: number }) {
    this.needManage(user);
    if (!p.storeIds?.length || p.storeIds.length > 100) throw new BadRequestException('一次添加 1 到 100 家店铺');
    return this.dataSource.transaction(async (em) => {
      const dev = await em.findOne(SessionDevice, { where: { id: p.deviceId, companyId: user.companyId, status: 'active' } });
      if (!dev) throw new BadRequestException('请选择一台可用的授权电脑');
      for (const sid of [...new Set(p.storeIds)]) {
        const st = await em.findOne(ResourceRecord, { where: { id: sid, companyId: user.companyId, type: 'stores' } });
        if (!st) throw new BadRequestException('店铺不存在');
        if (!this.addableStatuses.includes(st.status)) throw new BadRequestException(`店铺「${st.title}」状态不是正常，不能加入`);
        const ex = await em.findOne(SessionShop, { where: { companyId: user.companyId, workspace: this.ws, storeId: sid } });
        if (ex?.status === 'active') throw new ConflictException(`店铺「${st.title}」已经在列表里`);
        if (ex) { ex.status = 'active'; ex.deviceId = dev.id; await em.save(SessionShop, ex); }
        else await em.insert(SessionShop, { companyId: user.companyId, workspace: this.ws, storeId: sid, deviceId: dev.id, autoLogin: false, loginState: 'none', status: 'active' } as never);
        await this.log(em, user.companyId, 'managed_shop_added', `添加店铺「${st.title}」，负责电脑 ${dev.name}`, { actorId: user.id, storeId: sid, deviceId: dev.id });
      }
      return { ok: true };
    });
  }

  private async lockShop(em: EntityManager, user: AuthUser, id: number) {
    const s = await em.findOne(SessionShop, { where: { id, companyId: user.companyId, workspace: this.ws, status: 'active' }, lock: { mode: 'pessimistic_write' } });
    if (!s) throw new NotFoundException('店铺不在列表里');
    return s;
  }
  private async storeName(em: EntityManager, user: AuthUser, storeId: number) {
    return (await em.findOne(ResourceRecord, { where: { id: storeId, companyId: user.companyId, type: 'stores' }, select: ['id', 'title'] }))?.title ?? `#${storeId}`;
  }

  async updateShop(user: AuthUser, id: number, p: { deviceId?: number | null; loginAccount?: string; loginPassword?: string; clearPassword?: boolean; autoLogin?: boolean }) {
    this.needManage(user);
    return this.dataSource.transaction(async (em) => {
      const s = await this.lockShop(em, user, id);
      const name = await this.storeName(em, user, s.storeId);
      if (p.deviceId !== undefined) {
        if (p.deviceId !== null) {
          const dev = await em.findOne(SessionDevice, { where: { id: p.deviceId, companyId: user.companyId, status: 'active' } });
          if (!dev) throw new BadRequestException('授权电脑不可用');
        }
        if (await em.count(SessionOpenRequest, { where: { shopId: s.id, status: In(['pending', 'claimed']) } })) throw new ConflictException('有进行中的登录请求，先取消再改电脑');
        s.deviceId = p.deviceId;
        await this.log(em, user.companyId, 'managed_shop_assigned', `店铺「${name}」改绑电脑`, { actorId: user.id, storeId: s.storeId, deviceId: p.deviceId });
      }
      const hadCreds = !!s.loginAccount && !!s.loginPasswordEnc;
      if (p.loginAccount !== undefined) s.loginAccount = p.loginAccount.trim().slice(0, 100) || null;
      if (p.clearPassword) s.loginPasswordEnc = null;
      else if (p.loginPassword) s.loginPasswordEnc = this.crypto.encrypt(p.loginPassword.slice(0, 200));
      const hasCreds = !!s.loginAccount && !!s.loginPasswordEnc;
      if (!hasCreds) s.autoLogin = false; // 清空账号或密码时同时关闭自动登录
      else if (p.autoLogin !== undefined) s.autoLogin = p.autoLogin;
      else if (!hadCreds) s.autoLogin = true; // 第一次填全凭据，默认开启自动登录
      if (p.loginAccount !== undefined || p.loginPassword || p.clearPassword) await this.log(em, user.companyId, hasCreds ? 'credentials_updated' : 'credentials_cleared', `店铺「${name}」登录凭据${hasCreds ? '已更新' : '已清除'}`, { actorId: user.id, storeId: s.storeId });
      if (p.autoLogin !== undefined) await this.log(em, user.companyId, 'auto_login_changed', `店铺「${name}」自动登录${s.autoLogin ? '开启' : '关闭'}`, { actorId: user.id, storeId: s.storeId });
      await em.save(SessionShop, s);
      return { ok: true };
    });
  }

  async removeShop(user: AuthUser, id: number) {
    this.needManage(user);
    return this.dataSource.transaction(async (em) => {
      const s = await this.lockShop(em, user, id);
      if (await em.count(SessionOpenRequest, { where: { shopId: s.id, status: In(['pending', 'claimed']) } })) throw new ConflictException('有进行中的登录请求，不能移除');
      s.status = 'removed'; // 软移除：保留历史，重新添加会恢复
      await em.save(SessionShop, s);
      await this.log(em, user.companyId, 'managed_shop_removed', `移除店铺「${await this.storeName(em, user, s.storeId)}」`, { actorId: user.id, storeId: s.storeId });
      return { ok: true };
    });
  }

  /** 查看密码明文：需要管理权限，并写操作日志。资料页不做脱敏，靠权限控制。 */
  async revealPassword(user: AuthUser, id: number) {
    this.needManage(user);
    return this.dataSource.transaction(async (em) => {
      const s = await this.lockShop(em, user, id);
      if (!s.loginPasswordEnc) throw new BadRequestException('还没有保存密码');
      await this.log(em, user.companyId, 'credential_viewed', `查看店铺「${await this.storeName(em, user, s.storeId)}」登录密码`, { actorId: user.id, storeId: s.storeId });
      return { account: s.loginAccount ?? '', password: this.crypto.decrypt(s.loginPasswordEnc) };
    });
  }

  // ================= 登录请求 =================

  async requestOpen(user: AuthUser, shopId: number) {
    this.needManage(user);
    return this.dataSource.transaction(async (em) => {
      await this.expireStale(em, user.companyId);
      const s = await this.lockShop(em, user, shopId);
      if (!s.deviceId) throw new BadRequestException('还没有分配负责电脑');
      const dev = await em.findOne(SessionDevice, { where: { id: s.deviceId, companyId: user.companyId } });
      if (!dev || dev.status !== 'active') throw new BadRequestException('负责电脑已撤销，请改绑');
      if (!this.online(dev)) throw new BadRequestException(`电脑「${dev.name}」的助手不在线，请先打开助手`);
      if (await em.count(SessionOpenRequest, { where: { shopId: s.id, status: In(['pending', 'claimed']) } })) throw new ConflictException('已经有进行中的登录请求');
      const kind = s.loginState === 'valid' ? 'now' : 'first';
      const ins = await em.insert(SessionOpenRequest, { companyId: user.companyId, shopId: s.id, deviceId: dev.id, kind, status: 'pending', requestedBy: user.id } as never);
      await this.log(em, user.companyId, 'shop_open_requested', `请求在 ${dev.name} 登录店铺「${await this.storeName(em, user, s.storeId)}」`, { actorId: user.id, storeId: s.storeId, deviceId: dev.id });
      return { id: Number(ins.identifiers[0].id), kind };
    });
  }

  async cancelRequest(user: AuthUser, id: number) {
    this.needManage(user);
    const r = await this.dataSource.query("UPDATE session_open_requests SET status = 'cancelled', finished_at = NOW() WHERE id = ? AND company_id = ? AND status IN ('pending','claimed') AND shop_id IN (SELECT id FROM session_shops WHERE company_id = ? AND workspace = ?)", [id, user.companyId, user.companyId, this.ws]);
    if (!r.affectedRows) throw new NotFoundException('没有可取消的请求');
    return { ok: true };
  }

  async history(user: AuthUser, shopId: number) {
    const s = await this.dataSource.manager.findOne(SessionShop, { where: { id: shopId, companyId: user.companyId, workspace: this.ws } });
    if (!s) throw new NotFoundException('店铺不在列表里');
    return this.dataSource.query(
      `SELECT r.id, r.kind, r.status, r.error_code AS errorCode, r.error_text AS errorText, r.created_at AS createdAt, r.finished_at AS finishedAt, d.name AS deviceName, u.name AS requestedByName
       FROM session_open_requests r LEFT JOIN session_devices d ON d.id = r.device_id LEFT JOIN users u ON u.id = r.requested_by WHERE r.company_id = ? AND r.shop_id = ? ORDER BY r.id DESC LIMIT 50`, [user.companyId, shopId]);
  }

  // ================= 提现凭证（截图） =================

  /** 网页端请求：让负责电脑的助手把当前打开的店铺页面截成图，作为提现凭证。 */
  async requestCapture(user: AuthUser, shopId: number) {
    if (!this.can(user, 'finance.docs.create') && !this.can(user, 'finance.session.manage')) throw new ForbiddenException('没有登记提现的权限');
    return this.dataSource.transaction(async (em) => {
      await this.expireStale(em, user.companyId);
      const s = await this.lockShop(em, user, shopId);
      const dev = s.deviceId ? await em.findOne(SessionDevice, { where: { id: s.deviceId, companyId: user.companyId } }) : null;
      if (!dev || dev.status !== 'active') throw new BadRequestException('这家店铺没有可用的负责电脑');
      if (!this.online(dev)) throw new BadRequestException(`电脑「${dev.name}」的助手不在线`);
      if (await em.count(SessionOpenRequest, { where: { shopId: s.id, kind: 'capture', status: In(['pending', 'claimed']) } })) throw new ConflictException('已经有一条截图请求在进行中');
      const ins = await em.insert(SessionOpenRequest, { companyId: user.companyId, shopId: s.id, deviceId: dev.id, kind: 'capture', status: 'pending', requestedBy: user.id } as never);
      await this.log(em, user.companyId, 'shop_capture_requested', `请求在 ${dev.name} 截取店铺「${await this.storeName(em, user, s.storeId)}」当前页面作为提现凭证`, { actorId: user.id, storeId: s.storeId, deviceId: dev.id });
      return { id: Number(ins.identifiers[0].id) };
    });
  }

  /** 网页端轮询：请求状态；截图完成后带文件信息。 */
  async requestStatus(user: AuthUser, id: number) {
    const r = await this.dataSource.manager.findOne(SessionOpenRequest, { where: { id, companyId: user.companyId } });
    if (!r) throw new NotFoundException('请求不存在');
    await this.expireStale(this.dataSource.manager, user.companyId);
    const fresh = (await this.dataSource.manager.findOne(SessionOpenRequest, { where: { id } }))!;
    const file = fresh.fileId ? (await this.files.info(user.companyId, [fresh.fileId])).get(fresh.fileId) ?? null : null;
    return { id: fresh.id, kind: fresh.kind, status: fresh.status, errorText: fresh.errorText, file };
  }

  /** 助手上传截图：请求必须是本设备领取的截图请求。 */
  async agentUpload(token: string | undefined, id: number, file: UploadedFile | undefined) {
    const d = await this.deviceByToken(this.dataSource.manager, token);
    const req = await this.dataSource.manager.findOne(SessionOpenRequest, { where: { id, deviceId: d.id } });
    if (!req || req.kind !== 'capture') throw new NotFoundException('截图请求不存在');
    if (req.status !== 'claimed') throw new ConflictException('这条请求不是进行中的');
    const info = await this.files.putBlob(d.companyId, null, VOUCHER_TYPE, VOUCHER_FIELD, file);
    return this.dataSource.transaction(async (em) => {
      const locked = await em.findOne(SessionOpenRequest, { where: { id, deviceId: d.id }, lock: { mode: 'pessimistic_write' } });
      if (!locked || locked.status !== 'claimed') throw new ConflictException('这条请求已经结束');
      locked.status = 'succeeded'; locked.finishedAt = new Date(); locked.fileId = info.id;
      await em.save(SessionOpenRequest, locked);
      const shop = await em.findOne(SessionShop, { where: { id: locked.shopId } });
      await this.log(em, d.companyId, 'shop_capture_completed', '已截取店铺页面作为提现凭证', { deviceId: d.id, storeId: shop?.storeId });
      return { ok: true, fileId: info.id };
    });
  }

  /** 网页端手动上传凭证（截图、照片、PDF）。文件先是“未绑定”，保存提现单后再绑定。 */
  async uploadVoucher(user: AuthUser, file: UploadedFile | undefined) {
    if (!this.can(user, 'finance.docs.create')) throw new ForbiddenException('没有登记提现的权限');
    return this.files.putBlob(user.companyId, user.id, VOUCHER_TYPE, VOUCHER_FIELD, file);
  }

  private async withdrawalDoc(em: EntityManager, user: AuthUser, docId: number) {
    const doc = await em.findOne(FinanceDocument, { where: { id: docId, companyId: user.companyId, docType: 'withdrawal' } });
    if (!doc) throw new NotFoundException('提现单不存在');
    return doc;
  }

  /** 把凭证文件绑定到提现单（整组替换）。红冲后的单据不再改凭证。 */
  async bindVouchers(user: AuthUser, docId: number, fileIds: number[]) {
    if (!this.can(user, 'finance.docs.create')) throw new ForbiddenException('没有登记提现的权限');
    if (!Array.isArray(fileIds) || fileIds.length > 10) throw new BadRequestException('每笔提现最多 10 个凭证文件');
    const ids = [...new Set(fileIds)];
    const gone = await this.dataSource.transaction(async (em) => {
      const doc = await this.withdrawalDoc(em, user, docId);
      if (doc.status === 'reversed') throw new ConflictException('已红冲的单据不能再改凭证');
      return this.files.replaceFor(em, user.companyId, VOUCHER_TYPE, VOUCHER_FIELD, docId, ids);
    });
    await this.files.deleteObjects(user.companyId, gone);
    return this.docVouchers(user, docId);
  }

  async docVouchers(user: AuthUser, docId: number) {
    await this.withdrawalDoc(this.dataSource.manager, user, docId);
    const rows: Array<{ id: number }> = await this.dataSource.query('SELECT id FROM resource_files WHERE company_id = ? AND resource_type = ? AND resource_id = ? ORDER BY id', [user.companyId, VOUCHER_TYPE, docId]);
    return [...(await this.files.info(user.companyId, rows.map((r) => r.id))).values()];
  }

  async voucherUrl(user: AuthUser, fileId: number) {
    return this.files.urlOf(user.companyId, fileId, VOUCHER_TYPE);
  }

  // ================= 授权电脑 =================

  async devices(user: AuthUser) {
    const rows = (await this.dataSource.manager.find(SessionDevice, { where: { companyId: user.companyId }, order: { id: 'ASC' } })).filter((d) => d.status !== 'deleted');
    const counts = await this.dataSource.query("SELECT device_id AS id, COUNT(*) AS n FROM session_shops WHERE company_id = ? AND status = 'active' AND device_id IS NOT NULL GROUP BY device_id", [user.companyId]);
    const cm = new Map<number, number>(counts.map((c: { id: number; n: string }) => [c.id, Number(c.n)]));
    const latest = await this.latestFor(user.companyId);
    return rows.map((d) => ({
      id: d.id, name: d.name, deviceNo: d.deviceNo, os: d.os, agentVersion: d.agentVersion, status: d.status as 'active' | 'revoked', online: this.online(d), lastSeenAt: d.lastSeenAt, shopCount: cm.get(d.id) ?? 0,
      outdated: !!latest && d.status === 'active' && compareVersions(d.agentVersion, latest) < 0, latestVersion: latest,
      update: d.updateStatus ? { target: d.updateTarget, status: d.updateStatus, requestedAt: d.updateRequestedAt, error: d.updateError } : null,
    }));
  }

  /** 安排助手升级：只记下“这台电脑要升到哪个版本”，助手下次心跳时领取；升到目标版本后自动标记成功。 */
  /** 最新版本：优先取本公司已上传且未撤回的最新升级包；一个都没传过才退回部署配置 KUDESI_AGENT_LATEST_VERSION（此时助手会报告“没有安装包”） */
  protected async latestFor(companyId: number): Promise<string | null> {
    return (await releases.latestReleaseVersion(this.dataSource, companyId)) ?? latestAgentVersion();
  }

  async requestDeviceUpdate(user: AuthUser, id: number) {
    this.needManage(user);
    const latest = await this.latestFor(user.companyId);
    if (!latest) throw new BadRequestException('暂未发布新版助手，请联系管理员');
    return this.dataSource.transaction(async (em) => {
      const d = await em.findOne(SessionDevice, { where: { id, companyId: user.companyId }, lock: { mode: 'pessimistic_write' } });
      if (!d || d.status === 'deleted') throw new NotFoundException('电脑不存在');
      if (d.status !== 'active') throw new ConflictException('这台电脑已撤销，先恢复再升级');
      if (compareVersions(d.agentVersion, latest) >= 0) return { queued: false, alreadyCurrent: true, target: latest };
      d.updateTarget = latest; d.updateStatus = 'queued'; d.updateRequestedAt = new Date(); d.updateError = null;
      await em.save(SessionDevice, d);
      await this.log(em, user.companyId, 'agent_update_queued', `已安排电脑「${d.name}」升级到 ${latest}`, { actorId: user.id, deviceId: d.id });
      return { queued: true, alreadyCurrent: false, target: latest };
    });
  }

  async requestUpdateAll(user: AuthUser) {
    this.needManage(user);
    const latest = await this.latestFor(user.companyId);
    if (!latest) throw new BadRequestException('暂未发布新版助手，请联系管理员');
    const rows = await this.dataSource.manager.find(SessionDevice, { where: { companyId: user.companyId, status: 'active' } });
    let queued = 0;
    for (const d of rows) if (compareVersions(d.agentVersion, latest) < 0 && !(UPDATE_IN_PROGRESS.includes(d.updateStatus ?? '') && d.updateTarget === latest)) { await this.requestDeviceUpdate(user, d.id); queued++; }
    return { queued, target: latest };
  }

  /** 删除电脑记录：只能删已撤销、且没有负责店铺的电脑；只是从列表里隐藏，历史日志保留 */
  async deleteDevice(user: AuthUser, id: number) {
    this.needManage(user);
    return this.dataSource.transaction(async (em) => {
      const d = await em.findOne(SessionDevice, { where: { id, companyId: user.companyId }, lock: { mode: 'pessimistic_write' } });
      if (!d || d.status === 'deleted') throw new NotFoundException('电脑不存在');
      if (d.status !== 'revoked') throw new ConflictException('只能删除已撤销的电脑，请先撤销');
      const n = await em.count(SessionShop, { where: { companyId: user.companyId, deviceId: id, status: 'active' } });
      if (n > 0) throw new ConflictException(`这台电脑还负责 ${n} 家店铺，请先给这些店铺改绑别的电脑`);
      d.status = 'deleted';
      await em.save(SessionDevice, d);
      await this.log(em, user.companyId, 'device_deleted', `删除电脑记录「${d.name}」`, { actorId: user.id, deviceId: id });
      return { ok: true };
    });
  }

  async createBindCode(user: AuthUser) {
    this.needManage(user);
    const code = Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await this.dataSource.manager.insert(SessionBindCode, { companyId: user.companyId, codeHash: sha(code), expiresAt, createdBy: user.id } as never);
    await this.log(this.dataSource.manager, user.companyId, 'bind_code_created', '生成了一个电脑绑定码（10 分钟有效）', { actorId: user.id });
    return { code, expiresAt };
  }

  async renameDevice(user: AuthUser, id: number, name: string) {
    this.needManage(user);
    if (!name?.trim() || name.length > 80) throw new BadRequestException('名称必填，不超过 80 字');
    const r = await this.dataSource.manager.update(SessionDevice, { id, companyId: user.companyId }, { name: name.trim() });
    if (!r.affected) throw new NotFoundException('电脑不存在');
    return { ok: true };
  }

  /** 撤销：立即让这台电脑的令牌失效，进行中的请求全部取消。 */
  async setDeviceStatus(user: AuthUser, id: number, status: 'active' | 'revoked') {
    this.needManage(user);
    return this.dataSource.transaction(async (em) => {
      const d = await em.findOne(SessionDevice, { where: { id, companyId: user.companyId }, lock: { mode: 'pessimistic_write' } });
      if (!d || d.status === 'deleted') throw new NotFoundException('电脑不存在');
      d.status = status;
      if (status === 'active') d.lastSeenAt = null; // 恢复后要重新心跳才算在线
      await em.save(SessionDevice, d);
      if (status === 'revoked') await em.update(SessionOpenRequest, { deviceId: id, status: In(['pending', 'claimed']) }, { status: 'cancelled', finishedAt: new Date() });
      await this.log(em, user.companyId, status === 'revoked' ? 'device_revoked' : 'device_restored', `${status === 'revoked' ? '撤销' : '恢复'}电脑「${d.name}」`, { actorId: user.id, deviceId: id });
      return { ok: true };
    });
  }

  async audit(user: AuthUser) {
    const rows = await this.dataSource.query(
      `SELECT a.id, a.event_type AS eventType, a.summary, a.created_at AS createdAt, u.name AS actorName, d.name AS deviceName FROM session_audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN session_devices d ON d.id = a.device_id WHERE a.company_id = ? ORDER BY a.id DESC LIMIT 100`, [user.companyId]);
    return rows;
  }

  // ================= 助手（Windows 程序）接口 =================

  private async deviceByToken(em: EntityManager, token: string | undefined) {
    if (!token || token.length < 32) throw new UnauthorizedException('设备未授权');
    const d = await em.findOne(SessionDevice, { where: { tokenHash: sha(token) } });
    if (!d || d.status !== 'active') throw new UnauthorizedException('设备未授权或已撤销');
    return d;
  }

  async agentRegister(p: { code: string; name: string; os?: string; agentVersion?: string }) {
    const code = (p.code ?? '').trim().toUpperCase();
    if (!/^[A-Z2-9]{8}$/.test(code)) throw new BadRequestException('绑定码不对');
    if (!p.name?.trim() || p.name.length > 80) throw new BadRequestException('电脑名称必填，不超过 80 字');
    return this.dataSource.transaction(async (em) => {
      // 条件更新保证一个绑定码只能成功使用一次
      const upd = await em.query('UPDATE session_bind_codes SET used_at = NOW() WHERE code_hash = ? AND used_at IS NULL AND expires_at > NOW()', [sha(code)]);
      if (!upd.affectedRows) throw new BadRequestException('绑定码无效或已过期');
      const [row] = await em.query('SELECT company_id AS companyId FROM session_bind_codes WHERE code_hash = ?', [sha(code)]);
      const token = crypto.randomBytes(32).toString('hex');
      const deviceNo = Array.from(crypto.randomBytes(12), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
      const ins = await em.insert(SessionDevice, { companyId: row.companyId, deviceNo, name: p.name.trim(), os: p.os?.slice(0, 60) ?? null, agentVersion: p.agentVersion?.slice(0, 30) ?? null, tokenHash: sha(token), status: 'active', lastSeenAt: new Date() } as never);
      const id = Number(ins.identifiers[0].id);
      await this.log(em, row.companyId, 'device_registered', `电脑「${p.name.trim()}」完成绑定`, { deviceId: id });
      return { deviceId: id, deviceNo, token }; // token 只在这里返回一次
    });
  }

  async agentHeartbeat(token: string | undefined, p: { agentVersion?: string }) {
    const d = await this.deviceByToken(this.dataSource.manager, token);
    const version = p.agentVersion?.slice(0, 30) ?? d.agentVersion;
    const inProgress = UPDATE_IN_PROGRESS.includes(d.updateStatus ?? '') && !!d.updateTarget;
    const done = inProgress && compareVersions(version, d.updateTarget) >= 0; // 升到目标版本了
    let update: { targetVersion: string; sha256?: string; size?: number } | null = null;
    let failedNow: string | null = null;
    if (inProgress && !done) {
      const rel = await releases.findRelease(this.dataSource, d.companyId, d.updateTarget!);
      if (rel?.withdrawn) failedNow = '该版本的升级包已被管理员撤回';
      else update = rel ? { targetVersion: d.updateTarget!, sha256: rel.sha256, size: rel.size } : { targetVersion: d.updateTarget! };
    }
    await this.dataSource.manager.update(SessionDevice, { id: d.id }, { lastSeenAt: new Date(), agentVersion: version, ...(done ? { updateStatus: 'succeeded' as const, updateError: null } : {}), ...(failedNow ? { updateStatus: 'failed' as const, updateError: failedNow } : {}) });
    const [{ n }] = await this.dataSource.query("SELECT COUNT(*) AS n FROM session_open_requests WHERE device_id = ? AND status = 'pending'", [d.id]);
    return { ok: true, pending: Number(n), update };
  }

  // ================= 助手升级包（管理员上传，助手下载） =================

  async listReleases(user: AuthUser) {
    this.needManage(user);
    const rows = await releases.listReleases(this.dataSource, user.companyId);
    const latest = rows.find((r) => !r.withdrawnAt)?.version ?? null;
    return rows.map((r) => ({ ...r, isLatest: r.version === latest }));
  }

  async publishRelease(user: AuthUser, file: { buffer: Buffer } | undefined, p: { sha256?: string; version?: string; notes?: string }) {
    this.needManage(user);
    const r = await releases.publishRelease(this.dataSource, user.companyId, user.id, file, p);
    await this.dataSource.transaction((em) => this.log(em, user.companyId, 'agent_release_published', `发布助手升级包 ${r.version}（SHA-256 ${r.sha256.slice(0, 12)}…）`, { actorId: user.id }));
    return r;
  }

  async withdrawRelease(user: AuthUser, id: number) {
    this.needManage(user);
    const version = await releases.withdrawRelease(this.dataSource, user.companyId, id);
    await this.dataSource.transaction((em) => this.log(em, user.companyId, 'agent_release_withdrawn', `撤回助手升级包 ${version}`, { actorId: user.id }));
    return { ok: true };
  }

  /** 助手下载升级包：只发给“正被安排升级到这个版本”的本公司设备 */
  async agentReleaseDownload(token: string | undefined, version: string) {
    const d = await this.deviceByToken(this.dataSource.manager, token);
    if (!UPDATE_IN_PROGRESS.includes(d.updateStatus ?? '') || d.updateTarget !== version) throw new ForbiddenException('这台电脑没有升级到该版本的安排');
    return releases.loadPackage(this.dataSource, d.companyId, version);
  }

  /** 助手回报升级进度；“升级成功”不接受助手自己报，以心跳里的版本号为准 */
  async agentUpdateReport(token: string | undefined, p: { version: string; status: string; errorCode?: string; errorText?: string }) {
    const d = await this.deviceByToken(this.dataSource.manager, token);
    if (!UPDATE_REPORTABLE.includes(p.status)) throw new BadRequestException('升级状态不对');
    if (!UPDATE_IN_PROGRESS.includes(d.updateStatus ?? '') || d.updateTarget !== p.version) throw new ConflictException('没有对应的升级安排');
    const bad = p.status === 'failed' || p.status === 'rolled_back';
    const text = bad ? (p.errorText?.trim() || (p.status === 'failed' ? '升级失败' : '新版本启动失败，已回退')).slice(0, 300) : null;
    await this.dataSource.transaction(async (em) => {
      await em.update(SessionDevice, { id: d.id }, { updateStatus: p.status as SessionDevice['updateStatus'], updateError: text });
      if (bad) await this.log(em, d.companyId, p.status === 'failed' ? 'agent_update_failed' : 'agent_update_rolled_back', `电脑「${d.name}」升级到 ${p.version} ${p.status === 'failed' ? '失败' : '后已回退'}：${text}`, { deviceId: d.id });
    });
    return { ok: true };
  }

  /** 领取下一条登录请求。开启了自动登录的店铺，凭据在这里一次性交给助手（写日志）。 */
  async agentClaim(token: string | undefined) {
    return this.dataSource.transaction(async (em) => {
      const d = await this.deviceByToken(em, token);
      await this.expireStale(em);
      const req = await em.findOne(SessionOpenRequest, { where: { deviceId: d.id, status: 'pending' }, order: { id: 'ASC' }, lock: { mode: 'pessimistic_write' } });
      if (!req) return { request: null };
      const shop = await em.findOne(SessionShop, { where: { id: req.shopId } });
      const store = shop ? await em.findOne(ResourceRecord, { where: { id: shop.storeId, companyId: d.companyId, type: 'stores' } }) : null;
      req.status = 'claimed'; req.claimedAt = new Date();
      await em.save(SessionOpenRequest, req);
      if (req.kind === 'capture') {
        return { request: { id: req.id, kind: req.kind, store: { id: shop?.storeId ?? 0, name: store?.title ?? '', platform: String(store?.data.platform ?? ''), url: String(store?.data.url ?? '') }, credentials: null } };
      }
      const deliver = !!shop?.autoLogin && !!shop.loginAccount && !!shop.loginPasswordEnc;
      if (deliver) await this.log(em, d.companyId, 'auto_login_credentials_delivered', `向电脑「${d.name}」交付店铺「${store?.title ?? ''}」的自动登录凭据`, { deviceId: d.id, storeId: shop!.storeId });
      return {
        request: {
          id: req.id, kind: req.kind,
          store: { id: shop?.storeId ?? 0, name: store?.title ?? '', platform: String(store?.data.platform ?? ''), url: String(store?.data.url ?? '') },
          credentials: deliver ? { account: shop!.loginAccount, password: this.crypto.decrypt(shop!.loginPasswordEnc!) } : null,
        },
      };
    });
  }

  async agentReport(token: string | undefined, id: number, p: { status: string; errorCode?: string; errorText?: string }) {
    if (!['succeeded', 'failed'].includes(p.status)) throw new BadRequestException('状态不对');
    return this.dataSource.transaction(async (em) => {
      const d = await this.deviceByToken(em, token);
      const req = await em.findOne(SessionOpenRequest, { where: { id, deviceId: d.id }, lock: { mode: 'pessimistic_write' } });
      if (!req) throw new NotFoundException('请求不存在');
      if (req.status !== 'claimed') throw new ConflictException('这条请求不是进行中的');
      const shop = await em.findOne(SessionShop, { where: { id: req.shopId }, lock: { mode: 'pessimistic_write' } });
      let text = (p.errorText ?? '').slice(0, 300);
      // 错误文案里不能带出密码
      if (shop?.loginPasswordEnc) { const pw = this.crypto.decrypt(shop.loginPasswordEnc); if (pw.length >= 3) text = text.split(pw).join('******'); }
      req.status = p.status as 'succeeded' | 'failed'; req.finishedAt = new Date();
      req.errorCode = p.status === 'failed' ? (p.errorCode ?? 'unknown').slice(0, 40) : null; req.errorText = p.status === 'failed' ? text || null : null;
      await em.save(SessionOpenRequest, req);
      if (shop && req.kind !== 'capture') {
        shop.loginState = p.status === 'succeeded' ? 'valid' : p.errorCode === 'login_expired' ? 'expired' : 'error';
        if (p.status === 'succeeded') shop.lastVerifiedAt = new Date();
        await em.save(SessionShop, shop);
      }
      await this.log(em, d.companyId, req.kind === 'capture' ? 'shop_capture_failed' : p.status === 'succeeded' ? 'shop_open_completed' : 'shop_open_failed', `${req.kind === 'capture' ? '截取店铺页面' : '店铺登录'}${p.status === 'succeeded' ? '成功' : '失败'}${text ? `：${text}` : ''}`, { deviceId: d.id, storeId: shop?.storeId });
      return { ok: true };
    });
  }
}

export type { User };

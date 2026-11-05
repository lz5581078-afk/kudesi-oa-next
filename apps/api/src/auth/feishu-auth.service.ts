import { FEISHU_DESKTOP_STATE_PREFIX, isFeishuDesktopState } from '@kudesi/shared';
import { User } from '../entities';
import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { AuthUser } from '../common/auth.decorators';
import { ExternalConfigService, FeishuConfig } from '../integrations/external-config.service';
import { FeishuClient } from '../integrations/feishu.client';
import { AuthService } from './auth.service';
export const hashState = (v: string) => createHash('sha256').update(v).digest('hex');
export const stateCookie = (state: string) => '__Host-feishu-' + hashState(state).slice(0, 20);
@Injectable()
export class FeishuAuthService {
  constructor(private readonly settings: ExternalConfigService, private readonly client: FeishuClient, private readonly auth: AuthService) {}
  async companies() {
    const rows = await this.settings.ds.query("SELECT c.id,c.name FROM companies c JOIN integration_settings s ON s.company_id=c.id AND s.setting_key='feishu' WHERE c.status='active'");
    const out: Array<{ id: number; name: string }> = [];
    for (const r of rows) {
      try { const c = await this.settings.read<FeishuConfig>(r.id, 'feishu'); if (c?.enabled && c.appId && c.appSecret && c.tenantKey) out.push({ id: Number(r.id), name: r.name }); }
      catch { /* 某家公司的损坏配置不能阻断其他公司的登录入口 */ }
    }
    return out;
  }
  private async config(companyId: number) {
    const [company] = await this.settings.ds.query("SELECT id FROM companies WHERE id=? AND status='active'", [companyId]);
    const cfg = await this.settings.read<FeishuConfig>(companyId, 'feishu');
    if (!company || !cfg?.enabled || !cfg.appId || !cfg.appSecret || !cfg.tenantKey) throw new BadRequestException('该公司尚未启用飞书授权');
    const origin = new URL(cfg.origin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new BadRequestException('飞书回调域名配置不合法');
    return cfg;
  }
  async start(companyId: number, user?: AuthUser) {
    return this.begin(companyId, user ? 'bind' : 'login', user);
  }
  async startDesktop(companyId: number) {
    return this.begin(companyId, 'desktop');
  }
  private async begin(companyId: number, purpose: 'bind' | 'login' | 'desktop', user?: AuthUser) {
    if (user && user.companyId !== companyId) throw new ForbiddenException();
    const cfg = await this.config(companyId);
    const nonce = randomBytes(32).toString('base64url');
    const state = purpose === 'desktop' ? FEISHU_DESKTOP_STATE_PREFIX + nonce : nonce;
    const browser = randomBytes(32).toString('base64url');
    const redirectUri = new URL(user ? '/feishu-bind' : '/login', cfg.origin).href;
    await this.settings.ds.query('DELETE FROM feishu_oauth_states WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
    await this.settings.ds.query('INSERT INTO feishu_oauth_states(state_hash,browser_hash,company_id,user_id,app_id,purpose,redirect_uri,expires_at) VALUES(?,?,?,?,?,?,?,DATE_ADD(NOW(),INTERVAL 10 MINUTE))', [hashState(state), hashState(browser), companyId, user?.id ?? null, cfg.appId, purpose, redirectUri]);
    const u = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    u.search = new URLSearchParams({ client_id: cfg.appId, response_type: 'code', redirect_uri: redirectUri, state }).toString();
    return { authorizationUrl: u.href, state, browser };
  }
  async complete(code: string, state: string, browser: string, user?: AuthUser) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(browser)) throw new UnauthorizedException('飞书授权状态无效，请重新发起');
    // 一次性原子消费；先匹配浏览器及用途，跨浏览器和重放均不能交换 code。
    const row = await this.settings.ds.transaction(async em => {
      const [r] = await em.query('SELECT * FROM feishu_oauth_states WHERE state_hash=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE', [hashState(state), hashState(browser)]);
      if (!r || r.purpose !== (user ? 'bind' : 'login') || (user && (Number(r.company_id) !== user.companyId || Number(r.user_id) !== user.id))) throw new UnauthorizedException('飞书授权已过期或不属于当前账号');
      await em.query('UPDATE feishu_oauth_states SET consumed_at=NOW() WHERE state_hash=?', [r.state_hash]);
      return r;
    });
    const { cfg, identity } = await this.resolveIdentity(code, row);
    if (user) {
      await this.settings.ds.transaction(async em => {
        await em.query('SELECT id FROM companies WHERE id=? FOR UPDATE', [user.companyId]);
        const [validState] = await em.query('SELECT state_hash FROM feishu_oauth_states WHERE company_id=? AND user_id=? AND state_hash=? AND consumed_at IS NOT NULL FOR UPDATE', [user.companyId, user.id, row.state_hash]);
        if (!validState) throw new UnauthorizedException('飞书关联已由管理员重置，请重新发起授权');
        const [other] = await em.query('SELECT user_id,company_id,open_id FROM feishu_identities WHERE app_id=? AND tenant_key=? AND open_id=? FOR UPDATE', [cfg.appId, cfg.tenantKey, identity.openId]);
        if (other && (Number(other.user_id) !== user.id || Number(other.company_id) !== user.companyId)) throw new ForbiddenException('此飞书账号已绑定其他员工');
        const [mine] = await em.query('SELECT open_id FROM feishu_identities WHERE company_id=? AND user_id=? AND app_id=? FOR UPDATE', [user.companyId, user.id, cfg.appId]);
        if (mine && mine.open_id !== identity.openId) throw new ForbiddenException('当前员工已绑定另一个飞书账号，请联系管理员');
        if (!await em.findOneBy(User, { id: user.id, companyId: user.companyId, status: 'active' })) throw new UnauthorizedException('员工已停用或不属于当前公司');
        try { await em.query('INSERT INTO feishu_identities(company_id,user_id,app_id,tenant_key,open_id,union_id,oa_notifications) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE union_id=VALUES(union_id),oa_notifications=GREATEST(oa_notifications,VALUES(oa_notifications))', [user.companyId, user.id, cfg.appId, cfg.tenantKey, identity.openId, identity.unionId, 1]); }
        catch { throw new ForbiddenException('飞书身份绑定冲突，请联系管理员'); }
        await em.query("INSERT INTO audit_logs(company_id,actor_id,action,resource_type,resource_id,detail) VALUES(?,?,'user.bind_feishu','user',?,NULL)", [user.companyId, user.id, String(user.id)]);
      });
      return { bound: true, allNotificationsEnabled: true };
    }
    const userId = await this.boundUser(Number(row.company_id), cfg, identity.openId);
    return this.auth.loginBoundUser(userId, Number(row.company_id));
  }
  private async resolveIdentity(code: string, row: { company_id: number; app_id: string; redirect_uri: string }) {
    const cfg = await this.config(Number(row.company_id));
    if (cfg.appId !== row.app_id) throw new UnauthorizedException('飞书应用已变更，请重新发起');
    let identity;
    try { identity = await this.client.identity(cfg, code, row.redirect_uri); } catch { throw new BadRequestException('飞书授权失败，请检查应用权限和回调白名单后重新授权'); }
    if (identity.tenantKey !== cfg.tenantKey) throw new ForbiddenException('请使用本企业的飞书账号');
    return { cfg, identity };
  }
  private async boundUser(companyId: number, cfg: FeishuConfig, openId: string) {
    const [bound] = await this.settings.ds.query('SELECT user_id FROM feishu_identities WHERE company_id=? AND app_id=? AND tenant_key=? AND open_id=?', [companyId, cfg.appId, cfg.tenantKey, openId]);
    if (!bound) throw new ForbiddenException('此飞书账号尚未绑定员工，请先用账号密码登录，再绑定飞书');
    return Number(bound.user_id);
  }
  async relayDesktop(code: string, state: string) {
    if (!isFeishuDesktopState(state)) throw new UnauthorizedException('飞书桌面授权状态无效');
    const stateHash = hashState(state);
    const [row] = await this.settings.ds.query("SELECT company_id,app_id,redirect_uri,user_id FROM feishu_oauth_states WHERE state_hash=? AND purpose='desktop' AND consumed_at IS NULL AND expires_at>NOW()", [stateHash]);
    if (!row || row.user_id !== null) throw new UnauthorizedException('飞书桌面授权已处理或过期');
    const { cfg, identity } = await this.resolveIdentity(code, row);
    // Record only the OA employee ID, and check the exact Feishu binding in the same update.
    const result = await this.settings.ds.query(
      "UPDATE feishu_oauth_states AS pending JOIN feishu_identities AS bound ON bound.company_id=pending.company_id AND bound.app_id=pending.app_id AND bound.tenant_key=? AND bound.open_id=? SET pending.user_id=bound.user_id WHERE pending.state_hash=? AND pending.purpose='desktop' AND pending.user_id IS NULL AND pending.consumed_at IS NULL AND pending.expires_at>NOW()",
      [cfg.tenantKey, identity.openId, stateHash],
    );
    if (result.affectedRows !== 1) {
      await this.boundUser(Number(row.company_id), cfg, identity.openId);
      throw new UnauthorizedException('飞书桌面授权已处理或过期');
    }
    return { received: true };
  }
  async pollDesktop(state: string, browser: string) {
    if (!isFeishuDesktopState(state) || !/^[A-Za-z0-9_-]{43}$/.test(browser)) throw new UnauthorizedException('飞书桌面授权状态无效，请重新发起');
    const row = await this.settings.ds.transaction(async em => {
      const [pending] = await em.query("SELECT state_hash,company_id,user_id,app_id FROM feishu_oauth_states WHERE state_hash=? AND browser_hash=? AND purpose='desktop' AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE", [hashState(state), hashState(browser)]);
      if (!pending) throw new UnauthorizedException('飞书桌面授权已过期或不属于当前窗口');
      if (pending.user_id === null) return null;
      await em.query('UPDATE feishu_oauth_states SET consumed_at=NOW() WHERE state_hash=?', [pending.state_hash]);
      return pending;
    });
    if (!row) return { login: null };
    const cfg = await this.config(Number(row.company_id));
    const [bound] = await this.settings.ds.query('SELECT user_id FROM feishu_identities WHERE company_id=? AND user_id=? AND app_id=? AND tenant_key=?', [row.company_id, row.user_id, cfg.appId, cfg.tenantKey]);
    if (cfg.appId !== row.app_id || !bound) throw new UnauthorizedException('飞书绑定已变更，请重新授权');
    return { login: await this.auth.loginBoundUser(Number(row.user_id), Number(row.company_id)) };
  }
  async status(user: AuthUser) {
    const cfg = await this.config(user.companyId);
    const [r] = await this.settings.ds.query('SELECT bound_at,oa_notifications FROM feishu_identities WHERE company_id=? AND user_id=? AND app_id=? AND tenant_key=?', [user.companyId, user.id, cfg.appId, cfg.tenantKey]);
    const [sw] = await this.settings.ds.query("SELECT enabled FROM outbox_switches WHERE company_id=? AND channel='feishu'", [user.companyId]);
    return { configured: true, bound: Boolean(r), boundAt: r?.bound_at ?? null, allNotificationsEnabled: Boolean(r?.oa_notifications), notificationsEnabled: Boolean(sw?.enabled) };
  }
}

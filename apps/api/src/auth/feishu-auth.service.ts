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
    if (user && user.companyId !== companyId) throw new ForbiddenException();
    const cfg = await this.config(companyId), state = randomBytes(32).toString('base64url'), browser = randomBytes(32).toString('base64url');
    const redirectUri = new URL(user ? '/feishu-bind' : '/login', cfg.origin).href;
    await this.settings.ds.query('DELETE FROM feishu_oauth_states WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
    await this.settings.ds.query('INSERT INTO feishu_oauth_states(state_hash,browser_hash,company_id,user_id,app_id,purpose,redirect_uri,expires_at) VALUES(?,?,?,?,?,?,?,DATE_ADD(NOW(),INTERVAL 10 MINUTE))', [hashState(state), hashState(browser), companyId, user?.id ?? null, cfg.appId, user ? 'bind' : 'login', redirectUri]);
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
    const cfg = await this.config(Number(row.company_id));
    if (cfg.appId !== row.app_id) throw new UnauthorizedException('飞书应用已变更，请重新发起');
    let identity;
    try { identity = await this.client.identity(cfg, code, row.redirect_uri); } catch { throw new BadRequestException('飞书授权失败，请检查应用权限和回调白名单后重新授权'); }
    if (identity.tenantKey !== cfg.tenantKey) throw new ForbiddenException('请使用本企业的飞书账号');
    if (user) {
      await this.settings.ds.transaction(async em => {
        const [other] = await em.query('SELECT user_id,company_id,open_id FROM feishu_identities WHERE app_id=? AND tenant_key=? AND open_id=? FOR UPDATE', [cfg.appId, cfg.tenantKey, identity.openId]);
        if (other && (Number(other.user_id) !== user.id || Number(other.company_id) !== user.companyId)) throw new ForbiddenException('此飞书账号已绑定其他员工');
        const [mine] = await em.query('SELECT open_id FROM feishu_identities WHERE company_id=? AND user_id=? AND app_id=? FOR UPDATE', [user.companyId, user.id, cfg.appId]);
        if (mine && mine.open_id !== identity.openId) throw new ForbiddenException('当前员工已绑定另一个飞书账号，请联系管理员');
        try { await em.query('INSERT INTO feishu_identities(company_id,user_id,app_id,tenant_key,open_id,union_id) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE union_id=VALUES(union_id)', [user.companyId, user.id, cfg.appId, cfg.tenantKey, identity.openId, identity.unionId]); }
        catch { throw new ForbiddenException('飞书身份绑定冲突，请联系管理员'); }
        await em.query("INSERT INTO audit_logs(company_id,actor_id,action,resource_type,resource_id,detail) VALUES(?,?,'user.bind_feishu','user',?,NULL)", [user.companyId, user.id, String(user.id)]);
      });
      return { bound: true };
    }
    const [bound] = await this.settings.ds.query('SELECT user_id FROM feishu_identities WHERE company_id=? AND app_id=? AND tenant_key=? AND open_id=?', [Number(row.company_id), cfg.appId, cfg.tenantKey, identity.openId]);
    if (!bound) throw new ForbiddenException('此飞书账号尚未绑定员工，请先用账号密码登录，再绑定飞书');
    return this.auth.loginBoundUser(Number(bound.user_id), Number(row.company_id));
  }
  async status(user: AuthUser) {
    const cfg = await this.config(user.companyId);
    const [r] = await this.settings.ds.query('SELECT bound_at FROM feishu_identities WHERE company_id=? AND user_id=? AND app_id=? AND tenant_key=?', [user.companyId, user.id, cfg.appId, cfg.tenantKey]);
    return { configured: true, bound: Boolean(r), boundAt: r?.bound_at ?? null };
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { checkHttpUrl } from './integration-settings.service';
import type { VisionConfig } from './vision.client';

/** 内置识别功能用哪个服务商的哪个模型（旧系统 ai_company_settings 的两个 key）。 */
export const AI_SCOPES = {
  business_license_recognition: '营业执照识别',
  express_price_recognition: '快递价格表识别',
} as const;
export type AiScope = keyof typeof AI_SCOPES;
export const AI_SYNC_CHANNEL = 'ai_models';

export interface RemoteModel { id: string; ownedBy?: string | null }
export interface AiProviderRow { id: number; providerKey: string; name: string; baseUrl: string; modelName: string | null; status: string; lastSyncedAt: string | null; lastSyncError: string | null; modelCount: number }
export type ModelFetcher = (baseUrl: string, apiKey: string) => Promise<RemoteModel[]>;

/** 默认的模型清单读取：只发一个 GET {baseUrl}/models，不写任何东西；超时 20 秒，最多收 500 个。 */
export const fetchRemoteModels: ModelFetcher = async (baseUrl, apiKey) => {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`服务商返回 ${res.status}`);
  let data: { data?: Array<{ id?: unknown; owned_by?: unknown }> };
  try { data = JSON.parse(text); } catch { throw new Error('服务商返回的不是 JSON'); }
  return (data.data ?? []).filter((m) => typeof m.id === 'string').slice(0, 500).map((m) => ({ id: String(m.id), ownedBy: typeof m.owned_by === 'string' ? m.owned_by : null }));
};

/** 按模型名推断用途和调用方式（和旧系统一样是名字规则，仅用于展示和筛选）。 */
export function inferModel(id: string): { endpointType: string; capabilities: string[] } {
  const n = id.toLowerCase();
  const caps: string[] = [];
  let endpointType = 'chat-completions';
  if (/embed/.test(n)) { endpointType = 'embeddings'; caps.push('embedding'); }
  else if (/(dall-e|image|flux|sdxl|midjourney)/.test(n)) { endpointType = 'images'; caps.push('image-generation'); }
  else if (/(video|sora|veo|kling)/.test(n)) { endpointType = 'videos'; caps.push('video-generation'); }
  else {
    caps.push('text');
    if (/(gpt-4o|gpt-4\.1|gpt-5|vision|-vl|gemini|claude|qwen-vl|o1|o3|o4)/.test(n)) caps.push('vision');
    if (/(gpt-5|o1|o3|o4|codex)/.test(n)) endpointType = 'responses';
  }
  return { endpointType, capabilities: caps };
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** 多个 AI 服务商：密钥加密保存且任何接口都不返回；模型同步只在“模型同步开关”打开时才会真的去服务商读清单（默认关）。 */
@Injectable()
export class AiProviderService {
  /** 测试里替换成假的，避免连真实服务商 */
  fetchModels: ModelFetcher = fetchRemoteModels;

  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly crypto: CryptoService) {}

  private admin(user: AuthUser) { if (!user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员能改这项设置'); }

  async syncEnabled(companyId: number) {
    const [r] = await this.ds.query('SELECT enabled FROM outbox_switches WHERE company_id = ? AND channel = ?', [companyId, AI_SYNC_CHANNEL]);
    return Boolean(r?.enabled);
  }

  async setSyncEnabled(user: AuthUser, enabled: boolean) {
    this.admin(user);
    await this.ds.query(
      'INSERT INTO outbox_switches (company_id, channel, enabled, note, updated_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), note = VALUES(note), updated_by = VALUES(updated_by)',
      [user.companyId, AI_SYNC_CHANNEL, enabled ? 1 : 0, 'AI 模型同步', user.id]);
    return { syncEnabled: enabled };
  }

  async overview(companyId: number) {
    const providers: AiProviderRow[] = await this.ds.query(
      `SELECT p.id, p.provider_key AS providerKey, p.name, p.base_url AS baseUrl, p.model_name AS modelName, p.status, p.last_synced_at AS lastSyncedAt, p.last_sync_error AS lastSyncError,
              (SELECT COUNT(*) FROM ai_models m WHERE m.provider_id = p.id) AS modelCount
       FROM ai_providers p WHERE p.company_id = ? ORDER BY p.id`, [companyId]);
    return {
      syncEnabled: await this.syncEnabled(companyId),
      providers: providers.map((p) => ({ ...p, modelCount: Number(p.modelCount), apiKeyConfigured: true })),
    };
  }

  private async owned(companyId: number, id: number) {
    const [p] = await this.ds.query('SELECT * FROM ai_providers WHERE id = ? AND company_id = ?', [id, companyId]);
    if (!p) throw new NotFoundException('服务商不存在');
    return p as { id: number; provider_key: string; name: string; base_url: string; model_name: string | null; api_key_enc: string; status: string };
  }

  private check(p: { name?: string; baseUrl?: string; modelName?: string | null; status?: string }) {
    if (!p.name?.trim() || p.name.trim().length > 80) throw new BadRequestException('服务商名称必填，不超过 80 字');
    if (p.modelName && p.modelName.length > 100) throw new BadRequestException('模型名不超过 100 字');
    if (p.status && !['active', 'testing', 'inactive'].includes(p.status)) throw new BadRequestException('状态不合法');
  }

  async save(user: AuthUser, id: number | null, p: { name: string; baseUrl: string; apiKey?: string; modelName?: string | null; status?: string }) {
    this.check(p);
    const baseUrl = checkHttpUrl(p.baseUrl ?? '', '接口地址');
    const apiKey = p.apiKey?.trim();
    if (!id) {
      if (!apiKey) throw new BadRequestException('请填写 API Key');
      const key = slug(p.name) || `provider-${Date.now().toString(36)}`;
      try {
        const r = await this.ds.query('INSERT INTO ai_providers (company_id, provider_key, name, base_url, model_name, api_key_enc, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [user.companyId, key, p.name.trim(), baseUrl, p.modelName?.trim() || null, this.crypto.encrypt(apiKey), p.status ?? 'active', user.id]);
        return { id: Number(r.insertId) };
      } catch (e) {
        if ((e as { code?: string }).code === 'ER_DUP_ENTRY') throw new ConflictException('已经有同名的服务商');
        throw e;
      }
    }
    await this.owned(user.companyId, id);
    await this.ds.query('UPDATE ai_providers SET name = ?, base_url = ?, model_name = ?, status = ?, api_key_enc = COALESCE(?, api_key_enc) WHERE id = ? AND company_id = ?',
      [p.name.trim(), baseUrl, p.modelName?.trim() || null, p.status ?? 'active', apiKey ? this.crypto.encrypt(apiKey) : null, id, user.companyId]);
    return { id };
  }

  async remove(user: AuthUser, id: number) {
    await this.owned(user.companyId, id);
    await this.ds.query('DELETE FROM ai_providers WHERE id = ? AND company_id = ?', [id, user.companyId]); // 模型目录和默认模型设置级联删除
    return { ok: true };
  }

  async models(companyId: number, id: number) {
    await this.owned(companyId, id);
    const rows: Array<{ modelId: string; ownedBy: string | null; endpointType: string; capabilities: unknown; syncedAt: string }> = await this.ds.query(
      'SELECT model_id AS modelId, owned_by AS ownedBy, endpoint_type AS endpointType, capabilities, synced_at AS syncedAt FROM ai_models WHERE provider_id = ? AND company_id = ? ORDER BY model_id', [id, companyId]);
    return rows.map((r) => ({ ...r, capabilities: typeof r.capabilities === 'string' ? JSON.parse(r.capabilities) : r.capabilities ?? [] }));
  }

  /** 从服务商同步模型清单。开关没开就不碰外部：这是对外网络访问，必须管理员明确打开。 */
  async syncModels(user: AuthUser, id: number) {
    if (!(await this.syncEnabled(user.companyId))) throw new ConflictException('模型同步开关是关着的。确认要连接服务商后，由管理员先打开“模型同步”开关。');
    const p = await this.owned(user.companyId, id);
    let apiKey: string;
    try { apiKey = this.crypto.decrypt(p.api_key_enc); } catch { throw new BadRequestException('这个服务商的 API Key 无法解密，请重新保存 API Key'); }
    let list: RemoteModel[];
    try {
      list = await this.fetchModels(p.base_url, apiKey);
    } catch (e) {
      const msg = (e as Error).message.replace(apiKey, '***').slice(0, 280);
      await this.ds.query('UPDATE ai_providers SET last_sync_error = ? WHERE id = ?', [msg, id]);
      throw new BadRequestException(`同步失败：${msg}`);
    }
    await this.ds.transaction(async (em) => {
      for (const m of list) {
        const inf = inferModel(m.id);
        await em.query(
          'INSERT INTO ai_models (company_id, provider_id, model_id, owned_by, endpoint_type, capabilities) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE owned_by = VALUES(owned_by), endpoint_type = VALUES(endpoint_type), capabilities = VALUES(capabilities), synced_at = CURRENT_TIMESTAMP',
          [user.companyId, id, m.id, m.ownedBy ?? null, inf.endpointType, JSON.stringify(inf.capabilities)]);
      }
      await em.query('UPDATE ai_providers SET last_synced_at = NOW(), last_sync_error = NULL WHERE id = ?', [id]);
    });
    return { synced: list.length };
  }

  // ---------- 识别场景的默认模型（OCR 设置页） ----------

  async defaults(companyId: number) {
    const set: Array<{ key: string; providerId: number; modelId: string }> = await this.ds.query('SELECT setting_key AS `key`, provider_id AS providerId, model_id AS modelId FROM ai_company_settings WHERE company_id = ?', [companyId]);
    const providers: Array<{ id: number; name: string; status: string; modelName: string | null }> = await this.ds.query('SELECT id, name, status, model_name AS modelName FROM ai_providers WHERE company_id = ? ORDER BY id', [companyId]);
    const models: Array<{ providerId: number; modelId: string }> = await this.ds.query('SELECT provider_id AS providerId, model_id AS modelId FROM ai_models WHERE company_id = ? ORDER BY model_id', [companyId]);
    return {
      scopes: Object.entries(AI_SCOPES).map(([key, label]) => ({ key, label, current: set.find((s) => s.key === key) ?? null })),
      providers: providers.map((p) => ({ id: p.id, name: p.name, status: p.status, models: [...new Set([...(p.modelName ? [p.modelName] : []), ...models.filter((m) => m.providerId === p.id).map((m) => m.modelId)])] })),
    };
  }

  async setDefault(user: AuthUser, scope: string, providerId: number | null, modelId?: string) {
    if (!(scope in AI_SCOPES)) throw new BadRequestException('识别场景不存在');
    if (providerId === null) {
      await this.ds.query('DELETE FROM ai_company_settings WHERE company_id = ? AND setting_key = ?', [user.companyId, scope]);
      return { ok: true };
    }
    const p = await this.owned(user.companyId, providerId);
    if (p.status === 'inactive') throw new BadRequestException('这个服务商已停用');
    const model = modelId?.trim();
    if (!model) throw new BadRequestException('请选择模型');
    const [known] = await this.ds.query('SELECT 1 AS ok FROM ai_models WHERE provider_id = ? AND model_id = ?', [providerId, model]);
    if (!known && p.model_name !== model) throw new BadRequestException('这个模型不在该服务商的模型清单里，请先同步模型或在服务商里填写默认模型名');
    await this.ds.query('INSERT INTO ai_company_settings (company_id, setting_key, provider_id, model_id, updated_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE provider_id = VALUES(provider_id), model_id = VALUES(model_id), updated_by = VALUES(updated_by)',
      [user.companyId, scope, providerId, model, user.id]);
    return { ok: true };
  }

  /** 给识别功能用：这个场景选了默认模型就用它，没选返回 null（调用方回退到“接口设置”里的识别大模型）。 */
  async resolveVision(companyId: number, scope: AiScope): Promise<VisionConfig | null> {
    const [r] = await this.ds.query(
      `SELECT p.base_url AS baseUrl, p.api_key_enc AS enc, p.status, s.model_id AS model FROM ai_company_settings s JOIN ai_providers p ON p.id = s.provider_id
       WHERE s.company_id = ? AND s.setting_key = ? AND p.company_id = s.company_id`, [companyId, scope]);
    if (!r || r.status === 'inactive') return null;
    try { return { baseUrl: r.baseUrl, apiKey: this.crypto.decrypt(r.enc), model: r.model, enabled: true }; } catch { return null; }
  }
}

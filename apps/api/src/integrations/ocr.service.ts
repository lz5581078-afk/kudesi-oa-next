import { BadRequestException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { AiProviderService, type AiScope } from './ai-providers.service';
import { IntegrationSettingsService } from './integration-settings.service';
import { sniffFile, UploadedFile } from './files.service';
import { extractJson, VisionClient, VisionConfig } from './vision.client';
import { normalizePriceTable, normalizeSurchargeNotice, PRICE_TABLE_PROMPT, RecognitionKind, SURCHARGE_PROMPT, xlsxToText } from './express-recognition';

const LICENSE_PROMPT = `你是营业执照信息提取助手。请识别图片中的营业执照，只输出一个 JSON 对象，不要任何解释。
字段（识别不到的填空字符串）：
companyName 主体名称/名称；creditCode 统一社会信用代码；legalPerson 法定代表人/经营者；licenseType 类型；
registeredCapital 注册资本；address 住所/经营场所；businessScope 经营范围；foundedAt 成立日期；approvedAt 核准日期；registrar 登记机关。
日期统一写成 YYYY-MM-DD。统一社会信用代码是 18 位数字和大写字母。`;

const EXPRESS_PROMPT = `你是快递报价表识别助手。请识别图片里的快递价格表，只输出一个 JSON 对象，不要任何解释，格式：
{"carrier":"快递公司","branch":"网点（没有就空字符串）","validFrom":"YYYY-MM-DD 或空","validTo":"YYYY-MM-DD 或空","rows":[
 {"province":"目的省份（全国统一价写 全国）","weightMin":重量下限kg数字,"weightMax":重量上限kg数字或null,"firstWeight":首重kg数字或null,"firstPrice":首重价（元）或null,"extraPrice":续重每kg价（元）或null,"fixedPrice":固定价（元）或null}
]}
省份只写简称（如 广东、内蒙古）；价格单位是元，数字不要带单位；看不清的字段填 null，不要猜。`;

const FIELDS = ['companyName', 'creditCode', 'legalPerson', 'licenseType', 'registeredCapital', 'address', 'businessScope', 'foundedAt', 'approvedAt', 'registrar'] as const;

/** 把“2015年03月12日”“2015.3.12”等写法统一成 YYYY-MM-DD；认不出来返回空。 */
export function normalizeDate(input: unknown): string {
  if (typeof input !== 'string') return '';
  const m = input.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
  if (!m) return '';
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeLicenseFields(raw: Record<string, unknown>) {
  const fields: Record<string, string> = {};
  const warnings: string[] = [];
  for (const key of FIELDS) {
    const v = raw[key];
    if (typeof v === 'string' && v.trim()) fields[key] = v.trim();
  }
  for (const key of ['foundedAt', 'approvedAt'] as const) {
    if (fields[key]) {
      const d = normalizeDate(fields[key]);
      if (d) fields[key] = d;
      else {
        delete fields[key];
        warnings.push('有一个日期没认出来，已留空');
      }
    }
  }
  if (fields.creditCode) {
    fields.creditCode = fields.creditCode.replace(/\s+/g, '').toUpperCase();
    if (!/^[0-9A-Z]{18}$/.test(fields.creditCode)) warnings.push('统一社会信用代码不是 18 位，请核对');
  }
  return { fields, warnings };
}

/** 营业执照识别：用管理员在“接口设置”里配置的视觉大模型，结果交给前端确认后再填入，不直接入库。 */
@Injectable()
export class OcrService {
  /** 测试里可替换成假的识别客户端 */
  visionFactory: (cfg: VisionConfig) => VisionClient = (cfg) => new VisionClient(cfg);

  constructor(private readonly settings: IntegrationSettingsService, @Optional() private readonly ai?: AiProviderService) {}

  /** 这个识别场景在“OCR 设置”里选了默认模型就用它，否则用“接口设置”里的识别大模型。 */
  private async visionFor(companyId: number, scope: AiScope) {
    return (await this.ai?.resolveVision(companyId, scope)) ?? (await this.settings.getVision(companyId));
  }

  async recognizeLicense(user: AuthUser, file: UploadedFile | undefined) {
    const can = createChecker(user.permissions);
    if (!can('resource.licenses.create') && !can('resource.licenses.edit')) throw new ForbiddenException('没有权限执行此操作');
    const cfg = await this.visionFor(user.companyId, 'business_license_recognition');
    if (!cfg || !cfg.enabled) throw new BadRequestException('还没有启用识别接口，请先到“系统 → 接口设置”填写并启用');
    if (!file || file.size === 0) throw new BadRequestException('没有收到图片');
    if (file.size > 8 * 1024 * 1024) throw new BadRequestException('图片不能超过 8MB');
    const kind = sniffFile(file.buffer);
    if (!kind?.image) throw new BadRequestException('只能识别图片（png、jpg、webp）');

    let reply: string;
    try {
      reply = await this.visionFactory(cfg).recognize(LICENSE_PROMPT, `data:${kind.mime};base64,${file.buffer.toString('base64')}`);
    } catch (e) {
      throw new BadRequestException(`识别失败：${(e as Error).message}`);
    }
    const parsed = extractJson(reply);
    if (!parsed) throw new BadRequestException('识别结果无法解析，请换一张更清晰的图片重试');
    const { fields, warnings } = normalizeLicenseFields(parsed);
    if (Object.keys(fields).length === 0) throw new BadRequestException('没有识别出任何内容，请换一张更清晰的图片重试');
    return { fields, warnings, rawText: reply.slice(0, 4000) };
  }

  /** 快递价格表图片 → 待确认的价格行；不入库，确认后才逐行建“快递价格表”记录 */
  async recognizeExpress(user: AuthUser, file: UploadedFile | undefined, provinces: readonly string[]) {
    const can = createChecker(user.permissions);
    if (!can('resource.finance-express-prices.create')) throw new ForbiddenException('没有权限执行此操作');
    const cfg = await this.visionFor(user.companyId, 'express_price_recognition');
    if (!cfg || !cfg.enabled) throw new BadRequestException('还没有启用识别接口，请先到“系统 → 接口设置”填写并启用');
    if (!file || file.size === 0) throw new BadRequestException('没有收到图片');
    if (file.size > 8 * 1024 * 1024) throw new BadRequestException('图片不能超过 8MB');
    const kind = sniffFile(file.buffer);
    if (!kind?.image) throw new BadRequestException('只能识别图片（png、jpg、webp）');
    let reply: string;
    try {
      reply = await this.visionFactory(cfg).recognize(EXPRESS_PROMPT, `data:${kind.mime};base64,${file.buffer.toString('base64')}`);
    } catch (e) {
      throw new BadRequestException(`识别失败：${(e as Error).message}`);
    }
    const parsed = extractJson(reply);
    if (!parsed) throw new BadRequestException('识别结果无法解析，请换一张更清晰的图片重试');
    const out = normalizeExpressRows(parsed, provinces);
    if (out.rows.length === 0) throw new BadRequestException('没有识别出价格行，请换一张更清晰的图片重试');
    return { ...out, rawText: reply.slice(0, 4000) };
  }

  /**
   * 快递价格表 / 临时加收通知识别（图片、Excel、CSV、文本都行）。只返回待确认的草稿，不入库。
   * 价格表识别要有快递价格表的“编辑”权限，加收通知同理。
   */
  async recognizeExpressDocument(user: AuthUser, file: UploadedFile | undefined, kind: RecognitionKind, provinces: readonly string[]) {
    const can = createChecker(user.permissions);
    if (!can('resource.finance-express-prices.edit')) throw new ForbiddenException('没有权限执行此操作');
    const cfg = await this.visionFor(user.companyId, 'express_price_recognition');
    if (!cfg || !cfg.enabled) throw new BadRequestException('还没有启用识别接口，请先到“系统 → 接口设置”填写并启用');
    if (!file || file.size === 0) throw new BadRequestException('没有收到文件');
    if (file.size > 8 * 1024 * 1024) throw new BadRequestException('文件不能超过 8MB');
    const prompt = kind === 'surcharge_notice' ? SURCHARGE_PROMPT : PRICE_TABLE_PROMPT;
    const sniff = sniffFile(file.buffer);
    const name = (file as { originalname?: string }).originalname ?? '';
    const client = this.visionFactory(cfg);
    let reply: string;
    try {
      if (sniff?.image) {
        reply = await client.recognize(prompt, `data:${sniff.mime};base64,${file.buffer.toString('base64')}`);
      } else {
        let content: string;
        if (file.buffer.subarray(0, 2).toString('latin1') === 'PK') content = xlsxToText(file.buffer);
        else if (/\.(csv|txt)$/i.test(name) || !file.buffer.subarray(0, 512).includes(0)) content = file.buffer.toString('utf8');
        else throw new BadRequestException('只能识别图片、Excel（xlsx）、CSV 和文本文件');
        if (!content.trim()) throw new BadRequestException('文件里没有读到文字内容');
        reply = await client.recognizeText(`${prompt}\n\n以下是上传文件中可直接读取的文字内容：\n${content.slice(0, 40000)}`);
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`识别失败：${(e as Error).message}`);
    }
    const parsed = extractJson(reply);
    if (!parsed) throw new BadRequestException('识别结果无法解析，请换一个更清晰的文件重试');
    const out = kind === 'surcharge_notice' ? normalizeSurchargeNotice(parsed, provinces) : normalizePriceTable(parsed, provinces);
    if (out.rows.length === 0) throw new BadRequestException(kind === 'surcharge_notice' ? '没有识别出加收规则，请换一个更清晰的文件重试' : '没有识别出价格行，请换一个更清晰的文件重试');
    return { kind, ...out, modelName: cfg.model, fileName: name, rawText: reply.slice(0, 4000) };
  }

  async pingVision(user: AuthUser) {
    const cfg = await this.settings.getVision(user.companyId);
    if (!cfg) throw new BadRequestException('还没有保存识别接口设置');
    try {
      const reply = await this.visionFactory(cfg).ping();
      return { ok: true, message: `接口可用，模型回复：${reply.slice(0, 40)}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}


export interface ExpressRowDraft {
  carrier: string; branch: string; province: string;
  shipWeightMin: number | null; shipWeightMax: number | null; firstWeight: number | null;
  firstPrice: number | null; extraPrice: number | null; fixedPrice: number | null;
  validFrom: string; validTo: string; warnings: string[];
}

const toNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const n = Number(v.replace(/[^\d.\-]/g, '')); return v.trim() && Number.isFinite(n) ? n : null; }
  return null;
};
const toCents = (v: unknown): number | null => { const n = toNum(v); return n === null ? null : Math.round(n * 100); };

/** 把模型识别出的报价表整理成可以导入“快递价格表”的行（金额转成分）；认不准的行带上提醒，交给人确认 */
export function normalizeExpressRows(raw: Record<string, unknown>, provinces: readonly string[]): { rows: ExpressRowDraft[]; warnings: string[] } {
  const warnings: string[] = [];
  const carrier = typeof raw.carrier === 'string' ? raw.carrier.trim() : '';
  const branch = typeof raw.branch === 'string' ? raw.branch.trim() : '';
  const validFrom = normalizeDate(raw.validFrom), validTo = normalizeDate(raw.validTo);
  if (!carrier) warnings.push('没有识别出快递公司，请手工填写');
  const list = Array.isArray(raw.rows) ? raw.rows : [];
  const rows: ExpressRowDraft[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const w: string[] = [];
    let province = typeof r.province === 'string' ? r.province.trim() : '';
    if (/^(全国|全部|ALL)$/i.test(province)) province = 'ALL';
    else {
      const hit = provinces.find((p) => province === p || province.startsWith(p));
      if (hit) province = hit; else { w.push(`省份「${province || '空'}」不在省份清单里`); }
    }
    const row: ExpressRowDraft = {
      carrier, branch, province, shipWeightMin: toNum(r.weightMin) ?? 0, shipWeightMax: toNum(r.weightMax), firstWeight: toNum(r.firstWeight),
      firstPrice: toCents(r.firstPrice), extraPrice: toCents(r.extraPrice), fixedPrice: toCents(r.fixedPrice), validFrom, validTo, warnings: w,
    };
    if (row.fixedPrice === null && (row.firstWeight === null || row.firstPrice === null)) w.push('没有固定价，也缺首重或首重价');
    if (row.shipWeightMax !== null && row.shipWeightMax <= (row.shipWeightMin ?? 0)) w.push('重量上限必须大于下限');
    rows.push(row);
  }
  if (rows.length === 0) warnings.push('没有识别出价格行');
  return { rows, warnings };
}

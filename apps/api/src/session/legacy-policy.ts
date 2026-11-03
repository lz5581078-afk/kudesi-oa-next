import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionWorkspace } from './legacy-store';

type Action = 'view' | 'manage' | 'remote' | 'agent';
type Route = { method: string; pattern: RegExp; action: Action; fields?: readonly string[] };
const uuid = '[0-9a-f-]{36}';
const route = (method: string, pattern: string, action: Action, fields?: string[]): Route => ({ method, pattern: new RegExp(`^${pattern}$`, 'i'), action, fields });
const ROUTES: Route[] = [
  route('GET', '/(overview|store-abnormal-reasons|devices|audit-logs|oa-context)', 'view'),
  route('GET', '/shop-candidates', 'manage'),
  route('GET', '/shops/\\d+', 'view'), route('GET', `/open-requests/${uuid}`, 'view'),
  route('POST', '/pairings', 'manage', []), route('POST', '/managed-shops', 'manage', ['storeIds', 'assignedDeviceId']),
  route('PATCH', '/managed-shops/\\d+/assigned-device', 'manage', ['deviceId', 'expectedDeviceId']),
  route('DELETE', '/managed-shops/\\d+', 'manage'),
  route('PATCH', '/managed-shops/\\d+/auto-login', 'manage', ['enabled']),
  route('PATCH', '/managed-shops/\\d+/login-credentials', 'manage', ['account', 'password', 'clearPassword']),
  route('POST', '/shops/\\d+/credentials/reveal', 'manage', ['purpose']),
  route('PATCH', '/shops/\\d+/archive-status', 'manage', ['status', 'abnormalReason', 'abnormalReasonId', 'reason']),
  route('POST', '/open-requests', 'manage', ['storeId', 'deviceId', 'purpose']), route('DELETE', `/open-requests/${uuid}`, 'manage'),
  route('PATCH', `/devices/${uuid}/(revoke|restore)`, 'manage', []), route('DELETE', `/devices/${uuid}`, 'manage'),
  route('PATCH', `/devices/${uuid}/remark`, 'manage', ['remark']), route('PATCH', `/oa-devices/${uuid}/name`, 'manage', ['name']),
  route('GET', '/releases/windows/(latest|download)', 'manage'), route('POST', '/devices/update-all', 'manage', []), route('POST', `/devices/${uuid}/update`, 'manage', []),
  route('GET', '/browser-sessions/active', 'remote'), route('POST', '/remote-sessions', 'remote', ['browserSessionId', 'deviceId', 'shopId']),
  route('GET', `/remote-sessions/${uuid}(/frame|/commands/\\d+)?`, 'remote'),
  route('POST', `/remote-sessions/${uuid}/(webrtc-ticket|heartbeat|jpeg-fallback|webrtc-recover|end)`, 'remote', []),
  route('DELETE', `/remote-sessions/${uuid}`, 'remote'), route('POST', `/remote-sessions/${uuid}/commands`, 'remote', ['kind', 'phase', 'point', 'deltaY', 'points']),
  route('GET', '/oa-remote/(devices|history)', 'view'), route('POST', `/oa-remote/devices/${uuid}`, 'manage', ['enabled', 'allowControl', 'maxMinutes']), route('POST', '/oa-remote/stop-all', 'manage', []),
  route('POST', '/oa-capture/\\d+', 'view', []), route('GET', `/oa-requests/${uuid}`, 'view'),
  route('POST', '/agent/register', 'agent', ['pairingCode', 'name', 'hostname', 'platform', 'arch', 'agentVersion', 'publicKeyPem']),
  route('POST', '/agent/heartbeat', 'agent', ['agentVersion', 'currentStep', 'currentRequestId', 'activeBrowserSessionIds']),
  route('GET', '/agent/(open-requests|remote|update-jobs|sessions|device-keys)', 'agent'),
  route('PATCH', `/agent/open-requests/${uuid}`, 'agent', ['status', 'progress', 'currentStep', 'errorCode', 'errorMessage']),
  route('POST', '/agent/browser-sessions', 'agent', ['openRequestId', 'storeId', 'localProfileId', 'platformCode', 'pageUrl']),
  route('PATCH', `/agent/browser-sessions/${uuid}`, 'agent', ['action', 'pageUrl']),
  route('POST', '/agent/remote', 'agent', ['action', 'sessionId', 'browserSessionId', 'shopId', 'localProfileId', 'stage', 'error', 'pageUrl', 'width', 'height', 'frame']),
  route('PATCH', '/agent/remote', 'agent', ['commandId', 'ok', 'error']),
  route('POST', `/agent/remote-sessions/${uuid}/webrtc-ticket`, 'agent', []),
  route('GET', '/agent/releases/windows/(latest|download)', 'agent'), route('POST', '/agent/update-jobs/request', 'agent', []),
  route('PATCH', `/agent/update-jobs/${uuid}`, 'agent', ['status', 'progress', 'phase', 'errorMessage', 'downloadedBytes', 'totalBytes', 'failureCode']),
  route('POST', '/agent/bindings', 'agent', ['storeId', 'localProfileId', 'platformCode', 'loginStatus', 'sessionVersion', 'appliedSessionVersion', 'localStateHash', 'lastError', 'verification']),
  // Old client probes this intentionally disabled endpoint; original core returns 410.
  route('POST', '/agent/sessions', 'agent', ['storeId', 'localProfileId', 'platformCode', 'storageState', 'localStateHash', 'version']),
];
const QUERY_KEYS = new Set(['workspaceKey', 'assignedDeviceId', 'deviceId', 'keyword', 'loginStatus', 'status', 'storeStatus', 'sort', 'page', 'pageSize', 'historyLimit', 'shopId', 'transport', 'fromVersion']);

export function legacyRequestPolicy(req: Pick<Request, 'method' | 'path' | 'body' | 'query'>) {
  const policy = ROUTES.find(r => req.method === r.method && r.pattern.test(req.path));
  if (!policy) throw new NotFoundException('店铺登录接口不存在');
  if (Object.entries(req.query).some(([key, value]) => !QUERY_KEYS.has(key) || typeof value !== 'string')) throw new BadRequestException('查询字段无效');
  if (policy.fields) {
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !policy.fields!.includes(k))) throw new BadRequestException('请求包含未允许的字段');
    const stringKeys = new Set(['account','password','name','remark','purpose','pairingCode','hostname','platform','arch','agentVersion','publicKeyPem','status','currentStep','errorCode','errorMessage','error','lastError','localProfileId','platformCode','loginStatus','localStateHash','pageUrl','action','sessionId','browserSessionId','openRequestId','stage','frame','phase','failureCode','kind','reason','abnormalReason']);
    for (const [key, value] of Object.entries(body)) {
      // Original MySQL BIGINT IDs and local Profile keys are decimal strings.
      // Accept that original wire contract only on authenticated agent routes;
      // employee DTOs remain numeric and identity fields remain disallowed.
      if (policy.action === 'agent' && ['storeId','shopId','commandId'].includes(key) && typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) {
        body[key] = Number(value);
        continue;
      }
      if (stringKeys.has(key) && typeof value !== 'string') throw new BadRequestException('文字字段类型无效');
      if (['enabled','allowControl','clearPassword','ok'].includes(key) && typeof value !== 'boolean') throw new BadRequestException('开关字段类型无效');
      if (['storeId','shopId','commandId','abnormalReasonId'].includes(key) && (!Number.isSafeInteger(value) || Number(value) <= 0)) throw new BadRequestException('编号字段无效');
      if (['deviceId','expectedDeviceId','currentRequestId'].includes(key) && value !== null && (typeof value !== 'string' || !/^[\da-f-]{36}$/i.test(value))) throw new BadRequestException('电脑或请求编号无效');
    }
    if (body.storeIds !== undefined && (!Array.isArray(body.storeIds) || body.storeIds.length < 1 || body.storeIds.length > 100 || body.storeIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0))) throw new BadRequestException('每次请选择1–100家有效店铺');
    if (body.activeBrowserSessionIds !== undefined && (!Array.isArray(body.activeBrowserSessionIds) || body.activeBrowserSessionIds.length > 100 || body.activeBrowserSessionIds.some((id: unknown) => typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id)))) throw new BadRequestException('受管浏览器编号无效');
  }
  if (req.method === 'POST' && req.path === '/open-requests' && req.body?.purpose !== undefined) {
    if (req.body.purpose !== 'remote') throw new BadRequestException('登录请求用途无效');
    return 'remote';
  }
  return policy.action;
}
export function legacyWorkspace(req: Pick<Request, 'headers' | 'query'>): SessionWorkspace {
  const header = req.headers['x-session-workspace'], query = req.query.workspaceKey;
  if (header && query && header !== query) throw new BadRequestException('工作区不一致');
  const key = header ?? query ?? 'finance_withdrawal';
  if (key !== 'finance_withdrawal' && key !== 'company_store_maintenance') throw new NotFoundException('登录工作区不存在');
  return key;
}

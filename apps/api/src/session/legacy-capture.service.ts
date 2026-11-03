import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FilesService } from '../integrations/files.service';
import { LegacySqlTx, LegacyStore, SessionWorkspace } from './legacy-store';
import { remoteGloballyDisabled } from './remote.service';

const TIMEOUT_MS = 90_000;
type CaptureRow = { id: string; company_id: number; workspace_id: number; user_id: number; store_id: number;
  remote_session_id: string; owns_remote: number; baseline_sequence: number; status: string;
  file_id: number | null; error_text: string | null; created_at: Date };

/** Screenshot bridge uses the original agent's JPEG fallback. It does not ask an
 * old binary to handle a new task kind and never closes the merchant browser. */
@Injectable()
export class LegacyCaptureService {
  constructor(private readonly store: LegacyStore, private readonly files: FilesService) {}

  private async access(user: AuthUser, ws: SessionWorkspace) {
    if (ws !== 'finance_withdrawal') throw new ForbiddenException('公司店铺维护不提供提现凭证截图');
    const can = createChecker(user.permissions);
    if (!can('finance.docs.create') && !can('finance.session.manage')) throw new ForbiddenException('没有登记提现的权限');
    // Preserve the original voucher screenshot permission. A pending, persisted
    // capture authorizes only its bounded temporary agent frame transport; normal
    // viewer, ticket and input endpoints still require the remote permission.
    return this.store.workspace(user, ws, 'view');
  }

  private async finishRemote(row: CaptureRow, tx: LegacySqlTx) {
    if (Number(row.owns_remote) !== 1) return;
    await this.store.module('remote-assistance-service').closeRemoteSession({
      companyId: Number(row.company_id), workspaceId: Number(row.workspace_id), userId: Number(row.user_id),
      sessionId: row.remote_session_id, withTransaction: (work: (sql: LegacySqlTx) => Promise<unknown>) => work(tx),
    });
  }

  async begin(user: AuthUser, ws: SessionWorkspace, legacyStoreId: number) {
    const workspaceId = await this.access(user, ws);
    if (remoteGloballyDisabled()) throw new ConflictException('管理员已关闭远程协助，不能请求截图');
    if (!Number.isSafeInteger(legacyStoreId) || legacyStoreId <= 0) throw new BadRequestException('店铺编号无效');
    return this.store.ds.transaction(async em => {
      if (remoteGloballyDisabled()) throw new ConflictException('管理员已关闭远程协助，不能请求截图');
      const tx = this.store.forManager(em);
      const [shop] = await tx.query(`SELECT m.store_id,m.assigned_device_id,s.platform FROM session_managed_shops m
        JOIN stores s ON s.id=m.store_id AND s.company_id=m.company_id
        WHERE m.company_id=? AND m.workspace_id=? AND m.store_id=? AND m.status='active' LIMIT 1 FOR UPDATE`,
        [user.companyId, workspaceId, legacyStoreId]);
      if (!shop?.assigned_device_id) throw new ConflictException('这家店铺没有已分配的负责电脑');
      const [browser] = await tx.query(`SELECT b.id,b.user_id,b.device_id,b.local_profile_id,b.page_url,d.agent_version FROM managed_browser_sessions b
        JOIN session_devices d ON d.id=b.device_id AND d.company_id=b.company_id AND d.workspace_id=b.workspace_id
        JOIN sm_legacy_remote_policies p ON p.company_id=b.company_id AND p.workspace_id=b.workspace_id AND p.device_id=b.device_id
        WHERE b.company_id=? AND b.workspace_id=? AND b.shop_id=? AND b.device_id=? AND b.status='open'
          AND d.status='active' AND p.enabled=1 AND p.allow_control=1
          AND d.last_seen_at>=DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 45 SECOND)
          AND b.last_agent_at>=DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 45 SECOND)
        ORDER BY b.opened_at DESC LIMIT 1 FOR UPDATE`, [user.companyId, workspaceId, legacyStoreId, shop.assigned_device_id]);
      if (!browser) throw new ConflictException('请先打开这家店铺的受管浏览器，并启用负责电脑的远程权限');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(browser.local_profile_id)) throw new ConflictException('店铺浏览器Profile标识无效');
      const platform = this.store.module('platform-registry');
      if (!platform.isAllowedPlatformUrl(platform.normalizePlatform(shop.platform), browser.page_url)) throw new ForbiddenException('店铺页面已离开所属平台允许的商家域名');
      if (this.store.module('agent-update-service').compareVersions(browser.agent_version, '0.3.45') < 0) throw new ConflictException('负责电脑需升级到0.3.45或以上兼容助手');
      const [pending] = await em.query(`SELECT id FROM sm_legacy_captures WHERE company_id=? AND workspace_id=? AND user_id=? AND store_id=? AND status='pending' FOR UPDATE`,
        [user.companyId, workspaceId, user.id, legacyStoreId]);
      if (pending) return { id: pending.id, kind: 'capture' as const };
      const [existing] = await tx.query(`SELECT id,user_id,transport_mode,frame_sequence FROM session_remote_sessions
        WHERE company_id=? AND workspace_id=? AND browser_session_id=? AND status IN ('requested','connected','closing')
          AND (expires_at>CURRENT_TIMESTAMP OR status='closing') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [user.companyId, workspaceId, browser.id]);
      if (existing && (Number(existing.user_id) !== user.id || Number(browser.user_id) !== user.id)) throw new ConflictException('当前浏览器已有远程操作，不能截取或接管');
      if (existing && existing.transport_mode !== 'jpeg_fallback') throw new ConflictException('当前实时远程正在使用 WebRTC，请先切换到兼容画面后截图；不会中断现有远程');
      const remote = this.store.module('remote-assistance-service');
      const withTransaction = (work: (sql: LegacySqlTx) => Promise<unknown>) => work(tx);
      let remoteId = existing?.id;
      if (!remoteId) {
        if (Number(browser.user_id) === user.id) {
          const created = await remote.createRemoteSession({ companyId: user.companyId, workspaceId, userId: user.id,
            browserSessionId: browser.id, deviceId: browser.device_id, shopId: legacyStoreId, withTransaction });
          remoteId = created.id;
          await remote.requestJpegFallback({ companyId: user.companyId, workspaceId, userId: user.id, sessionId: remoteId, withTransaction });
        } else {
          // An idle shared browser can supply a voucher image without changing
          // its owner or granting the clerk control. The exact capture row below
          // is the only 30-second JPEG lease; normal remote/ticket routes fence it.
          remoteId = randomUUID();
          await tx.execute(`INSERT INTO session_remote_sessions
            (id,company_id,workspace_id,user_id,shop_id,device_id,browser_session_id,status,transport_mode,expires_at)
            VALUES (?,?,?,?,?,?,?,'requested','jpeg_fallback',DATE_ADD(CURRENT_TIMESTAMP,INTERVAL 30 SECOND))`,
            [remoteId, user.companyId, workspaceId, user.id, legacyStoreId, browser.device_id, browser.id]);
        }
      }
      const id = randomUUID();
      await em.query(`INSERT INTO sm_legacy_captures (id,company_id,workspace_id,user_id,store_id,remote_session_id,owns_remote,baseline_sequence,status,created_at)
        VALUES (?,?,?,?,?,?,?,?, 'pending',CURRENT_TIMESTAMP(3))`,
        [id, user.companyId, workspaceId, user.id, legacyStoreId, remoteId, existing ? 0 : 1, Number(existing?.frame_sequence ?? 0)]);
      return { id, kind: 'capture' as const };
    });
  }

  async get(user: AuthUser, ws: SessionWorkspace, id: string) {
    const workspaceId = await this.access(user, ws);
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new BadRequestException('截图请求编号无效');
    const uploadedKeys: string[] = [];
    let owned: CaptureRow | undefined;
    let row: CaptureRow;
    try {
      row = await this.store.ds.transaction(async em => {
        // FilesService already supports tracking uploaded objects on rollback for
        // explicit imports. Reuse that facility rather than duplicating storage.
        if (em.queryRunner) Object.assign(em.queryRunner.data, { legacyImport: true, importUploadedKeys: uploadedKeys });
        const tx = this.store.forManager(em);
        const [current] = await em.query(`SELECT * FROM sm_legacy_captures WHERE id=? AND company_id=? AND workspace_id=? AND user_id=? LIMIT 1 FOR UPDATE`,
          [id, user.companyId, workspaceId, user.id]) as CaptureRow[];
        if (!current) throw new NotFoundException('截图请求不存在');
        owned = current;
        if (current.status !== 'pending') return current;
        const fail = async (message: string) => {
          await em.query("UPDATE sm_legacy_captures SET status='failed',error_text=?,finished_at=CURRENT_TIMESTAMP(3) WHERE id=? AND company_id=? AND workspace_id=? AND user_id=? AND status='pending'",
            [message, id, user.companyId, workspaceId, user.id]);
          await this.finishRemote(current, tx);
          return { ...current, status: 'failed', error_text: message };
        };
        if (remoteGloballyDisabled()) return fail('管理员已关闭远程协助，未保存截图');
        if (Date.now() - new Date(current.created_at).getTime() > TIMEOUT_MS) return fail('截图等待超时，请确认助手和店铺浏览器在线后重试');
        const [frame] = await tx.query(`SELECT r.status,r.transport_mode,r.frame_sequence,r.frame_data,r.frame_url,r.last_agent_at,r.expires_at,
          r.device_id,r.browser_session_id,b.local_profile_id,
          b.status AS browser_status,b.last_agent_at AS browser_seen,d.status AS device_status,d.last_seen_at AS device_seen,s.platform,
          p.enabled,p.allow_control FROM session_remote_sessions r
          JOIN managed_browser_sessions b ON b.id=r.browser_session_id AND b.company_id=r.company_id AND b.workspace_id=r.workspace_id AND b.shop_id=r.shop_id AND b.device_id=r.device_id
          JOIN session_devices d ON d.id=r.device_id AND d.company_id=r.company_id AND d.workspace_id=r.workspace_id
          JOIN stores s ON s.id=r.shop_id AND s.company_id=r.company_id
          LEFT JOIN sm_legacy_remote_policies p ON p.company_id=r.company_id AND p.workspace_id=r.workspace_id AND p.device_id=r.device_id
          WHERE r.id=? AND r.company_id=? AND r.workspace_id=? AND r.user_id=? AND r.shop_id=? LIMIT 1`,
          [current.remote_session_id, user.companyId, workspaceId, user.id, current.store_id]);
        if (!frame || !['requested', 'connected'].includes(frame.status) || frame.browser_status !== 'open' || frame.device_status !== 'active' || !frame.enabled || !frame.allow_control || new Date(frame.expires_at).getTime() <= Date.now()) {
          return fail('远程会话或电脑授权已结束，未保存截图');
        }
        if (Date.now() - new Date(frame.browser_seen).getTime() > 45_000 || Date.now() - new Date(frame.device_seen).getTime() > 45_000) return fail('负责电脑或店铺浏览器已离线，未保存截图');
        if (frame.transport_mode !== 'jpeg_fallback') return fail('远程传输方式已改变，请重新截图');
        if (!frame.frame_data || frame.status !== 'connected' || Number(frame.frame_sequence) <= Number(current.baseline_sequence)) return current;
        const platform = this.store.module('platform-registry');
        if (!platform.isAllowedPlatformUrl(platform.normalizePlatform(frame.platform), frame.frame_url)) return fail('店铺页面已离开允许的平台域名，未保存截图');
        // Sequence strictly advances after begin; timestamp is an additional
        // coarse guard because old TIMESTAMP columns have second precision.
        if (new Date(frame.last_agent_at).getTime() < new Date(current.created_at).getTime() - 1000) return current;
        const bytes = Buffer.from(frame.frame_data);
        if (remoteGloballyDisabled()) return fail('管理员已关闭远程协助，未保存截图');
        const file = await this.files.putBlob(user.companyId, user.id, 'withdrawal-voucher', 'voucher',
          { originalname: `withdrawal-capture-${current.store_id}.jpg`, buffer: bytes, size: bytes.length }, em);
        // Upload awaits an external service. Re-read authorization under locks
        // after that boundary; a snapshot read before upload can be stale even
        // in this transaction. Throw on loss so the ResourceFile insert rolls
        // back and the catch path compensates the already-uploaded object.
        if (remoteGloballyDisabled() || !await this.store.captureAllowed(user.companyId, workspaceId, frame.device_id, user.id, current.remote_session_id, current.id, em)) {
          throw new ConflictException('截图上传期间远程授权已停止');
        }
        const [authorized] = await tx.query(`SELECT r.id,r.frame_url,s.platform FROM session_remote_sessions r
          JOIN managed_browser_sessions b ON b.id=r.browser_session_id AND b.company_id=r.company_id AND b.workspace_id=r.workspace_id AND b.shop_id=r.shop_id AND b.device_id=r.device_id
          JOIN session_devices d ON d.id=r.device_id AND d.company_id=r.company_id AND d.workspace_id=r.workspace_id
          JOIN session_managed_shops m ON m.company_id=r.company_id AND m.workspace_id=r.workspace_id AND m.store_id=r.shop_id AND m.assigned_device_id=r.device_id AND m.status='active'
          JOIN sm_legacy_remote_policies p ON p.company_id=r.company_id AND p.workspace_id=r.workspace_id AND p.device_id=r.device_id
          JOIN stores s ON s.id=r.shop_id AND s.company_id=r.company_id
          WHERE r.id=? AND r.company_id=? AND r.workspace_id=? AND r.user_id=? AND r.shop_id=?
            AND r.device_id=? AND r.browser_session_id=? AND b.local_profile_id=?
            AND r.status='connected' AND r.transport_mode='jpeg_fallback' AND r.expires_at>CURRENT_TIMESTAMP
            AND b.status='open' AND d.status='active' AND p.enabled=1 AND p.allow_control=1
            AND b.last_agent_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 45 SECOND)
            AND d.last_seen_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 45 SECOND)
            AND NOT EXISTS (SELECT 1 FROM session_remote_sessions occupied
              WHERE occupied.company_id=r.company_id AND occupied.workspace_id=r.workspace_id
                AND occupied.browser_session_id=r.browser_session_id AND occupied.id<>r.id
                AND occupied.status IN ('requested','connected','closing')
                AND (occupied.expires_at>CURRENT_TIMESTAMP OR occupied.status='closing'))
          LIMIT 1 FOR UPDATE`, [current.remote_session_id, user.companyId, workspaceId, user.id, current.store_id,
          frame.device_id, frame.browser_session_id, frame.local_profile_id]);
        if (!authorized || remoteGloballyDisabled() || !platform.isAllowedPlatformUrl(platform.normalizePlatform(authorized.platform), authorized.frame_url)) {
          throw new ConflictException('截图上传期间会话、电脑或策略已失效');
        }
        await em.query("UPDATE sm_legacy_captures SET status='succeeded',file_id=?,error_text=NULL,finished_at=CURRENT_TIMESTAMP(3) WHERE id=? AND company_id=? AND workspace_id=? AND user_id=? AND status='pending'",
          [file.id, id, user.companyId, workspaceId, user.id]);
        await tx.execute(`INSERT INTO session_audit_logs (company_id,workspace_id,employee_id,store_id,event_type,outcome,summary)
          VALUES (?,?,?,?, 'oa_capture_completed','success','已保存本次店铺画面作为提现凭证')`, [user.companyId, workspaceId, user.id, current.store_id]);
        await this.finishRemote(current, tx);
        return { ...current, status: 'succeeded', file_id: file.id, error_text: null };
      });
    } catch (error) {
      if (!owned) throw error;
      // A failed upload/transaction cannot leave a pending capture that may be
      // uploaded twice by the next poll. Do not expose storage or raw SQL errors.
      row = await this.store.ds.transaction(async em => {
        const [current] = await em.query(`SELECT * FROM sm_legacy_captures WHERE id=? AND company_id=? AND workspace_id=? AND user_id=? LIMIT 1 FOR UPDATE`,
          [id, user.companyId, workspaceId, user.id]) as CaptureRow[];
        if (!current) throw new NotFoundException('截图请求不存在');
        if (current.status !== 'pending') return current;
        await em.query("UPDATE sm_legacy_captures SET status='failed',error_text='截图保存失败，请重试',finished_at=CURRENT_TIMESTAMP(3) WHERE id=? AND company_id=? AND workspace_id=? AND user_id=?",
          [id, user.companyId, workspaceId, user.id]);
        await this.finishRemote(current, this.store.forManager(em));
        return { ...current, status: 'failed', error_text: '截图保存失败，请重试' };
      });
      // A commit acknowledgement may be lost after the database committed. Read
      // the durable capture first: never delete an object a succeeded row owns.
      // If reconciliation itself is unavailable, retain the object for recovery.
      if (row.status === 'failed' && !row.file_id) await this.files.deleteObjects(user.companyId, uploadedKeys);
    }
    const file = row.file_id ? (await this.files.info(user.companyId, [Number(row.file_id)])).get(Number(row.file_id)) ?? null : null;
    return { id: row.id, kind: 'capture' as const, status: row.status, errorText: row.error_text, file };
  }
}

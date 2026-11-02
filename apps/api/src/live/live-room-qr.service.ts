import { GoneException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { liveRoomList, loadLiveAccess, requireManage } from './live-access';
import { liveFail, lockCompany } from './live-core';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
@Injectable()
export class LiveRoomQrService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly crypto: CryptoService) {}
  private async room(user: AuthUser, id: number, em = this.ds.manager) {
    if (!Number.isSafeInteger(id) || id < 1 || !(await liveRoomList(em, user.companyId)).some(r => r.id === id))
      liveFail('直播间不存在或已停用', 404);
  }
  async read(user: AuthUser, id: number) {
    requireManage(await loadLiveAccess(this.ds.manager, user));
    await this.room(user, id);
    const [row] = await this.ds.query('SELECT qr_token_cipher,qr_version FROM live_room_settings WHERE company_id=? AND room_id=?', [user.companyId, id]);
    return { token: row?.qr_token_cipher ? this.crypto.decrypt(row.qr_token_cipher) : null, version: Number(row?.qr_version ?? 0) };
  }
  async generate(user: AuthUser, id: number, version: number) {
    requireManage(await loadLiveAccess(this.ds.manager, user));
    return this.ds.transaction(async em => {
      await lockCompany(em, user.companyId);
      await this.room(user, id, em);
      const [row] = await em.query('SELECT qr_version FROM live_room_settings WHERE company_id=? AND room_id=? FOR UPDATE', [user.companyId, id]);
      if (Number(row?.qr_version ?? 0) !== version) liveFail('二维码已被其他人更新，请刷新后查看', 409);
      const token = randomBytes(32).toString('base64url');
      await em.query(`INSERT INTO live_room_settings(company_id,room_id,updated_by,qr_token_cipher,qr_token_hash,qr_version)
        VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE qr_token_cipher=VALUES(qr_token_cipher),qr_token_hash=VALUES(qr_token_hash),qr_version=VALUES(qr_version),updated_by=VALUES(updated_by)`,
        [user.companyId, id, user.id, this.crypto.encrypt(token), digest(token), version + 1]);
      await em.query('INSERT INTO audit_logs(company_id,actor_id,action,resource_type,resource_id,detail) VALUES (?,?,?,?,?,?)',
        [user.companyId, user.id, 'live.room.qr.generate', 'live-room', String(id), JSON.stringify({ version: version + 1 })]);
      return { token, version: version + 1 };
    });
  }
  /** No expiry: only replacing the persisted token or disabling the room invalidates it. */
  async assert(user: AuthUser, id: number, token?: string) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new GoneException('二维码已失效，请扫描直播间最新二维码');
    await this.room(user, id);
    const [row] = await this.ds.query('SELECT qr_token_hash FROM live_room_settings WHERE company_id=? AND room_id=?', [user.companyId, id]);
    const actual = Buffer.from(digest(token!));
    const expected = Buffer.from(String(row?.qr_token_hash ?? ''));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new GoneException('二维码已失效，请扫描直播间最新二维码');
  }
}

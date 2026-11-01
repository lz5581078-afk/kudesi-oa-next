import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { SpeechSettingsService } from './speech-settings.service';

/** Single API process (PM2 fork); slots are shared by file and realtime calls. */
@Injectable()
export class CollectorService {
  private readonly active = new Map<number, number>();
  constructor(private readonly settings: SpeechSettingsService) {}
  async config(companyId: number, mode: 'file' | 'realtime') {
    const c = await this.settings.read(companyId);
    if (!c?.enabled || !c.apiKey || !(mode === 'file' ? c.fileEnabled : c.realtimeEnabled)) throw new ForbiddenException('公司未启用此语音模式，请联系管理员在 OA 系统 → 接口设置中配置');
    return c;
  }
  acquire(companyId: number, limit: number) {
    const n = this.active.get(companyId) ?? 0;
    if (n >= limit) throw new HttpException('公司语音并发已满，请稍后重试', 429);
    this.active.set(companyId, n + 1); let released = false;
    return () => { if (released) return; released = true; const remaining = (this.active.get(companyId) ?? 1) - 1;
      if (remaining) this.active.set(companyId, remaining); else this.active.delete(companyId); };
  }
}

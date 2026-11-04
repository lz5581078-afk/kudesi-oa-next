import {createHash} from 'crypto';
import type {ResourceRecord} from '../entities';

/** 记录版本：内容一变就变（不靠只有秒精度的 updatedAt），表格编辑保存时用来发现别人改过 */
export function recordVersion(r: ResourceRecord): string {
  return createHash('sha1').update(JSON.stringify([r.title, r.status, r.data, r.secrets, r.archivedAt ? 1 : 0, r.updatedAt ? new Date(r.updatedAt).getTime() : 0])).digest('hex').slice(0, 16);
}

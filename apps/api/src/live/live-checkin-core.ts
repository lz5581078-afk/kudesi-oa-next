import { createHash } from 'crypto';
import { liveFromText, liveToText } from '@kudesi/shared';
import { Row } from './live-core';
export const REPORT_WINDOW_MS = 30 * 60_000;
export function reportsLocked(s: Row, now: Date) {
  return !!s.report_locked_at || !!s.report_deadline && +liveFromText(liveToText(s.report_deadline))! <= +now;
}
export function scheduleFingerprint(s: Row) {
  return createHash('sha256').update(JSON.stringify(['id','room_id','anchor_user_id','control_user_id','operator_user_id','start_at','end_at','status','session_id','channels_json','products_json','updated_at'].map(k => s[k]))).digest('hex');
}
export function primaryReport(reports: Row[]) {
  return reports.find(r => r.role === 'operator') ?? reports.find(r => r.role === 'anchor') ?? reports.find(r => r.role === 'control');
}

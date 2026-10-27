import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { CaseLog, Notification, ResourceFile, User } from '../entities';
import { FilesService, UploadedFile } from '../integrations/files.service';

/** 凭证/附件挂在哪张表哪一列（固定白名单，绝不来自请求）。 */
export interface AttachTarget {
  table: 'after_sales_cases' | 'order_appeals';
  column: 'attachments' | 'evidence';
  fileType: 'after-sales' | 'order-appeal';
  logType: 'after_sales' | 'appeal';
  /** 页面入口，用于通知里的链接 */
  link: string;
}
export const AFTER_SALES_FILES: AttachTarget = { table: 'after_sales_cases', column: 'attachments', fileType: 'after-sales', logType: 'after_sales', link: '/after-sales/table' };
export const APPEAL_FILES: AttachTarget = { table: 'order_appeals', column: 'evidence', fileType: 'order-appeal', logType: 'appeal', link: '/after-sales/appeals' };
export const MAX_ATTACHMENTS = 20;

const parseJson = (v: unknown): number[] => {
  const x = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(x) ? x.filter((n): n is number => typeof n === 'number') : [];
};

/** 工单和申诉共用：凭证上传/移除/取链接、跟进记录、催办。所有查询都带 company_id。 */
@Injectable()
export class CaseSupport {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly files: FilesService) {}

  async userNames(companyId: number, ids: number[], em: EntityManager = this.ds.manager) {
    const uniq = [...new Set(ids.filter((x) => Number.isInteger(x)))];
    if (!uniq.length) return new Map<number, string>();
    const rows = await em.find(User, { where: { companyId, id: In(uniq) }, select: ['id', 'name'] });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** 锁住业务行并确认流程还在办（办结后凭证不能再改）。返回当前凭证 id 列表、流程编号。 */
  private async lockOpen(em: EntityManager, t: AttachTarget, companyId: number, id: number) {
    const [row] = await em.query(
      `SELECT x.${t.column} AS ids, x.run_id AS runId, r.status AS runStatus FROM ${t.table} x JOIN flow_runs r ON r.id = x.run_id WHERE x.id = ? AND x.company_id = ? FOR UPDATE`,
      [id, companyId],
    );
    if (!row) throw new NotFoundException('记录不存在');
    if (row.runStatus !== 'running') throw new BadRequestException('已经办结，不能再改凭证');
    return { ids: parseJson(row.ids), runId: Number(row.runId) };
  }

  async addFile(user: AuthUser, t: AttachTarget, id: number, file: UploadedFile | undefined) {
    const info = await this.files.putBlob(user.companyId, user.id, t.fileType, t.column, file);
    try {
      await this.ds.transaction(async (em) => {
        const cur = await this.lockOpen(em, t, user.companyId, id);
        if (cur.ids.length >= MAX_ATTACHMENTS) throw new BadRequestException(`最多 ${MAX_ATTACHMENTS} 个文件`);
        await em.query(`UPDATE ${t.table} SET ${t.column} = ? WHERE id = ? AND company_id = ?`, [JSON.stringify([...cur.ids, info.id]), id, user.companyId]);
        await this.files.bind(em, user.companyId, id, [info.id]);
        await em.insert(CaseLog, { companyId: user.companyId, targetType: t.logType, targetId: id, userId: user.id, kind: 'system', content: `上传了文件：${info.name}`.slice(0, 1000) });
      });
    } catch (e) {
      await this.files.deleteObjects(user.companyId, await this.dropUnbound(user.companyId, info.id)); // 没挂上就别留着
      throw e;
    }
    return info;
  }

  private async dropUnbound(companyId: number, fileId: number): Promise<string[]> {
    const row = await this.ds.manager.findOne(ResourceFile, { where: { id: fileId, companyId } });
    if (!row || row.resourceId !== null) return [];
    await this.ds.manager.delete(ResourceFile, { id: fileId, companyId });
    return [row.storageKey];
  }

  async removeFile(user: AuthUser, t: AttachTarget, id: number, fileId: number) {
    let keys: string[] = [];
    await this.ds.transaction(async (em) => {
      const cur = await this.lockOpen(em, t, user.companyId, id);
      if (!cur.ids.includes(fileId)) throw new NotFoundException('这个文件不在这条记录里');
      const f = await em.findOne(ResourceFile, { where: { id: fileId, companyId: user.companyId } });
      if (f && f.uploadedBy !== user.id && !user.permissions.isCompanyAdmin) throw new ForbiddenException('只能移除自己上传的文件（管理员可以移除任何文件）');
      const keep = cur.ids.filter((x) => x !== fileId);
      await em.query(`UPDATE ${t.table} SET ${t.column} = ? WHERE id = ? AND company_id = ?`, [JSON.stringify(keep), id, user.companyId]);
      keys = await this.files.dropRemoved(em, user.companyId, t.fileType, id, t.column, keep);
      await em.insert(CaseLog, { companyId: user.companyId, targetType: t.logType, targetId: id, userId: user.id, kind: 'system', content: `移除了文件：${f?.name ?? fileId}`.slice(0, 1000) });
    });
    await this.files.deleteObjects(user.companyId, keys);
    return { ok: true };
  }

  async fileUrl(user: AuthUser, t: AttachTarget, id: number, fileId: number) {
    const [row] = await this.ds.query(`SELECT ${t.column} AS ids FROM ${t.table} WHERE id = ? AND company_id = ?`, [id, user.companyId]);
    if (!row) throw new NotFoundException('记录不存在');
    if (!parseJson(row.ids).includes(fileId)) throw new NotFoundException('这个文件不在这条记录里');
    return this.files.urlOf(user.companyId, fileId, t.fileType);
  }

  async fileInfos(companyId: number, ids: unknown) {
    const list = parseJson(ids);
    const map = await this.files.info(companyId, list);
    return list.map((id) => map.get(id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
  }

  async logs(companyId: number, targetType: string, targetId: number) {
    const rows = await this.ds.manager.find(CaseLog, { where: { companyId, targetType, targetId }, order: { id: 'DESC' }, take: 200 });
    const names = await this.userNames(companyId, rows.map((r) => r.userId ?? 0));
    return rows.map((r) => ({ id: r.id, kind: r.kind, content: r.content, userName: r.userId ? names.get(r.userId) ?? '' : '系统', createdAt: r.createdAt }));
  }

  /** 跟进记录；催办会给当前办理人发一条站内通知。 */
  async addLog(user: AuthUser, t: AttachTarget, id: number, content: string, kind: 'note' | 'urge') {
    const text = content?.trim();
    if (!text) throw new BadRequestException('请写跟进内容');
    if (text.length > 1000) throw new BadRequestException('跟进内容不超过 1000 字');
    return this.ds.transaction(async (em) => {
      const [row] = await em.query(`SELECT x.run_id AS runId, r.title AS title, r.status AS runStatus FROM ${t.table} x JOIN flow_runs r ON r.id = x.run_id WHERE x.id = ? AND x.company_id = ?`, [id, user.companyId]);
      if (!row) throw new NotFoundException('记录不存在');
      if (kind === 'urge') {
        if (row.runStatus !== 'running') throw new BadRequestException('已经办结，不用催办');
        const handlers: Array<{ assigneeId: number }> = await em.query(
          `SELECT assignee_id AS assigneeId FROM work_items WHERE company_id = ? AND run_id = ? AND status = 'open'`, [user.companyId, row.runId]);
        if (!handlers.length) throw new BadRequestException('现在没有办理人可催');
        for (const h of handlers) {
          await em.insert(Notification, { companyId: user.companyId, userId: h.assigneeId, kind: 'urge', title: `${user.name} 催办：${row.title}`.slice(0, 200), body: text.slice(0, 500), link: `/workbench/todos?run=${row.runId}` });
        }
      }
      await em.insert(CaseLog, { companyId: user.companyId, targetType: t.logType, targetId: id, userId: user.id, kind, content: text });
      return { ok: true };
    });
  }
}

/** 列表关键词：空格/逗号/换行分开的多个词，任一词命中即算（旧系统“多订单号搜索”）。 */
export function keywordTokens(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,，、;；]+/).map((x) => x.trim()).filter(Boolean).slice(0, 30);
}
export const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
export const activeStepSql = (col: 'step_name' | 'recipients' | 'entered_via') => `(SELECT s.${col} FROM flow_steps s WHERE s.run_id = r.id AND s.status = 'active' ORDER BY s.seq DESC LIMIT 1)`;
export const parseRecipients = (v: unknown): number[] => (typeof v === 'string' ? (JSON.parse(v) as number[]) : Array.isArray(v) ? (v as number[]) : []);

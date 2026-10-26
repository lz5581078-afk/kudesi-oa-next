import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { inspectPackage, isVersion, sha256Hex } from './agent-package';

/** 助手升级包的存取（SessionService 的升级功能调用这里；全部按公司隔离）。查询列表时不读 package 大字段。 */
export interface ReleaseRow { id: number; version: string; sha256: string; size: number; notes: string | null; createdAt: Date; withdrawnAt: Date | null; createdByName: string | null }

const cmp = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1; return 0; };

export async function listReleases(ds: DataSource, companyId: number): Promise<ReleaseRow[]> {
  const rows: ReleaseRow[] = await ds.query(
    `SELECT r.id, r.version, r.sha256, r.size, r.notes, r.created_at AS createdAt, r.withdrawn_at AS withdrawnAt, u.name AS createdByName
       FROM agent_releases r LEFT JOIN users u ON u.id = r.created_by WHERE r.company_id = ?`, [companyId]);
  return rows.map((r) => ({ ...r, size: Number(r.size) })).sort((a, b) => cmp(b.version, a.version));
}

/** 当前公司最新的、未撤回的版本；没有上传过任何升级包返回 null */
export async function latestReleaseVersion(ds: DataSource | { query: DataSource['query'] }, companyId: number): Promise<string | null> {
  const rows: Array<{ version: string }> = await ds.query('SELECT version FROM agent_releases WHERE company_id = ? AND withdrawn_at IS NULL', [companyId]);
  return rows.map((r) => r.version).sort((a, b) => cmp(b, a))[0] ?? null;
}

export async function findRelease(ds: DataSource | { query: DataSource['query'] }, companyId: number, version: string): Promise<{ id: number; version: string; sha256: string; size: number; withdrawn: boolean } | null> {
  const [r] = await ds.query('SELECT id, version, sha256, size, withdrawn_at AS w FROM agent_releases WHERE company_id = ? AND version = ?', [companyId, version]);
  return r ? { id: r.id, version: r.version, sha256: r.sha256, size: Number(r.size), withdrawn: !!r.w } : null;
}

export async function publishRelease(ds: DataSource, companyId: number, userId: number, file: { buffer: Buffer } | undefined, p: { sha256?: string; version?: string; notes?: string }) {
  if (!file?.buffer?.length) throw new BadRequestException('请选择升级包文件');
  const actual = sha256Hex(file.buffer);
  const claimed = p.sha256?.trim().toLowerCase();
  if (claimed) {
    if (!/^[a-f0-9]{64}$/.test(claimed)) throw new BadRequestException('SHA-256 应为 64 位十六进制');
    if (claimed !== actual) throw new BadRequestException('SHA-256 与上传的文件不一致，文件可能在传输中被改动，请重新上传');
  }
  const { version } = inspectPackage(file.buffer);
  if (p.version && p.version.trim() !== version) throw new BadRequestException(`填写的版本号 ${p.version.trim()} 与升级包里的版本 ${version} 不一致`);
  if (!isVersion(version)) throw new BadRequestException('版本号格式不对');
  const existing: Array<{ version: string }> = await ds.query('SELECT version FROM agent_releases WHERE company_id = ?', [companyId]);
  if (existing.some((r) => r.version === version)) throw new ConflictException(`版本 ${version} 已经发布过，不能覆盖；请提高版本号后重新打包`);
  const top = existing.map((r) => r.version).sort((a, b) => cmp(b, a))[0];
  if (top && cmp(version, top) < 0) throw new BadRequestException(`版本号必须高于已发布的最高版本 ${top}`);
  await ds.query('INSERT INTO agent_releases (company_id, version, sha256, size, package, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [companyId, version, actual, file.buffer.length, file.buffer, p.notes?.trim().slice(0, 300) || null, userId]);
  return { version, sha256: actual, size: file.buffer.length };
}

export async function withdrawRelease(ds: DataSource, companyId: number, id: number) {
  const r = await ds.query('UPDATE agent_releases SET withdrawn_at = NOW() WHERE id = ? AND company_id = ? AND withdrawn_at IS NULL', [id, companyId]);
  if (!r.affectedRows) throw new NotFoundException('升级包不存在或已撤回');
  const [row] = await ds.query('SELECT version FROM agent_releases WHERE id = ? AND company_id = ?', [id, companyId]);
  return row.version as string;
}

/** 读出包内容并再核对一次 SHA-256（库里的数据被改过就拒绝发出） */
export async function loadPackage(ds: DataSource, companyId: number, version: string): Promise<{ buf: Buffer; sha256: string }> {
  const [r] = await ds.query('SELECT package, sha256, withdrawn_at AS w FROM agent_releases WHERE company_id = ? AND version = ?', [companyId, version]);
  if (!r || r.w) throw new NotFoundException('该版本的升级包不存在或已撤回');
  const buf: Buffer = r.package;
  if (sha256Hex(buf) !== r.sha256) throw new ConflictException('服务器上的升级包校验失败，已拒绝发放，请管理员重新上传');
  return { buf, sha256: r.sha256 };
}

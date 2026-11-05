/**
 * 招聘登记表：字段、选项和校验只在这里定义一次。
 * 服务端（权威校验）和求职者填表页（提前提示）共用，识别结果也按这里的规则整理后才给求职者确认。
 */

export const RECRUIT_GENDERS = ['男', '女'] as const;
export const RECRUIT_MARITAL = ['未婚', '已婚', '离异', '其他'] as const;
export const RECRUIT_EDUCATIONS = ['初中及以下', '高中/中专', '大专', '本科', '硕士', '博士'] as const;
export const RECRUIT_CHANNELS = ['招聘网站', '朋友/员工推荐', '微信/朋友圈', '抖音/短视频', '线下招聘会', '路过门店', '其他'] as const;
export const RECRUIT_STATUSES = { submitted: '待面试' } as const;
export const RECRUIT_MAX_HISTORY = 10;

/** 教育经历、工作经历共用：时间段、学校/公司、专业/职位、说明 */
export interface RecruitHistoryItem { period: string; org: string; title: string; note: string }

export interface RecruitForm {
  name: string;
  gender: string;
  ethnicity: string;
  birthDate: string;
  marital: string;
  education: string;
  school: string;
  graduationDate: string;
  expectedSalary: string;
  idNo: string;
  phone: string;
  educationHistory: RecruitHistoryItem[];
  workHistory: RecruitHistoryItem[];
  achievements: string;
  selfEvaluation: string;
  sourceChannel: string;
}

export const RECRUIT_FIELD_LABELS: Record<keyof RecruitForm, string> = {
  name: '姓名', gender: '性别', ethnicity: '民族', birthDate: '出生日期', marital: '婚否', education: '学历', school: '毕业院校',
  graduationDate: '毕业时间', expectedSalary: '期望薪资', idNo: '身份证号码', phone: '手机号', educationHistory: '教育经历',
  workHistory: '工作经历', achievements: '工作成果', selfEvaluation: '自我评价', sourceChannel: '应聘获取渠道',
};

export function emptyRecruitForm(sourceChannel = ''): RecruitForm {
  return { name: '', gender: '', ethnicity: '', birthDate: '', marital: '', education: '', school: '', graduationDate: '', expectedSalary: '',
    idNo: '', phone: '', educationHistory: [], workHistory: [], achievements: '', selfEvaluation: '', sourceChannel };
}

/** 18 位身份证号校验位 */
export function isValidIdNo(raw: string): boolean {
  const id = raw.toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(id[i]) * weights[i];
  if (codes[sum % 11] !== id[17]) return false;
  const y = Number(id.slice(6, 10)), m = Number(id.slice(10, 12)), d = Number(id.slice(12, 14));
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 1900;
}

/** 脱敏显示：110101********1234 */
export function maskIdNo(id: string): string {
  return id.length >= 8 ? `${id.slice(0, 6)}${'*'.repeat(id.length - 10)}${id.slice(-4)}` : '****';
}

/** “2015年3月”“2015.03.12”“2015-3”统一成 YYYY-MM-DD / YYYY-MM；认不出来返回空。 */
export function normalizeRecruitDate(input: unknown): string {
  if (typeof input !== 'string') return '';
  const m = input.trim().match(/^(\d{4})\D{1,3}(\d{1,2})(?:\D{1,3}(\d{1,2}))?\D?$/);
  if (!m) return '';
  const month = Number(m[2]);
  if (month < 1 || month > 12) return '';
  const mm = String(month).padStart(2, '0');
  if (m[3] === undefined) return `${m[1]}-${mm}`;
  const day = Number(m[3]);
  const date = new Date(Date.UTC(Number(m[1]), month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${m[1]}-${mm}-${String(day).padStart(2, '0')}`;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
/** 识别/手填常见写法 → 标准学历选项 */
function educationOf(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if ((RECRUIT_EDUCATIONS as readonly string[]).includes(t)) return t;
  if (/博士/.test(t)) return '博士';
  if (/硕士|研究生/.test(t)) return '硕士';
  if (/本科|学士|大学/.test(t)) return '本科';
  if (/大专|专科|高职/.test(t)) return '大专';
  if (/高中|中专|中技|技校|职高|职中/.test(t)) return '高中/中专';
  if (/初中|小学/.test(t)) return '初中及以下';
  return '';
}
const pick = <T extends string>(v: unknown, options: readonly T[]) => (typeof v === 'string' && (options as readonly string[]).includes(v.trim()) ? (v.trim() as T) : '');

function history(v: unknown): RecruitHistoryItem[] {
  if (!Array.isArray(v)) return [];
  const rows: RecruitHistoryItem[] = [];
  for (const raw of v.slice(0, RECRUIT_MAX_HISTORY)) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const row = { period: text(o.period, 40), org: text(o.org, 100), title: text(o.title, 100), note: text(o.note, 500) };
    if (row.period || row.org || row.title || row.note) rows.push(row);
  }
  return rows;
}

/** 把任意输入整理成登记表（识别结果、网络提交都先过这里）；不合规的选项/日期变成空，不报错。 */
export function normalizeRecruitForm(input: unknown): RecruitForm {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const idNo = text(o.idNo, 30).replace(/\s+/g, '').toUpperCase();
  return {
    name: text(o.name, 50), gender: pick(o.gender, RECRUIT_GENDERS), ethnicity: text(o.ethnicity, 20).replace(/族$/, '') && `${text(o.ethnicity, 20).replace(/族$/, '')}族`,
    birthDate: normalizeRecruitDate(o.birthDate), marital: pick(o.marital, RECRUIT_MARITAL), education: educationOf(o.education),
    school: text(o.school, 100), graduationDate: normalizeRecruitDate(o.graduationDate), expectedSalary: text(o.expectedSalary, 40),
    idNo, phone: text(o.phone, 20).replace(/[\s-]/g, ''), educationHistory: history(o.educationHistory), workHistory: history(o.workHistory),
    achievements: text(o.achievements, 2000), selfEvaluation: text(o.selfEvaluation, 2000), sourceChannel: text(o.sourceChannel, 40),
  };
}

/** 提交前的必填和格式检查，返回人话错误；空数组表示通过。 */
export function recruitFormProblems(f: RecruitForm): string[] {
  const p: string[] = [];
  if (!f.name) p.push('请填写姓名');
  if (!f.gender) p.push('请选择性别');
  if (!f.birthDate || f.birthDate.length !== 10) p.push('请填写出生日期');
  if (!f.education) p.push('请选择学历');
  if (!f.phone || !/^1[3-9]\d{9}$/.test(f.phone)) p.push('请填写有效的 11 位手机号');
  if (!f.idNo) p.push('请填写身份证号码');
  else if (!isValidIdNo(f.idNo)) p.push('身份证号码不正确，请核对 18 位号码');
  if (!f.sourceChannel) p.push('请选择应聘获取渠道');
  return p;
}

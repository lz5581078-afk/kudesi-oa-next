import { RECRUIT_FIELD_LABELS, type RecruitForm } from '@kudesi/shared';
import type { RecruitDetail } from './recruitApi';

const L = RECRUIT_FIELD_LABELS;
const dash = (v: string) => v || '—';

/** 面试用的 A4 登记表。屏幕上隐藏，打印时只显示它 */
export function RecruitPrintSheet({ detail, form, company }: { detail: RecruitDetail; form: RecruitForm; company: string }) {
  const history = (title: string, rows: RecruitForm['workHistory'], org: string, role: string) => (
    <>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="recruit-print-empty">未填写</p> : (
        <table><thead><tr><th>起止时间</th><th>{org}</th><th>{role}</th><th>说明</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><td>{dash(r.period)}</td><td>{dash(r.org)}</td><td>{dash(r.title)}</td><td>{dash(r.note)}</td></tr>)}</tbody></table>
      )}
    </>
  );
  return (
    <article className="recruit-print" aria-hidden="true" data-testid="recruit-print-sheet">
      <h1>{company} · 面试登记表</h1>
      <p className="recruit-print-meta">登记时间：{new Date(detail.createdAt).toLocaleString('zh-CN')}　登记方式：{detail.sourceMode === 'image' ? '简历图片识别后确认' : '手工填写'}　跟进人事：{detail.handlerName ?? '未认领'}</p>
      <table className="recruit-print-basic"><tbody>
        <tr><th>{L.name}</th><td>{form.name}</td><th>{L.gender}</th><td>{form.gender}</td><th>{L.ethnicity}</th><td>{dash(form.ethnicity)}</td></tr>
        <tr><th>{L.birthDate}</th><td>{form.birthDate}</td><th>{L.marital}</th><td>{dash(form.marital)}</td><th>{L.phone}</th><td>{form.phone}</td></tr>
        <tr><th>{L.education}</th><td>{form.education}</td><th>{L.school}</th><td>{dash(form.school)}</td><th>{L.graduationDate}</th><td>{dash(form.graduationDate)}</td></tr>
        <tr><th>{L.expectedSalary}</th><td>{dash(form.expectedSalary)}</td><th>{L.idNo}</th><td colSpan={3}>{form.idNo}</td></tr>
        <tr><th>{L.sourceChannel}</th><td colSpan={5}>{form.sourceChannel}</td></tr>
      </tbody></table>
      {history(L.educationHistory, form.educationHistory, '学校', '专业')}
      {history(L.workHistory, form.workHistory, '公司', '职位')}
      <h3>{L.achievements}</h3><p className="recruit-print-text">{form.achievements || '未填写'}</p>
      <h3>{L.selfEvaluation}</h3><p className="recruit-print-text">{form.selfEvaluation || '未填写'}</p>
      <h3>面试记录</h3>
      <div className="recruit-print-notes"><p>面试官：＿＿＿＿＿＿　面试时间：＿＿＿＿＿＿　结果：□ 通过　□ 待定　□ 不通过</p><div className="recruit-print-lines" /></div>
    </article>
  );
}

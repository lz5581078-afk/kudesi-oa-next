import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { emptyRecruitForm, normalizeRecruitForm, recruitFormProblems, type RecruitForm } from '@kudesi/shared';
import { RecruitFormFields } from './RecruitFormFields';
import { recruitApplyApi, type PublicOpening } from './recruitApi';
import './recruit.css';

type Step = 'choose' | 'recognizing' | 'fill' | 'done';

/** 求职者扫码进入（免登录）：先选手工填写或简历图片识别，识别后本人确认再提交 */
export function RecruitApplyPage() {
  const token = useLocation().hash.slice(1);
  const [info, setInfo] = useState<{ companyName: string; channel: string; openings: PublicOpening[] } | null>(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState<Step>('choose');
  const [mode, setMode] = useState<'manual' | 'image'>('manual');
  const [form, setForm] = useState<RecruitForm>(emptyRecruitForm());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [openingId, setOpeningId] = useState('');
  const requestKey = useRef(crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { setError('招聘二维码无效，请联系公司人事重新获取。'); return; }
    recruitApplyApi.preview(token).then((r) => { if (active) { setInfo(r); setForm(emptyRecruitForm(r.channel)); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : '二维码读取失败，请重试'); });
    return () => { active = false; };
  }, [token]);

  async function recognize(file: File | undefined) {
    if (!file) return;
    setError(''); setNotice(''); setStep('recognizing'); setMode('image');
    try {
      const r = await recruitApplyApi.recognize(token, file);
      setForm({ ...emptyRecruitForm(info?.channel), ...r.form, sourceChannel: r.form.sourceChannel || info?.channel || '' });
      setNotice('已根据简历图片帮你填好，请逐项核对、补全缺少的内容后再提交（身份证号、手机号请务必自己确认）。');
      setStep('fill');
    } catch (e) {
      setError(`${e instanceof Error ? e.message : '识别失败'}`); setStep('choose');
    } finally { if (fileInput.current) fileInput.current.value = ''; }
  }

  async function submit() {
    if (busy) return;
    if (info?.openings.length && !openingId) { setError('请选择应聘岗位'); return; }
    const clean = normalizeRecruitForm(form);
    const problems = recruitFormProblems(clean);
    if (problems.length) { setError(problems.join('；')); return; }
    setBusy(true); setError('');
    try {
      await recruitApplyApi.submit({ token, requestKey: requestKey.current, sourceMode: mode, form: clean, ...(openingId ? { openingId: Number(openingId) } : {}) });
      setStep('done');
    } catch (e) { setError(e instanceof Error ? e.message : '提交失败，请重试'); } finally { setBusy(false); }
  }

  return (
    <main className="recruit-apply">
      <section className="recruit-apply-card">
        <div className="enrollment-brand">{info?.companyName ?? '面试登记'}</div>
        <h1>面试登记表</h1>
        {error && <div className="notice error" role="alert">{error}</div>}
        {!info && !error && <p className="muted">正在读取…</p>}
        {info && step === 'choose' && (
          <>
            <p className="enrollment-intro">欢迎应聘。请选择填写方式，提交后公司人事会尽快联系你。</p>
            <div className="recruit-choice">
              <button type="button" className="primary" onClick={() => { setMode('manual'); setNotice(''); setStep('fill'); }}>手工填写<small>逐项填写登记表</small></button>
              <button type="button" onClick={() => fileInput.current?.click()}>已有简历图片，识别后确认<small>上传简历照片/截图，自动填表，你确认后再提交</small></button>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="resume-file" onChange={(e) => void recognize(e.target.files?.[0])} />
            </div>
          </>
        )}
        {step === 'recognizing' && <p className="recruit-busy" role="status">正在识别简历，请稍候（约十几秒）…</p>}
        {info && step === 'fill' && (
          <>
            {notice && <div className="notice warn">{notice}</div>}
            {info.openings.length > 0 && (
              <div className="recruit-fields recruit-opening">
                <label>应聘岗位
                  <select value={openingId} onChange={(e) => setOpeningId(e.target.value)}>
                    <option value="">请选择应聘岗位</option>
                    {info.openings.map((o) => <option key={o.id} value={o.id}>{o.title}{o.departmentName ? `（${o.departmentName}）` : ''}</option>)}
                  </select>
                </label>
                {info.openings.find((o) => String(o.id) === openingId)?.requirements && <p className="muted recruit-text">{info.openings.find((o) => String(o.id) === openingId)?.requirements}</p>}
              </div>
            )}
            <RecruitFormFields form={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />
            <div className="recruit-actions">
              <button type="button" className="ghost" onClick={() => { setStep('choose'); setError(''); }}>返回重选</button>
              <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>{busy ? '提交中…' : '确认无误，提交'}</button>
            </div>
          </>
        )}
        {step === 'done' && (
          <div className="recruit-done" role="status">
            <h2>提交成功</h2>
            <p>你的面试登记表已送达公司人事部门，请保持手机畅通，等待面试通知。</p>
          </div>
        )}
      </section>
    </main>
  );
}

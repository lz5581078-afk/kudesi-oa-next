import { useEffect, useState } from 'react';
import { resourceApi, type LogEntry } from './api';
export function ReferenceRecordHistory({ type, id, label }: { type: string; id: number; label: string }) {
  const [rows,setRows]=useState<LogEntry[] | null>(null),[error,setError]=useState('');
  useEffect(()=>{let alive=true;resourceApi.logs(type,id).then(r=>alive&&setRows(r)).catch(()=>alive&&setError('操作记录暂不可读。'));return()=>{alive=false;};},[type,id]);
  return <section className="reference-record-history"><h3>{label}档案操作记录</h3>{error ? <p>{error}</p> : rows===null ? <p>读取中…</p> : !rows.length ? <div><strong>暂无操作记录</strong><p>新增、编辑、停用和删除等动作会记录在这里。</p></div> : <ol>{rows.map(r=><li key={r.id}><strong>{r.action}</strong><small>{r.actor} · {r.createdAt}</small>{r.note&&<p>{r.note}</p>}</li>)}</ol>}</section>;
}

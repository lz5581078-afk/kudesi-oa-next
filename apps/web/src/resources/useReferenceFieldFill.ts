import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ResourceDef } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';

type Values = Record<string, unknown>;
type Result = { scope: string; id: number; data?: Values; error?: string };
const empty = (value: unknown) => value === undefined || value === null || value === '';

/** Optional form-only reference defaults; it never changes resource validation or writes a record. */
export function useReferenceFieldFill(def: ResourceDef, record: ResourceDto | null, values: Values, setValues: Dispatch<SetStateAction<Values>>, identity: string) {
  const fields = def.fields.filter(field => field.type === 'ref' && field.ref && field.referenceFill);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [attempt, setAttempt] = useState(0);
  const applied = useRef<Record<string, number>>({});
  const valuesRef = useRef(values); valuesRef.current = values;
  const scope = JSON.stringify([identity, fields.map(field => [field.key,field.ref,field.referenceFill,Number(values[field.key]) || 0]),attempt]);
  useEffect(() => {
    let active = true;
    for (const field of fields) {
      const id = Number(values[field.key]) || 0;
      const mapping = field.referenceFill!;
      if (!id) {
        if (!record) setValues(current => {
          const patch = Object.fromEntries(mapping.targets.filter(target => target.clearOnEmpty && !empty(current[target.field])).map(target => [target.field,'']));
          return Object.keys(patch).length ? {...current,...patch} : current;
        });
        continue;
      }
      setResults(current => { const next={...current};delete next[field.key];return next; });
      void resourceApi.get(field.ref!,id).then(source => {
        if (!active || Number(valuesRef.current[field.key]) !== id) return;
        setResults(current => ({...current,[field.key]:{scope,id,data:source.data}}));
        const initialExisting = applied.current[field.key] === undefined && record && Number(record.data[field.key]) === id;
        applied.current[field.key] = id;
        if (initialExisting) return;
        setValues(current => {
          if (Number(current[field.key]) !== id) return current;
          const patch: Values = {};
          for (const target of mapping.targets) {
            if (source.data[target.source] === undefined || target.whenEmpty && !empty(current[target.field])) continue;
            patch[target.field] = source.data[target.source];
          }
          return Object.keys(patch).length ? {...current,...patch} : current;
        });
      }).catch(error => {
        if (active && Number(valuesRef.current[field.key]) === id) setResults(current => ({...current,[field.key]:{scope,id,error:(error as Error).message || '引用资料读取失败'}}));
      });
    }
    return () => { active = false; };
  // Target edits must not refetch or overwrite the user's input.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  const problems: Record<string,string> = {};
  const locked: string[] = [];
  let pending = false;
  for (const field of fields) {
    const id=Number(values[field.key]) || 0;
    if (!id) continue;
    const result=results[field.key]?.id===id && results[field.key]?.scope===scope ? results[field.key] : undefined;
    if (!result) { pending=true;problems[field.key]='引用资料正在加载，请稍候'; }
    else if (result.error) problems[field.key]=result.error;
    for (const lock of field.referenceFill!.locks ?? []) if (!result?.data?.[lock.unlessSource]) locked.push(lock.field);
  }
  return {locked,problems,pending,error:Object.values(problems).find(problem=>problem!=='引用资料正在加载，请稍候') || '',retry:()=>setAttempt(value=>value+1)};
}

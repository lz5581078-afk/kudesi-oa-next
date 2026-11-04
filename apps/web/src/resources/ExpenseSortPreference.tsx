import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {EXPENSE_SORT_KEY,normalizeExpenseSortPreference,applyExpenseSortOrder,moveExpenseIdBefore,type ExpenseSortPreference} from '@kudesi/shared';
import {api} from '../api/client';
import {useAuth} from '../auth/AuthContext';
interface SortContext{value:ExpenseSortPreference;revision:number;reload:()=>Promise<void>;flush:()=>Promise<void>;move:(section:keyof ExpenseSortPreference,key:string,ids:number[],source:number,target:number)=>void}
const Context=createContext<SortContext|null>(null);
export const useExpenseSortPreference=()=>useContext(Context);
export function ExpenseSortProvider({enabled,children}:{enabled:boolean;children:ReactNode}){const {user}=useAuth();const identity=JSON.stringify([user?.companyId,user?.id,user?.permissions]);return enabled?<ScopedProvider key={identity}>{children}</ScopedProvider>:<>{children}</>;}
function ScopedProvider({children}:{children:ReactNode}){
 const [value,setValue]=useState(()=>normalizeExpenseSortPreference(null)),[revision,setRevision]=useState(0);const current=useRef(value),mounted=useRef(false),sequence=useRef(0),edited=useRef(0),queue=useRef(Promise.resolve());current.current=value;
 const reload=async()=>{const request=++sequence.current,initial=edited.current;const result=await api<{value:unknown}>(`/user-preferences/${EXPENSE_SORT_KEY}`);if(mounted.current&&request===sequence.current&&initial===edited.current){const next=normalizeExpenseSortPreference(result.value);current.current=next;setValue(next);setRevision(value=>value+1);}};
 useEffect(()=>{mounted.current=true;void reload().catch(()=>{});return()=>{mounted.current=false;sequence.current++;};},[]);
 const move:SortContext['move']=(section,key,ids,source,target)=>{if(!mounted.current)return;const ordered=applyExpenseSortOrder(ids.map(id=>({id})),current.current[section][key]).map(row=>String(row.id));const nextOrder=moveExpenseIdBefore(ordered,source,target);if(nextOrder.join('|')===ordered.join('|'))return;const next={...current.current,[section]:{...current.current[section],[key]:nextOrder}};edited.current++;current.current=next;setValue(next);setRevision(value=>value+1);queue.current=queue.current.catch(()=>{}).then(async()=>{if(mounted.current){await api(`/user-preferences/${EXPENSE_SORT_KEY}`,{method:'PUT',body:{value:next}});if(mounted.current)setRevision(value=>value+1);}}).catch(()=>{});};
 return <Context.Provider value={{value,revision,reload,flush:()=>queue.current,move}}>{children}</Context.Provider>;
}

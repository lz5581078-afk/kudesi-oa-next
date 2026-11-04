/** 24号OA显示契约：无时区的数据库壁钟属北京时间，带offset的值表示真实瞬间。 */
const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function partsOf(value:unknown):Record<string,string>|null{
 if(value===null||value===undefined||value==='')return null;
 let input=value;
 if(typeof input==='string'){
  const trimmed=input.trim();input=trimmed;
  const local=trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?)?$/);
  if(local){const [,year,month,day,hour='00',minute='00',second='00',fraction='']=local;input=`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T${hour.padStart(2,'0')}:${minute}:${second}${fraction}+08:00`;}
 }
 const date=input instanceof Date?input:typeof input==='string'||typeof input==='number'?new Date(input):null;
 return date&&Number.isFinite(date.getTime())?Object.fromEntries(clock.formatToParts(date).map(part=>[part.type,part.value])):null;
}
export function formatOaDateTime(value:unknown,{seconds=true,empty='-'}:{seconds?:boolean;empty?:string}={}){
 const parts=partsOf(value);return parts?`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${seconds?`:${parts.second}`:''}`:empty;
}

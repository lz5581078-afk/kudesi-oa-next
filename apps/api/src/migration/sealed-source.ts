import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat,mkdir,open,readFile,realpath,rename,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createInterface } from 'node:readline';
import type { CryptoService } from '../common/crypto.service';
import type { LegacyArchive } from './protocol';

interface Identity { sourceCompanyId:number;softwareFingerprint:string }
type Path=Array<string|number>;
const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const invalid=()=>Error('封存迁移包校验失败，禁止导入');
function identity(i:Identity){if(!Number.isSafeInteger(i.sourceCompanyId)||i.sourceCompanyId<1||!/^([a-f0-9]{64})$/.test(i.softwareFingerprint))throw invalid();}
/** No Date coercion, unsafe integers, binary coercion, holes or hidden code.
 * Undefined optional object properties have the same JSON representation as
 * the existing importer; undefined array values are never silently made null. */
function jsonValue(v:unknown):unknown{
  if(v===null||typeof v==='string'||typeof v==='boolean')return v;
  if(typeof v==='number'){if(!Number.isFinite(v)||(Number.isInteger(v)&&!Number.isSafeInteger(v)))throw invalid();return v;}
  if(v instanceof Date||Buffer.isBuffer(v)||!v||typeof v!=='object')throw invalid();
  if(Array.isArray(v)){for(let i=0;i<v.length;i++)if(!(i in v))throw invalid();return v.map(jsonValue);}
  return Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).map(([k,x])=>[k,jsonValue(x)]));
}
async function privateRoot(path:string){const root=await realpath(path),s=await lstat(root);if(!s.isDirectory()||(s.mode&0o077)!==0)throw invalid();return root;}
async function privateFile(path:string){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0)throw invalid();}
/** Canonical streaming digest; only the file loader and transport locators
 * differ between the original and sealed representations. */
export function sealedSourceHash(archive:LegacyArchive){
  const {loadFile:_,...rest}=archive;
  const data={...rest,records:archive.records.map(r=>({...r,...(r.files?{files:r.files.map(f=>({...f,locator:'content:'+f.contentHash}))}:{})}))};
  const hash=createHash('sha256'),ancestors=new Set<object>();
  const walk=(v:unknown)=>{
    if(v===null||typeof v!=='object'){hash.update(JSON.stringify(jsonValue(v)));return;}
    if(v instanceof Date||Buffer.isBuffer(v)||ancestors.has(v))throw invalid();ancestors.add(v);
    if(Array.isArray(v)){hash.update('[');for(let i=0;i<v.length;i++){if(!(i in v))throw invalid();if(i)hash.update(',');walk(v[i]);}hash.update(']');}
    else{hash.update('{');const keys=Object.keys(v).filter(k=>(v as any)[k]!==undefined).sort();keys.forEach((k,i)=>{if(i)hash.update(',');hash.update(JSON.stringify(k)+':');walk((v as any)[k]);});hash.update('}');}
    ancestors.delete(v);
  };walk(data);return hash.digest('hex');
}
/** A new private directory only; no SQL, workers, external writes or key files.
 * Each array row is its own authenticated frame, avoiding a second serialized
 * copy of the complete archive in memory. Chain and footer reject truncation,
 * reordering and ciphertext copied from another package. */
export async function writeSealedArchive(directory:string,archive:LegacyArchive,crypto:CryptoService,pin:Identity){
  identity(pin);if(archive.company.id!==pin.sourceCompanyId)throw invalid();
  await mkdir(resolve(directory),{mode:0o700});const root=await privateRoot(directory);
  try{
    await mkdir(join(root,'files'),{mode:0o700});
    const sourceHash=sealedSourceHash(archive),written=new Set<string>();let bytes=0,references=0;
    const records=[];
    for(const row of archive.records){
      const files=[];
      for(const file of row.files??[]){
        if(!file.contentHash||!/^[a-f0-9]{64}$/.test(file.contentHash))throw invalid();
        const buffer=await archive.loadFile(file.locator);
        if(sha(buffer)!==file.contentHash)throw invalid();
        if(!written.has(file.contentHash)){
          const handle=await open(join(root,'files',file.contentHash),'wx',0o600);
          try{await handle.writeFile(buffer);await handle.sync();}finally{await handle.close();}
          written.add(file.contentHash);bytes+=buffer.length;
        }
        files.push({...file,locator:'sealed:'+file.contentHash});references++;
      }
      records.push({...row,...(row.files?{files}:{})});
    }
    const {loadFile:_,...source}=archive;
    const data={...source,records};
    const handle=await open(join(root,'archive.part'),'wx',0o600);
    const hash=createHash('sha256');let seq=0,previous='';
    const emit=async(body:Record<string,unknown>)=>{
      const cipher=crypto.encrypt(JSON.stringify({seq,previous,body})),line=cipher+'\n';
      await handle.writeFile(line);hash.update(line);previous=sha(line);seq++;
    };
    const walk=async(value:unknown,path:Path,atomic=false):Promise<void>=>{
      if(atomic||value===null||typeof value!=='object'){await emit({kind:'value',path,value:jsonValue(value)});return;}
      if(value instanceof Date||Buffer.isBuffer(value))throw invalid();
      if(Array.isArray(value)){
        await emit({kind:'array',path,length:value.length});
        for(let i=0;i<value.length;i++){if(!(i in value))throw invalid();await walk(value[i],[...path,i],true);}return;
      }
      const entries=Object.entries(value).filter(([,v])=>v!==undefined);
      await emit({kind:'object',path,keys:entries.map(([k])=>k)});
      for(const [key,v]of entries)await walk(v,[...path,key]);
    };
    try{
      await emit({kind:'header',format:1,...pin,sourceHash});await walk(data,[]);
      if(sealedSourceHash(archive)!==sourceHash)throw invalid();
      await emit({kind:'end',frames:seq,dataHash:hash.copy().digest('hex')});await handle.sync();
    }finally{await handle.close();}
    await rename(join(root,'archive.part'),join(root,'archive.enc'));
    return {sha256:hash.digest('hex'),sourceHash,frames:seq,files:written.size,fileReferences:references,fileBytes:bytes};
  }catch{await rm(root,{recursive:true,force:true});throw invalid();}
}

/** Reconstruct only after authenticating every frame and the complete bytes.
 * Expected digest and identity come from the separately reviewed receipt.
 * Reconstructed containers have no prototype; untrusted JSON property names
 * cannot write through Object.prototype. Original row JSON remains ordinary
 * data and is never used as a path. */
export async function readSealedArchive(directory:string,crypto:CryptoService,expectedSha:string,pin:Identity):Promise<LegacyArchive>{
  identity(pin);if(!/^[a-f0-9]{64}$/.test(expectedSha))throw invalid();
  const root=await privateRoot(directory),path=join(root,'archive.enc');await privateFile(path);
  const input=createReadStream(path),bytesHash=createHash('sha256'),chainHash=createHash('sha256');input.on('data',chunk=>bytesHash.update(chunk));
  const lines=createInterface({input,crlfDelay:Infinity});
  let seq=0,previous='',ended=false,result:any,sourceHash='';
  const containers=new Map<string,{value:any;keys:Array<string|number>;next:number}>();
  const key=(p:Path)=>JSON.stringify(p);
  const assign=(p:Path,value:any)=>{
    if(!p.length){if(result!==undefined)throw invalid();result=value;return;}
    const parent=containers.get(key(p.slice(0,-1))),part=p[p.length-1];
    if(!parent||parent.keys[parent.next]!==part||parent.next>=parent.keys.length)throw invalid();
    parent.value[part]=value;parent.next++;
  };
  try{
    for await(const line of lines){
      if(ended||!line||line.length>128*1024*1024)throw invalid();
      const frame=JSON.parse(crypto.decrypt(line)),body=frame.body;
      if(frame.seq!==seq||frame.previous!==previous||!body||typeof body!=='object')throw invalid();
      if(seq===0){if(body.kind!=='header'||body.format!==1||body.sourceCompanyId!==pin.sourceCompanyId||body.softwareFingerprint!==pin.softwareFingerprint||typeof body.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(body.sourceHash))throw invalid();sourceHash=body.sourceHash;}
      else if(body.kind==='end'){
        if(body.frames!==seq||body.dataHash!==chainHash.copy().digest('hex')||result===undefined||[...containers.values()].some(c=>c.next!==c.keys.length))throw invalid();ended=true;
      }else{
        const p=body.path;
        if(!Array.isArray(p)||p.length>40||p.some((v:any)=>typeof v!=='string'&&(!Number.isSafeInteger(v)||v<0)))throw invalid();
        if(body.kind==='value')assign(p,jsonValue(body.value));
        else if(body.kind==='array'||body.kind==='object'){
          const array=body.kind==='array';
          if(array&&(!Number.isSafeInteger(body.length)||body.length<0||body.length>5000000))throw invalid();
          if(!array&&(!Array.isArray(body.keys)||body.keys.some((k:any)=>typeof k!=='string')||new Set(body.keys).size!==body.keys.length))throw invalid();
          const keys=array?Array.from({length:body.length},(_,i)=>i):body.keys,value=array?[]:Object.create(null);
          if(containers.has(key(p)))throw invalid();assign(p,value);containers.set(key(p),{value,keys,next:0});
        }else throw invalid();
      }
      const encoded=line+'\n';chainHash.update(encoded);previous=sha(encoded);seq++;
    }
    if(!ended||bytesHash.digest('hex')!==expectedSha||result?.company?.id!==pin.sourceCompanyId||!Array.isArray(result.records))throw invalid();
    result.loadFile=async(locator:string)=>{
      if(!/^sealed:[a-f0-9]{64}$/.test(locator))throw invalid();
      const digest=locator.slice(7),file=join(root,'files',digest);await privateFile(file);const bytes=await readFile(file);if(sha(bytes)!==digest)throw invalid();return bytes;
    };
    if(await privateRoot(join(root,'files'))!==join(root,'files'))throw invalid();
    const checked=new Set<string>();
    for(const record of result.records)for(const file of record.files??[]){
      if(typeof file.locator!=='string'||!/^sealed:[a-f0-9]{64}$/.test(file.locator)||file.contentHash!==file.locator.slice(7))throw invalid();
      if(!checked.has(file.locator)){await result.loadFile(file.locator);checked.add(file.locator);}
    }
    if(sealedSourceHash(result)!==sourceHash)throw invalid();
    return result as LegacyArchive;
  }catch{throw invalid();}finally{lines.close();input.destroy();}
}

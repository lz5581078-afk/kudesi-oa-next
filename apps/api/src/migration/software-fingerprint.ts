import { createHash } from 'node:crypto';
import { existsSync,readFileSync,readdirSync,realpathSync } from 'node:fs';
import { dirname,extname,relative,resolve,sep } from 'node:path';

interface Layout {apiDir:string;sharedDir:string;adapterPath:string;packages:Array<{label:string;file:string}>}
/** Hash deployed code, not environment files, credentials or audit reports.
 * Adapter code must live in its own directory. The entry point is part of the
 * identity even when several adapters share the same helper files. */
export function fingerprintMigrationLayout(layout:Layout){
  const entries:Array<[string,string]>=[];
  const digest=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
  const walk=(root:string,group:string,adapter=false)=>{
    const visit=(dir:string)=>{
      for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
        const file=resolve(dir,entry.name);
        if(entry.isSymbolicLink())throw Error('迁移程序目录包含符号链接，无法锁定代码');
        if(entry.isDirectory()){if(entry.name!=='node_modules')visit(file);continue;}
        if(!entry.isFile())continue;
        const ext=extname(entry.name);
        if(!['.js','.cjs'].includes(ext)&&!(ext==='.json'&&(!adapter||entry.name==='mapping-rules.json')))continue;
        entries.push([`${group}/${relative(root,file).split(sep).join('/')}`,digest(file)]);
      }
    };visit(root);
  };
  walk(realpathSync(layout.apiDir),'api');walk(realpathSync(layout.sharedDir),'shared');
  const adapter=realpathSync(layout.adapterPath),adapterDir=dirname(adapter);walk(adapterDir,'adapter',true);
  entries.push(['adapter-entry',relative(adapterDir,adapter).split(sep).join('/')]);
  for(const pkg of layout.packages)entries.push([`package/${pkg.label}`,existsSync(pkg.file)?digest(pkg.file):'missing']);
  return createHash('sha256').update(JSON.stringify(entries.sort(([a],[b])=>a<b?-1:a>b?1:0))).digest('hex');
}

export function migrationSoftwareFingerprint(adapterPath:string){
  const root=resolve(__dirname,'../../../..');
  return fingerprintMigrationLayout({apiDir:resolve(__dirname,'..'),sharedDir:dirname(require.resolve('@kudesi/shared')),adapterPath,packages:[
    {label:'root-lock',file:resolve(root,'package-lock.json')},{label:'root',file:resolve(root,'package.json')},
    {label:'api',file:resolve(root,'apps/api/package.json')},{label:'shared',file:resolve(root,'packages/shared/package.json')},
  ]});
}

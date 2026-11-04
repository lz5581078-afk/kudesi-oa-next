import { pinyin } from 'pinyin-pro';
import { BadRequestException } from '@nestjs/common';
import type { BeforeSaveContext } from './resource-rules';
import { Company, ResourceRecord, ResourceLink } from '../entities';

/** 编码目录独立于档案分类；手工维护与受控工作簿使用相同的层级/身份约束。 */
export async function beforeCodeDictionary({em,user,data,existing}:BeforeSaveContext) {
  await em.findOneOrFail(Company,{where:{id:user.companyId},lock:{mode:'pessimistic_write'}});
  const kind=String(data.kind ?? '');
  if(!['product_category','variety'].includes(kind))throw new BadRequestException('编码字典类型不正确');
  const rows=await em.find(ResourceRecord,{where:{companyId:user.companyId,type:'finance-code-dictionaries'}});
  data.name=String(data.name ?? '').trim();
  let code=String(data.code ?? '').trim().toUpperCase();
  if(!code){
    code=String(existing?.data.code || '').trim();
    if(!code){
      const base=(pinyin(String(data.name),{pattern:'first',toneType:'none',type:'array'}).join('').replace(/[^A-Z0-9]/gi,'').toUpperCase() || (kind==='variety'?'PZ':'FL')).slice(0,24);
      const used=new Set(rows.filter(row=>row.data.kind===kind).map(row=>String(row.data.code).toUpperCase()));
      code=base;for(let suffix=2;used.has(code);suffix++)code=base+suffix;
    }
  }
  data.code=code;
  if(!/^[A-Z0-9][A-Z0-9_+*/.-]*$/.test(code))throw new BadRequestException('编码字典编码格式不正确');
  if(kind==='variety' && data.parentId!=null)throw new BadRequestException('品种字典不能设置上级');
  const children=existing?rows.filter(row=>row.data.parentId===existing.id):[];
  if(existing && existing.data.kind!==kind && children.length)throw new BadRequestException('含下级分类的字典不能更改类型');
  if(data.parentId!=null){
    const parent=rows.find(row=>row.id===Number(data.parentId));
    if(!parent || parent.status!=='active' || parent.archivedAt || parent.data.kind!==kind)throw new BadRequestException('请选择同类启用的上级编码字典');
    const byId=new Map(rows.map(row=>[row.id,row])),seen=new Set<number>(existing?[existing.id]:[]);
    let ancestorDepth=0,current:ResourceRecord|undefined=parent;
    while(current){
      if(seen.has(current.id))throw new BadRequestException('上级分类不能形成循环');seen.add(current.id);ancestorDepth++;
      if(current.data.parentId==null)break;
      current=byId.get(Number(current.data.parentId));if(!current || current.data.kind!==kind)throw new BadRequestException('分类父级资料不完整');
    }
    const height=(id:number,path:Set<number>):number=>{
      if(path.has(id))throw new BadRequestException('上级分类不能形成循环');
      const next=new Set(path);next.add(id);
      return 1+Math.max(0,...rows.filter(row=>row.data.parentId===id).map(row=>height(row.id,next)));
    };
    if(ancestorDepth+(existing?height(existing.id,new Set()):1)>4)throw new BadRequestException('商品编码分类最多四级');
  }

  if(rows.some(row=>row.id!==existing?.id && row.data.kind===kind && String(row.data.name).toLowerCase()===String(data.name).toLowerCase() && (row.data.parentId ?? null)===(data.parentId ?? null)))throw new BadRequestException('同级编码字典已有此名称');
  if(existing && (existing.data.kind!==kind || existing.data.code!==data.code)){
    const links=await em.find(ResourceLink,{where:{companyId:user.companyId,targetType:'finance-code-dictionaries',targetId:existing.id},take:1});
    if(links.length)throw new BadRequestException('编码字典已被引用，类型和编码不能修改');
  }
}

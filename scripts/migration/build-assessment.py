#!/usr/bin/env python3
"""Offline report builder. Inputs and generated business reports must stay outside Git."""
import argparse
import csv
import json
import os
from pathlib import Path
import re
from collections import Counter, defaultdict


def snake(value):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', value).lower()


def json_source(rule):
    spec=rule.get('json')
    if not spec:return None
    return rule['tables'][0]+(':'+spec['kind'] if spec.get('kind') else '')+'.'+spec['column']


def candidates(field,rule,common):
    names=rule.get('aliases',{}).get(field['key'],common.get(field['key'],[]))
    return list(dict.fromkeys(names+[field['key'],snake(field['key'])]))


def locate(field,rule,common,source):
    tables={t['name']:t for t in source['tables']}
    shapes=source.get('jsonProfiles',{})
    for name in candidates(field,rule,common):
        if name.startswith('@json:'):
            key=json_source(rule);target=name[len('@json:'):]
            profile=shapes.get(key,{})
            if target in profile.get('paths',{}):return key+':'+target,'json',profile['paths'][target]
            continue
        if name.startswith('@'):
            if name.startswith('@review:'):return name[8:],'review',{}
            return name[1:],'transform',{}
        for table in rule['tables']:
            if name in {c['name'] for c in tables.get(table,{}).get('columns',[])}:
                return table+'.'+name,'column',source.get('profiles',{}).get(table,{}).get('fields',{}).get(name,{})
        spec=rule.get('json');key=json_source(rule)
        if spec:
            path=spec['path']+'.'+name
            if path in shapes.get(key,{}).get('paths',{}):return key+':'+path,'json',shapes[key]['paths'][path]
    return '', 'missing', {}


def transform(field,kind):
    todo=[]
    if field['type'] in ['ref','refs']:todo.append('旧ID到新ID映射；校验同公司；禁止用姓名或显示名直接猜关联')
    if field['type']=='money':todo.append('核实旧单位后用十进制定点换算为整数分；小于一分的差异单列，不静默舍入')
    if field['type'] in ['secret','sensitive']:todo.append('服务器内按旧格式解密后以新密钥重加密；报告不输出原值')
    if field['type']=='files':todo.append('迁移真实文件并校验数量/摘要；回填新文件ID；旧URL不能直接当新附件')
    if field['type']=='select':todo.append('按新枚举逐值对应；未知值不设默认，列待处理')
    if field['type'] in ['date','monthday']:todo.append('保留业务日期，明确时区及空值，不补今天')
    if kind=='transform':todo.append('关联/派生规则需专项验证，当前没有执行转换')
    if not todo:todo.append('按新字段校验长度、空值和状态，不造数据')
    return '；'.join(todo)


def assessment(source,target,rules):
    fields=[];resources=[];used=defaultdict(list)
    policy_labels={'exclude-derived':'本轮不迁（计算或运行历史）','review-history':'范围待确认（资料附属历史）','review-balance':'范围待确认（余额快照）','review-transform':'需确认转换口径'}
    for resource in target['resources']:
        rule=rules['resources'].get(resource['key'],{'tables':[],'aliases':{}})
        for table in rule['tables']:used[table].append(resource['key'])
        json_key=json_source(rule);spec=rule.get('json')
        array_info=source.get('jsonProfiles',{}).get(json_key,{}).get('paths',{}).get(spec['path'].removesuffix('[]'),{}) if spec else {}
        count = array_info.get('elements') if spec and spec['path'].endswith('[]') else None
        if spec and spec['path'].endswith('[]') and count is None:
            jp=source.get('jsonProfiles',{}).get(json_key,{})
            if not jp.get('truncated') and not jp.get('invalidJson'):
                count=0
        if count is None and rule['tables'] and (not spec or not spec['path'].endswith('[]')):
            count=source.get('profiles',{}).get(rule['tables'][0],{}).get('rows')
            if spec and spec.get('kind') and json_key not in source.get('jsonProfiles',{}):count=0
        resources.append({'资源键':resource['key'],'新页面资料':resource['label'],'候选来源':','.join(rule['tables']),'旧来源记录数':count if count is not None else '未核定','数量口径':'JSON数组元素（全量结构统计）' if spec and spec['path'].endswith('[]') else '首个来源表的指定公司行数，不等于最终导入行数','处置':policy_labels.get(rule.get('policy'),'按新字段筛选转换'),'说明':rule.get('reason','先试跑，最终新增/复用/冲突/未迁逐行对账')})
        for field in resource['fields']:
            origin,kind,profile=locate(field,rule,rules['commonAliases'],source)
            status={'column':'找到表字段，待值及语义校验','json':'找到JSON路径，待值及语义校验','transform':'需要关联或派生转换','review':'需要人工核定口径','missing':'未找到来源，待核对'}[kind]
            if count==0:status='本公司未观测到此类来源记录，不新增空资料'
            if field.get('readonly'):status='新系统计算字段，不直接迁值'
            if rule.get('policy') in policy_labels:status=policy_labels[rule['policy']]
            notes=[]
            missing=profile.get('missing',profile.get('empty'))
            if missing:notes.append('源字段观测空值='+str(missing)+'（不是已确认的导入拒绝数）')
            if field.get('maxLength') and field['type'] not in ['sensitive','secret'] and profile.get('maxLength',0)>field['maxLength']:
                notes.append('源最大长度超过新字段上限；不自动截断')
            if resource['key']=='bank-accounts' and field['key']=='balance':
                status='范围待确认（账户余额）';notes.append('账户资料照迁，但余额口径需单独确认；不自动建立期初分录')
            if field.get('required') and kind in ['missing','review'] and not field.get('readonly'):notes.append('新必填字段尚无可执行映射，试迁前必须解决')
            fields.append({'资源键':resource['key'],'资料名称':resource['label'],'新字段':field['key'],'字段中文':field['label'],'类型':field['type'],'必填':'是' if field.get('required') else '否','只读计算':'是' if field.get('readonly') else '否','旧来源候选':origin or '未在已核对表列及JSON结构中找到','结论':status,'转换与校验':transform(field,kind),'注意事项':'；'.join(notes),'新枚举':' / '.join(str(o['value']) for o in field.get('options',[])),'关联目标':field.get('ref',''),'来源匹配方式':kind,'来源记录数':count if count is not None else '未核定'})
    table_rows=[]
    org={'companies','departments','positions','position_permissions','position_duties','position_responsibilities','employees','employee_positions','employee_roles','roles','role_permissions','employee_permission_overrides'}
    support={'resource_media':'附件索引供字段迁移使用，不原样搬表','finance_product_archive_photos':'商品图片按新附件机制迁移','finance_zero_value_reasons':'零值理由参考，须匹配到具体字段，不造缺失理由','finance_product_freight_history':'当前运费来源需核对，历史不直接写成当前成本','finance_product_units':'单位字典需与新固定选项比对，不能静默替换单位','finance_product_packaging_units':'包装单位需核对新字段支持范围','finance_shipping_material_units':'物料单位需核对新字段支持范围','finance_production_cost_rates':'旧生产成本规则暂未找到明确目标，先列待核对','finance_product_archive_types':'档案类型与新固定枚举对应，不导入旧页面配置'}
    for t in source['tables']:
        name=t['name'];profile=source.get('profiles',{}).get(name,{})
        if name in used:
            linked=[rules['resources'][key] for key in used[name]]
            if all(r.get('policy')=='exclude-derived' for r in linked):
                decision='本轮不迁';why='；'.join(dict.fromkeys(r.get('reason','计算或运行历史') for r in linked))
            elif all(r.get('policy','').startswith('review-') for r in linked):
                decision='口径待定，暂不导入';why='对应 '+','.join(used[name])+'；待核定范围和转换口径'
            else:
                decision='关联到新目标，逐字段取用';why='对应 '+','.join(used[name])+'；各子类仍按资料清单的排除/待定策略处理，不表示整表全量迁入'
        elif name in org:decision='组织账号来源';why='转为新公司/部门/岗位/用户及权限；旧角色和权限不是原样复制'
        elif name in support:decision='辅助来源或待核对';why=support[name]
        elif any(v in name for v in ['log','event','snapshot','backup','import']):decision='本轮不迁';why='旧日志、历史快照、导入/备份过程记录，无当前资料字段用途；保留旧系统'
        elif any(name.startswith(p) for p in ['workflow','task','delay_','delegation','supervision','exception','notifications','feishu','oa_feishu','after_sales','live_','finance_document','finance_posting','finance_prepayment','finance_payment','finance_expense','finance_entries','finance_workflow']):decision='本轮不迁';why='流程/任务/通知/财务单据与分录/直播售后历史不在已确认范围'
        elif name.startswith('session_') or name=='managed_browser_sessions':decision='本轮不迁';why='旧设备令牌、浏览器会话及助手运行状态不移植；不自动开通访问'
        elif name.startswith(('integration','jst_','verified_','ai_')) or name in ['platform_admins','company_applications','schema_migrations','user_preferences']:decision='本轮不迁';why='平台/接口授权、缓存、系统运行或历史配置不属于本次资料账号迁移；不得重放外部写入'
        else:decision='未找到新目标，暂不迁';why='不能因为旧库存在就导入；逐项列出并等待明确用途'
        count=profile.get('rows')
        table_rows.append({'旧表':name,'指定公司行数':count if count is not None else '未核定','公司筛选方式':profile.get('scope',profile.get('reason','未核定')),'处置':decision,'原因':why,'旧字段数':len(t['columns'])})
    return fields,resources,table_rows


def write_csv(path,rows):
    if not rows:return
    with path.open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)


def main():
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--target',required=True);p.add_argument('--rules',required=True);p.add_argument('--output',required=True);args=p.parse_args()
    source=json.loads(Path(args.source).read_text());target=json.loads(Path(args.target).read_text());rules=json.loads(Path(args.rules).read_text())
    os.umask(0o077);out=Path(args.output);out.mkdir(parents=True,exist_ok=True);out.chmod(0o700)
    fields,resources,tables=assessment(source,target,rules)
    write_csv(out/'新字段对应清单.csv',fields);write_csv(out/'资料类型与数量.csv',resources);write_csv(out/'旧表取舍清单.csv',tables)
    issues=[]
    for r in source.get('references',[]):
        if r['missingOrCrossCompany']:issues.append({'来源':r['table']+'.'+r['field'],'数量':r['missingOrCrossCompany'],'问题':'引用不存在或不属于指定公司','来源记录ID':' '.join(map(str,r['sourceIds'])),'处理':'保留原记录并阻止该引用直接导入；先修复或确认处理'})
    for r in source.get('baseCodeSourceProblems',[]):issues.append({'来源':'finance_product_base_codes','数量':1,'问题':'没有直接商品来源或关联多个商品，目标要求单一productId','来源记录ID':r['id'],'处理':'核对实际关联/马甲，不猜商品，不生成虚假商品'})
    for r in source.get('media',[]):
        if not r['exists'] or r['shaMatches'] is False:issues.append({'来源':'resource_media','数量':1,'问题':'按已知目录未定位文件' if not r['exists'] else '文件摘要不符','来源记录ID':r['id'],'处理':'复核旧存储定位规则；未核实前不判定文件已丢失，不导入坏引用'})
    for f in fields:
        if f['必填']=='是' and f['只读计算']=='否' and f['来源匹配方式'] in ['missing','review'] and f['来源记录数'] != 0 and not f['结论'].startswith(('本轮不迁','范围待确认')):
            issues.append({'来源':f['资源键']+'.'+f['新字段'],'数量':'字段级待核对，非拒绝行数','问题':'新必填字段尚缺可执行来源','来源记录ID':'未生成导入记录','处理':f['旧来源候选']})
    write_csv(out/'待处理问题.csv',issues or [{'来源':'无','数量':0,'问题':'未发现已核实的问题','来源记录ID':'','处理':''}])
    unmatched=[]
    for table in source['tables']:
        used=[f['旧来源候选'] for f in fields if table['name']+'.' in f['旧来源候选'] or table['name']+':' in f['旧来源候选']]
        selected=any(r['候选来源'].split(',').count(table['name']) for r in resources)
        if not selected:continue
        for col in table['columns']:
            if col['name'] in ['id','company_id'] or any(re.search(r'(?<![A-Za-z0-9_])'+re.escape(col['name'])+r'(?![A-Za-z0-9_])',u) for u in used):continue
            reason='旧审计/归档元数据，不直接写业务字段；保留来源对照' if col['name'] in ['created_at','updated_at','created_by','updated_by','archived_at','archived_by','archive_reason','archived_from_status'] else '当前映射尚未明确取用；可能是辅助关联/派生来源，需核对后归类，禁止静默丢弃'
            unmatched.append({'旧表':table['name'],'旧字段':col['name'],'处置':'尚未明确映射到新字段','原因':reason})
    write_csv(out/'未直接取用旧字段.csv',unmatched)
    summary={'phase':'mapping-only; imported rows = 0','company':source['sourceCompany'],'collectedAt':source['collectedAt'],'targetRevision':target['revision'],'resources':len(resources),'fields':len(fields),'tables':len(tables),'fieldDecisions':dict(Counter(f['结论'] for f in fields)),'accounts':source.get('accounts',{}),'issues':len(issues),'issueCounting':'异质问题条目数；非不重复问题记录数或拒绝导入行数','unmatchedSourceColumns':len(unmatched)}
    (out/'assessment-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(summary,ensure_ascii=False))


if __name__=='__main__':main()

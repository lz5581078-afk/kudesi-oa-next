export {};
const { readSourceCoverage,uncoveredSourceTables } = require('../../../../scripts/migration/source-coverage.cjs');
describe('全量来源覆盖盘点',()=>{
  it('非空新增表和无公司全局表会显式阻止放行，不读取大日志正文或分配公司',async()=>{
    const calls:string[]=[];
    const connection={query:async(sql:string)=>{calls.push(sql);if(sql.includes('information_schema.TABLES'))return [[{name:'companies'},{name:'workflow_instances'},{name:'session_logs'},{name:'future_business'},{name:'empty_table'}]];return [[{n:sql.includes('session_logs')?'90071992547409930':sql.includes('empty_table')?'0':'2'}]];}};
    const columns=['companies','workflow_instances','session_logs','future_business','empty_table'].map(t=>({t,c:'id',pk:'PRI',ordinal:1}));
    const result=await readSourceCoverage(connection,columns,{companies:[{id:3}]},{tables:{workflow_instances:[{id:4}]}});
    expect(uncoveredSourceTables(result).map((x:any)=>x.id)).toEqual(['session_logs','future_business']);
    expect(result.tables.find((x:any)=>x.table==='session_logs')).toMatchObject({totalRows:'90071992547409930',companyRowsRead:null,readInCompanyScope:false});
    expect(calls.some(sql=>/SELECT\s+\*/i.test(sql))).toBe(false);expect(calls.some(sql=>/company_id\s*=/i.test(sql))).toBe(false);
  });
  it('拒绝不可信表名及缺失字段清单；不将盘点失败当空表',async()=>{
    await expect(readSourceCoverage({query:async()=>[[{name:'bad;DROP'}]]},[],{},null)).rejects.toThrow('标识');
    let n=0;await expect(readSourceCoverage({query:async()=>++n===1?[[{name:'new_table'}]]:[[{n:'1'}]]},[],{},null)).rejects.toThrow('字段');
  });
});

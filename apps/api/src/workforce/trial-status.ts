// A personnel record can predate its employment archive. Old filed records may
// still carry the original trial flag, so resolve it against the linked archive.
export function unfiledTrialSql(userAlias: 'u' | 'a'): string {
  return `(${userAlias}.live_trial = 1 AND NOT EXISTS (
    SELECT 1 FROM resource_records wf
    WHERE wf.company_id = ${userAlias}.company_id AND wf.type = 'workforce'
      AND JSON_UNQUOTE(JSON_EXTRACT(wf.data, '$.userId')) = CAST(${userAlias}.id AS CHAR)
  ))`;
}

import type { EntityManager } from 'typeorm';
import type { AuthUser } from '../common/auth.decorators';
import type { FlowRun } from '../entities';

/** Normal flow visibility is checked by the caller. Original task feedback is
 * additionally limited to its assignee, supervisor, requester/feedback receiver
 * and company administrator. A flow-overview grant alone does not expose it. */
export async function legacyTaskHistory(em:EntityManager,user:AuthUser,run:FlowRun){
  const rows=await em.query(`SELECT w.id,w.step_id AS stepId,w.title,w.status,w.created_at AS createdAt,w.due_at AS dueAt,
    w.finished_at AS finishedAt,w.submitted_at AS submittedAt,w.done_note AS doneNote,w.completion_standard AS completionStandard,
    a.name AS assigneeName,s.name AS supervisorName,l.source_key AS sourceKey
    FROM work_items w JOIN legacy_import_links l ON l.company_id=w.company_id AND l.target_id=w.id AND l.target_type='work_item' AND l.source_system='legacy-oa' AND LEFT(l.source_key,10)='work_item:'
    JOIN users a ON a.id=w.assignee_id AND a.company_id=w.company_id
    LEFT JOIN users s ON s.id=w.supervisor_id AND s.company_id=w.company_id
    WHERE w.company_id=? AND w.run_id=? AND w.kind='flow' AND w.status IN ('done','cancelled')
    AND (?=1 OR ?=? OR w.assignee_id=? OR w.supervisor_id=?) ORDER BY w.created_at,w.id`,
    [user.companyId,run.id,user.permissions.isCompanyAdmin?1:0,user.id,run.requesterId,user.id,user.id]);
  return rows.map(({sourceKey,...r}:{sourceKey:string;[key:string]:unknown})=>({...r,sourceTaskId:sourceKey.slice('work_item:'.length)}));
}

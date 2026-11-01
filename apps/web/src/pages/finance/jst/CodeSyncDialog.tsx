import { useAuth } from '../../../auth/AuthContext';
import { FinanceModal } from '../FinanceModal';
import { JstSyncItems } from './JstSyncItems';
import { ArchiveJobs } from './JstSyncExtras';

export function CodeSyncDialog({ type, code = '', onClose, onChanged }: { type: string; code?: string; onClose: () => void; onChanged: () => void }) {
  const {can}=useAuth();
  return <FinanceModal title="聚水潭同步维护" onClose={onClose}><JstSyncItems initialType={type} initialKeyword={code} onQueued={onChanged} />{can('finance.bundle-sync.manage') && <ArchiveJobs />}</FinanceModal>;
}

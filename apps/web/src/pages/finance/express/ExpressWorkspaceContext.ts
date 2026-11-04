import { createContext, useContext } from 'react';
import type { TreeCarrier } from './expressApi';
export interface ExpressLocation {
  branchName?: string; versionName?: string; companies: () => void; versions: () => void;
}
export const ExpressWorkspaceContext = createContext<{
  setLocation: (location: ExpressLocation | null) => void;
  acceptCarriers: (carriers: TreeCarrier[]) => void;
  refreshCounts: () => void;
} | null>(null);
export const useExpressWorkspace = () => useContext(ExpressWorkspaceContext);

import type { ComponentType } from 'react';
export interface LegacyRemoteProps {
  shop: Record<string,unknown>;
  onClose:()=>void;
  onRequestChange:()=>void;
  requestJson:(path:string,options?:RequestInit)=>Promise<unknown>;
  requestBlob:(path:string,options?:RequestInit)=>Promise<{blob:Blob;headers:Headers}>;
}
declare const PddRemoteAssistDialog:ComponentType<LegacyRemoteProps>;
export default PddRemoteAssistDialog;

import { useMemo } from 'react';
import type { ShopRow } from '../../sessionApi';
import type { SessionWorkspace } from '../../sessionEngine';
import PddRemoteAssistDialog from './runtime/PddRemoteAssistDialog.jsx';
import { legacyRemoteTransport } from './legacyTransport';
import './runtime/session-manager.css';

/** Reuses the shipped legacy dialog, including its recovery and safe-close
 * workflow. It is used only for the explicitly selected legacy engine. */
export function LegacyRemoteAssistDialog({shop,onClose,onChanged}:{shop:ShopRow;onClose:()=>void;onChanged:()=>void}){
  const workspace=shop.legacy?.workspace as SessionWorkspace;
  const transport=useMemo(()=>legacyRemoteTransport(workspace),[workspace]);
  if(!shop.legacy||!shop.deviceId)return null;
  return <div className="sm-page"><PddRemoteAssistDialog shop={{...shop.legacy,id:shop.id,name:shop.storeName,savedDeviceId:shop.deviceId,savedDeviceName:shop.deviceName,savedDeviceAgentVersion:shop.legacy.assignedDeviceAgentVersion}}
    onClose={onClose} onRequestChange={onChanged} {...transport}/></div>;
}

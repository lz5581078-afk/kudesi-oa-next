import {feeBookingNodes,feeBookingOptions} from './feeBookingPresentation';

export function FeeBookingNodes({ value, onChange }: { value: unknown; onChange: (value: string) => void }) {
  const selected = feeBookingNodes(value);
  return <div className="fee-booking-node-buttons" role="group" aria-label="挂账节点">{feeBookingOptions(selected).map(node => <button key={node} type="button" aria-pressed={node === '不固定' ? !selected.length : selected.includes(node)} onClick={() => onChange(node === '不固定' ? '' : (selected.includes(node) ? selected.filter(item => item !== node) : [...selected,node]).join('、'))}>{node}</button>)}</div>;
}

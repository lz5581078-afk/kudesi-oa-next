import { FEE_BOOKING_NODES } from '@kudesi/shared';

export function FeeBookingNodes({ value, onChange }: { value: unknown; onChange: (value: string) => void }) {
  const selected = String(value ?? '').split(/[、,，]/).map(node => node.trim()).filter(node => node && node !== '不固定');
  return <div className="fee-booking-node-buttons" role="group" aria-label="挂账节点">{FEE_BOOKING_NODES.map(({node}) => <button key={node} type="button" aria-pressed={node === '不固定' ? !selected.length : selected.includes(node)} onClick={() => onChange(node === '不固定' ? '' : (selected.includes(node) ? selected.filter(item => item !== node) : [...selected,node]).join('、'))}>{node}</button>)}</div>;
}

/** 资料壳里用的几个小图标：线条风格，跟随文字颜色。 */
type P = { size?: number };
const base = (size: number) => ({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true });
export const FilterIcon = ({ size = 15 }: P) => <svg {...base(size)}><path d="M2 3.5h12L9.5 9v4l-3-1.5V9z" /></svg>;
export const ColumnsIcon = ({ size = 15 }: P) => <svg {...base(size)}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6.3 3v10M9.7 3v10" /></svg>;
export const DensityIcon = ({ size = 15, compact = true }: P & { compact?: boolean }) => (compact
  ? <svg {...base(size)}><path d="M2.5 4h11M2.5 6.7h11M2.5 9.3h11M2.5 12h11" /></svg>
  : <svg {...base(size)}><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>);
export const InfoIcon = ({ size = 15 }: P) => <svg {...base(size)}><circle cx="8" cy="8" r="6" /><path d="M8 7.2v3.6M8 5.2v.1" /></svg>;
export const MoreIcon = ({ size = 15 }: P) => <svg {...base(size)}><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.2} /></svg>;
export const ChevronDown = ({ size = 12 }: P) => <svg {...base(size)}><path d="M4 6l4 4 4-4" /></svg>;
export const CloseIcon = ({ size = 14 }: P) => <svg {...base(size)}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
export const UpIcon = ({ size = 14 }: P) => <svg {...base(size)}><path d="M4 10l4-4 4 4" /></svg>;
export const DownIcon = ({ size = 14 }: P) => <svg {...base(size)}><path d="M4 6l4 4 4-4" /></svg>;
export const ExpandIcon = ({ size = 14 }: P) => <svg {...base(size)}><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4.5 4.5M2.5 13.5L7 9" /></svg>;
export const ShrinkIcon = ({ size = 14 }: P) => <svg {...base(size)}><path d="M13 6.5H9.5V3M3 9.5h3.5V13M9.5 6.5L14 2M6.5 9.5L2 14" /></svg>;
export const PlusIcon = ({ size = 14 }: P) => <svg {...base(size)}><path d="M8 3v10M3 8h10" /></svg>;
export const SearchGlyph = ({ size = 14 }: P) => <svg {...base(size)}><circle cx="7" cy="7" r="4.2" /><path d="M10.3 10.3L14 14" /></svg>;
export const BackIcon = ({ size = 14 }: P) => <svg {...base(size)}><path d="M10 3L5 8l5 5" /></svg>;
export const GearIcon = ({ size = 15 }: P) => <svg {...base(size)}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" /></svg>;

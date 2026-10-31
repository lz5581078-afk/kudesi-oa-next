import type { DeviceRow } from './sessionApi';

export const PLATFORM_LABELS: Record<string,string> = { pdd:'拼多多', taobao:'淘宝', tmall:'天猫', douyin:'抖音电商', jd:'京东', kuaishou:'快手', xhs:'小红书', other:'其他' };
export const deviceLabel = (d: Pick<DeviceRow,'name'|'remark'>) => d.remark ? `${d.remark}（${d.name}）` : d.name;

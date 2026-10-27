import { resourcePagePath } from '@kudesi/shared';

/** 打开某条资料的地址（带 ?open=id，目标资料页会自动打开详情）；这种资料没有自己的页面则返回 null。 */
export function recordLink(type: string, id: number): string | null {
  const path = resourcePagePath(type);
  return path ? `${path}?open=${id}` : null;
}

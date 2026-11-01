/** Task context is an ordinary company-scoped store link. The destination keeps
 * its normal resource permission checks; no account secrets travel with a task. */
export function TaskStoreLink({ storeId, storeName }: { storeId?: number | null; storeName?: string | null }) {
  if (!storeId) return null;
  return <a className="sub-line" href={`/resources/stores?open=${storeId}`}>关联店铺：{storeName || `#${storeId}`}</a>;
}

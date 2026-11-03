/** Verified old-source IDs stay below this boundary. New-only records never
 * reuse the old low-number Profile namespace, including profiles not in a list.
 * Adoption rejects old source IDs entering this reserved range. */
export const LEGACY_NEW_STORE_BASE = 2 ** 40;
export function newLegacyStoreId(recordId: number) {
  if (!Number.isSafeInteger(recordId) || recordId <= 0 || recordId > 0xffffffff) throw new Error('Invalid new store record identity');
  return LEGACY_NEW_STORE_BASE + recordId;
}
export const validOldStoreId = (id: number) => Number.isSafeInteger(id) && id > 0 && id < LEGACY_NEW_STORE_BASE;

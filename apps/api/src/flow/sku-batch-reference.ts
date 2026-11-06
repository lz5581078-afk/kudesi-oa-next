/** Both live draft groups and migrated application batches keep their original keys. */
export const SKU_GROUP_PATTERN = 'B[0-9a-z]{1,19}|legacy-oa:[1-9][0-9]{0,19}:[1-9][0-9]{0,19}';
export const SKU_BATCH_REF = new RegExp(`^(${SKU_GROUP_PATTERN}|run-[0-9]{1,10})$`);

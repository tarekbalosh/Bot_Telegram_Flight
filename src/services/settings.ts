import { getPrisma } from "../config/db";
import { env } from "../config/env";
import { logger } from "../utils/logger";

export const SETTING_KEY_TARGET_PRICE = "TARGET_PRICE_MYR";
export const SETTING_KEY_LAST_MANUAL_SEARCH = "LAST_MANUAL_SEARCH";

export const MIN_TARGET_PRICE_MYR = 300;
export const MAX_TARGET_PRICE_MYR = 20000;

export interface SettingRecord {
  key: string;
  value: string;
  updatedAt?: Date;
}

export interface SettingStore {
  findUnique(args: {
    where: { key: string };
  }): Promise<SettingRecord | null>;
  upsert(args: {
    where: { key: string };
    create: { key: string; value: string };
    update: { value: string };
  }): Promise<SettingRecord>;
}

export interface GetEffectiveTargetOptions {
  store?: Pick<SettingStore, "findUnique"> | null;
  fallbackTargetMyr?: number;
}

/**
 * Returns the target price override from the Setting table (key "TARGET_PRICE_MYR")
 * if present and valid; otherwise falls back to env.TARGET_PRICE_MYR.
 */
export async function getEffectiveTarget(
  options?: GetEffectiveTargetOptions
): Promise<number> {
  const fallback = options?.fallbackTargetMyr ?? env.TARGET_PRICE_MYR;
  const store =
    options?.store !== undefined
      ? options.store
      : env.DATABASE_URL
      ? getPrisma().setting
      : null;

  if (!store) {
    return fallback;
  }

  try {
    const record = await store.findUnique({
      where: { key: SETTING_KEY_TARGET_PRICE },
    });
    if (!record || typeof record.value !== "string") {
      return fallback;
    }
    const parsed = Number(record.value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return fallback;
  } catch (err) {
    logger.warn(
      "Failed to read TARGET_PRICE_MYR from Setting table; using env.TARGET_PRICE_MYR fallback",
      {
        error: err instanceof Error ? err.message : String(err),
      }
    );
    return fallback;
  }
}

export async function setEffectiveTarget(
  targetPriceMyr: number,
  store?: SettingStore
): Promise<void> {
  const resolvedStore = store ?? getPrisma().setting;
  const value = String(targetPriceMyr);
  await resolvedStore.upsert({
    where: { key: SETTING_KEY_TARGET_PRICE },
    create: { key: SETTING_KEY_TARGET_PRICE, value },
    update: { value },
  });
}

export async function getLastManualSearchTime(
  store?: Pick<SettingStore, "findUnique"> | null
): Promise<Date | null> {
  const resolvedStore =
    store !== undefined
      ? store
      : env.DATABASE_URL
      ? getPrisma().setting
      : null;

  if (!resolvedStore) {
    return null;
  }

  try {
    const record = await resolvedStore.findUnique({
      where: { key: SETTING_KEY_LAST_MANUAL_SEARCH },
    });
    if (!record || typeof record.value !== "string" || !record.value.trim()) {
      return null;
    }
    const trimmed = record.value.trim();
    const asEpoch = Number(trimmed);
    const parsedDate =
      Number.isFinite(asEpoch) && /^\d+$/.test(trimmed)
        ? new Date(asEpoch)
        : new Date(trimmed);
    if (Number.isNaN(parsedDate.getTime())) {
      return null;
    }
    return parsedDate;
  } catch (err) {
    logger.warn("Failed to read LAST_MANUAL_SEARCH from Setting table", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function setLastManualSearchTime(
  when: Date = new Date(),
  store?: SettingStore | null
): Promise<void> {
  const resolvedStore =
    store !== undefined
      ? store
      : env.DATABASE_URL
      ? getPrisma().setting
      : null;

  if (!resolvedStore) {
    return;
  }

  const value = when.toISOString();
  await resolvedStore.upsert({
    where: { key: SETTING_KEY_LAST_MANUAL_SEARCH },
    create: { key: SETTING_KEY_LAST_MANUAL_SEARCH, value },
    update: { value },
  });
}


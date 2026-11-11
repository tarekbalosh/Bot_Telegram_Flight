import { getPrisma } from "../config/db";
import { env } from "../config/env";
import {
  buildRouteInfo,
  parseRouteKey,
  parseWatchRoutes,
  RouteInfo,
} from "../utils/airports";
import { formatIsoDateUTC, parseIsoDateUTC } from "../utils/dates";
import { logger } from "../utils/logger";

export const SETTING_KEY_TARGET_PRICE = "TARGET_PRICE_MYR";
export const SETTING_KEY_LAST_MANUAL_SEARCH = "LAST_MANUAL_SEARCH";
export const SETTING_KEY_ROUTE = "ROUTE";
export const SETTING_KEY_DATE_FROM = "DATE_FROM";
export const SETTING_KEY_DATE_TO = "DATE_TO";

export const MIN_TARGET_PRICE_MYR = 300;
export const MAX_TARGET_PRICE_MYR = 20000;
export const MAX_DATE_RANGE_DAYS = 90;

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

export interface GetEffectiveRouteOptions {
  store?: Pick<SettingStore, "findUnique"> | null;
  fallbackOrigin?: string;
  fallbackDestination?: string;
}

export interface EffectiveDates {
  dateFrom: string;
  dateTo: string;
}

export interface GetEffectiveDatesOptions {
  store?: Pick<SettingStore, "findUnique"> | null;
  fallbackDateFrom?: string;
  fallbackDateTo?: string;
}

export function isValidCalendarIsoDate(dateStr: string): boolean {
  if (!ISO_DATE_REGEX.test(dateStr)) {
    return false;
  }
  const parsed = parseIsoDateUTC(dateStr);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return formatIsoDateUTC(parsed) === dateStr;
}

export interface DatesValidationResult {
  ok: boolean;
  dates?: EffectiveDates;
  daysSpan?: number;
  reason?:
    | "missing"
    | "invalid_format"
    | "past_date"
    | "from_after_to"
    | "range_too_long";
}

function normalizeDigits(input: string): string {
  return input
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Validates `/dates <DATE_FROM> <DATE_TO>`:
 * - Both must be valid YYYY-MM-DD dates
 * - Must be future/today dates (dateFrom >= today in UTC)
 * - dateFrom <= dateTo
 * - Maximum range of 90 days
 */
export function validateDatesArgs(
  rawArgs: string,
  now: Date = new Date()
): DatesValidationResult {
  const normalized = normalizeDigits(rawArgs ?? "").trim();
  if (!normalized) {
    return { ok: false, reason: "missing" };
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length !== 2) {
    return { ok: false, reason: "invalid_format" };
  }

  const [dateFrom, dateTo] = tokens;
  if (!isValidCalendarIsoDate(dateFrom) || !isValidCalendarIsoDate(dateTo)) {
    return { ok: false, reason: "invalid_format" };
  }

  const todayIso = formatIsoDateUTC(now);
  if (dateFrom < todayIso) {
    return { ok: false, reason: "past_date" };
  }

  if (dateFrom > dateTo) {
    return { ok: false, reason: "from_after_to" };
  }

  const fromMs = parseIsoDateUTC(dateFrom).getTime();
  const toMs = parseIsoDateUTC(dateTo).getTime();
  const diffDays = Math.round((toMs - fromMs) / MS_PER_DAY);

  if (diffDays > MAX_DATE_RANGE_DAYS) {
    return { ok: false, reason: "range_too_long" };
  }

  return {
    ok: true,
    dates: { dateFrom, dateTo },
    daysSpan: diffDays + 1,
  };
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

/**
 * Returns the active route from the Setting table (key "ROUTE") if present and valid;
 * otherwise falls back to env.ORIGIN_IATA and env.DESTINATION_IATA.
 */
export async function getEffectiveRoute(
  options?: GetEffectiveRouteOptions
): Promise<RouteInfo> {
  const fallback = buildRouteInfo(
    options?.fallbackOrigin ?? env.ORIGIN_IATA,
    options?.fallbackDestination ?? env.DESTINATION_IATA
  );

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
      where: { key: SETTING_KEY_ROUTE },
    });
    if (!record || typeof record.value !== "string") {
      return fallback;
    }
    const parsed = parseRouteKey(record.value);
    if (parsed) {
      return parsed;
    }
    return fallback;
  } catch (err) {
    logger.warn(
      "Failed to read ROUTE from Setting table; using env fallback",
      {
        error: err instanceof Error ? err.message : String(err),
      }
    );
    return fallback;
  }
}

export async function setEffectiveRoute(
  origin: string,
  destination: string,
  store?: SettingStore
): Promise<RouteInfo> {
  const route = buildRouteInfo(origin, destination);
  const resolvedStore = store ?? getPrisma().setting;
  await resolvedStore.upsert({
    where: { key: SETTING_KEY_ROUTE },
    create: { key: SETTING_KEY_ROUTE, value: route.routeKey },
    update: { value: route.routeKey },
  });
  return route;
}

/**
 * Returns the active search date window from the Setting table (keys "DATE_FROM" and "DATE_TO")
 * if present and valid; otherwise falls back to env.DATE_FROM and env.DATE_TO.
 */
export async function getEffectiveDates(
  options?: GetEffectiveDatesOptions
): Promise<EffectiveDates> {
  const fallback: EffectiveDates = {
    dateFrom: options?.fallbackDateFrom ?? env.DATE_FROM,
    dateTo: options?.fallbackDateTo ?? env.DATE_TO,
  };

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
    const [fromRecord, toRecord] = await Promise.all([
      store.findUnique({ where: { key: SETTING_KEY_DATE_FROM } }),
      store.findUnique({ where: { key: SETTING_KEY_DATE_TO } }),
    ]);

    const rawFrom = fromRecord?.value?.trim();
    const rawTo = toRecord?.value?.trim();

    const dateFrom =
      rawFrom && isValidCalendarIsoDate(rawFrom) ? rawFrom : fallback.dateFrom;
    const dateTo =
      rawTo && isValidCalendarIsoDate(rawTo) ? rawTo : fallback.dateTo;

    if (dateFrom <= dateTo) {
      return { dateFrom, dateTo };
    }
    return fallback;
  } catch (err) {
    logger.warn(
      "Failed to read DATE_FROM/DATE_TO from Setting table; using env fallback",
      {
        error: err instanceof Error ? err.message : String(err),
      }
    );
    return fallback;
  }
}

export async function setEffectiveDates(
  dateFrom: string,
  dateTo: string,
  store?: SettingStore
): Promise<EffectiveDates> {
  const resolvedStore = store ?? getPrisma().setting;
  const cleanFrom = dateFrom.trim();
  const cleanTo = dateTo.trim();

  await Promise.all([
    resolvedStore.upsert({
      where: { key: SETTING_KEY_DATE_FROM },
      create: { key: SETTING_KEY_DATE_FROM, value: cleanFrom },
      update: { value: cleanFrom },
    }),
    resolvedStore.upsert({
      where: { key: SETTING_KEY_DATE_TO },
      create: { key: SETTING_KEY_DATE_TO, value: cleanTo },
      update: { value: cleanTo },
    }),
  ]);

  return { dateFrom: cleanFrom, dateTo: cleanTo };
}

/**
 * Resolves all watched routes: starts with the active primary route from getEffectiveRoute(),
 * plus any additional routes specified in WATCH_ROUTES.
 */
export async function getEffectiveWatchRoutes(
  options?: GetEffectiveRouteOptions & { watchRoutesRaw?: string }
): Promise<RouteInfo[]> {
  const primaryRoute = await getEffectiveRoute(options);
  const rawWatch =
    options?.watchRoutesRaw !== undefined
      ? options.watchRoutesRaw
      : env.WATCH_ROUTES;
  return parseWatchRoutes(rawWatch, primaryRoute);
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

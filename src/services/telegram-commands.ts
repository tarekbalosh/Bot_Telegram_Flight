import axios from "axios";
import { getPrisma } from "../config/db";
import { env, telegramConfigured } from "../config/env";
import { FlightProviderName, UnifiedFlightOffer } from "../types/flight";
import { getCurrentYearMonth } from "../utils/dates";
import { convertMyrToUsd } from "../utils/fx";
import { httpClient } from "../utils/http";
import { logger, maskSecrets } from "../utils/logger";
import { filterStrictDamascusFlights } from "./filter";
import { ARABIC_STRINGS, escapeHtml, formatPrice, wrapLtr } from "./format";
import {
  getEffectiveTarget,
  getLastManualSearchTime,
  MAX_TARGET_PRICE_MYR,
  MIN_TARGET_PRICE_MYR,
  setEffectiveTarget,
  setLastManualSearchTime,
} from "./settings";
import {
  buildTelegramPayloads,
  NotificationResult,
  sendTelegramPayloadWithRetry,
  TelegramMessagePayload,
} from "./telegram";
import {
  isTrackerRunInProgress,
  runFlightTrackerAgent,
  TrackerRunOptions,
  TrackerRunSummary,
} from "./tracker";

export {
  getEffectiveTarget,
  getLastManualSearchTime,
  MAX_TARGET_PRICE_MYR,
  MIN_TARGET_PRICE_MYR,
  setEffectiveTarget,
  setLastManualSearchTime,
} from "./settings";

export const TELEGRAM_POLL_TIMEOUT_SEC = 30;
export const TELEGRAM_POLL_HTTP_TIMEOUT_MS = 40_000;
export const TELEGRAM_CONFLICT_RETRY_MS = 30_000;
export const TELEGRAM_MAX_BACKOFF_MS = 30_000;

export type TelegramCommandName =
  | "start"
  | "help"
  | "search"
  | "status"
  | "top"
  | "target"
  | "budget"
  | "unknown";

export interface ParsedTelegramCommand {
  command: TelegramCommandName;
  rawCommand: string;
  args: string;
}

export interface TargetValidationResult {
  ok: boolean;
  value?: number;
  reason?: "missing" | "not_a_number" | "out_of_range";
}

export interface CooldownCheckResult {
  allowed: boolean;
  remainingMinutes: number;
  remainingSeconds: number;
  elapsedMs: number | null;
}

export interface BudgetStatus {
  monthKey: string;
  used: number;
  budget: number;
  remaining: number;
}

export interface StatusSnapshotData {
  lowestEver: { priceMYR: number; observedAt: Date } | null;
  lowestLatestRun: { priceMYR: number; observedAt: Date } | null;
  targetPriceMyr: number;
  lastNotification: {
    lowestPriceMYR: number;
    channel: string;
    reason: string;
    sentAt: Date;
  } | null;
  budget: BudgetStatus;
  nextScheduledRun: string;
}

export interface TelegramUpdateMessage {
  message_id?: number;
  date?: number;
  text?: string;
  chat?: {
    id: number | string;
    type?: string;
    username?: string;
    first_name?: string;
  };
  from?: {
    id?: number;
    username?: string;
    first_name?: string;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramUpdateMessage;
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

export const BOT_MENU_COMMANDS: ReadonlyArray<{
  command: string;
  description: string;
}> = [
  { command: "start", description: "بدء استخدام البوت وعرض قائمة الأوامر" },
  { command: "help", description: "عرض المساعدة وقائمة الأوامر المتاحة" },
  { command: "search", description: "تشغيل بحث فوري عن أرخص الرحلات الآن" },
  { command: "status", description: "عرض حالة التتبع وأقل الأسعار والميزانية" },
  {
    command: "top",
    description: "عرض أفضل الرحلات المحفوظة حالياً بدون استهلاك الرصيد",
  },
  {
    command: "target",
    description: "تحديد السعر المستهدف بالرينغيت (مثال: /target 2200)",
  },
  { command: "budget", description: "عرض استهلاك رصيد البحث الشهري (SerpApi)" },
];

const KNOWN_COMMANDS = new Set<string>([
  "start",
  "help",
  "search",
  "status",
  "top",
  "target",
  "budget",
]);

/**
 * Converts Arabic-Indic digits (٠-٩) and Eastern Arabic-Indic digits (۰-۹) to ASCII digits (0-9).
 */
function normalizeDigits(input: string): string {
  return input
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Parses a Telegram message text into a normalized command name and argument string.
 * Supports "/command", "/command@BotName", and "/command@BotName args".
 */
export function parseTelegramCommand(text: string): ParsedTelegramCommand {
  const trimmed = (text ?? "").trim();
  if (!trimmed.startsWith("/")) {
    return {
      command: "unknown",
      rawCommand: trimmed.split(/\s+/)[0] || "",
      args: "",
    };
  }

  const match = trimmed.match(
    /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/
  );
  if (!match) {
    return {
      command: "unknown",
      rawCommand: trimmed.split(/\s+/)[0] || "",
      args: "",
    };
  }

  const cmdLower = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();

  if (KNOWN_COMMANDS.has(cmdLower)) {
    return {
      command: cmdLower as TelegramCommandName,
      rawCommand: `/${cmdLower}`,
      args,
    };
  }

  return {
    command: "unknown",
    rawCommand: `/${cmdLower}`,
    args,
  };
}

/**
 * Validates the argument to `/target <number>`:
 * Must be a positive number in the sane range [300, 20000].
 */
export function validateTargetPrice(rawArgs: string): TargetValidationResult {
  const normalized = normalizeDigits(rawArgs ?? "").trim();
  if (!normalized) {
    return { ok: false, reason: "missing" };
  }

  // Reject trailing tokens or non-numeric characters (allow optional decimal point)
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) {
    return { ok: false, reason: "not_a_number" };
  }

  const num = Number(normalized);
  if (!Number.isFinite(num)) {
    return { ok: false, reason: "not_a_number" };
  }

  if (num < MIN_TARGET_PRICE_MYR || num > MAX_TARGET_PRICE_MYR) {
    return { ok: false, reason: "out_of_range" };
  }

  return { ok: true, value: Math.round(num * 100) / 100 };
}

/**
 * Checks whether a manual `/search` is allowed under the cooldown policy.
 */
export function checkSearchCooldown(
  lastManualSearch: Date | null,
  cooldownMinutes: number = env.SEARCH_COOLDOWN_MIN,
  nowMs: number = Date.now()
): CooldownCheckResult {
  if (!lastManualSearch || cooldownMinutes <= 0) {
    return {
      allowed: true,
      remainingMinutes: 0,
      remainingSeconds: 0,
      elapsedMs: lastManualSearch ? nowMs - lastManualSearch.getTime() : null,
    };
  }

  const lastMs = lastManualSearch.getTime();
  if (Number.isNaN(lastMs)) {
    return {
      allowed: true,
      remainingMinutes: 0,
      remainingSeconds: 0,
      elapsedMs: null,
    };
  }

  const cooldownMs = cooldownMinutes * 60 * 1000;
  const elapsedMs = nowMs - lastMs;

  if (elapsedMs >= cooldownMs) {
    return {
      allowed: true,
      remainingMinutes: 0,
      remainingSeconds: 0,
      elapsedMs,
    };
  }

  const remainingMs = cooldownMs - elapsedMs;
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));

  return {
    allowed: false,
    remainingMinutes,
    remainingSeconds,
    elapsedMs,
  };
}

/**
 * Masks a chat ID for safe logging of unauthorized access attempts.
 */
export function maskChatId(chatId: number | string | undefined | null): string {
  if (chatId === undefined || chatId === null) {
    return "unknown";
  }
  const str = String(chatId).trim();
  if (str.length <= 4) {
    return "***";
  }
  return `${str.slice(0, 2)}***${str.slice(-2)}`;
}

/**
 * Security check: returns true only when chatId strictly matches TELEGRAM_CHAT_ID.
 */
export function isAuthorizedChat(
  chatId: number | string | undefined | null,
  authorizedChatId: string | undefined = env.TELEGRAM_CHAT_ID
): boolean {
  if (chatId === undefined || chatId === null || !authorizedChatId) {
    return false;
  }
  return String(chatId).trim() === String(authorizedChatId).trim();
}

/**
 * Parses a single cron field into a predicate for [min..max].
 */
function parseCronField(
  expr: string,
  min: number,
  max: number,
  isDayOfWeek: boolean = false
): (val: number) => boolean {
  const trimmed = expr.trim();
  if (trimmed === "*") {
    return () => true;
  }

  const allowed = new Set<number>();
  const parts = trimmed.split(",");

  for (const part of parts) {
    const [rangePart, stepPart] = part.trim().split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isFinite(step) || step <= 0) {
      continue;
    }

    let start = min;
    let end = max;

    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [s, e] = rangePart.split("-").map(Number);
        if (Number.isFinite(s) && Number.isFinite(e)) {
          start = s;
          end = e;
        }
      } else {
        const single = Number(rangePart);
        if (Number.isFinite(single)) {
          start = single;
          end = stepPart ? max : single;
        }
      }
    }

    for (let v = start; v <= end; v += step) {
      const normalized = isDayOfWeek && v === 7 ? 0 : v;
      allowed.add(normalized);
    }
  }

  return (val: number) => allowed.has(isDayOfWeek && val === 7 ? 0 : val);
}

const WEEKDAY_MAP: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getZonedDateParts(
  date: Date,
  tzName: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dow: number;
  formatted: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const rawHour = Number(map.hour);
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(map.minute);
  const dow = WEEKDAY_MAP[map.weekday] ?? 0;

  const formatted = `${String(year).padStart(4, "0")}-${String(month).padStart(
    2,
    "0"
  )}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(
    minute
  ).padStart(2, "0")} (${tzName})`;

  return { year, month, day, hour, minute, dow, formatted };
}

/**
 * Computes the next scheduled run time for a 5-field cron expression in the given timezone.
 */
export function getNextScheduledRunTime(
  cronSchedule: string = env.CRON_SCHEDULE,
  tzName: string = env.TZ_NAME,
  now: Date = new Date()
): string {
  try {
    const fields = cronSchedule.trim().split(/\s+/);
    if (fields.length !== 5) {
      return `${cronSchedule} (${tzName})`;
    }

    const matchMin = parseCronField(fields[0], 0, 59);
    const matchHour = parseCronField(fields[1], 0, 23);
    const matchDom = parseCronField(fields[2], 1, 31);
    const matchMonth = parseCronField(fields[3], 1, 12);
    const matchDow = parseCronField(fields[4], 0, 7, true);

    const domWild = fields[2].trim() === "*";
    const dowWild = fields[4].trim() === "*";

    // Start from the next whole minute
    let candidateMs =
      Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
    const maxLookaheadMs = candidateMs + 366 * 24 * 60 * 60_000;

    while (candidateMs <= maxLookaheadMs) {
      const parts = getZonedDateParts(new Date(candidateMs), tzName);

      if (!matchMonth(parts.month)) {
        candidateMs += 60 * 60_000;
        continue;
      }

      const domOk = matchDom(parts.day);
      const dowOk = matchDow(parts.dow);
      const dayMatches =
        domWild && dowWild
          ? true
          : !domWild && !dowWild
          ? domOk || dowOk
          : domWild
          ? dowOk
          : domOk;

      if (!dayMatches) {
        candidateMs += 60 * 60_000;
        continue;
      }

      if (!matchHour(parts.hour)) {
        candidateMs += Math.max(1, 60 - parts.minute) * 60_000;
        continue;
      }

      if (!matchMin(parts.minute)) {
        candidateMs += 60_000;
        continue;
      }

      return parts.formatted;
    }

    return `${cronSchedule} (${tzName})`;
  } catch {
    return `${cronSchedule} (${tzName})`;
  }
}

export function formatDateTimeInTz(
  date: Date,
  tzName: string = env.TZ_NAME
): string {
  try {
    return getZonedDateParts(date, tzName).formatted;
  } catch {
    return date.toISOString();
  }
}

export async function getSerpApiBudgetStatus(
  now: Date = new Date()
): Promise<BudgetStatus> {
  const monthKey = getCurrentYearMonth(now);
  const budgetKey = `SERPAPI:${monthKey}`;
  const budget = env.SERPAPI_MONTHLY_BUDGET;

  if (!env.DATABASE_URL) {
    return {
      monthKey,
      used: 0,
      budget,
      remaining: budget,
    };
  }

  const prisma = getPrisma();
  const usage = await prisma.apiUsage.findUnique({
    where: { key: budgetKey },
  });
  const used = usage?.count ?? 0;
  const remaining = Math.max(0, budget - used);

  return {
    monthKey,
    used,
    budget,
    remaining,
  };
}

export async function fetchStatusData(
  now: Date = new Date()
): Promise<StatusSnapshotData> {
  const [targetPriceMyr, budget] = await Promise.all([
    getEffectiveTarget(),
    getSerpApiBudgetStatus(now),
  ]);
  const nextScheduledRun = getNextScheduledRunTime(
    env.CRON_SCHEDULE,
    env.TZ_NAME,
    now
  );

  if (!env.DATABASE_URL) {
    return {
      lowestEver: null,
      lowestLatestRun: null,
      targetPriceMyr,
      lastNotification: null,
      budget,
      nextScheduledRun,
    };
  }

  const prisma = getPrisma();
  const [lowestSnapshot, latestSnapshot, lastNotification] = await Promise.all([
    prisma.priceSnapshot.findFirst({
      orderBy: [{ priceMYR: "asc" }, { observedAt: "asc" }],
    }),
    prisma.priceSnapshot.findFirst({
      orderBy: { observedAt: "desc" },
    }),
    prisma.notificationLog.findFirst({
      orderBy: { sentAt: "desc" },
    }),
  ]);

  let lowestLatestRun: { priceMYR: number; observedAt: Date } | null = null;
  if (latestSnapshot) {
    // Snapshots inserted in the same run transaction share nearly identical observedAt timestamps (within 60s)
    const runWindowStart = new Date(
      latestSnapshot.observedAt.getTime() - 60_000
    );
    const minInLatestBatch = await prisma.priceSnapshot.findFirst({
      where: {
        observedAt: { gte: runWindowStart },
      },
      orderBy: [{ priceMYR: "asc" }, { observedAt: "desc" }],
    });
    lowestLatestRun = minInLatestBatch
      ? {
          priceMYR: minInLatestBatch.priceMYR,
          observedAt: minInLatestBatch.observedAt,
        }
      : {
          priceMYR: latestSnapshot.priceMYR,
          observedAt: latestSnapshot.observedAt,
        };
  }

  return {
    lowestEver: lowestSnapshot
      ? {
          priceMYR: lowestSnapshot.priceMYR,
          observedAt: lowestSnapshot.observedAt,
        }
      : null,
    lowestLatestRun,
    targetPriceMyr,
    lastNotification: lastNotification
      ? {
          lowestPriceMYR: lastNotification.lowestPriceMYR,
          channel: lastNotification.channel,
          reason: lastNotification.reason,
          sentAt: lastNotification.sentAt,
        }
      : null,
    budget,
    nextScheduledRun,
  };
}

/**
 * Fetches current best offers from the DB (latest PriceSnapshot per externalId
 * joined with FlightOfferRecord) WITHOUT calling SerpApi.
 */
export async function fetchTopOffersFromDb(): Promise<UnifiedFlightOffer[]> {
  if (!env.DATABASE_URL) {
    return [];
  }

  const prisma = getPrisma();
  const [latestSnapshots, offerRecords] = await Promise.all([
    prisma.priceSnapshot.findMany({
      distinct: ["externalId"],
      orderBy: [{ externalId: "asc" }, { observedAt: "desc" }],
    }),
    prisma.flightOfferRecord.findMany(),
  ]);

  if (offerRecords.length === 0) {
    return [];
  }

  const latestPriceByExtId = new Map<string, number>();
  for (const snap of latestSnapshots) {
    latestPriceByExtId.set(snap.externalId, snap.priceMYR);
  }

  const offers: UnifiedFlightOffer[] = offerRecords.map((rec) => {
    const latestPriceMYR = latestPriceByExtId.get(rec.externalId) ?? rec.priceMYR;
    const ratio =
      rec.priceMYR > 0 && rec.priceUSD > 0
        ? rec.priceUSD / rec.priceMYR
        : env.FALLBACK_MYR_TO_USD;
    const priceUSD =
      Math.abs(latestPriceMYR - rec.priceMYR) < 0.005
        ? rec.priceUSD
        : convertMyrToUsd(latestPriceMYR, ratio);

    return {
      externalId: rec.externalId,
      provider: (rec.provider as FlightProviderName) || "SERPAPI",
      origin: env.ORIGIN_IATA,
      destination: env.DESTINATION_IATA,
      priceMYR: latestPriceMYR,
      priceUSD,
      departureDate: rec.departureDate,
      departureTime: rec.departureTime,
      arrivalTime: rec.arrivalTime,
      airlines: rec.airlines,
      flightNumbers: rec.flightNumbers,
      transitAirports: rec.transitAirports,
      layoverDurationsHours: rec.layoverDurationsHours,
      totalDurationHours: rec.totalDurationHours,
      checkedBaggageKg: rec.checkedBaggageKg,
      baggageVerified: rec.baggageVerified,
      isSinglePNR: rec.isSinglePNR,
      bagsRecheckRequired: rec.bagsRecheckRequired,
      bookingLink: rec.bookingLink,
    };
  });

  return filterStrictDamascusFlights(offers);
}

export function renderHelpMessageHtml(): string {
  return [
    `🤖 <b>أوامر بوت تتبع رحلات الطيران (كوالالمبور ➔ دمشق)</b>`,
    ``,
    `• <code>/search</code> — تشغيل بحث فوري عن أرخص الرحلات الآن وإرسال التقرير`,
    `• <code>/status</code> — عرض أقل سعر تاريخي، أقل سعر في آخر فحص، السعر المستهدف، والميزانية`,
    `• <code>/top</code> — عرض أفضل الرحلات المحفوظة في قاعدة البيانات حالياً (بدون استهلاك رصيد SerpApi)`,
    `• <code>/target &lt;السعر&gt;</code> — تعديل السعر المستهدف بالرينغيت الماليزي (${MIN_TARGET_PRICE_MYR}–${MAX_TARGET_PRICE_MYR})، مثال: <code>/target 2200</code>`,
    `• <code>/budget</code> — عرض عدد عمليات البحث المستهلكة والمتبقية هذا الشهر`,
    `• <code>/help</code> — عرض قائمة الأوامر والمساعدة`,
  ].join("\n");
}

export function renderUnknownCommandHtml(rawCommand: string): string {
  const safeCmd = escapeHtml(rawCommand || "/");
  return `❓ أمر غير معروف: <code>${safeCmd}</code>\nأرسل <code>/help</code> لعرض قائمة الأوامر المتاحة.`;
}

export function renderBudgetMessageHtml(status: BudgetStatus): string {
  return [
    `📊 <b>ميزانية البحث الشهرية (SerpApi)</b>`,
    `📅 <b>الشهر:</b> ${escapeHtml(wrapLtr(status.monthKey))}`,
    `🔎 <b>المستهلك:</b> ${escapeHtml(
      wrapLtr(`${status.used} / ${status.budget}`)
    )} عملية بحث`,
    `✅ <b>المتبقي هذا الشهر:</b> ${escapeHtml(
      wrapLtr(String(status.remaining))
    )} عملية بحث`,
  ].join("\n");
}

export function renderStatusMessageHtml(data: StatusSnapshotData): string {
  const lowestEverLine = data.lowestEver
    ? `${escapeHtml(
        wrapLtr(`${formatPrice(data.lowestEver.priceMYR)} MYR`)
      )} (بتاريخ ${escapeHtml(
        wrapLtr(data.lowestEver.observedAt.toISOString().slice(0, 10))
      )})`
    : "لا توجد بيانات مسجلة بعد";

  const lowestLatestLine = data.lowestLatestRun
    ? `${escapeHtml(
        wrapLtr(`${formatPrice(data.lowestLatestRun.priceMYR)} MYR`)
      )} (${escapeHtml(
        wrapLtr(formatDateTimeInTz(data.lowestLatestRun.observedAt))
      )})`
    : "لا توجد بيانات مسجلة بعد";

  const targetLine = `${escapeHtml(
    wrapLtr(`${formatPrice(data.targetPriceMyr)}`)
  )} ${escapeHtml(ARABIC_STRINGS.myrUnit)}`;

  const lastNotifLine = data.lastNotification
    ? `${escapeHtml(
        wrapLtr(formatDateTimeInTz(data.lastNotification.sentAt))
      )} (${escapeHtml(data.lastNotification.channel)} — ${escapeHtml(
        data.lastNotification.reason
      )})`
    : "لم يتم إرسال أي إشعار بعد";

  const budgetLine = `${escapeHtml(
    wrapLtr(`${data.budget.used} / ${data.budget.budget}`)
  )} (المتبقي: ${escapeHtml(wrapLtr(String(data.budget.remaining)))})`;

  const nextRunLine = escapeHtml(wrapLtr(data.nextScheduledRun));

  return [
    `📌 <b>حالة وكيل تتبع الرحلات (KUL ➔ DAM)</b>`,
    ``,
    `🏆 <b>أقل سعر مسجل تاريخياً:</b> ${lowestEverLine}`,
    `📉 <b>أقل سعر في آخر فحص:</b> ${lowestLatestLine}`,
    `🎯 <b>السعر المستهدف الحالي:</b> ${targetLine}`,
    `🔔 <b>آخر إشعار مرسل:</b> ${lastNotifLine}`,
    `🔎 <b>استهلاك SerpApi هذا الشهر:</b> ${budgetLine}`,
    `⏰ <b>موعد الفحص المجدول القادم:</b> ${nextRunLine}`,
  ].join("\n");
}

export interface CommandHandlerDeps {
  authorizedChatId?: string;
  cooldownMinutes?: number;
  now?: () => Date;
  sendMessage?: (payload: TelegramMessagePayload) => Promise<NotificationResult>;
  isRunInProgress?: () => boolean;
  runAgent?: (options: TrackerRunOptions) => Promise<TrackerRunSummary>;
  getEffectiveTarget?: () => Promise<number>;
  setEffectiveTarget?: (priceMyr: number) => Promise<void>;
  getLastManualSearchTime?: () => Promise<Date | null>;
  setLastManualSearchTime?: (when: Date) => Promise<void>;
  getBudgetStatus?: (now: Date) => Promise<BudgetStatus>;
  getStatusData?: (now: Date) => Promise<StatusSnapshotData>;
  getTopOffers?: () => Promise<UnifiedFlightOffer[]>;
  topN?: number;
}

let isManualSearchStarting = false;

/**
 * Handles a single Telegram update object.
 * - Rejects updates from unauthorized chats (logs a masked warning, sends NO reply).
 * - Dispatches supported commands in Arabic HTML format.
 */
export async function handleTelegramUpdate(
  update: TelegramUpdate,
  deps: CommandHandlerDeps = {}
): Promise<{ handled: boolean; command?: TelegramCommandName }> {
  const msg = update.message;
  if (!msg || !msg.chat) {
    return { handled: false };
  }

  const authorizedChatId = deps.authorizedChatId ?? env.TELEGRAM_CHAT_ID;
  const incomingChatId = msg.chat.id;

  if (!isAuthorizedChat(incomingChatId, authorizedChatId)) {
    logger.warn(
      "Ignoring Telegram update from unauthorized chat",
      {
        chatId: maskChatId(incomingChatId),
        updateId: update.update_id,
      }
    );
    return { handled: false };
  }

  const text = msg.text?.trim() ?? "";
  if (!text) {
    return { handled: false };
  }

  const sendMessage: (
    payload: TelegramMessagePayload
  ) => Promise<NotificationResult> =
    deps.sendMessage ??
    (async (payload: TelegramMessagePayload) => {
      const token = env.TELEGRAM_BOT_TOKEN;
      const chatId = String(authorizedChatId ?? "");
      if (!token || !chatId) {
        return { ok: false, error: "Telegram not configured" };
      }
      return sendTelegramPayloadWithRetry(token, chatId, payload);
    });

  const nowFn = deps.now ?? (() => new Date());
  const parsed = parseTelegramCommand(text);

  switch (parsed.command) {
    case "start":
    case "help": {
      await sendMessage({ text: renderHelpMessageHtml() });
      return { handled: true, command: parsed.command };
    }

    case "budget": {
      const getBudget = deps.getBudgetStatus ?? getSerpApiBudgetStatus;
      const status = await getBudget(nowFn());
      await sendMessage({ text: renderBudgetMessageHtml(status) });
      return { handled: true, command: "budget" };
    }

    case "status": {
      const getStatus = deps.getStatusData ?? fetchStatusData;
      const statusData = await getStatus(nowFn());
      await sendMessage({ text: renderStatusMessageHtml(statusData) });
      return { handled: true, command: "status" };
    }

    case "top": {
      const getTop = deps.getTopOffers ?? fetchTopOffersFromDb;
      const getTarget = deps.getEffectiveTarget ?? getEffectiveTarget;
      const [offers, targetPriceMyr] = await Promise.all([
        getTop(),
        getTarget(),
      ]);

      if (offers.length === 0) {
        await sendMessage({
          text: [
            `📭 <b>لا توجد عروض رحلات محفوظة في قاعدة البيانات حالياً.</b>`,
            `استخدم الأمر <code>/search</code> لتشغيل بحث جديد.`,
          ].join("\n"),
        });
        return { handled: true, command: "top" };
      }

      const payloads = buildTelegramPayloads(offers, {
        targetPriceMyr,
        topN: deps.topN ?? env.TELEGRAM_TOP_N,
      });

      for (const payload of payloads) {
        await sendMessage(payload);
      }
      return { handled: true, command: "top" };
    }

    case "target": {
      const validation = validateTargetPrice(parsed.args);
      if (!validation.ok || validation.value === undefined) {
        await sendMessage({
          text: [
            `⚠️ <b>قيمة السعر المستهدف غير صالحة.</b>`,
            `يرجى إدخال رقم صحيح أو عشري موجب بين <b>${escapeHtml(
              wrapLtr(`${formatPrice(MIN_TARGET_PRICE_MYR)}`)
            )}</b> و <b>${escapeHtml(
              wrapLtr(`${formatPrice(MAX_TARGET_PRICE_MYR)}`)
            )}</b> ${escapeHtml(ARABIC_STRINGS.myrUnit)}.`,
            `مثال: <code>/target 2200</code>`,
          ].join("\n"),
        });
        return { handled: true, command: "target" };
      }

      const saveTarget = deps.setEffectiveTarget ?? setEffectiveTarget;
      await saveTarget(validation.value);

      await sendMessage({
        text: [
          `✅ <b>تم تحديث السعر المستهدف بنجاح!</b>`,
          `🎯 السعر المستهدف الجديد: <b>${escapeHtml(
            wrapLtr(`${formatPrice(validation.value)}`)
          )} ${escapeHtml(ARABIC_STRINGS.myrUnit)}</b>`,
        ].join("\n"),
      });
      return { handled: true, command: "target" };
    }

    case "search": {
      const checkInProgress = deps.isRunInProgress ?? isTrackerRunInProgress;
      if (checkInProgress() || isManualSearchStarting) {
        await sendMessage({
          text: [
            `⚠️ <b>توجد عملية بحث قيد التنفيذ حالياً.</b>`,
            `يرجى الانتظار حتى تنتهي العملية الجارية قبل طلب بحث جديد.`,
          ].join("\n"),
        });
        return { handled: true, command: "search" };
      }

      const now = nowFn();
      const cooldownMin = deps.cooldownMinutes ?? env.SEARCH_COOLDOWN_MIN;
      const getLastSearch =
        deps.getLastManualSearchTime ?? getLastManualSearchTime;
      const lastManualSearch = await getLastSearch();
      const cooldown = checkSearchCooldown(
        lastManualSearch,
        cooldownMin,
        now.getTime()
      );

      if (!cooldown.allowed) {
        await sendMessage({
          text: [
            `⏳ <b>فترة التهدئة نشطة بين عمليات البحث اليدوي (${escapeHtml(
              String(cooldownMin)
            )} دقيقة).</b>`,
            `يرجى الانتظار <b>${escapeHtml(
              String(cooldown.remainingMinutes)
            )} دقيقة</b> قبل تشغيل بحث يدوي جديد، أو استخدم <code>/top</code> لعرض أفضل الرحلات المحفوظة حالياً.`,
          ].join("\n"),
        });
        return { handled: true, command: "search" };
      }

      const getBudget = deps.getBudgetStatus ?? getSerpApiBudgetStatus;
      const budgetStatus = await getBudget(now);
      if (budgetStatus.remaining <= 0) {
        await sendMessage({
          text: [
            `🚫 <b>تم استنفاد رصيد البحث الشهري لـ SerpApi.</b>`,
            `🔎 المستهلك هذا الشهر: <b>${escapeHtml(
              wrapLtr(`${budgetStatus.used} / ${budgetStatus.budget}`)
            )}</b>`,
            `📉 العمليات المتبقية: <b>${escapeHtml(
              wrapLtr(String(budgetStatus.remaining))
            )}</b> عملية بحث.`,
            `يمكنك استخدام <code>/top</code> لعرض أفضل الرحلات المحفوظة في قاعدة البيانات.`,
          ].join("\n"),
        });
        return { handled: true, command: "search" };
      }

      isManualSearchStarting = true;
      try {
        const saveLastSearch =
          deps.setLastManualSearchTime ?? setLastManualSearchTime;
        await saveLastSearch(now);

        await sendMessage({ text: "⏳ جاري البحث..." });

        const runAgent = deps.runAgent ?? runFlightTrackerAgent;
        const summary = await runAgent({ forceNotify: true });

        if (summary.skippedMutex) {
          await sendMessage({
            text: [
              `⚠️ <b>توجد عملية بحث قيد التنفيذ حالياً.</b>`,
              `يرجى الانتظار حتى تنتهي العملية الجارية.`,
            ].join("\n"),
          });
        }
      } catch (err) {
        const errMsg =
          err instanceof Error ? maskSecrets(err.message) : String(err);
        logger.error("Manual /search command failed", { error: errMsg });
        await sendMessage({
          text: `❌ <b>حدث خطأ أثناء تنفيذ البحث:</b>\n<code>${escapeHtml(
            errMsg
          )}</code>`,
        });
      } finally {
        isManualSearchStarting = false;
      }

      return { handled: true, command: "search" };
    }

    case "unknown":
    default: {
      await sendMessage({ text: renderUnknownCommandHtml(parsed.rawCommand) });
      return { handled: true, command: "unknown" };
    }
  }
}

/**
 * Registers the bot's Arabic command menu in Telegram via setMyCommands.
 */
export async function registerTelegramBotCommands(
  botToken: string | undefined = env.TELEGRAM_BOT_TOKEN
): Promise<boolean> {
  if (!botToken) {
    return false;
  }

  const url = `https://api.telegram.org/bot${botToken}/setMyCommands`;
  try {
    await httpClient.post(url, {
      commands: BOT_MENU_COMMANDS,
    });
    logger.info("Telegram bot menu commands registered via setMyCommands");
    return true;
  } catch (err) {
    const errMsg =
      err instanceof Error ? maskSecrets(err.message) : String(err);
    logger.warn("Failed to register Telegram commands via setMyCommands", {
      error: errMsg,
    });
    return false;
  }
}

export interface TelegramPollerHandle {
  stop: () => Promise<void>;
}

function interruptibleSleep(
  ms: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Starts the long-polling loop for Telegram commands (`getUpdates`).
 * Should only be called in the default long-running mode (`npm start`).
 */
export function startTelegramCommandPoller(): TelegramPollerHandle {
  if (!env.TELEGRAM_COMMANDS_ENABLED) {
    logger.info(
      "Telegram commands poller is disabled (TELEGRAM_COMMANDS_ENABLED=false)."
    );
    return {
      stop: async () => {},
    };
  }

  if (!telegramConfigured()) {
    logger.warn(
      "Telegram is not configured (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing); skipping command polling."
    );
    return {
      stop: async () => {},
    };
  }

  const token = env.TELEGRAM_BOT_TOKEN!;
  const abortController = new AbortController();
  let stopped = false;
  let offset: number | undefined;
  let consecutiveErrors = 0;

  const loopPromise = (async () => {
    await registerTelegramBotCommands(token);

    logger.info("Telegram interactive command poller started", {
      pollTimeoutSec: TELEGRAM_POLL_TIMEOUT_SEC,
    });

    while (!stopped && !abortController.signal.aborted) {
      try {
        const url = `https://api.telegram.org/bot${token}/getUpdates`;
        const response = await httpClient.post<TelegramGetUpdatesResponse>(
          url,
          {
            ...(offset !== undefined ? { offset } : {}),
            timeout: TELEGRAM_POLL_TIMEOUT_SEC,
            allowed_updates: ["message"],
          },
          {
            timeout: TELEGRAM_POLL_HTTP_TIMEOUT_MS,
            signal: abortController.signal,
          }
        );

        consecutiveErrors = 0;
        const updates = response.data?.result ?? [];

        for (const update of updates) {
          offset = update.update_id + 1;
          if (stopped || abortController.signal.aborted) {
            break;
          }

          const cmdPreview = parseTelegramCommand(
            update.message?.text ?? ""
          ).command;

          if (cmdPreview === "search") {
            // Run /search asynchronously so the polling loop remains responsive
            // to subsequent commands (e.g. /status or duplicate /search mutex check)
            void handleTelegramUpdate(update).catch((err) => {
              logger.error("Unhandled error processing /search update", {
                error:
                  err instanceof Error ? maskSecrets(err.message) : String(err),
              });
            });
          } else {
            await handleTelegramUpdate(update);
          }
        }
      } catch (err) {
        if (stopped || abortController.signal.aborted) {
          break;
        }

        if (axios.isAxiosError(err)) {
          if (err.code === "ERR_CANCELED") {
            break;
          }

          const status = err.response?.status;
          const apiDesc = (
            err.response?.data as { description?: string } | undefined
          )?.description;
          const safeDesc = apiDesc
            ? maskSecrets(apiDesc)
            : maskSecrets(err.message);

          if (status === 409) {
            consecutiveErrors = 0;
            logger.warn(
              "Telegram getUpdates returned HTTP 409 Conflict (another bot instance is polling). Retrying in 30s...",
              { description: safeDesc }
            );
            await interruptibleSleep(
              TELEGRAM_CONFLICT_RETRY_MS,
              abortController.signal
            );
            continue;
          }

          consecutiveErrors += 1;
          const retryAfterSec = (
            err.response?.data as
              | { parameters?: { retry_after?: number } }
              | undefined
          )?.parameters?.retry_after;

          const backoffMs =
            status === 429 && retryAfterSec
              ? Math.max(1, retryAfterSec) * 1000
              : Math.min(
                  TELEGRAM_MAX_BACKOFF_MS,
                  1000 * Math.pow(2, Math.min(consecutiveErrors - 1, 5))
                );

          logger.warn("Telegram getUpdates polling error; backing off", {
            status: status ?? "NETWORK_ERROR",
            consecutiveErrors,
            retryInMs: backoffMs,
            error: safeDesc,
          });

          await interruptibleSleep(backoffMs, abortController.signal);
          continue;
        }

        consecutiveErrors += 1;
        const backoffMs = Math.min(
          TELEGRAM_MAX_BACKOFF_MS,
          1000 * Math.pow(2, Math.min(consecutiveErrors - 1, 5))
        );
        const safeErr =
          err instanceof Error ? maskSecrets(err.message) : String(err);

        logger.warn("Unexpected error in Telegram poller; backing off", {
          consecutiveErrors,
          retryInMs: backoffMs,
          error: safeErr,
        });

        await interruptibleSleep(backoffMs, abortController.signal);
      }
    }

    logger.info("Telegram interactive command poller stopped.");
  })();

  return {
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      abortController.abort();
      await loopPromise;
    },
  };
}

import "dotenv/config";
import { z } from "zod";
import { logger } from "../utils/logger";

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((val) => {
    if (typeof val === "string" && val.trim() === "") {
      return undefined;
    }
    return val;
  }, schema);

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const iataRegex = /^[A-Z]{3}$/;

export const envSchema = z
  .object({
    DATABASE_URL: emptyToUndefined(z.string().min(1).optional()),

    ORIGIN_IATA: emptyToUndefined(
      z.string().regex(iataRegex, "Must be 3 uppercase letters").default("KUL")
    ),
    DESTINATION_IATA: emptyToUndefined(
      z.string().regex(iataRegex, "Must be 3 uppercase letters").default("DAM")
    ),
    DATE_FROM: emptyToUndefined(
      z
        .string()
        .regex(dateRegex, "Must be YYYY-MM-DD")
        .default("2026-12-01")
    ),
    DATE_TO: emptyToUndefined(
      z
        .string()
        .regex(dateRegex, "Must be YYYY-MM-DD")
        .default("2026-12-31")
    ),
    MIN_LAYOVER_HOURS: emptyToUndefined(
      z.coerce.number().nonnegative().default(2)
    ),
    MAX_LAYOVER_HOURS: emptyToUndefined(
      z.coerce.number().positive().default(10)
    ),
    MIN_BAGGAGE_KG: emptyToUndefined(
      z.coerce.number().nonnegative().default(20)
    ),
    TARGET_PRICE_MYR: emptyToUndefined(
      z.coerce.number().positive().default(2500)
    ),
    BAGGAGE_UNKNOWN_POLICY: emptyToUndefined(
      z.enum(["flag", "reject"]).default("flag")
    ),
    CRON_SCHEDULE: emptyToUndefined(z.string().min(1).default("0 8 * * *")),
    TZ_NAME: emptyToUndefined(
      z.string().min(1).default("Asia/Kuala_Lumpur")
    ),
    FALLBACK_MYR_TO_USD: emptyToUndefined(
      z.coerce.number().positive().default(0.22)
    ),

    // SerpApi (primary)
    SERPAPI_KEY: emptyToUndefined(z.string().min(1).optional()),
    SERPAPI_DATES_PER_RUN: emptyToUndefined(
      z.coerce.number().int().min(1).max(31).default(6)
    ),
    SERPAPI_MONTHLY_BUDGET: emptyToUndefined(
      z.coerce.number().int().positive().default(240)
    ),

    // Optional legacy providers
    AMADEUS_CLIENT_ID: emptyToUndefined(z.string().min(1).optional()),
    AMADEUS_CLIENT_SECRET: emptyToUndefined(z.string().min(1).optional()),
    AMADEUS_ENV: emptyToUndefined(
      z.enum(["test", "production"]).default("production")
    ),
    KIWI_API_KEY: emptyToUndefined(z.string().min(1).optional()),

    // Telegram (primary notification channel)
    TELEGRAM_BOT_TOKEN: emptyToUndefined(z.string().min(1).optional()),
    TELEGRAM_CHAT_ID: emptyToUndefined(z.string().min(1).optional()),
    TELEGRAM_TOP_N: emptyToUndefined(
      z.coerce.number().int().positive().default(5)
    ),
    TELEGRAM_COMMANDS_ENABLED: emptyToUndefined(
      z.preprocess((val) => {
        if (typeof val === "boolean") return val;
        if (typeof val === "string") {
          const normalized = val.trim().toLowerCase();
          if (["true", "1", "yes", "on"].includes(normalized)) return true;
          if (["false", "0", "no", "off"].includes(normalized)) return false;
        }
        return val;
      }, z.boolean().default(true))
    ),
    SEARCH_COOLDOWN_MIN: emptyToUndefined(
      z.coerce.number().nonnegative().default(30)
    ),

    // Email (Resend)
    RESEND_API_KEY: emptyToUndefined(z.string().min(1).optional()),
    EMAIL_FROM: emptyToUndefined(
      z.string().min(1).default("Flight Agent <onboarding@resend.dev>")
    ),
    EMAIL_TO: emptyToUndefined(z.string().email().optional()),
  })
  .refine((data) => data.DATE_FROM <= data.DATE_TO, {
    message: "DATE_FROM must be less than or equal to DATE_TO",
    path: ["DATE_FROM"],
  })
  .refine((data) => data.MIN_LAYOVER_HOURS <= data.MAX_LAYOVER_HOURS, {
    message: "MIN_LAYOVER_HOURS must be less than or equal to MAX_LAYOVER_HOURS",
    path: ["MIN_LAYOVER_HOURS"],
  });

export type EnvConfig = z.infer<typeof envSchema>;

export const env: EnvConfig = envSchema.parse(process.env);

export type ProviderName = "SERPAPI" | "AMADEUS" | "KIWI";

export function activeProviders(cfg: EnvConfig = env): ProviderName[] {
  const list: ProviderName[] = [];
  if (cfg.SERPAPI_KEY) {
    list.push("SERPAPI");
  }
  if (cfg.AMADEUS_CLIENT_ID && cfg.AMADEUS_CLIENT_SECRET) {
    list.push("AMADEUS");
  }
  if (cfg.KIWI_API_KEY) {
    list.push("KIWI");
  }
  return list;
}

export function telegramConfigured(cfg: EnvConfig = env): boolean {
  return Boolean(cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID);
}

export function emailConfigured(cfg: EnvConfig = env): boolean {
  return Boolean(cfg.RESEND_API_KEY && cfg.EMAIL_FROM && cfg.EMAIL_TO);
}

export function assertLiveReady(cfg: EnvConfig = env): void {
  const missingEn: string[] = [];
  const missingAr: string[] = [];

  if (!cfg.DATABASE_URL) {
    missingEn.push("DATABASE_URL (PostgreSQL connection string)");
    missingAr.push("DATABASE_URL (رابط قاعدة البيانات PostgreSQL)");
  }

  const providers = activeProviders(cfg);
  if (providers.length === 0) {
    missingEn.push(
      "At least one flight provider key (SERPAPI_KEY, AMADEUS_CLIENT_ID+AMADEUS_CLIENT_SECRET, or KIWI_API_KEY)"
    );
    missingAr.push(
      "مفتاح مزود رحلات واحد على الأقل (SERPAPI_KEY أو AMADEUS_CLIENT_ID+AMADEUS_CLIENT_SECRET أو KIWI_API_KEY)"
    );
  }

  if (missingEn.length > 0) {
    const message = [
      "❌ Live mode configuration incomplete / إعدادات التشغيل الفعلي غير مكتملة:",
      "Missing (English):",
      ...missingEn.map((item) => `  - ${item}`),
      "المفقود (بالعربية):",
      ...missingAr.map((item) => `  - ${item}`),
      "Tip: Run with --dry-run to test without keys or a database. / نصيحة: استخدم --dry-run للتجربة بدون مفاتيح أو قاعدة بيانات.",
    ].join("\n");
    throw new Error(message);
  }

  const tgReady = telegramConfigured(cfg);
  const mailReady = emailConfigured(cfg);

  if (!tgReady) {
    logger.warn(
      "Telegram channel is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing); Telegram notifications will be skipped."
    );
  }
  if (!mailReady) {
    logger.warn(
      "Email channel is not configured (RESEND_API_KEY / EMAIL_TO missing); Email notifications will be skipped."
    );
  }
  if (!tgReady && !mailReady) {
    logger.warn(
      "⚠️ WARNING / تحذير: No notification channel (Telegram or Email) is configured in live mode! Results will only be stored in the database, not delivered."
    );
  }
}

import { env, telegramConfigured } from "../src/config/env";
import {
  BOT_MENU_COMMANDS,
  handleTelegramUpdate,
  registerTelegramBotCommands,
  TelegramUpdate,
} from "../src/services/telegram-commands";
import { httpClient } from "../src/utils/http";
import { logger, maskSecrets } from "../src/utils/logger";

export const maxDuration = 300;

const processedUpdateIds = new Set<number>();
const MAX_PROCESSED_IDS = 200;

function markUpdateProcessed(updateId: number): boolean {
  if (processedUpdateIds.has(updateId)) {
    return false;
  }
  processedUpdateIds.add(updateId);
  if (processedUpdateIds.size > MAX_PROCESSED_IDS) {
    const oldest = processedUpdateIds.values().next().value;
    if (oldest !== undefined) {
      processedUpdateIds.delete(oldest);
    }
  }
  return true;
}

/**
 * Health check and one-click webhook registration endpoint (`GET /api/telegram?register=1`).
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const shouldRegister = url.searchParams.get("register") === "1";

  if (!telegramConfigured() || !env.TELEGRAM_BOT_TOKEN) {
    logger.error("Telegram webhook GET called without TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID configured");
    return Response.json(
      {
        ok: false,
        error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured in environment variables.",
      },
      { status: 500 }
    );
  }

  if (shouldRegister) {
    const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    const providedSecret = url.searchParams.get("secret")?.trim();
    if (configuredSecret && providedSecret !== configuredSecret) {
      return Response.json(
        { ok: false, error: "Invalid webhook secret parameter." },
        { status: 401 }
      );
    }

    const prodDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
    const baseUrl = prodDomain
      ? `https://${prodDomain}`
      : `${url.protocol}//${url.host}`;
    const webhookUrl = `${baseUrl}/api/telegram`;

    try {
      const telegramSetWebhookUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`;
      await httpClient.post(telegramSetWebhookUrl, {
        url: webhookUrl,
        allowed_updates: ["message"],
        drop_pending_updates: false,
        ...(configuredSecret ? { secret_token: configuredSecret } : {}),
      });

      await registerTelegramBotCommands(env.TELEGRAM_BOT_TOKEN);

      logger.info("Registered Telegram webhook via GET /api/telegram?register=1", {
        webhookUrl,
        commandsCount: BOT_MENU_COMMANDS.length,
      });

      return Response.json({
        ok: true,
        message: "تم ربط Webhook تيليجرام بنجاح! البوت يعمل الآن 24/7 على السحابة.",
        webhookUrl,
      });
    } catch (err) {
      const safeErr = err instanceof Error ? maskSecrets(err.message) : String(err);
      logger.error("Failed to register Telegram webhook", { error: safeErr });
      return Response.json({ ok: false, error: safeErr }, { status: 500 });
    }
  }

  return Response.json({
    ok: true,
    status: "Telegram Flight Tracker Webhook active",
    registerUrl: `${url.origin}/api/telegram?register=1`,
  });
}

/**
 * Telegram Webhook receiver (`POST /api/telegram`).
 */
export async function POST(request: Request): Promise<Response> {
  const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (configuredSecret) {
    const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");
    if (headerSecret !== configuredSecret) {
      logger.warn("Rejected Telegram webhook request with invalid secret token");
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const update = (await request.json()) as TelegramUpdate;

    if (!update || typeof update.update_id !== "number") {
      return Response.json({ ok: true, ignored: true });
    }

    if (!markUpdateProcessed(update.update_id)) {
      logger.info("Skipping duplicate Telegram webhook update", {
        updateId: update.update_id,
      });
      return Response.json({ ok: true, duplicate: true });
    }

    const result = await handleTelegramUpdate(update);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const safeErr = err instanceof Error ? maskSecrets(err.message) : String(err);
    logger.error("Error handling Telegram webhook POST", { error: safeErr });
    // Return 200 to prevent endless Telegram webhook retry loops on unexpected errors
    return Response.json({ ok: false, error: safeErr }, { status: 200 });
  }
}

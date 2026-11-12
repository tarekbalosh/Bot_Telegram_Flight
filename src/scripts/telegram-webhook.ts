import { env } from "../config/env";
import { registerTelegramBotCommands } from "../services/telegram-commands";
import { httpClient } from "../utils/http";
import { logger, maskSecrets } from "../utils/logger";

async function registerWebhookForBaseUrl(baseUrlInput: string, token: string): Promise<void> {
  const normalizedBase = baseUrlInput.replace(/\/+$/, "");
  const webhookUrl = normalizedBase.endsWith("/api/telegram")
    ? normalizedBase
    : `${normalizedBase}/api/telegram`;
  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

  const setUrl = `https://api.telegram.org/bot${token}/setWebhook`;
  const res = await httpClient.post(setUrl, {
    url: webhookUrl,
    allowed_updates: ["message"],
    drop_pending_updates: false,
    ...(secretToken ? { secret_token: secretToken } : {}),
  });

  await registerTelegramBotCommands(token);

  logger.info("Telegram Webhook registered successfully", {
    webhookUrl,
    ok: res.data?.ok,
    description: res.data?.description,
  });
}

async function main(): Promise<void> {
  const arg = process.argv[2]?.trim();

  if (arg === "--auto-vercel") {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const prodDomain =
      process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
      process.env.VERCEL_URL?.trim();

    if (!token || !prodDomain) {
      logger.info(
        "Skipping automatic Vercel webhook registration (TELEGRAM_BOT_TOKEN or VERCEL_PROJECT_PRODUCTION_URL not set at build time)."
      );
      return;
    }

    const baseUrl = prodDomain.startsWith("http")
      ? prodDomain
      : `https://${prodDomain}`;
    try {
      await registerWebhookForBaseUrl(baseUrl, token);
    } catch (err) {
      logger.warn("Non-fatal error during auto-vercel webhook registration", {
        error: err instanceof Error ? maskSecrets(err.message) : String(err),
      });
    }
    return;
  }

  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN is missing in .env");
    process.exit(1);
  }

  if (!arg || arg === "info") {
    const infoUrl = `https://api.telegram.org/bot${token}/getWebhookInfo`;
    const res = await httpClient.get(infoUrl);
    logger.info("Current Telegram Webhook Info", { result: res.data?.result });
    return;
  }

  if (arg === "delete" || arg === "off") {
    const deleteUrl = `https://api.telegram.org/bot${token}/deleteWebhook`;
    const res = await httpClient.post(deleteUrl, {
      drop_pending_updates: false,
    });
    logger.info("Deleted Telegram Webhook (long-polling mode restored)", {
      ok: res.data?.ok,
    });
    return;
  }

  await registerWebhookForBaseUrl(arg, token);
}

main().catch((err) => {
  logger.error("Failed to manage Telegram webhook", {
    error: err instanceof Error ? maskSecrets(err.message) : String(err),
  });
  process.exit(1);
});

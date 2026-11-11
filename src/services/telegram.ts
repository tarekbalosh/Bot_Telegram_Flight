import axios from "axios";
import { env } from "../config/env";
import { UnifiedFlightOffer } from "../types/flight";
import { httpClient, sleep } from "../utils/http";
import { logger, maskSecrets } from "../utils/logger";
import {
  ARABIC_STRINGS,
  escapeHtml,
  formatAirlinesSummary,
  formatBaggageLine,
  formatFlightDate,
  formatPrice,
  formatTransitSummary,
  isValidHttpUrl,
  wrapLtr,
} from "./format";

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export interface TelegramInlineButton {
  text: string;
  url: string;
}

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

export interface TelegramMessagePayload {
  text: string;
  reply_markup?: TelegramReplyMarkup;
}

export interface NotificationResult {
  ok: boolean;
  error?: string;
}

export function buildInlineKeyboard(
  flights: UnifiedFlightOffer[]
): TelegramReplyMarkup | undefined {
  const rows: TelegramInlineButton[][] = [];

  flights.forEach((flight, idx) => {
    const url = flight.bookingLink?.trim() || "";
    if (isValidHttpUrl(url)) {
      rows.push([
        {
          text: `${ARABIC_STRINGS.bookButtonPrefix} #${idx + 1} ✈️`,
          url,
        },
      ]);
    }
  });

  if (rows.length === 0) {
    return undefined;
  }

  return { inline_keyboard: rows };
}

export function renderTelegramHeaderHtml(
  topFlights: UnifiedFlightOffer[],
  targetPriceMyr: number = env.TARGET_PRICE_MYR
): string {
  if (topFlights.length === 0) {
    return [
      `<b>${escapeHtml(ARABIC_STRINGS.noMatchingFlightsTitle)}</b>`,
      escapeHtml(ARABIC_STRINGS.noMatchingFlightsBody),
    ].join("\n\n");
  }

  const lowest = topFlights[0];
  const beaten = lowest.priceMYR <= targetPriceMyr;
  const targetStatus = beaten
    ? `🟢 <b>${escapeHtml(ARABIC_STRINGS.targetBeatenBadge)}</b> (${escapeHtml(
        formatPrice(targetPriceMyr)
      )} ${escapeHtml(ARABIC_STRINGS.myrUnit)})`
    : `🔵 ${escapeHtml(ARABIC_STRINGS.targetNotBeatenBadge)} (${escapeHtml(
        formatPrice(targetPriceMyr)
      )} ${escapeHtml(ARABIC_STRINGS.myrUnit)})`;

  const lowestLine = `💰 <b>${escapeHtml(
    ARABIC_STRINGS.lowestPriceLabel
  )}:</b> ${escapeHtml(
    wrapLtr(`${formatPrice(lowest.priceMYR)} MYR`)
  )} (${escapeHtml(wrapLtr(`$${formatPrice(lowest.priceUSD)} USD`))})`;

  return [
    `<b>${escapeHtml(ARABIC_STRINGS.reportTitle)}</b>`,
    escapeHtml(ARABIC_STRINGS.routeHeader),
    lowestLine,
    targetStatus,
  ].join("\n");
}

export function renderSingleFlightBlockHtml(
  flight: UnifiedFlightOffer,
  index: number
): string {
  const rank = index + 1;
  const dateText = escapeHtml(formatFlightDate(flight.departureDate));
  const depArrText = escapeHtml(
    wrapLtr(`${flight.departureTime} ➔ ${flight.arrivalTime}`)
  );
  const priceText = `${escapeHtml(
    wrapLtr(`${formatPrice(flight.priceMYR)}`)
  )} ${escapeHtml(ARABIC_STRINGS.myrUnit)} (${escapeHtml(
    wrapLtr(`$${formatPrice(flight.priceUSD)} USD`)
  )})`;
  const airlinesText = escapeHtml(
    formatAirlinesSummary(flight.airlines, flight.flightNumbers)
  );
  const transitText = escapeHtml(
    formatTransitSummary(flight.transitAirports, flight.layoverDurationsHours)
  );
  const durationText = `${escapeHtml(
    String(Math.round(flight.totalDurationHours * 10) / 10)
  )} ${escapeHtml(ARABIC_STRINGS.hoursUnit)}`;
  const baggageBadge = escapeHtml(formatBaggageLine(flight));

  const linkUrl = flight.bookingLink?.trim() || "";
  const linkLine = isValidHttpUrl(linkUrl)
    ? `🔗 <b>${escapeHtml(ARABIC_STRINGS.bookingLinkLabel)}:</b> <a href="${escapeHtml(
        linkUrl
      )}">${escapeHtml(ARABIC_STRINGS.bookNowButton)}</a>`
    : `🔗 <b>${escapeHtml(ARABIC_STRINGS.bookingLinkLabel)}:</b> ${escapeHtml(
        linkUrl
      )}`;

  return [
    `━━━━━━━━━━━━━━━━━━━━`,
    `✈️ <b>${escapeHtml(ARABIC_STRINGS.flightHeaderPrefix)} #${rank}</b>`,
    `📅 <b>${escapeHtml(ARABIC_STRINGS.dateLabel)}:</b> ${dateText}`,
    `🕒 <b>${escapeHtml(ARABIC_STRINGS.timingLabel)}:</b> ${depArrText} (${escapeHtml(
      ARABIC_STRINGS.totalDurationLabel
    )}: ${durationText})`,
    `💵 <b>${escapeHtml(ARABIC_STRINGS.priceLabel)}:</b> <b>${priceText}</b>`,
    `🏢 <b>${escapeHtml(ARABIC_STRINGS.airlinesLabel)}:</b> ${airlinesText}`,
    `🔄 <b>${escapeHtml(ARABIC_STRINGS.transitLabel)}:</b> ${transitText}`,
    `🧳 <b>${escapeHtml(ARABIC_STRINGS.baggageLabel)}:</b> ${baggageBadge}`,
    linkLine,
  ].join("\n");
}

/**
 * Builds one or more Telegram messages (each <= maxLen characters, default 4096),
 * splitting strictly on flight boundaries and attaching the inline keyboard to the last message.
 */
export function buildTelegramPayloads(
  offers: UnifiedFlightOffer[],
  options?: {
    targetPriceMyr?: number;
    maxLen?: number;
  }
): TelegramMessagePayload[] {
  const maxLen = options?.maxLen ?? TELEGRAM_MAX_MESSAGE_LENGTH;
  const targetPriceMyr = options?.targetPriceMyr ?? env.TARGET_PRICE_MYR;

  const top3 = offers.slice(0, 3);
  const header = renderTelegramHeaderHtml(top3, targetPriceMyr);

  if (top3.length === 0) {
    return [{ text: header.slice(0, maxLen) }];
  }

  const flightBlocks = top3.map((flight, i) =>
    renderSingleFlightBlockHtml(flight, i)
  );
  const keyboard = buildInlineKeyboard(top3);

  const chunks: string[] = [];
  let currentChunk = header;

  for (const block of flightBlocks) {
    const candidate = `${currentChunk}\n\n${block}`;
    if (candidate.length <= maxLen) {
      currentChunk = candidate;
    } else {
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk);
      }
      if (block.length <= maxLen) {
        currentChunk = block;
      } else {
        currentChunk = block.slice(0, maxLen);
      }
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk);
  }

  return chunks.map((text, idx) => {
    const isLast = idx === chunks.length - 1;
    if (isLast && keyboard) {
      return { text, reply_markup: keyboard };
    }
    return { text };
  });
}

function classifyTelegramError(status: number | undefined, description?: string): string {
  const desc = description ? ` (${description})` : "";
  if (status === 401 || status === 404) {
    return `Invalid Telegram bot token (HTTP ${status})${desc}. Verify TELEGRAM_BOT_TOKEN with @BotFather.`;
  }
  if (status === 403) {
    return `Telegram bot is blocked or user has not pressed Start in the bot chat (HTTP 403)${desc}.`;
  }
  if (status === 400) {
    return `Telegram request rejected (HTTP 400 — check TELEGRAM_CHAT_ID and ensures user pressed Start)${desc}.`;
  }
  return `Telegram API error${status ? ` (HTTP ${status})` : ""}${desc}`;
}

export async function sendTelegramPayloadWithRetry(
  botToken: string,
  chatId: string,
  payload: TelegramMessagePayload
): Promise<NotificationResult> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const requestBody = {
    chat_id: chatId,
    text: payload.text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}),
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await httpClient.post(url, requestBody);
      return { ok: true };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const data = err.response?.data as
          | { description?: string; parameters?: { retry_after?: number } }
          | undefined;
        const description = data?.description
          ? maskSecrets(data.description)
          : undefined;

        if (status === 429 && attempt === 1) {
          const retryAfterSec = data?.parameters?.retry_after ?? 2;
          logger.warn("Telegram rate limited (HTTP 429), waiting retry_after", {
            retryAfterSec,
          });
          await sleep(Math.max(1, retryAfterSec) * 1000);
          continue;
        }

        if (status && [400, 401, 403, 404].includes(status)) {
          const friendly = classifyTelegramError(status, description);
          logger.error("Telegram notification failed", { error: friendly });
          return { ok: false, error: friendly };
        }

        const genericMsg = classifyTelegramError(
          status,
          description || maskSecrets(err.message)
        );
        logger.error("Telegram notification failed", { error: genericMsg });
        return { ok: false, error: genericMsg };
      }

      const unknownMsg =
        err instanceof Error ? maskSecrets(err.message) : String(err);
      logger.error("Telegram notification failed", { error: unknownMsg });
      return { ok: false, error: unknownMsg };
    }
  }

  return { ok: false, error: "Telegram send failed after retry" };
}

export async function sendTelegramReport(
  offers: UnifiedFlightOffer[],
  options?: {
    dryRun?: boolean;
    targetPriceMyr?: number;
  }
): Promise<NotificationResult> {
  try {
    const payloads = buildTelegramPayloads(offers, {
      targetPriceMyr: options?.targetPriceMyr ?? env.TARGET_PRICE_MYR,
    });

    if (options?.dryRun) {
      console.log("\n================ [DRY-RUN] TELEGRAM REPORT (ARABIC) ================");
      payloads.forEach((p, i) => {
        if (payloads.length > 1) {
          console.log(`--- Message ${i + 1} / ${payloads.length} ---`);
        }
        console.log(p.text);
        if (p.reply_markup) {
          console.log(
            "\n[Inline Keyboard Buttons]:",
            JSON.stringify(p.reply_markup.inline_keyboard, null, 2)
          );
        }
      });
      console.log("====================================================================\n");
      return { ok: true };
    }

    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      const msg =
        "Telegram is not configured (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing)";
      logger.warn(msg);
      return { ok: false, error: msg };
    }

    for (const payload of payloads) {
      const result = await sendTelegramPayloadWithRetry(token, chatId, payload);
      if (!result.ok) {
        return result;
      }
    }

    logger.info("Telegram report sent successfully", {
      messagesSent: payloads.length,
      flightsIncluded: Math.min(3, offers.length),
    });
    return { ok: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? maskSecrets(err.message) : String(err);
    logger.error("Unexpected error in sendTelegramReport", { error: errorMsg });
    return { ok: false, error: errorMsg };
  }
}


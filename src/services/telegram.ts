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
  formatNoMatchingFlightsBody,
  formatNoMatchingFlightsTitle,
  formatPrice,
  formatReportTitle,
  formatRouteHeader,
  formatTransitSummary,
  isValidHttpUrl,
  wrapLtr,
} from "./format";
import { getEffectiveRoute, getEffectiveTarget } from "./settings";

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

export interface GroupedFlightItinerary {
  key: string;
  representative: UnifiedFlightOffer;
  dates: string[];
  departureClock: string;
  arrivalClock: string;
}

function extractTimeOfDay(dateTimeStr: string): string {
  const trimmed = dateTimeStr.trim();
  const match = trimmed.match(/(\d{1,2}:\d{2})/);
  return match ? match[1] : trimmed;
}

export function buildItineraryGroupKey(offer: UnifiedFlightOffer): string {
  const airlinesPart = offer.airlines
    .map((a) => a.trim().toUpperCase())
    .join(",");
  const flightsPart = offer.flightNumbers
    .map((f) => f.replace(/\s+/g, "").toUpperCase())
    .join(",");
  const depClock = extractTimeOfDay(offer.departureTime);
  const arrClock = extractTimeOfDay(offer.arrivalTime);
  return `${airlinesPart}|${flightsPart}|${depClock}|${arrClock}`;
}

/**
 * Groups offers by distinct itinerary (same airlines + flight numbers + times).
 * Keeps the lowest-priced offer as representative, collects sorted unique dates,
 * and returns up to topN itineraries sorted ascending by lowest price.
 */
export function groupOffersByItinerary(
  offers: UnifiedFlightOffer[],
  topN: number = env.TELEGRAM_TOP_N
): GroupedFlightItinerary[] {
  const groups = new Map<
    string,
    { representative: UnifiedFlightOffer; dates: Set<string> }
  >();

  for (const offer of offers) {
    const key = buildItineraryGroupKey(offer);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        representative: offer,
        dates: new Set([offer.departureDate]),
      });
    } else {
      existing.dates.add(offer.departureDate);
      if (offer.priceMYR < existing.representative.priceMYR) {
        existing.representative = offer;
      } else if (
        offer.priceMYR === existing.representative.priceMYR &&
        offer.baggageVerified &&
        !existing.representative.baggageVerified
      ) {
        existing.representative = offer;
      }
    }
  }

  return Array.from(groups.entries())
    .map(([key, { representative, dates }]) => ({
      key,
      representative,
      dates: Array.from(dates).sort(),
      departureClock: extractTimeOfDay(representative.departureTime),
      arrivalClock: extractTimeOfDay(representative.arrivalTime),
    }))
    .sort((a, b) => a.representative.priceMYR - b.representative.priceMYR)
    .slice(0, topN);
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
          text: `احجز #${idx + 1} ✈️`,
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
  targetPriceMyr: number = env.TARGET_PRICE_MYR,
  route?: { origin?: string; destination?: string }
): string {
  const originIata = (
    route?.origin ||
    topFlights[0]?.origin ||
    env.ORIGIN_IATA
  ).toUpperCase();
  const destinationIata = (
    route?.destination ||
    topFlights[0]?.destination ||
    env.DESTINATION_IATA
  ).toUpperCase();

  if (topFlights.length === 0) {
    return [
      `<b>${escapeHtml(
        formatNoMatchingFlightsTitle(originIata, destinationIata)
      )}</b>`,
      escapeHtml(formatNoMatchingFlightsBody(destinationIata)),
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
    `<b>${escapeHtml(formatReportTitle(originIata, destinationIata))}</b>`,
    escapeHtml(formatRouteHeader(originIata, destinationIata)),
    lowestLine,
    targetStatus,
  ].join("\n");
}

export function renderItineraryBlockHtml(
  group: GroupedFlightItinerary,
  index: number,
  destinationIata?: string
): string {
  const rank = index + 1;
  const flight = group.representative;

  const priceText = `${escapeHtml(
    wrapLtr(`${formatPrice(flight.priceMYR)}`)
  )} ${escapeHtml(ARABIC_STRINGS.myrUnit)} (${escapeHtml(
    wrapLtr(`$${formatPrice(flight.priceUSD)} USD`)
  )})`;

  const datesText = group.dates
    .map((d) => escapeHtml(wrapLtr(d)))
    .join(" ، ");

  const airlinesText = escapeHtml(
    formatAirlinesSummary(flight.airlines, flight.flightNumbers)
  );
  const timingText = escapeHtml(
    wrapLtr(`${group.departureClock} ➔ ${group.arrivalClock}`)
  );
  const transitText = escapeHtml(
    formatTransitSummary(flight.transitAirports, flight.layoverDurationsHours)
  );
  const baggageBadge = escapeHtml(formatBaggageLine(flight, destinationIata));

  const linkUrl = flight.bookingLink?.trim() || "";
  const linkPart = isValidHttpUrl(linkUrl)
    ? ` — <a href="${escapeHtml(linkUrl)}">احجز ✈️</a>`
    : "";

  return [
    `━━━━━━━━━━━━━━━━━━━━`,
    `✈️ <b>${escapeHtml(ARABIC_STRINGS.flightHeaderPrefix)} #${rank}</b> — 💵 <b>${priceText}</b>${linkPart}`,
    `📅 <b>${escapeHtml(ARABIC_STRINGS.dateLabel)}:</b> ${datesText}`,
    `🏢 ${airlinesText} | 🕒 ${timingText}`,
    `🔄 ${transitText}`,
    `🧳 ${baggageBadge}`,
  ].join("\n");
}

export function renderSingleFlightBlockHtml(
  flight: UnifiedFlightOffer,
  index: number
): string {
  return renderItineraryBlockHtml(
    {
      key: buildItineraryGroupKey(flight),
      representative: flight,
      dates: [flight.departureDate],
      departureClock: extractTimeOfDay(flight.departureTime),
      arrivalClock: extractTimeOfDay(flight.arrivalTime),
    },
    index,
    flight.destination
  );
}

/**
 * Builds one or more Telegram messages (each <= maxLen characters, default 4096),
 * grouping offers by distinct itinerary, splitting strictly on itinerary boundaries,
 * and attaching the inline keyboard to the last message.
 */
export function buildTelegramPayloads(
  offers: UnifiedFlightOffer[],
  options?: {
    targetPriceMyr?: number;
    maxLen?: number;
    topN?: number;
    originIata?: string;
    destinationIata?: string;
  }
): TelegramMessagePayload[] {
  const maxLen = options?.maxLen ?? TELEGRAM_MAX_MESSAGE_LENGTH;
  const targetPriceMyr = options?.targetPriceMyr ?? env.TARGET_PRICE_MYR;
  const topN = options?.topN ?? env.TELEGRAM_TOP_N;

  const topGroups = groupOffersByItinerary(offers, topN);
  const representativeFlights = topGroups.map((g) => g.representative);
  const originIata =
    options?.originIata || representativeFlights[0]?.origin || env.ORIGIN_IATA;
  const destinationIata =
    options?.destinationIata ||
    representativeFlights[0]?.destination ||
    env.DESTINATION_IATA;

  const header = renderTelegramHeaderHtml(
    representativeFlights,
    targetPriceMyr,
    {
      origin: originIata,
      destination: destinationIata,
    }
  );

  if (topGroups.length === 0) {
    return [{ text: header.slice(0, maxLen) }];
  }

  const flightBlocks = topGroups.map((group, i) =>
    renderItineraryBlockHtml(group, i, destinationIata)
  );
  const keyboard = buildInlineKeyboard(representativeFlights);

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

function classifyTelegramError(
  status: number | undefined,
  description?: string
): string {
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
    originIata?: string;
    destinationIata?: string;
  }
): Promise<NotificationResult> {
  try {
    const [resolvedTargetPriceMyr, effectiveRoute] = await Promise.all([
      options?.targetPriceMyr !== undefined
        ? Promise.resolve(options.targetPriceMyr)
        : options?.dryRun
        ? Promise.resolve(env.TARGET_PRICE_MYR)
        : getEffectiveTarget(),
      options?.originIata && options?.destinationIata
        ? Promise.resolve({
            origin: options.originIata,
            destination: options.destinationIata,
          })
        : getEffectiveRoute(options?.dryRun ? { store: null } : undefined),
    ]);

    const payloads = buildTelegramPayloads(offers, {
      targetPriceMyr: resolvedTargetPriceMyr,
      originIata: options?.originIata || effectiveRoute.origin,
      destinationIata: options?.destinationIata || effectiveRoute.destination,
    });

    if (options?.dryRun) {
      console.log(
        "\n================ [DRY-RUN] TELEGRAM REPORT (ARABIC) ================"
      );
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
      console.log(
        "====================================================================\n"
      );
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
      itinerariesIncluded: groupOffersByItinerary(offers, env.TELEGRAM_TOP_N)
        .length,
    });
    return { ok: true };
  } catch (err) {
    const errorMsg =
      err instanceof Error ? maskSecrets(err.message) : String(err);
    logger.error("Unexpected error in sendTelegramReport", { error: errorMsg });
    return { ok: false, error: errorMsg };
  }
}

import axios from "axios";
import { getPrisma } from "../config/db";
import { env } from "../config/env";
import { getEffectiveDates, getEffectiveRoute } from "../services/settings";
import {
  FlightProvider,
  FlightSearchContext,
  UnifiedFlightOffer,
} from "../types/flight";
import { getCurrentYearMonth, sampleSearchDates } from "../utils/dates";
import { convertMyrToUsd, getMyrToUsdRate } from "../utils/fx";
import { buildExternalId } from "../utils/hash";
import { httpRequest, sleep } from "../utils/http";
import { logger } from "../utils/logger";

export const SELF_TRANSFER_PATTERNS: readonly RegExp[] = [
  /self[\s-]*transfer/i,
  /separate\s+tickets?/i,
  /re-?check\s+bag/i,
  /virtual\s+interlin/i,
];

export interface SerpApiAirportInfo {
  name?: string;
  id?: string;
  time?: string;
}

export interface SerpApiFlightSegment {
  departure_airport?: SerpApiAirportInfo;
  arrival_airport?: SerpApiAirportInfo;
  duration?: number;
  airplane?: string;
  airline?: string;
  airline_logo?: string;
  travel_class?: string;
  flight_number?: string;
  legroom?: string;
  extensions?: string[];
  overnight?: boolean;
}

export interface SerpApiLayover {
  duration?: number; // in minutes
  name?: string;
  id?: string;
  overnight?: boolean;
}

export interface SerpApiFlightOption {
  flights?: SerpApiFlightSegment[];
  layovers?: SerpApiLayover[];
  total_duration?: number; // in minutes
  price?: number;
  type?: string;
  airline_logo?: string;
  extensions?: string[];
  baggage_prices?: string[];
  booking_token?: string;
}

export interface SerpApiFlightsResponse {
  search_metadata?: {
    id?: string;
    status?: string;
    google_flights_url?: string;
  };
  best_flights?: SerpApiFlightOption[];
  other_flights?: SerpApiFlightOption[];
  error?: string;
}

export function detectSelfTransfer(option: SerpApiFlightOption): boolean {
  const serialized = JSON.stringify(option);
  return SELF_TRANSFER_PATTERNS.some((pattern) => pattern.test(serialized));
}

/**
 * Pure helper to extract checked baggage allowance in kg from a SerpApi flight option.
 */
export function parseBaggage(option: SerpApiFlightOption): {
  kg: number | null;
  verified: boolean;
} {
  const allExtensions: string[] = [];

  if (Array.isArray(option.extensions)) {
    allExtensions.push(...option.extensions);
  }
  if (Array.isArray(option.baggage_prices)) {
    allExtensions.push(...option.baggage_prices);
  }
  if (Array.isArray(option.flights)) {
    for (const seg of option.flights) {
      if (Array.isArray(seg.extensions)) {
        allExtensions.push(...seg.extensions);
      }
    }
  }

  for (const rawText of allExtensions) {
    const text = rawText.trim();
    if (!text) continue;

    // 1. Negative / extra-fee patterns must be checked first
    if (
      /no\s+(?:free\s+)?checked\s+bags?/i.test(text) ||
      /checked\s+bag(?:gage|s)?\s+(?:available\s+)?for\s+a\s+fee/i.test(text) ||
      /checked\s+bag(?:gage|s)?\s+not\s+included/i.test(text) ||
      /carry-?on\s+only/i.test(text)
    ) {
      return { kg: 0, verified: true };
    }

    // 2. Explicit weight in kg near "checked" / "bag" / "baggage" / "luggage"
    const kgNearCheckedMatch =
      text.match(/(\d+)\s*kg\b[^.;,]*?\b(?:checked|bag(?:gage|s)?|luggage|hold)/i) ||
      text.match(/\b(?:checked|bag(?:gage|s)?|luggage|hold)\b[^.;,]*?(\d+)\s*kg\b/i);
    if (kgNearCheckedMatch) {
      const weight = Number(kgNearCheckedMatch[1]);
      if (Number.isFinite(weight) && weight >= 0) {
        return { kg: weight, verified: true };
      }
    }

    // 3. "N checked bag(s) included" or "free checked bag(s)"
    const countCheckedMatch = text.match(
      /(?:(\d+)|a|one|two|three)\s+(?:free\s+)?checked\s+bags?\s*(?:included|free)?/i
    );
    if (countCheckedMatch && /included|free|checked\s+bags?/i.test(text)) {
      const rawNum = countCheckedMatch[1];
      let bagsCount = 1;
      if (rawNum) {
        bagsCount = Number(rawNum);
      } else if (/\btwo\b/i.test(countCheckedMatch[0])) {
        bagsCount = 2;
      } else if (/\bthree\b/i.test(countCheckedMatch[0])) {
        bagsCount = 3;
      }
      if (Number.isFinite(bagsCount) && bagsCount >= 0) {
        return { kg: bagsCount * 23, verified: true };
      }
    }

    if (/checked\s+bag(?:gage)?\s+included/i.test(text)) {
      return { kg: 23, verified: true };
    }
  }

  return { kg: null, verified: false };
}

export function buildDefaultGoogleFlightsUrl(
  origin: string,
  destination: string,
  outboundDate: string
): string {
  return `https://www.google.com/travel/flights?q=Flights%20from%20${encodeURIComponent(
    origin
  )}%20to%20${encodeURIComponent(destination)}%20on%20${encodeURIComponent(
    outboundDate
  )}%20oneway`;
}

/**
 * Pure parser converting a SerpApi response into UnifiedFlightOffer items.
 */
export function parseSerpApiResponse(
  data: SerpApiFlightsResponse,
  params: {
    outboundDate: string;
    originIata: string;
    destinationIata: string;
    usdRate: number;
  }
): UnifiedFlightOffer[] {
  if (data.error) {
    if (/hasn't returned any results|no results/i.test(data.error)) {
      return [];
    }
    throw new Error(`SerpApi error: ${data.error}`);
  }

  const options: SerpApiFlightOption[] = [
    ...(Array.isArray(data.best_flights) ? data.best_flights : []),
    ...(Array.isArray(data.other_flights) ? data.other_flights : []),
  ];

  const fallbackBookingUrl = buildDefaultGoogleFlightsUrl(
    params.originIata,
    params.destinationIata,
    params.outboundDate
  );
  const bookingLink =
    data.search_metadata?.google_flights_url?.trim() || fallbackBookingUrl;

  const offers: UnifiedFlightOffer[] = [];

  for (const option of options) {
    const segments = option.flights ?? [];
    if (segments.length === 0) {
      continue;
    }

    const priceMYR = typeof option.price === "number" ? option.price : NaN;
    if (!Number.isFinite(priceMYR) || priceMYR <= 0) {
      continue;
    }

    const firstSeg = segments[0];
    const lastSeg = segments[segments.length - 1];

    const origin = firstSeg.departure_airport?.id || params.originIata;
    const destination = lastSeg.arrival_airport?.id || params.destinationIata;

    const departureTime =
      firstSeg.departure_airport?.time || `${params.outboundDate} 00:00`;
    const arrivalTime =
      lastSeg.arrival_airport?.time || `${params.outboundDate} 23:59`;
    const departureDate = departureTime.slice(0, 10) || params.outboundDate;

    const airlines = Array.from(
      new Set(
        segments
          .map((s) => s.airline?.trim())
          .filter((a): a is string => Boolean(a))
      )
    );
    const flightNumbers = segments
      .map((s) => s.flight_number?.trim())
      .filter((f): f is string => Boolean(f));

    const layovers = option.layovers ?? [];
    const transitAirports =
      layovers.length > 0
        ? layovers
            .map((l) => l.id?.trim() || l.name?.trim())
            .filter((id): id is string => Boolean(id))
        : segments
            .slice(0, -1)
            .map((s) => s.arrival_airport?.id?.trim())
            .filter((id): id is string => Boolean(id));

    const layoverDurationsHours = layovers.map((l) => {
      const mins = typeof l.duration === "number" ? l.duration : 0;
      return Math.round((mins / 60) * 100) / 100;
    });

    const totalMinutes =
      typeof option.total_duration === "number"
        ? option.total_duration
        : segments.reduce((acc, s) => acc + (s.duration ?? 0), 0) +
          layovers.reduce((acc, l) => acc + (l.duration ?? 0), 0);
    const totalDurationHours = Math.round((totalMinutes / 60) * 100) / 100;

    const isSelfTransfer = detectSelfTransfer(option);
    const isSinglePNR = !isSelfTransfer;
    const bagsRecheckRequired = isSelfTransfer;

    const baggage = parseBaggage(option);

    const draft: Omit<UnifiedFlightOffer, "externalId"> = {
      provider: "SERPAPI",
      origin,
      destination,
      priceMYR,
      priceUSD: convertMyrToUsd(priceMYR, params.usdRate),
      departureDate,
      departureTime,
      arrivalTime,
      airlines,
      flightNumbers,
      transitAirports,
      layoverDurationsHours,
      totalDurationHours,
      checkedBaggageKg: baggage.kg,
      baggageVerified: baggage.verified,
      isSinglePNR,
      bagsRecheckRequired,
      bookingLink,
    };

    offers.push({
      ...draft,
      externalId: buildExternalId(draft),
    });
  }

  return offers;
}

async function checkBudgetAvailable(budgetKey: string, limit: number): Promise<boolean> {
  const prisma = getPrisma();
  const usage = await prisma.apiUsage.findUnique({
    where: { key: budgetKey },
  });
  const currentCount = usage?.count ?? 0;
  if (currentCount >= limit) {
    logger.warn("SerpApi monthly budget reached; skipping request", {
      key: budgetKey,
      count: currentCount,
      budget: limit,
    });
    return false;
  }
  return true;
}

async function incrementBudgetUsage(budgetKey: string): Promise<number> {
  const prisma = getPrisma();
  const updated = await prisma.apiUsage.upsert({
    where: { key: budgetKey },
    create: { key: budgetKey, count: 1 },
    update: { count: { increment: 1 } },
  });
  return updated.count;
}

export class SerpApiProvider implements FlightProvider {
  public readonly name = "SERPAPI" as const;

  public isConfigured(): boolean {
    return Boolean(env.SERPAPI_KEY);
  }

  public async search(
    context: FlightSearchContext = {}
  ): Promise<UnifiedFlightOffer[]> {
    if (!env.SERPAPI_KEY) {
      return [];
    }

    const [effectiveRoute, effectiveDates] = await Promise.all([
      getEffectiveRoute(),
      getEffectiveDates(),
    ]);

    const originIata = (context.originIata || effectiveRoute.origin).toUpperCase();
    const destinationIata = (
      context.destinationIata || effectiveRoute.destination
    ).toUpperCase();
    const dateFrom = context.dateFrom || effectiveDates.dateFrom;
    const dateTo = context.dateTo || effectiveDates.dateTo;
    const datesPerRun = context.datesPerRun ?? env.SERPAPI_DATES_PER_RUN;

    if (datesPerRun <= 0) {
      return [];
    }

    const dates = sampleSearchDates(dateFrom, dateTo, datesPerRun);
    const usdRate = await getMyrToUsdRate();
    const budgetKey = `SERPAPI:${getCurrentYearMonth()}`;
    const allOffers: UnifiedFlightOffer[] = [];

    logger.info("SerpApi sampled dates for run", {
      route: `${originIata}-${destinationIata}`,
      dates,
      budgetKey,
      monthlyBudget: env.SERPAPI_MONTHLY_BUDGET,
    });

    for (let i = 0; i < dates.length; i++) {
      const outboundDate = dates[i];

      const hasBudget = await checkBudgetAvailable(
        budgetKey,
        env.SERPAPI_MONTHLY_BUDGET
      );
      if (!hasBudget) {
        break;
      }

      if (i > 0) {
        await sleep(1000);
      }

      try {
        const response = await httpRequest<SerpApiFlightsResponse>(
          {
            method: "GET",
            url: "https://serpapi.com/search.json",
            params: {
              engine: "google_flights",
              departure_id: originIata,
              arrival_id: destinationIata,
              outbound_date: outboundDate,
              type: "2",
              currency: "MYR",
              hl: "en",
              gl: "my",
              layover_duration: `0,${env.MAX_LAYOVER_HOURS * 60}`,
              api_key: env.SERPAPI_KEY,
            },
          },
          {
            label: `SerpApi search (${originIata}->${destinationIata} ${outboundDate})`,
          }
        );

        const newCount = await incrementBudgetUsage(budgetKey);
        const parsed = parseSerpApiResponse(response.data, {
          outboundDate,
          originIata,
          destinationIata,
          usdRate,
        });

        logger.info("SerpApi date search completed", {
          route: `${originIata}-${destinationIata}`,
          outboundDate,
          offersFound: parsed.length,
          monthlyUsage: `${newCount}/${env.SERPAPI_MONTHLY_BUDGET}`,
        });

        allOffers.push(...parsed);
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.data) {
          const apiErr = (err.response.data as { error?: string }).error;
          if (apiErr && /hasn't returned any results|no results/i.test(apiErr)) {
            await incrementBudgetUsage(budgetKey);
            logger.info("SerpApi returned no flights for date", {
              route: `${originIata}-${destinationIata}`,
              outboundDate,
            });
            continue;
          }
          if (
            err.response.status === 401 ||
            err.response.status === 403 ||
            err.response.status === 429
          ) {
            throw new Error(
              `SerpApi authentication/quota error (${err.response.status}): ${
                apiErr || err.message
              }`
            );
          }
        }
        throw err;
      }
    }

    return allOffers;
  }
}


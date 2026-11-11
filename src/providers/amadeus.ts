import { env } from "../config/env";
import { FlightProvider, UnifiedFlightOffer } from "../types/flight";
import { sampleSearchDates } from "../utils/dates";
import { convertMyrToUsd, getMyrToUsdRate } from "../utils/fx";
import { buildExternalId } from "../utils/hash";
import { httpRequest } from "../utils/http";
import { logger } from "../utils/logger";
import { buildDefaultGoogleFlightsUrl } from "./serpapi";

interface AmadeusTokenCache {
  accessToken: string;
  expiresAtMs: number;
}

let tokenCache: AmadeusTokenCache | null = null;

interface AmadeusSegment {
  id?: string;
  departure?: { iataCode?: string; at?: string };
  arrival?: { iataCode?: string; at?: string };
  carrierCode?: string;
  number?: string;
  duration?: string;
}

interface AmadeusItinerary {
  duration?: string;
  segments?: AmadeusSegment[];
}

interface AmadeusIncludedCheckedBags {
  weight?: number;
  weightUnit?: string;
  quantity?: number;
}

interface AmadeusFareDetailsBySegment {
  segmentId?: string;
  includedCheckedBags?: AmadeusIncludedCheckedBags;
}

interface AmadeusFlightOffer {
  id?: string;
  itineraries?: AmadeusItinerary[];
  price?: {
    currency?: string;
    grandTotal?: string;
    total?: string;
  };
  travelerPricings?: Array<{
    fareDetailsBySegment?: AmadeusFareDetailsBySegment[];
  }>;
}

interface AmadeusSearchResponse {
  data?: AmadeusFlightOffer[];
  dictionaries?: {
    carriers?: Record<string, string>;
  };
}

export function parseIso8601DurationHours(isoDuration?: string): number {
  if (!isoDuration) return 0;
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!match) return 0;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  return Math.round((hours + minutes / 60) * 100) / 100;
}

export function parseAmadeusBaggageKg(offer: AmadeusFlightOffer): {
  kg: number | null;
  verified: boolean;
} {
  const details = offer.travelerPricings?.[0]?.fareDetailsBySegment;
  if (!Array.isArray(details) || details.length === 0) {
    return { kg: null, verified: false };
  }

  const weightsKg: number[] = [];

  for (const segDetail of details) {
    const bags = segDetail.includedCheckedBags;
    if (!bags) {
      return { kg: null, verified: false };
    }

    if (typeof bags.weight === "number" && Number.isFinite(bags.weight)) {
      const unit = (bags.weightUnit || "KG").toUpperCase();
      const kg =
        unit === "LB" || unit === "LBS"
          ? Math.round(bags.weight * 0.45359237)
          : Math.round(bags.weight);
      weightsKg.push(kg);
    } else if (typeof bags.quantity === "number" && Number.isFinite(bags.quantity)) {
      weightsKg.push(bags.quantity * 23);
    } else {
      return { kg: null, verified: false };
    }
  }

  if (weightsKg.length === 0) {
    return { kg: null, verified: false };
  }

  return {
    kg: Math.min(...weightsKg),
    verified: true,
  };
}

export class AmadeusProvider implements FlightProvider {
  public readonly name = "AMADEUS" as const;

  public isConfigured(): boolean {
    return Boolean(env.AMADEUS_CLIENT_ID && env.AMADEUS_CLIENT_SECRET);
  }

  private getBaseUrl(): string {
    return env.AMADEUS_ENV === "test"
      ? "https://test.api.amadeus.com"
      : "https://api.amadeus.com";
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (tokenCache && now < tokenCache.expiresAtMs - 30_000) {
      return tokenCache.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.AMADEUS_CLIENT_ID || "",
      client_secret: env.AMADEUS_CLIENT_SECRET || "",
    }).toString();

    const response = await httpRequest<{
      access_token: string;
      expires_in: number;
    }>(
      {
        method: "POST",
        url: `${this.getBaseUrl()}/v1/security/oauth2/token`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        data: body,
      },
      { label: "Amadeus OAuth2 token" }
    );

    const accessToken = response.data.access_token;
    const expiresInSec = response.data.expires_in || 1799;
    tokenCache = {
      accessToken,
      expiresAtMs: now + expiresInSec * 1000,
    };

    return accessToken;
  }

  public async search(): Promise<UnifiedFlightOffer[]> {
    if (!this.isConfigured()) {
      return [];
    }

    logger.warn(
      "Amadeus Self-Service was retired on 2026-07-17; this adapter works only with Enterprise credentials."
    );

    const token = await this.getAccessToken();
    const dates = sampleSearchDates(
      env.DATE_FROM,
      env.DATE_TO,
      Math.min(6, env.SERPAPI_DATES_PER_RUN)
    );
    const usdRate = await getMyrToUsdRate();
    const allOffers: UnifiedFlightOffer[] = [];

    for (const departureDate of dates) {
      const response = await httpRequest<AmadeusSearchResponse>(
        {
          method: "GET",
          url: `${this.getBaseUrl()}/v2/shopping/flight-offers`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
          params: {
            originLocationCode: env.ORIGIN_IATA,
            destinationLocationCode: env.DESTINATION_IATA,
            departureDate,
            adults: 1,
            currencyCode: "MYR",
            max: 50,
          },
        },
        { label: `Amadeus search (${departureDate})` }
      );

      const rawList = response.data?.data ?? [];
      const carriersDict = response.data?.dictionaries?.carriers ?? {};

      for (const item of rawList) {
        const itinerary = item.itineraries?.[0];
        const segments = itinerary?.segments ?? [];
        if (segments.length === 0) continue;

        const priceMYR = Number(item.price?.grandTotal ?? item.price?.total ?? NaN);
        if (!Number.isFinite(priceMYR) || priceMYR <= 0) continue;

        const firstSeg = segments[0];
        const lastSeg = segments[segments.length - 1];

        const origin = firstSeg.departure?.iataCode || env.ORIGIN_IATA;
        const destination = lastSeg.arrival?.iataCode || env.DESTINATION_IATA;
        const departureTime = firstSeg.departure?.at || `${departureDate}T00:00:00`;
        const arrivalTime = lastSeg.arrival?.at || `${departureDate}T23:59:00`;

        const airlines = Array.from(
          new Set(
            segments
              .map((s) => {
                const code = s.carrierCode || "";
                return carriersDict[code] || code;
              })
              .filter(Boolean)
          )
        );

        const flightNumbers = segments
          .map((s) => `${s.carrierCode || ""} ${s.number || ""}`.trim())
          .filter(Boolean);

        const transitAirports = segments
          .slice(0, -1)
          .map((s) => s.arrival?.iataCode || "")
          .filter(Boolean);

        const layoverDurationsHours: number[] = [];
        for (let i = 0; i < segments.length - 1; i++) {
          const arrAt = segments[i].arrival?.at;
          const nextDepAt = segments[i + 1].departure?.at;
          if (arrAt && nextDepAt) {
            const diffMs = new Date(nextDepAt).getTime() - new Date(arrAt).getTime();
            const hours = Math.max(0, Math.round((diffMs / 3_600_000) * 100) / 100);
            layoverDurationsHours.push(hours);
          }
        }

        const totalDurationHours = parseIso8601DurationHours(itinerary?.duration);
        const baggage = parseAmadeusBaggageKg(item);
        const bookingLink = buildDefaultGoogleFlightsUrl(
          origin,
          destination,
          departureDate
        );

        const draft: Omit<UnifiedFlightOffer, "externalId"> = {
          provider: "AMADEUS",
          origin,
          destination,
          priceMYR,
          priceUSD: convertMyrToUsd(priceMYR, usdRate),
          departureDate: departureTime.slice(0, 10) || departureDate,
          departureTime,
          arrivalTime,
          airlines,
          flightNumbers,
          transitAirports,
          layoverDurationsHours,
          totalDurationHours,
          checkedBaggageKg: baggage.kg,
          baggageVerified: baggage.verified,
          isSinglePNR: true,
          bagsRecheckRequired: false,
          bookingLink,
        };

        allOffers.push({
          ...draft,
          externalId: buildExternalId(draft),
        });
      }
    }

    return allOffers;
  }
}


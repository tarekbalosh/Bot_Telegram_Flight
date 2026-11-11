import { env } from "../config/env";
import { UnifiedFlightOffer } from "../types/flight";
import { buildExternalId } from "../utils/hash";
import { getEffectiveDates, getEffectiveRoute } from "./settings";

export interface FilterConfig {
  originIata: string;
  destinationIata: string;
  dateFrom: string;
  dateTo: string;
  minLayoverHours: number;
  maxLayoverHours: number;
  minBaggageKg: number;
  baggageUnknownPolicy: "flag" | "reject";
}

export function getDefaultFilterConfig(): FilterConfig {
  return {
    originIata: env.ORIGIN_IATA,
    destinationIata: env.DESTINATION_IATA,
    dateFrom: env.DATE_FROM,
    dateTo: env.DATE_TO,
    minLayoverHours: env.MIN_LAYOVER_HOURS,
    maxLayoverHours: env.MAX_LAYOVER_HOURS,
    minBaggageKg: env.MIN_BAGGAGE_KG,
    baggageUnknownPolicy: env.BAGGAGE_UNKNOWN_POLICY,
  };
}

export async function getEffectiveFilterConfig(
  overrides: Partial<FilterConfig> = {}
): Promise<FilterConfig> {
  const [route, dates] = await Promise.all([
    getEffectiveRoute(),
    getEffectiveDates(),
  ]);
  return {
    originIata: route.origin,
    destinationIata: route.destination,
    dateFrom: dates.dateFrom,
    dateTo: dates.dateTo,
    minLayoverHours: env.MIN_LAYOVER_HOURS,
    maxLayoverHours: env.MAX_LAYOVER_HOURS,
    minBaggageKg: env.MIN_BAGGAGE_KG,
    baggageUnknownPolicy: env.BAGGAGE_UNKNOWN_POLICY,
    ...overrides,
  };
}

/**
 * Pure filter function enforcing non-negotiable itinerary rules in strict order:
 * 1. Single ticket (isSinglePNR === true && bagsRecheckRequired === false)
 * 2. Checked baggage to destination (>= minBaggageKg if known; if null, drop on "reject" or keep with baggageVerified=false on "flag")
 * 3. Layovers (every layover between minLayoverHours and maxLayoverHours)
 * 4. Sanity (origin/destination match config, departureDate within [dateFrom, dateTo], priceMYR > 0)
 * 5. Dedupe by externalId (keep cheaper; prefer baggageVerified=true on equal price) + sort ascending by priceMYR
 */
export function filterStrictFlights(
  offers: UnifiedFlightOffer[],
  config: Partial<FilterConfig> = {}
): UnifiedFlightOffer[] {
  const cfg: FilterConfig = {
    ...getDefaultFilterConfig(),
    ...config,
  };

  const passed: UnifiedFlightOffer[] = [];

  for (const rawOffer of offers) {
    // Rule 1: Single ticket (single PNR & no bag re-check)
    if (
      rawOffer.isSinglePNR !== true ||
      rawOffer.bagsRecheckRequired !== false
    ) {
      continue;
    }

    // Rule 2: Checked baggage to final destination
    let baggageVerified = rawOffer.baggageVerified;
    if (rawOffer.checkedBaggageKg !== null) {
      if (rawOffer.checkedBaggageKg < cfg.minBaggageKg) {
        continue;
      }
      baggageVerified = true;
    } else {
      if (cfg.baggageUnknownPolicy === "reject") {
        continue;
      }
      baggageVerified = false;
    }

    // Rule 3: Layovers (every layover between minLayoverHours and maxLayoverHours)
    const hasInvalidLayover = rawOffer.layoverDurationsHours.some(
      (hours) =>
        hours < cfg.minLayoverHours ||
        hours > cfg.maxLayoverHours ||
        Number.isNaN(hours)
    );
    if (hasInvalidLayover) {
      continue;
    }

    // Rule 4: Sanity checks (origin/destination, date range, positive price)
    if (
      rawOffer.origin !== undefined &&
      rawOffer.origin.toUpperCase() !== cfg.originIata.toUpperCase()
    ) {
      continue;
    }
    if (
      rawOffer.destination !== undefined &&
      rawOffer.destination.toUpperCase() !== cfg.destinationIata.toUpperCase()
    ) {
      continue;
    }
    if (
      !rawOffer.departureDate ||
      rawOffer.departureDate < cfg.dateFrom ||
      rawOffer.departureDate > cfg.dateTo
    ) {
      continue;
    }
    if (
      typeof rawOffer.priceMYR !== "number" ||
      !Number.isFinite(rawOffer.priceMYR) ||
      rawOffer.priceMYR <= 0
    ) {
      continue;
    }

    const externalId = rawOffer.externalId || buildExternalId(rawOffer);

    passed.push({
      ...rawOffer,
      externalId,
      baggageVerified,
    });
  }

  // Rule 5: Dedupe by externalId + sort ascending by priceMYR
  const byExternalId = new Map<string, UnifiedFlightOffer>();

  for (const offer of passed) {
    const existing = byExternalId.get(offer.externalId);
    if (!existing) {
      byExternalId.set(offer.externalId, offer);
      continue;
    }

    if (offer.priceMYR < existing.priceMYR) {
      byExternalId.set(offer.externalId, offer);
    } else if (
      offer.priceMYR === existing.priceMYR &&
      offer.baggageVerified &&
      !existing.baggageVerified
    ) {
      byExternalId.set(offer.externalId, offer);
    }
  }

  return Array.from(byExternalId.values()).sort(
    (a, b) => a.priceMYR - b.priceMYR
  );
}

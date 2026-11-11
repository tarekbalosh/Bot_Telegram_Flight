import { env } from "../config/env";
import { getEffectiveDates, getEffectiveRoute } from "../services/settings";
import {
  FlightProvider,
  FlightSearchContext,
  UnifiedFlightOffer,
} from "../types/flight";
import { toDdMmYyyy } from "../utils/dates";
import { convertMyrToUsd, getMyrToUsdRate } from "../utils/fx";
import { buildExternalId } from "../utils/hash";
import { httpRequest } from "../utils/http";
import { logger } from "../utils/logger";
import { buildDefaultGoogleFlightsUrl } from "./serpapi";

interface KiwiRouteSegment {
  flyFrom?: string;
  flyTo?: string;
  airline?: string;
  flight_no?: number | string;
  local_departure?: string;
  local_arrival?: string;
  utc_departure?: string;
  utc_arrival?: string;
}

interface KiwiFlightItem {
  id?: string;
  flyFrom?: string;
  flyTo?: string;
  price?: number;
  local_departure?: string;
  local_arrival?: string;
  utc_departure?: string;
  utc_arrival?: string;
  duration?: {
    total?: number; // in seconds
  };
  baglimit?: {
    hold_weight?: number;
  };
  bags_recheck_required?: boolean;
  virtual_interlining?: boolean;
  deep_link?: string;
  route?: KiwiRouteSegment[];
}

interface KiwiSearchResponse {
  data?: KiwiFlightItem[];
}

export class KiwiProvider implements FlightProvider {
  public readonly name = "KIWI" as const;

  public isConfigured(): boolean {
    return Boolean(env.KIWI_API_KEY);
  }

  public async search(
    context: FlightSearchContext = {}
  ): Promise<UnifiedFlightOffer[]> {
    if (!this.isConfigured()) {
      return [];
    }

    logger.warn(
      "Kiwi Tequila public self-serve closed in May 2024; this adapter is for invited B2B partners only."
    );

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

    const usdRate = await getMyrToUsdRate();

    const response = await httpRequest<KiwiSearchResponse>(
      {
        method: "GET",
        url: "https://api.tequila.kiwi.com/v2/search",
        headers: {
          apikey: env.KIWI_API_KEY || "",
        },
        params: {
          fly_from: originIata,
          fly_to: destinationIata,
          date_from: toDdMmYyyy(dateFrom),
          date_to: toDdMmYyyy(dateTo),
          flight_type: "oneway",
          curr: "MYR",
          adults: 1,
          is_virtual_interlining: false,
          limit: 100,
          sort: "price",
        },
      },
      { label: `Kiwi Tequila search (${originIata}->${destinationIata})` }
    );

    const items = response.data?.data ?? [];
    const offers: UnifiedFlightOffer[] = [];

    for (const item of items) {
      const route = item.route ?? [];
      if (route.length === 0) continue;

      const priceMYR = typeof item.price === "number" ? item.price : NaN;
      if (!Number.isFinite(priceMYR) || priceMYR <= 0) continue;

      const firstSeg = route[0];
      const lastSeg = route[route.length - 1];

      const origin = item.flyFrom || firstSeg.flyFrom || originIata;
      const destination = item.flyTo || lastSeg.flyTo || destinationIata;

      const departureTime =
        item.local_departure || firstSeg.local_departure || `${dateFrom}T00:00:00`;
      const arrivalTime =
        item.local_arrival || lastSeg.local_arrival || `${dateFrom}T23:59:00`;
      const departureDate = departureTime.slice(0, 10);

      const airlines = Array.from(
        new Set(route.map((r) => r.airline?.trim()).filter((a): a is string => Boolean(a)))
      );
      const flightNumbers = route
        .map((r) => `${r.airline || ""} ${r.flight_no ?? ""}`.trim())
        .filter(Boolean);

      const transitAirports = route
        .slice(0, -1)
        .map((r) => r.flyTo?.trim())
        .filter((a): a is string => Boolean(a));

      const layoverDurationsHours: number[] = [];
      for (let i = 0; i < route.length - 1; i++) {
        const arrIso = route[i].utc_arrival || route[i].local_arrival;
        const nextDepIso = route[i + 1].utc_departure || route[i + 1].local_departure;
        if (arrIso && nextDepIso) {
          const diffMs = new Date(nextDepIso).getTime() - new Date(arrIso).getTime();
          const hours = Math.max(0, Math.round((diffMs / 3_600_000) * 100) / 100);
          layoverDurationsHours.push(hours);
        }
      }

      const totalSec = item.duration?.total ?? 0;
      const totalDurationHours = Math.round((totalSec / 3600) * 100) / 100;

      const holdWeight = item.baglimit?.hold_weight;
      const checkedBaggageKg =
        typeof holdWeight === "number" && Number.isFinite(holdWeight)
          ? holdWeight
          : null;
      const baggageVerified = checkedBaggageKg !== null;

      const isVirtualInterlining = Boolean(item.virtual_interlining);
      const isSinglePNR = !isVirtualInterlining;
      const bagsRecheckRequired = Boolean(item.bags_recheck_required);

      const bookingLink =
        item.deep_link?.trim() ||
        buildDefaultGoogleFlightsUrl(origin, destination, departureDate);

      const draft: Omit<UnifiedFlightOffer, "externalId"> = {
        provider: "KIWI",
        origin,
        destination,
        priceMYR,
        priceUSD: convertMyrToUsd(priceMYR, usdRate),
        departureDate,
        departureTime,
        arrivalTime,
        airlines,
        flightNumbers,
        transitAirports,
        layoverDurationsHours,
        totalDurationHours,
        checkedBaggageKg,
        baggageVerified,
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
}


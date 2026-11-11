import { env } from "../config/env";
import { getEffectiveDates, getEffectiveRoute } from "../services/settings";
import {
  FlightProvider,
  FlightSearchContext,
  UnifiedFlightOffer,
} from "../types/flight";
import { convertMyrToUsd } from "../utils/fx";
import { buildExternalId } from "../utils/hash";
import { buildDefaultGoogleFlightsUrl } from "./serpapi";

export interface BuildMockOffersOptions {
  originIata?: string;
  destinationIata?: string;
  dateFrom?: string;
}

/**
 * Generates realistic mock offers for --dry-run covering all filter test cases:
 * 1. Valid offer #1: 30 kg verified checked baggage, single PNR, 3.5h layover in DOH
 * 2. Valid offer #2: 23 kg verified checked baggage, single PNR, 4.0h layover in DXB
 * 3. Self-transfer offer (rejected by Rule 1)
 * 4. Low baggage offer with 15 kg (rejected by Rule 2)
 * 5. Long layover offer with 14 h layover (rejected by Rule 3)
 * 6. Unknown baggage offer (kept with baggageVerified=false under "flag" policy)
 * 7. Duplicate of Valid offer #1 at a higher price from another provider (deduped by Rule 5)
 */
export function buildMockOffers(
  options: BuildMockOffersOptions = {}
): UnifiedFlightOffer[] {
  const rate = env.FALLBACK_MYR_TO_USD;
  const origin = (options.originIata || env.ORIGIN_IATA).toUpperCase();
  const destination = (
    options.destinationIata || env.DESTINATION_IATA
  ).toUpperCase();
  const baseDate = options.dateFrom || env.DATE_FROM;
  const bookingLink = buildDefaultGoogleFlightsUrl(
    origin,
    destination,
    baseDate
  );

  const rawDrafts: Array<Omit<UnifiedFlightOffer, "externalId">> = [
    // 1. Valid: 30 kg checked baggage, Qatar Airways via DOH, beats target price (2150 MYR)
    {
      provider: "SERPAPI",
      origin,
      destination,
      priceMYR: 2150,
      priceUSD: convertMyrToUsd(2150, rate),
      departureDate: baseDate,
      departureTime: `${baseDate} 02:45`,
      arrivalTime: `${baseDate} 14:15`,
      airlines: ["Qatar Airways", "Royal Jordanian"],
      flightNumbers: ["QR 853", "QR 412"],
      transitAirports: ["DOH"],
      layoverDurationsHours: [3.5],
      totalDurationHours: 16.5,
      checkedBaggageKg: 30,
      baggageVerified: true,
      isSinglePNR: true,
      bagsRecheckRequired: false,
      bookingLink,
    },
    // 2. Valid: 23 kg checked baggage, Emirates + Flydubai via DXB (2380 MYR)
    {
      provider: "SERPAPI",
      origin,
      destination,
      priceMYR: 2380,
      priceUSD: convertMyrToUsd(2380, rate),
      departureDate: baseDate,
      departureTime: `${baseDate} 10:15`,
      arrivalTime: `${baseDate} 22:45`,
      airlines: ["Emirates", "Flydubai"],
      flightNumbers: ["EK 345", "FZ 115"],
      transitAirports: ["DXB"],
      layoverDurationsHours: [4.0],
      totalDurationHours: 17.5,
      checkedBaggageKg: 23,
      baggageVerified: true,
      isSinglePNR: true,
      bagsRecheckRequired: false,
      bookingLink,
    },
    // 3. Invalid: Self-transfer itinerary (isSinglePNR=false, bagsRecheckRequired=true)
    {
      provider: "SERPAPI",
      origin,
      destination,
      priceMYR: 1650,
      priceUSD: convertMyrToUsd(1650, rate),
      departureDate: baseDate,
      departureTime: `${baseDate} 06:00`,
      arrivalTime: `${baseDate} 20:30`,
      airlines: ["AirAsia X", "Air Arabia"],
      flightNumbers: ["D7 170", "G9 512"],
      transitAirports: ["SHJ"],
      layoverDurationsHours: [5.0],
      totalDurationHours: 19.5,
      checkedBaggageKg: 25,
      baggageVerified: true,
      isSinglePNR: false,
      bagsRecheckRequired: true,
      bookingLink,
    },
    // 4. Invalid: Checked baggage only 15 kg (< MIN_BAGGAGE_KG 20 kg)
    {
      provider: "KIWI",
      origin,
      destination,
      priceMYR: 1990,
      priceUSD: convertMyrToUsd(1990, rate),
      departureDate: baseDate,
      departureTime: `${baseDate} 08:30`,
      arrivalTime: `${baseDate} 21:00`,
      airlines: ["Gulf Air"],
      flightNumbers: ["GF 283", "GF 915"],
      transitAirports: ["BAH"],
      layoverDurationsHours: [3.0],
      totalDurationHours: 17.5,
      checkedBaggageKg: 15,
      baggageVerified: true,
      isSinglePNR: true,
      bagsRecheckRequired: false,
      bookingLink,
    },
    // 5. Invalid: Layover of 14 hours (> MAX_LAYOVER_HOURS 10 h)
    {
      provider: "AMADEUS",
      origin,
      destination,
      priceMYR: 2050,
      priceUSD: convertMyrToUsd(2050, rate),
      departureDate: baseDate,
      departureTime: `${baseDate} 01:20`,
      arrivalTime: `${baseDate} 23:50`,
      airlines: ["Etihad Airways"],
      flightNumbers: ["EY 411", "EY 535"],
      transitAirports: ["AUH"],
      layoverDurationsHours: [14.0],
      totalDurationHours: 27.5,
      checkedBaggageKg: 30,
      baggageVerified: true,
      isSinglePNR: true,
      bagsRecheckRequired: false,
      bookingLink,
    },
    // 6. Unknown baggage: checkedBaggageKg=null (kept with warning under "flag")
    {
      provider: "SERPAPI",
      origin,
      destination,
      priceMYR: 2490,
      priceUSD: convertMyrToUsd(2490, rate),
      departureDate: baseDate,
      departureTime: `${baseDate} 19:00`,
      arrivalTime: `${baseDate} 07:30`,
      airlines: ["Royal Jordanian"],
      flightNumbers: ["RJ 185", "RJ 432"],
      transitAirports: ["AMM"],
      layoverDurationsHours: [2.75],
      totalDurationHours: 15.25,
      checkedBaggageKg: null,
      baggageVerified: false,
      isSinglePNR: true,
      bagsRecheckRequired: false,
      bookingLink,
    },
    // 7. Duplicate of Valid offer #1 at a higher price from AMADEUS (2520 MYR vs 2150 MYR)
    {
      provider: "AMADEUS",
      origin,
      destination,
      priceMYR: 2520,
      priceUSD: convertMyrToUsd(2520, rate),
      departureDate: baseDate,
      departureTime: `${baseDate} 02:45`,
      arrivalTime: `${baseDate} 14:15`,
      airlines: ["Qatar Airways", "Royal Jordanian"],
      flightNumbers: ["QR 853", "QR 412"],
      transitAirports: ["DOH"],
      layoverDurationsHours: [3.5],
      totalDurationHours: 16.5,
      checkedBaggageKg: 30,
      baggageVerified: true,
      isSinglePNR: true,
      bagsRecheckRequired: false,
      bookingLink,
    },
  ];

  return rawDrafts.map((draft) => ({
    ...draft,
    externalId: buildExternalId(draft),
  }));
}

export class MockProvider implements FlightProvider {
  public readonly name = "MOCK" as const;

  public isConfigured(): boolean {
    return true;
  }

  public async search(
    context: FlightSearchContext = {}
  ): Promise<UnifiedFlightOffer[]> {
    return buildMockOffers({
      originIata: context.originIata || env.ORIGIN_IATA,
      destinationIata: context.destinationIata || env.DESTINATION_IATA,
      dateFrom: context.dateFrom || env.DATE_FROM,
    });
  }
}

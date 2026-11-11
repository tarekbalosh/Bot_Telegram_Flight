import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterStrictDamascusFlights, FilterConfig } from "../services/filter";
import { UnifiedFlightOffer } from "../types/flight";
import { buildExternalId } from "../utils/hash";

const testConfig: FilterConfig = {
  originIata: "KUL",
  destinationIata: "DAM",
  dateFrom: "2026-12-01",
  dateTo: "2026-12-31",
  minLayoverHours: 2,
  maxLayoverHours: 10,
  minBaggageKg: 20,
  baggageUnknownPolicy: "flag",
};

function makeOffer(overrides: Partial<UnifiedFlightOffer> = {}): UnifiedFlightOffer {
  const base: UnifiedFlightOffer = {
    externalId: "",
    provider: "SERPAPI",
    origin: "KUL",
    destination: "DAM",
    priceMYR: 2100,
    priceUSD: 462,
    departureDate: "2026-12-10",
    departureTime: "2026-12-10 23:15",
    arrivalTime: "2026-12-11 14:30",
    airlines: ["Qatar Airways"],
    flightNumbers: ["QR 853", "QR 410"],
    transitAirports: ["DOH"],
    layoverDurationsHours: [3.5],
    totalDurationHours: 14.25,
    checkedBaggageKg: 25,
    baggageVerified: true,
    isSinglePNR: true,
    bagsRecheckRequired: false,
    bookingLink: "https://www.google.com/travel/flights",
    ...overrides,
  };
  if (!overrides.externalId) {
    base.externalId = buildExternalId(base);
  }
  return base;
}

describe("filterStrictDamascusFlights", () => {
  it("rejects self-transfer itineraries (isSinglePNR === false)", () => {
    const offer = makeOffer({ isSinglePNR: false });
    const result = filterStrictDamascusFlights([offer], testConfig);
    assert.equal(result.length, 0);
  });

  it("rejects itineraries requiring bag re-check (bagsRecheckRequired === true)", () => {
    const offer = makeOffer({ bagsRecheckRequired: true });
    const result = filterStrictDamascusFlights([offer], testConfig);
    assert.equal(result.length, 0);
  });

  it("rejects itineraries with checked baggage below minimum (15 kg < 20 kg)", () => {
    const offer = makeOffer({ checkedBaggageKg: 15, baggageVerified: true });
    const result = filterStrictDamascusFlights([offer], testConfig);
    assert.equal(result.length, 0);
  });

  it("handles unknown baggage (null) according to BAGGAGE_UNKNOWN_POLICY", () => {
    const unknownOffer = makeOffer({
      checkedBaggageKg: null,
      baggageVerified: true,
    });

    const flagged = filterStrictDamascusFlights([unknownOffer], {
      ...testConfig,
      baggageUnknownPolicy: "flag",
    });
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].checkedBaggageKg, null);
    assert.equal(flagged[0].baggageVerified, false);

    const rejected = filterStrictDamascusFlights([unknownOffer], {
      ...testConfig,
      baggageUnknownPolicy: "reject",
    });
    assert.equal(rejected.length, 0);
  });

  it("rejects itineraries with layovers exceeding MAX_LAYOVER_HOURS (12 h > 10 h)", () => {
    const offer = makeOffer({ layoverDurationsHours: [2.5, 12.0] });
    const result = filterStrictDamascusFlights([offer], testConfig);
    assert.equal(result.length, 0);
  });

  it("rejects itineraries with layovers below MIN_LAYOVER_HOURS (1.5 h < 2 h)", () => {
    const tooShort = makeOffer({ layoverDurationsHours: [1.5] });
    const exactMin = makeOffer({
      layoverDurationsHours: [2.0],
      flightNumbers: ["QR 853", "QR 412"],
    });
    const exactMax = makeOffer({
      layoverDurationsHours: [10.0],
      flightNumbers: ["QR 853", "QR 414"],
    });

    const result = filterStrictDamascusFlights(
      [tooShort, exactMin, exactMax],
      testConfig
    );
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((o) => o.layoverDurationsHours[0]),
      [2.0, 10.0]
    );
  });

  it("rejects out-of-range dates, non-matching airports, and non-positive prices", () => {
    const earlyDate = makeOffer({ departureDate: "2026-11-30" });
    const lateDate = makeOffer({ departureDate: "2027-01-01" });
    const wrongOrigin = makeOffer({ origin: "SIN" });
    const wrongDest = makeOffer({ destination: "BEY" });
    const zeroPrice = makeOffer({ priceMYR: 0 });

    const result = filterStrictDamascusFlights(
      [earlyDate, lateDate, wrongOrigin, wrongDest, zeroPrice],
      testConfig
    );
    assert.equal(result.length, 0);
  });

  it("deduplicates identical itineraries across providers keeping the cheaper one and prefers verified baggage on equal price", () => {
    const expensive = makeOffer({
      provider: "AMADEUS",
      priceMYR: 2450,
      priceUSD: 539,
    });
    const cheaper = makeOffer({
      provider: "SERPAPI",
      priceMYR: 2100,
      priceUSD: 462,
    });

    assert.equal(expensive.externalId, cheaper.externalId);

    const deduped = filterStrictDamascusFlights([expensive, cheaper], testConfig);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].priceMYR, 2100);
    assert.equal(deduped[0].provider, "SERPAPI");

    // Equal price tie-breaker: prefer baggageVerified=true
    const unverifiedEqual = makeOffer({
      provider: "SERPAPI",
      priceMYR: 2000,
      checkedBaggageKg: null,
      baggageVerified: false,
    });
    const verifiedEqual = makeOffer({
      provider: "KIWI",
      priceMYR: 2000,
      checkedBaggageKg: 23,
      baggageVerified: true,
    });
    const tieResult = filterStrictDamascusFlights(
      [unverifiedEqual, verifiedEqual],
      testConfig
    );
    assert.equal(tieResult.length, 1);
    assert.equal(tieResult[0].baggageVerified, true);
    assert.equal(tieResult[0].provider, "KIWI");
  });

  it("sorts valid offers in ascending order by priceMYR", () => {
    const offerA = makeOffer({
      priceMYR: 2600,
      flightNumbers: ["TK 61", "TK 846"],
      departureTime: "2026-12-12 23:00",
    });
    const offerB = makeOffer({
      priceMYR: 1890,
      flightNumbers: ["QR 845", "QR 410"],
      departureTime: "2026-12-14 02:30",
    });
    const offerC = makeOffer({
      priceMYR: 2200,
      flightNumbers: ["EK 343", "EK 913"],
      departureTime: "2026-12-15 09:45",
    });

    const sorted = filterStrictDamascusFlights(
      [offerA, offerB, offerC],
      testConfig
    );
    assert.deepEqual(
      sorted.map((o) => o.priceMYR),
      [1890, 2200, 2600]
    );
  });
});


import crypto from "crypto";
import { UnifiedFlightOffer } from "../types/flight";

export type HashableOfferFields = Pick<
  UnifiedFlightOffer,
  "airlines" | "flightNumbers" | "departureDate" | "departureTime"
>;

/**
 * Computes a deterministic SHA-1 identifier from airlines, flightNumbers, and departure datetime,
 * deliberately excluding provider and price so identical itineraries from different providers collide.
 */
export function buildExternalId(offer: HashableOfferFields): string {
  const airlinesPart = offer.airlines
    .map((a) => a.trim().toUpperCase())
    .join(",");
  const flightsPart = offer.flightNumbers
    .map((f) => f.replace(/\s+/g, "").toUpperCase())
    .join(",");
  const departureIso = (offer.departureTime || offer.departureDate).trim();

  const raw = `${airlinesPart}|${flightsPart}|${departureIso}`;
  return crypto.createHash("sha1").update(raw, "utf8").digest("hex");
}


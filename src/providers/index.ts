import { FlightProvider, UnifiedFlightOffer } from "../types/flight";
import { logger } from "../utils/logger";
import { AmadeusProvider } from "./amadeus";
import { KiwiProvider } from "./kiwi";
import { MockProvider } from "./mock";
import { SerpApiProvider } from "./serpapi";

export const REGISTERED_PROVIDERS: readonly FlightProvider[] = [
  new SerpApiProvider(),
  new AmadeusProvider(),
  new KiwiProvider(),
];

export interface FetchOffersOptions {
  dryRun?: boolean;
}

export async function fetchAllOffers(
  options: FetchOffersOptions = {}
): Promise<UnifiedFlightOffer[]> {
  if (options.dryRun) {
    const mock = new MockProvider();
    const startMs = Date.now();
    const offers = await mock.search();
    logger.info("Provider finished", {
      provider: mock.name,
      status: "ok",
      count: offers.length,
      durationMs: Date.now() - startMs,
    });
    return offers;
  }

  const active = REGISTERED_PROVIDERS.filter((p) => p.isConfigured());
  if (active.length === 0) {
    logger.warn("No flight providers are configured.");
    return [];
  }

  const timedRuns = active.map(async (provider) => {
    const startMs = Date.now();
    try {
      const offers = await provider.search();
      const durationMs = Date.now() - startMs;
      logger.info("Provider finished", {
        provider: provider.name,
        status: "ok",
        count: offers.length,
        durationMs,
      });
      return offers;
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("Provider failed", {
        provider: provider.name,
        status: "error",
        durationMs,
        error: errorMsg,
      });
      throw err;
    }
  });

  const settled = await Promise.allSettled(timedRuns);
  const merged: UnifiedFlightOffer[] = [];

  for (const res of settled) {
    if (res.status === "fulfilled") {
      merged.push(...res.value);
    }
  }

  return merged;
}


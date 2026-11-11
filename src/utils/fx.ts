import { env } from "../config/env";
import { httpRequest } from "./http";
import { logger } from "./logger";

const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FRANKFURTER_URL = "https://api.frankfurter.app/latest?from=MYR&to=USD";

interface FxCacheEntry {
  rate: number;
  fetchedAt: number;
}

let fxCache: FxCacheEntry | null = null;

export function clearFxCache(): void {
  fxCache = null;
}

export async function getMyrToUsdRate(options?: {
  dryRun?: boolean;
}): Promise<number> {
  if (options?.dryRun) {
    return env.FALLBACK_MYR_TO_USD;
  }

  const now = Date.now();
  if (fxCache && now - fxCache.fetchedAt < FX_CACHE_TTL_MS) {
    return fxCache.rate;
  }

  try {
    const res = await httpRequest<{ rates?: { USD?: number } }>(
      {
        method: "GET",
        url: FRANKFURTER_URL,
      },
      { label: "Frankfurter FX MYR->USD", attempts: 2, baseDelayMs: 500 }
    );

    const rate = res.data?.rates?.USD;
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      fxCache = { rate, fetchedAt: now };
      return rate;
    }

    logger.warn("Frankfurter FX response missing valid USD rate, using fallback", {
      fallback: env.FALLBACK_MYR_TO_USD,
    });
  } catch (err) {
    logger.warn("Failed to fetch live MYR->USD rate, using FALLBACK_MYR_TO_USD", {
      fallback: env.FALLBACK_MYR_TO_USD,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  fxCache = { rate: env.FALLBACK_MYR_TO_USD, fetchedAt: now };
  return env.FALLBACK_MYR_TO_USD;
}

export function convertMyrToUsd(amountMyr: number, rate: number = env.FALLBACK_MYR_TO_USD): number {
  return Math.round(amountMyr * rate * 100) / 100;
}


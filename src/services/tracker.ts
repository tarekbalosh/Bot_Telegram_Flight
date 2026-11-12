import { getPrisma, withDbRetry } from "../config/db";
import {
  assertLiveReady,
  emailConfigured,
  env,
  telegramConfigured,
} from "../config/env";
import { fetchAllOffers } from "../providers";
import { UnifiedFlightOffer } from "../types/flight";
import {
  RouteInfo,
  splitDatesPerRunAcrossRoutes,
} from "../utils/airports";
import { logger } from "../utils/logger";
import { sendEmailReport } from "./email";
import { filterStrictFlights } from "./filter";
import {
  EffectiveDates,
  getEffectiveDates,
  getEffectiveRoute,
  getEffectiveTarget,
  getEffectiveWatchRoutes,
} from "./settings";
import { sendTelegramReport } from "./telegram";

export {
  getEffectiveDates,
  getEffectiveRoute,
  getEffectiveTarget,
  getEffectiveWatchRoutes,
} from "./settings";

export type NotificationReason = "FORCED" | "NEW_LOW" | "TARGET_HIT" | "DAILY";

export interface TrackerRunOptions {
  forceNotify?: boolean;
  dryRun?: boolean;
  noNotify?: boolean;
  routes?: RouteInfo[];
}

export interface RouteRunSummary {
  routeKey: string;
  rawCount: number;
  validCount: number;
  lowestPriceMYR: number | null;
  notified: string[];
  reason?: NotificationReason | null;
}

export interface TrackerRunSummary {
  rawCount: number;
  validCount: number;
  lowestPriceMYR: number | null;
  notified: string[];
  reason?: NotificationReason | null;
  skippedMutex?: boolean;
  routeSummaries?: RouteRunSummary[];
}

export interface RoutePersistenceStore {
  getRouteHistory(routeKey: string): Promise<{
    previousLowestMyr: number | null;
    lastNotification: { lowestPriceMYR: number; sentAt: Date } | null;
  }>;
  persistRouteOffers(
    routeKey: string,
    validOffers: UnifiedFlightOffer[]
  ): Promise<void>;
  recordNotification(params: {
    routeKey: string;
    lowestPriceMYR: number;
    channel: string;
    reason: NotificationReason;
  }): Promise<void>;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

let isRunInProgress = false;

export function isTrackerRunInProgress(): boolean {
  return isRunInProgress;
}

export function decideNotificationReason(params: {
  validCount: number;
  currentLowestMyr: number | null;
  previousLowestMyr: number | null;
  lastNotification: { lowestPriceMYR: number; sentAt: Date } | null;
  targetPriceMyr: number;
  forceNotify: boolean;
  nowMs?: number;
}): NotificationReason | null {
  const {
    validCount,
    currentLowestMyr,
    previousLowestMyr,
    lastNotification,
    targetPriceMyr,
    forceNotify,
    nowMs = Date.now(),
  } = params;

  // Step 6: If no valid flights, notify only when forced
  if (validCount === 0 || currentLowestMyr === null) {
    return forceNotify ? "FORCED" : null;
  }

  // Step 5a: FORCED
  if (forceNotify) {
    return "FORCED";
  }

  // Step 5b: NEW_LOW — current lowest < previous lowest, or first-ever run (baseline)
  if (previousLowestMyr === null || currentLowestMyr < previousLowestMyr) {
    return "NEW_LOW";
  }

  // Step 5c: TARGET_HIT — any offer <= TARGET_PRICE_MYR and current lowest differs from last notified lowest
  if (
    currentLowestMyr <= targetPriceMyr &&
    (lastNotification === null ||
      Math.abs(currentLowestMyr - lastNotification.lowestPriceMYR) > 0.001)
  ) {
    return "TARGET_HIT";
  }

  // Step 5d: DAILY — >= 24h since last notification
  if (
    lastNotification === null ||
    nowMs - lastNotification.sentAt.getTime() >= TWENTY_FOUR_HOURS_MS
  ) {
    return "DAILY";
  }

  return null;
}

export function createPrismaRouteStore(): RoutePersistenceStore {
  return {
    async getRouteHistory(routeKey: string) {
      return withDbRetry(async () => {
        const prisma = getPrisma();
        const minSnapshotAgg = await prisma.priceSnapshot.aggregate({
          where: { route: routeKey },
          _min: { priceMYR: true },
        });
        const latestNotif = await prisma.notificationLog.findFirst({
          where: { route: routeKey },
          orderBy: { sentAt: "desc" },
          select: { lowestPriceMYR: true, sentAt: true },
        });

        return {
          previousLowestMyr: minSnapshotAgg._min.priceMYR ?? null,
          lastNotification: latestNotif ?? null,
        };
      }, `getRouteHistory(${routeKey})`);
    },

    async persistRouteOffers(
      routeKey: string,
      validOffers: UnifiedFlightOffer[]
    ) {
      if (validOffers.length === 0) {
        return;
      }
      await withDbRetry(async () => {
        const prisma = getPrisma();
        for (const offer of validOffers) {
          await prisma.flightOfferRecord.upsert({
            where: { externalId: offer.externalId },
            create: {
              externalId: offer.externalId,
              route: routeKey,
              provider: offer.provider,
              priceMYR: offer.priceMYR,
              priceUSD: offer.priceUSD,
              departureDate: offer.departureDate,
              departureTime: offer.departureTime,
              arrivalTime: offer.arrivalTime,
              airlines: offer.airlines,
              flightNumbers: offer.flightNumbers,
              transitAirports: offer.transitAirports,
              layoverDurationsHours: offer.layoverDurationsHours,
              totalDurationHours: offer.totalDurationHours,
              checkedBaggageKg: offer.checkedBaggageKg,
              baggageVerified: offer.baggageVerified,
              isSinglePNR: offer.isSinglePNR,
              bagsRecheckRequired: offer.bagsRecheckRequired,
              bookingLink: offer.bookingLink,
            },
            update: {
              route: routeKey,
              provider: offer.provider,
              priceMYR: offer.priceMYR,
              priceUSD: offer.priceUSD,
              departureDate: offer.departureDate,
              departureTime: offer.departureTime,
              arrivalTime: offer.arrivalTime,
              airlines: offer.airlines,
              flightNumbers: offer.flightNumbers,
              transitAirports: offer.transitAirports,
              layoverDurationsHours: offer.layoverDurationsHours,
              totalDurationHours: offer.totalDurationHours,
              checkedBaggageKg: offer.checkedBaggageKg,
              baggageVerified: offer.baggageVerified,
              isSinglePNR: offer.isSinglePNR,
              bagsRecheckRequired: offer.bagsRecheckRequired,
              bookingLink: offer.bookingLink,
            },
          });
        }

        await prisma.priceSnapshot.createMany({
          data: validOffers.map((offer) => ({
            externalId: offer.externalId,
            route: routeKey,
            priceMYR: offer.priceMYR,
          })),
        });
      }, `persistRouteOffers(${routeKey})`);
    },

    async recordNotification({ routeKey, lowestPriceMYR, channel, reason }) {
      await withDbRetry(async () => {
        const prisma = getPrisma();
        await prisma.notificationLog.create({
          data: {
            route: routeKey,
            lowestPriceMYR,
            channel,
            reason,
          },
        });
      }, `recordNotification(${routeKey})`);
    },
  };
}

export async function executeSingleRouteRun(params: {
  route: RouteInfo;
  dates: EffectiveDates;
  datesPerRun: number;
  targetPriceMyr: number;
  dryRun: boolean;
  forceNotify: boolean;
  noNotify: boolean;
  store?: RoutePersistenceStore;
  fetchOffersFn?: (opts: {
    dryRun: boolean;
    originIata: string;
    destinationIata: string;
    dateFrom: string;
    dateTo: string;
    datesPerRun: number;
  }) => Promise<UnifiedFlightOffer[]>;
  notifyTelegramFn?: (
    offers: UnifiedFlightOffer[],
    opts: {
      dryRun: boolean;
      targetPriceMyr: number;
      originIata: string;
      destinationIata: string;
    }
  ) => Promise<{ ok: boolean }>;
  notifyEmailFn?: (
    offers: UnifiedFlightOffer[],
    opts: {
      dryRun: boolean;
      targetPriceMyr: number;
      originIata: string;
      destinationIata: string;
    }
  ) => Promise<{ ok: boolean }>;
}): Promise<RouteRunSummary> {
  const {
    route,
    dates,
    datesPerRun,
    targetPriceMyr,
    dryRun,
    forceNotify,
    noNotify,
  } = params;

  const fetchFn = params.fetchOffersFn ?? fetchAllOffers;
  const rawOffers = await fetchFn({
    dryRun,
    originIata: route.origin,
    destinationIata: route.destination,
    dateFrom: dates.dateFrom,
    dateTo: dates.dateTo,
    datesPerRun,
  });

  const validOffers = filterStrictFlights(rawOffers, {
    originIata: route.origin,
    destinationIata: route.destination,
    dateFrom: dates.dateFrom,
    dateTo: dates.dateTo,
  });

  const currentLowestMyr =
    validOffers.length > 0 ? validOffers[0].priceMYR : null;

  logger.info("Flight offers fetched and filtered for route", {
    route: route.routeKey,
    rawCount: rawOffers.length,
    validCount: validOffers.length,
    lowestPriceMYR: currentLowestMyr,
  });

  let previousLowestMyr: number | null = null;
  let lastNotification: { lowestPriceMYR: number; sentAt: Date } | null = null;
  const store =
    params.store ?? (!dryRun ? createPrismaRouteStore() : undefined);

  if (store) {
    const history = await store.getRouteHistory(route.routeKey);
    previousLowestMyr = history.previousLowestMyr;
    lastNotification = history.lastNotification;

    logger.info("Historical state read prior to persistence", {
      route: route.routeKey,
      previousLowestMyr,
      lastNotifiedPriceMYR: lastNotification?.lowestPriceMYR ?? null,
      lastNotifiedAt: lastNotification?.sentAt?.toISOString() ?? null,
    });

    if (validOffers.length > 0) {
      await store.persistRouteOffers(route.routeKey, validOffers);
      logger.info("Persisted valid offers and price snapshots", {
        route: route.routeKey,
        offersUpserted: validOffers.length,
        snapshotsInserted: validOffers.length,
      });
    }
  }

  if (noNotify) {
    logger.info("Notifications suppressed via --no-notify flag.", {
      route: route.routeKey,
    });
    return {
      routeKey: route.routeKey,
      rawCount: rawOffers.length,
      validCount: validOffers.length,
      lowestPriceMYR: currentLowestMyr,
      notified: [],
      reason: null,
    };
  }

  const reason = decideNotificationReason({
    validCount: validOffers.length,
    currentLowestMyr,
    previousLowestMyr,
    lastNotification,
    targetPriceMyr,
    forceNotify,
  });

  if (!reason) {
    logger.info("No notification trigger met for route", {
      route: route.routeKey,
      currentLowestMyr,
      previousLowestMyr,
      targetPriceMyr,
    });
    return {
      routeKey: route.routeKey,
      rawCount: rawOffers.length,
      validCount: validOffers.length,
      lowestPriceMYR: currentLowestMyr,
      notified: [],
      reason: null,
    };
  }

  logger.info("Notification triggered for route", {
    route: route.routeKey,
    reason,
    currentLowestMyr,
    previousLowestMyr,
    targetPriceMyr,
  });

  const notified: string[] = [];
  const notifyTg = params.notifyTelegramFn ?? sendTelegramReport;
  const notifyMail = params.notifyEmailFn ?? sendEmailReport;

  if (dryRun) {
    const [tgRes, emailRes] = await Promise.all([
      notifyTg(validOffers, {
        dryRun: true,
        targetPriceMyr,
        originIata: route.origin,
        destinationIata: route.destination,
      }),
      notifyMail(validOffers, {
        dryRun: true,
        targetPriceMyr,
        originIata: route.origin,
        destinationIata: route.destination,
      }),
    ]);
    if (tgRes.ok) notified.push("TELEGRAM");
    if (emailRes.ok) notified.push("EMAIL");
  } else {
    const tasks: Promise<void>[] = [];

    if (telegramConfigured() || params.notifyTelegramFn) {
      tasks.push(
        (async () => {
          const res = await notifyTg(validOffers, {
            dryRun: false,
            targetPriceMyr,
            originIata: route.origin,
            destinationIata: route.destination,
          });
          if (res.ok) {
            notified.push("TELEGRAM");
            if (store) {
              await store.recordNotification({
                routeKey: route.routeKey,
                lowestPriceMYR: currentLowestMyr ?? 0,
                channel: "TELEGRAM",
                reason,
              });
            }
          }
        })()
      );
    } else {
      logger.warn("Skipping Telegram delivery: channel not configured.");
    }

    if (emailConfigured() || params.notifyEmailFn) {
      tasks.push(
        (async () => {
          const res = await notifyMail(validOffers, {
            dryRun: false,
            targetPriceMyr,
            originIata: route.origin,
            destinationIata: route.destination,
          });
          if (res.ok) {
            notified.push("EMAIL");
            if (store) {
              await store.recordNotification({
                routeKey: route.routeKey,
                lowestPriceMYR: currentLowestMyr ?? 0,
                channel: "EMAIL",
                reason,
              });
            }
          }
        })()
      );
    } else {
      logger.warn("Skipping Email delivery: channel not configured.");
    }

    await Promise.allSettled(tasks);
  }

  return {
    routeKey: route.routeKey,
    rawCount: rawOffers.length,
    validCount: validOffers.length,
    lowestPriceMYR: currentLowestMyr,
    notified,
    reason,
  };
}

export async function runFlightTrackerAgent(
  options: TrackerRunOptions = {}
): Promise<TrackerRunSummary> {
  if (isRunInProgress) {
    logger.warn(
      "A flight tracker run is already in progress; skipping overlapping execution."
    );
    return {
      rawCount: 0,
      validCount: 0,
      lowestPriceMYR: null,
      notified: [],
      reason: null,
      skippedMutex: true,
    };
  }

  isRunInProgress = true;
  const dryRun = Boolean(options.dryRun);
  const forceNotify = Boolean(options.forceNotify || dryRun);
  const noNotify = Boolean(options.noNotify);

  try {
    if (!dryRun) {
      assertLiveReady();
    }

    const [watchedRoutes, effectiveDates, effectiveTargetMyr] =
      await Promise.all([
        options.routes
          ? Promise.resolve(options.routes)
          : getEffectiveWatchRoutes(dryRun ? { store: null } : undefined),
        getEffectiveDates(dryRun ? { store: null } : undefined),
        dryRun ? Promise.resolve(env.TARGET_PRICE_MYR) : getEffectiveTarget(),
      ]);

    const datesAllocations = splitDatesPerRunAcrossRoutes(
      env.SERPAPI_DATES_PER_RUN,
      watchedRoutes.length
    );

    logger.info("Starting Flight Tracker Agent run", {
      routes: watchedRoutes.map((r) => r.routeKey),
      datesAllocations,
      dateFrom: effectiveDates.dateFrom,
      dateTo: effectiveDates.dateTo,
      dryRun,
      forceNotify,
      noNotify,
    });

    const routeSummaries: RouteRunSummary[] = [];

    for (let i = 0; i < watchedRoutes.length; i++) {
      const route = watchedRoutes[i];
      const datesPerRun = datesAllocations[i] ?? 0;

      const summary = await executeSingleRouteRun({
        route,
        dates: effectiveDates,
        datesPerRun,
        targetPriceMyr: effectiveTargetMyr,
        dryRun,
        forceNotify,
        noNotify,
      });

      routeSummaries.push(summary);
    }

    const totalRaw = routeSummaries.reduce((acc, s) => acc + s.rawCount, 0);
    const totalValid = routeSummaries.reduce((acc, s) => acc + s.validCount, 0);
    const allLowest = routeSummaries
      .map((s) => s.lowestPriceMYR)
      .filter((p): p is number => p !== null);
    const overallLowest =
      allLowest.length > 0 ? Math.min(...allLowest) : null;
    const allNotified = Array.from(
      new Set(routeSummaries.flatMap((s) => s.notified))
    );
    const firstReason =
      routeSummaries.find((s) => s.reason)?.reason ?? null;

    logger.info("Flight Tracker Agent run completed", {
      routesChecked: routeSummaries.map((s) => s.routeKey),
      rawCount: totalRaw,
      validCount: totalValid,
      lowestPriceMYR: overallLowest,
      reason: firstReason,
      notified: allNotified,
    });

    return {
      rawCount: totalRaw,
      validCount: totalValid,
      lowestPriceMYR: overallLowest,
      notified: allNotified,
      reason: firstReason,
      routeSummaries,
    };
  } finally {
    isRunInProgress = false;
  }
}

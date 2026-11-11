import { getPrisma } from "../config/db";
import {
  assertLiveReady,
  emailConfigured,
  env,
  telegramConfigured,
} from "../config/env";
import { fetchAllOffers } from "../providers";
import { logger } from "../utils/logger";
import { sendEmailReport } from "./email";
import { filterStrictDamascusFlights } from "./filter";
import { sendTelegramReport } from "./telegram";

export type NotificationReason = "FORCED" | "NEW_LOW" | "TARGET_HIT" | "DAILY";

export interface TrackerRunOptions {
  forceNotify?: boolean;
  dryRun?: boolean;
  noNotify?: boolean;
}

export interface TrackerRunSummary {
  rawCount: number;
  validCount: number;
  lowestPriceMYR: number | null;
  notified: string[];
  reason?: NotificationReason | null;
  skippedMutex?: boolean;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

let isRunInProgress = false;

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
    logger.info("Starting Flight Tracker Agent run", {
      origin: env.ORIGIN_IATA,
      destination: env.DESTINATION_IATA,
      dateFrom: env.DATE_FROM,
      dateTo: env.DATE_TO,
      dryRun,
      forceNotify,
      noNotify,
    });

    // 1. Validate live readiness unless dry run
    if (!dryRun) {
      assertLiveReady();
    }

    // 2. Fetch raw offers from configured providers (or mock) and filter strictly
    const rawOffers = await fetchAllOffers({ dryRun });
    const validOffers = filterStrictDamascusFlights(rawOffers);

    const currentLowestMyr =
      validOffers.length > 0 ? validOffers[0].priceMYR : null;

    logger.info("Flight offers fetched and filtered", {
      rawCount: rawOffers.length,
      validCount: validOffers.length,
      lowestPriceMYR: currentLowestMyr,
    });

    let previousLowestMyr: number | null = null;
    let lastNotification: { lowestPriceMYR: number; sentAt: Date } | null = null;

    // 3. Read previous lowest price FIRST (and last NotificationLog) BEFORE writing this run's data
    if (!dryRun) {
      const prisma = getPrisma();
      const [minSnapshotAgg, latestNotif] = await Promise.all([
        prisma.priceSnapshot.aggregate({
          _min: { priceMYR: true },
        }),
        prisma.notificationLog.findFirst({
          orderBy: { sentAt: "desc" },
          select: { lowestPriceMYR: true, sentAt: true },
        }),
      ]);

      previousLowestMyr = minSnapshotAgg._min.priceMYR ?? null;
      lastNotification = latestNotif ?? null;

      logger.info("Historical state read prior to persistence", {
        previousLowestMyr,
        lastNotifiedPriceMYR: lastNotification?.lowestPriceMYR ?? null,
        lastNotifiedAt: lastNotification?.sentAt?.toISOString() ?? null,
      });

      // 4. Upsert valid offers into FlightOfferRecord and insert a PriceSnapshot per offer in a transaction
      if (validOffers.length > 0) {
        await prisma.$transaction(
          validOffers.flatMap((offer) => [
            prisma.flightOfferRecord.upsert({
              where: { externalId: offer.externalId },
              create: {
                externalId: offer.externalId,
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
            }),
            prisma.priceSnapshot.create({
              data: {
                externalId: offer.externalId,
                priceMYR: offer.priceMYR,
              },
            }),
          ])
        );

        logger.info("Persisted valid offers and price snapshots", {
          offersUpserted: validOffers.length,
          snapshotsInserted: validOffers.length,
        });
      }
    }

    // 5 & 6. Decide notification
    if (noNotify) {
      logger.info("Notifications suppressed via --no-notify flag.");
      return {
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
      targetPriceMyr: env.TARGET_PRICE_MYR,
      forceNotify,
    });

    if (!reason) {
      logger.info("No notification trigger met for this run", {
        currentLowestMyr,
        previousLowestMyr,
        targetPriceMyr: env.TARGET_PRICE_MYR,
      });
      return {
        rawCount: rawOffers.length,
        validCount: validOffers.length,
        lowestPriceMYR: currentLowestMyr,
        notified: [],
        reason: null,
      };
    }

    logger.info("Notification triggered", {
      reason,
      currentLowestMyr,
      previousLowestMyr,
    });

    // 7. Send Telegram and Email independently
    const notified: string[] = [];

    if (dryRun) {
      const [tgRes, emailRes] = await Promise.all([
        sendTelegramReport(validOffers, { dryRun: true }),
        sendEmailReport(validOffers, { dryRun: true }),
      ]);
      if (tgRes.ok) notified.push("TELEGRAM");
      if (emailRes.ok) notified.push("EMAIL");
    } else {
      const prisma = getPrisma();
      const tasks: Promise<void>[] = [];

      if (telegramConfigured()) {
        tasks.push(
          (async () => {
            const res = await sendTelegramReport(validOffers, { dryRun: false });
            if (res.ok) {
              notified.push("TELEGRAM");
              await prisma.notificationLog.create({
                data: {
                  lowestPriceMYR: currentLowestMyr ?? 0,
                  channel: "TELEGRAM",
                  reason,
                },
              });
            }
          })()
        );
      } else {
        logger.warn("Skipping Telegram delivery: channel not configured.");
      }

      if (emailConfigured()) {
        tasks.push(
          (async () => {
            const res = await sendEmailReport(validOffers, { dryRun: false });
            if (res.ok) {
              notified.push("EMAIL");
              await prisma.notificationLog.create({
                data: {
                  lowestPriceMYR: currentLowestMyr ?? 0,
                  channel: "EMAIL",
                  reason,
                },
              });
            }
          })()
        );
      } else {
        logger.warn("Skipping Email delivery: channel not configured.");
      }

      await Promise.allSettled(tasks);
    }

    logger.info("Flight Tracker Agent run completed", {
      rawCount: rawOffers.length,
      validCount: validOffers.length,
      lowestPriceMYR: currentLowestMyr,
      reason,
      notified,
    });

    return {
      rawCount: rawOffers.length,
      validCount: validOffers.length,
      lowestPriceMYR: currentLowestMyr,
      notified,
      reason,
    };
  } finally {
    isRunInProgress = false;
  }
}


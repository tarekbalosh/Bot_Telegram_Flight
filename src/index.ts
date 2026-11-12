import cron, { ScheduledTask } from "node-cron";
import { disconnectPrisma } from "./config/db";
import { env } from "./config/env";
import {
  startTelegramCommandPoller,
  TelegramPollerHandle,
} from "./services/telegram-commands";
import { runFlightTrackerAgent } from "./services/tracker";
import { logger, maskSecrets } from "./utils/logger";

export interface CliFlags {
  runNow: boolean;
  once: boolean;
  dryRun: boolean;
  noNotify: boolean;
}

export function parseCliFlags(argv: string[] = process.argv.slice(2)): CliFlags {
  const args = new Set(argv);
  return {
    runNow: args.has("--run-now"),
    once: args.has("--once"),
    dryRun: args.has("--dry-run"),
    noNotify: args.has("--no-notify"),
  };
}

async function main(): Promise<void> {
  const flags = parseCliFlags();

  if (flags.dryRun) {
    try {
      await runFlightTrackerAgent({
        dryRun: true,
        forceNotify: true,
        noNotify: flags.noNotify,
      });
    } finally {
      await disconnectPrisma();
    }
    return;
  }

  if (flags.runNow) {
    try {
      await runFlightTrackerAgent({
        forceNotify: true,
        noNotify: flags.noNotify,
      });
    } finally {
      await disconnectPrisma();
    }
    return;
  }

  if (flags.once) {
    try {
      await runFlightTrackerAgent({
        forceNotify: false,
        noNotify: flags.noNotify,
      });
    } finally {
      await disconnectPrisma();
    }
    return;
  }

  // Long-lived cron worker mode
  if (!cron.validate(env.CRON_SCHEDULE)) {
    throw new Error(
      `Invalid CRON_SCHEDULE expression: "${env.CRON_SCHEDULE}". Expected standard 5-field cron syntax (e.g. "0 8 * * *").`
    );
  }

  logger.info("Initializing long-lived Flight Tracker worker", {
    cronSchedule: env.CRON_SCHEDULE,
    timezone: env.TZ_NAME,
    telegramCommandsEnabled: env.TELEGRAM_COMMANDS_ENABLED,
  });

  let telegramPoller: TelegramPollerHandle | null =
    startTelegramCommandPoller();

  // Initial startup run (non-fatal so the long-lived worker and Telegram poller stay alive)
  try {
    await runFlightTrackerAgent({
      forceNotify: false,
      noNotify: flags.noNotify,
    });
  } catch (err) {
    logger.error("Initial startup tracker run failed; continuing worker loop", {
      error: err instanceof Error ? maskSecrets(err.message) : String(err),
    });
  }

  let scheduledTask: ScheduledTask | null = cron.schedule(
    env.CRON_SCHEDULE,
    async () => {
      try {
        await runFlightTrackerAgent({
          forceNotify: false,
          noNotify: flags.noNotify,
        });
      } catch (err) {
        logger.error("Scheduled tracker run failed", {
          error: err instanceof Error ? maskSecrets(err.message) : String(err),
        });
      }
    },
    {
      timezone: env.TZ_NAME,
    }
  );

  logger.info("Cron scheduler active; waiting for next scheduled run", {
    cronSchedule: env.CRON_SCHEDULE,
    timezone: env.TZ_NAME,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    if (scheduledTask) {
      scheduledTask.stop();
      scheduledTask = null;
    }
    if (telegramPoller) {
      const pollerToStop = telegramPoller;
      telegramPoller = null;
      await pollerToStop.stop();
    }
    await disconnectPrisma();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (require.main === module) {
  main().catch(async (err) => {
    logger.error("Fatal error in Flight Tracker Agent", {
      error: err instanceof Error ? maskSecrets(err.message) : String(err),
    });
    await disconnectPrisma();
    process.exit(1);
  });
}


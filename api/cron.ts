import { env } from "../src/config/env";
import { runFlightTrackerAgent } from "../src/services/tracker";
import { logger, maskSecrets } from "../src/utils/logger";

export const maxDuration = 300;

function isAuthorized(request: Request, url: URL): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    return true;
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader === `Bearer ${cronSecret}`) {
    return true;
  }

  const querySecret = url.searchParams.get("secret");
  if (querySecret === cronSecret) {
    return true;
  }

  return false;
}

async function handleTrackerRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (!isAuthorized(request, url)) {
    logger.warn("Unauthorized request to /api/cron");
    return Response.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const dryRun = url.searchParams.get("dryRun") === "true";
  const forceNotify = url.searchParams.get("forceNotify") === "true";
  const noNotify = url.searchParams.get("noNotify") === "true";

  try {
    const summary = await runFlightTrackerAgent({
      dryRun,
      forceNotify,
      noNotify,
    });

    return Response.json(
      {
        ok: true,
        route: `${env.ORIGIN_IATA} -> ${env.DESTINATION_IATA}`,
        dateRange: `${env.DATE_FROM} to ${env.DATE_TO}`,
        dryRun,
        forceNotify,
        summary,
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err) {
    const message =
      err instanceof Error ? maskSecrets(err.message) : String(err);
    logger.error("Vercel function /api/cron failed", { error: message });
    return Response.json(
      {
        ok: false,
        error: message,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleTrackerRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleTrackerRequest(request);
}


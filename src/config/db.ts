import { PrismaClient } from "@prisma/client";
import { logger, maskSecrets } from "../utils/logger";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/**
 * Enhances a PostgreSQL connection URL with serverless-friendly pool/timeout defaults
 * (especially for Neon PostgreSQL which auto-suspends after 5 minutes of inactivity).
 */
export function buildOptimizedDatabaseUrl(
  rawUrl: string | undefined = process.env.DATABASE_URL
): string | undefined {
  if (!rawUrl || !rawUrl.trim()) {
    return undefined;
  }

  try {
    const parsed = new URL(rawUrl.trim());
    if (!parsed.searchParams.has("connect_timeout")) {
      parsed.searchParams.set("connect_timeout", "30");
    }
    if (!parsed.searchParams.has("pool_timeout")) {
      parsed.searchParams.set("pool_timeout", "30");
    }
    if (!parsed.searchParams.has("connection_limit")) {
      parsed.searchParams.set("connection_limit", "5");
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function isTransientPrismaError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const code = (err as { code?: string }).code;
  if (
    typeof code === "string" &&
    ["P1001", "P1002", "P1008", "P1017", "P2024"].includes(code)
  ) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /Timed out fetching a new connection|Server has closed the connection|Can't reach database server|Connection reset|Socket timeout|ECONNRESET|ETIMEDOUT/i.test(
    message
  );
}

export async function withDbRetry<T>(
  operation: () => Promise<T>,
  label: string = "Database query"
): Promise<T> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt < 2 && isTransientPrismaError(err)) {
        const msg = err instanceof Error ? maskSecrets(err.message) : String(err);
        logger.warn(
          `${label} encountered transient DB connection/pool error; reconnecting and retrying...`,
          { error: msg }
        );
        try {
          if (globalForPrisma.prisma) {
            await globalForPrisma.prisma.$disconnect();
            await globalForPrisma.prisma.$connect();
          }
        } catch {
          // Ignore reconnect errors; next attempt will lazy-connect
        }
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} failed after retry`);
}

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const optimizedUrl = buildOptimizedDatabaseUrl(process.env.DATABASE_URL);
    globalForPrisma.prisma = new PrismaClient(
      optimizedUrl
        ? {
            datasources: {
              db: {
                url: optimizedUrl,
              },
            },
          }
        : undefined
    );
  }
  return globalForPrisma.prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (globalForPrisma.prisma) {
    await globalForPrisma.prisma.$disconnect();
    globalForPrisma.prisma = undefined;
  }
}

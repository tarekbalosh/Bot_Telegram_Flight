export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

const TELEGRAM_BOT_URL_TOKEN_REGEX = /bot\d+:[A-Za-z0-9_-]+/g;

export function maskSecrets(input: string): string {
  let masked = input.replace(TELEGRAM_BOT_URL_TOKEN_REGEX, "bot[REDACTED]");
  const rawToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (rawToken && rawToken.length >= 4) {
    masked = masked.split(rawToken).join("[REDACTED]");
  }
  const serpKey = process.env.SERPAPI_KEY?.trim();
  if (serpKey && serpKey.length >= 4) {
    masked = masked.split(serpKey).join("[REDACTED]");
  }
  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (resendKey && resendKey.length >= 4) {
    masked = masked.split(resendKey).join("[REDACTED]");
  }
  return masked;
}

function formatLine(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const metaSuffix =
    meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  return maskSecrets(`[${timestamp}] [${level}] ${message}${metaSuffix}`);
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(formatLine("INFO", message, meta));
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(formatLine("WARN", message, meta));
  },
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(formatLine("ERROR", message, meta));
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    if (process.env.DEBUG === "1" || process.env.DEBUG === "true") {
      console.log(formatLine("DEBUG", message, meta));
    }
  },
};

import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { logger, maskSecrets } from "./logger";

export const HTTP_TIMEOUT_MS = 30_000;

export const httpClient: AxiosInstance = axios.create({
  timeout: HTTP_TIMEOUT_MS,
});

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  label?: string;
}

export function isRetryableHttpError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    return false;
  }
  const axiosErr = err as AxiosError;
  if (!axiosErr.response) {
    // Network / timeout / DNS error
    return true;
  }
  const status = axiosErr.response.status;
  return status === 429 || (status >= 500 && status <= 599);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an async HTTP operation with 3 attempts and exponential backoff.
 * Retries only on network errors, HTTP 429, and HTTP 5xx responses.
 */
export async function withHttpRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const label = options.label ?? "HTTP request";

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const canRetry = attempt < maxAttempts && isRetryableHttpError(err);
      if (!canRetry) {
        throw err;
      }

      let delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        const retryAfterHeader = err.response.headers?.["retry-after"];
        const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
          delayMs = Math.max(delayMs, retryAfterSec * 1000);
        }
      }

      const message = err instanceof Error ? maskSecrets(err.message) : String(err);
      logger.warn(`${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`, {
        error: message,
      });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export async function httpRequest<T = unknown>(
  config: AxiosRequestConfig,
  retryOptions?: RetryOptions
): Promise<AxiosResponse<T>> {
  return withHttpRetry(
    () => httpClient.request<T>({ timeout: HTTP_TIMEOUT_MS, ...config }),
    retryOptions
  );
}


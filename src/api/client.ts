/**
 * WHOOP API HTTP client.
 *
 * Thin wrapper around native `fetch` that injects the OAuth Bearer token,
 * prepends the WHOOP API base URL, parses JSON responses, and throws
 * typed errors for non-2xx status codes.
 */

import { WHOOP_API_BASE_URL } from "./endpoints.js";
import type { Logger } from "../logging/logger.js";
import { MemoryCache, DEFAULT_TTL_MS } from "../cache/memory-cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating a WHOOP API client */
export interface WhoopClientOptions {
  accessToken: string;
  /** Override base URL — useful for testing. Defaults to WHOOP_API_BASE_URL. */
  baseUrl?: string;
  /** Callback to refresh the access token on 401. Returns a new access token. */
  onTokenRefresh?: () => Promise<string>;
  /**
   * Optional structured logger for API call observability.
   * Successful calls log at `debug` with `durationMs`; 429 responses log at
   * `warn`; timeouts/network errors log at `error`.
   */
  logger?: Logger;
  /** Optional request ID propagated to all log entries for this client. */
  requestId?: string;
  /**
   * Optional shared cache. When provided, callers can opt individual GETs into
   * caching via the `cache` option on {@link WhoopClient.get}. Without it,
   * caching is a no-op and every GET hits the network.
   */
  cache?: MemoryCache;
}

/** Per-request options for {@link WhoopClient.get}. */
export interface WhoopGetOptions {
  /** When true (and a cache is configured), serve from / store in the cache. */
  cache?: boolean;
  /** TTL override in milliseconds for this cached entry. Defaults to the cache default. */
  ttlMs?: number;
}

/** WHOOP API client returned by createWhoopClient */
export interface WhoopClient {
  /** Send a GET request and parse the JSON response as T */
  get<T>(path: string, options?: WhoopGetOptions): Promise<T>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error thrown when the WHOOP API returns a non-2xx response */
export class WhoopApiError extends Error {
  public override readonly name = "WhoopApiError";

  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly body: unknown
  ) {
    super(describeStatus(statusCode, statusText));
  }
}

/**
 * Human-readable message that separates WHOOP-side outages from problems the
 * user can fix, so a transient HTTP 500 does not read as a broken setup.
 */
function describeStatus(statusCode: number, statusText: string): string {
  const suffix = statusText ? ` ${statusText}` : "";
  if (statusCode >= 500) {
    return `WHOOP API is temporarily unavailable (HTTP ${statusCode}${suffix}). This is a WHOOP server-side error, not a credentials problem. Try again shortly.`;
  }
  if (statusCode === 429) {
    return "WHOOP API rate limit reached (HTTP 429). Wait a moment and try again.";
  }
  if (statusCode === 401) {
    return "WHOOP API rejected the access token (HTTP 401). Re-authentication may be required.";
  }
  return `WHOOP API error: ${statusCode}${suffix}`;
}

/** Error thrown when a network-level failure prevents reaching the WHOOP API */
export class WhoopNetworkError extends Error {
  public override readonly name = "WhoopNetworkError";

  constructor(cause: unknown) {
    super("Network error: Unable to reach the WHOOP API. Check your internet connection.", {
      cause,
    });
  }
}

/** Error thrown when token refresh fails during automatic 401 recovery */
export class WhoopAuthError extends Error {
  public override readonly name = "WhoopAuthError";

  constructor(cause: unknown) {
    super("Authentication error: Failed to refresh token. Re-authentication may be required.", {
      cause,
    });
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of retries for transient failures (429, 5xx, network errors, timeouts) */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff (1s, 2s, 4s) */
const BASE_RETRY_DELAY_MS = 1000;

/** Default request timeout in milliseconds (30 seconds) */
const REQUEST_TIMEOUT_MS = 30_000;

/** Maximum Retry-After delay in milliseconds (1 minute) — caps server-controlled header */
const MAX_RETRY_AFTER_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a given number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the Retry-After header as seconds.
 * Returns the delay in milliseconds (capped at MAX_RETRY_AFTER_MS),
 * or null if the header is missing/unparseable.
 */
function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isNaN(seconds) || seconds < 0) {
    return null;
  }
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * Delay before retry `attempt` (1-based). Honors Retry-After when the server
 * sends it; otherwise exponential backoff (1s, 2s, 4s) with equal jitter so
 * parallel requests do not retry in lockstep against a recovering server.
 */
function backoffDelay(attempt: number, response: Response | undefined): number {
  const retryAfter = response ? parseRetryAfter(response) : null;
  if (retryAfter !== null) {
    return retryAfter;
  }
  const base = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/**
 * Build a deterministic cache key for a GET request.
 * Query parameters are sorted so that semantically identical paths collapse to
 * the same key (e.g. `?a=1&b=2` and `?b=2&a=1`). No auth data is included.
 */
export function cacheKey(path: string): string {
  const qIndex = path.indexOf("?");
  if (qIndex === -1) {
    return `GET:${path}`;
  }
  const base = path.slice(0, qIndex);
  const params = new URLSearchParams(path.slice(qIndex + 1));
  params.sort();
  const query = params.toString();
  return query.length > 0 ? `GET:${base}?${query}` : `GET:${base}`;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a WHOOP API client.
 *
 * The client prepends the base URL to all paths, injects the Bearer token,
 * parses JSON responses, retries 429 rate limit responses with backoff,
 * and throws typed errors for non-2xx status codes.
 */
export function createWhoopClient(options: WhoopClientOptions): WhoopClient {
  const baseUrl = options.baseUrl ?? WHOOP_API_BASE_URL;
  const logger = options.logger;
  const requestId = options.requestId;
  const cache = options.cache;

  function logExtras(extra: Record<string, unknown>): Record<string, unknown> {
    return requestId !== undefined ? { requestId, ...extra } : extra;
  }

  async function doFetch(url: string, accessToken: string): Promise<Response> {
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      logger?.debug(
        "whoop api request",
        logExtras({ url, status: res.status, durationMs: Date.now() - startedAt })
      );
      return res;
    } catch (error: unknown) {
      const durationMs = Date.now() - startedAt;
      if (error instanceof WhoopApiError) {
        throw error;
      }
      // AbortError from AbortSignal.timeout → request timed out
      const isTimeout =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      if (isTimeout) {
        logger?.error("whoop api timeout", logExtras({ url, durationMs, error: error.message }));
      } else {
        logger?.error(
          "whoop api network error",
          logExtras({
            url,
            durationMs,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
      throw new WhoopNetworkError(error);
    }
  }

  async function parseErrorBody(response: Response): Promise<unknown> {
    try {
      const rawBody = await response.text();
      try {
        return JSON.parse(rawBody) as unknown;
      } catch {
        return rawBody;
      }
    } catch {
      return null;
    }
  }

  return {
    async get<T>(path: string, getOptions?: WhoopGetOptions): Promise<T> {
      if (getOptions?.cache && cache) {
        return cache.getOrFetch<T>(cacheKey(path), getOptions.ttlMs ?? DEFAULT_TTL_MS, () =>
          doGet<T>(path)
        );
      }
      return doGet<T>(path);
    },
  };

  async function doGet<T>(path: string): Promise<T> {
    const url = `${baseUrl}${path}`;
    let currentToken = options.accessToken;
    let lastError: Error | undefined;
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Wait before retry (not before the first attempt)
      if (attempt > 0) {
        await delay(backoffDelay(attempt, lastResponse));
      }

      let response: Response;
      try {
        response = await doFetch(url, currentToken);
      } catch (networkError: unknown) {
        // Connection reset, DNS blip or timeout: transient, so retry with backoff.
        if (networkError instanceof WhoopNetworkError && attempt < MAX_RETRIES) {
          logger?.warn("whoop api network error, retrying", logExtras({ url, attempt }));
          lastError = networkError;
          lastResponse = undefined;
          continue;
        }
        throw networkError;
      }

      if (response.ok) {
        return (await response.json()) as T;
      }

      const body = await parseErrorBody(response);
      const apiError = new WhoopApiError(response.status, response.statusText, body);

      // Retry rate limits and server errors. WHOOP's origin intermittently
      // returns 5xx while other requests succeed, so a retry usually lands.
      if (response.status === 429 || response.status >= 500) {
        const retryAfterMs = parseRetryAfter(response);
        logger?.warn(
          response.status === 429 ? "whoop api rate limited" : "whoop api server error",
          logExtras({ url, attempt, status: response.status, retryAfterMs: retryAfterMs ?? undefined })
        );
        lastError = apiError;
        lastResponse = response;
        continue;
      }

      // 401: attempt token refresh once
      if (response.status === 401 && options.onTokenRefresh) {
        let newToken: string;
        if (options.accessToken !== currentToken) {
          // A parallel request already refreshed while this one was in flight.
          newToken = options.accessToken;
        } else {
          try {
            newToken = await options.onTokenRefresh();
            logger?.info("whoop token refreshed", logExtras({ url }));
          } catch (refreshError: unknown) {
            throw new WhoopAuthError(refreshError);
          }
        }

        // Retry with the new token
        options.accessToken = newToken;
        currentToken = newToken;
        const retryResponse = await doFetch(url, newToken);
        if (retryResponse.ok) {
          return (await retryResponse.json()) as T;
        }

        // Retry also failed — throw the original error
        const retryBody = await parseErrorBody(retryResponse);
        throw new WhoopApiError(retryResponse.status, retryResponse.statusText, retryBody);
      }

      // All other errors: throw immediately
      throw apiError;
    }

    // All retries exhausted
    throw lastError!;
  }
}
